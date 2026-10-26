/**
 * Live ATProto ingestion via Jetstream (`src/jetstream.ts`) — M6.
 *
 * Subscribes to the three CultureBlocs creative collections only, so the
 * traffic is tiny. Remembers the last event time (a cursor file) so a restart
 * picks up where it left off, and reconnects with back-off. Off unless
 * started explicitly (JETSTREAM=on), so a local aggregator makes no network
 * connections by default.
 *
 * Jetstream only carries changes. When it shows activity from an account the
 * index doesn't know yet, the listener reads that account's whole persona once
 * (profile, works and connections), so records published before the
 * directory was listening (from Easel, say) appear too.
 */

import { readFile, writeFile } from "node:fs/promises";

import { IndexStore } from "./indexer.js";
import { resolvePersona } from "./resolver.js";
import { COLLECTIONS, JetstreamCommitEvent, PersonaBundle } from "./types.js";

export const DEFAULT_JETSTREAM = "wss://jetstream2.us-east.bsky.network/subscribe";

/** The bits of the WebSocket API we use (the global one in Node 22+, or a test double). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface JetstreamOptions {
  endpoint?: string;
  cursorFile?: string;
  createSocket?: (url: string) => SocketLike;
  log?: (msg: string) => void;
  /** Milliseconds; doubles after each failed connection up to maxDelay. */
  initialDelay?: number;
  maxDelay?: number;
  /**
   * Reads a whole persona for an account seen for the first time. Defaults to
   * resolving it from the account's PDS; `false` turns it off.
   */
  backfill?: ((did: string) => Promise<PersonaBundle>) | false;
}

export function jetstreamUrl(endpoint: string, cursor?: number): string {
  const params = new URLSearchParams();
  for (const c of COLLECTIONS) params.append("wantedCollections", c);
  if (cursor) params.set("cursor", String(cursor));
  return `${endpoint}?${params}`;
}

export function startJetstream(store: IndexStore, options: JetstreamOptions = {}) {
  const endpoint = options.endpoint ?? DEFAULT_JETSTREAM;
  const log = options.log ?? ((m: string) => console.log(`[jetstream] ${m}`));
  const createSocket =
    options.createSocket ??
    ((url: string) => {
      const WS = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
      if (!WS) throw new Error("This Node has no WebSocket; use Node 22 or later.");
      return new WS(url);
    });
  let delay = options.initialDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 60_000;
  let socket: SocketLike | null = null;
  let stopped = false;
  let cursor: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let lastSaved = 0;
  const backfill = options.backfill === false
    ? null
    : options.backfill ?? ((did: string) => resolvePersona({ uri: did, sourceType: "atproto" }));
  const tried = new Set<string>();
  let backfills: Promise<void> = Promise.resolve();

  const readWhole = async (did: string) => {
    try {
      const bundle = await backfill!(did);
      await store.upsertBundle(bundle);
      log(`read the whole persona of ${did}: ${bundle.works.length} works, ${bundle.connections.length} connections`);
    } catch (err) {
      log(`couldn't read the whole persona of ${did}: ${(err as Error).message}`);
    }
  };

  const saveCursor = async () => {
    if (!options.cursorFile || !cursor || cursor - lastSaved < 5_000_000) return;
    lastSaved = cursor;
    await writeFile(options.cursorFile, String(cursor), "utf8").catch(() => undefined);
  };

  const handle = async (raw: unknown) => {
    let event: JetstreamCommitEvent;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (event.time_us) cursor = event.time_us;
    if (event.kind === "identity" && event.identity) {
      await store.setHandle(event.did, event.identity.handle);
    } else if (event.kind === "commit") {
      const isNew = !!backfill && event.commit?.operation !== "delete" && !tried.has(event.did)
        && !(await store.find(event.did));
      const r = await store.applyCommit(event);
      if (r.applied) log(`${event.commit?.operation} ${event.commit?.collection} from ${event.did}`);
      if (isNew) {
        // Once per account per run; off the event queue, so a slow PDS never holds up the stream.
        tried.add(event.did);
        backfills = backfills.then(() => readWhole(event.did));
      }
    }
    await saveCursor();
  };

  const connect = async () => {
    if (stopped) return;
    if (cursor === undefined && options.cursorFile) {
      cursor = Number(await readFile(options.cursorFile, "utf8").catch(() => "")) || undefined;
    }
    // Rewind 5 s on reconnect so nothing in flight is missed (replays are idempotent).
    const url = jetstreamUrl(endpoint, cursor ? cursor - 5_000_000 : undefined);
    try {
      socket = createSocket(url);
    } catch (err) {
      log(`couldn't connect: ${(err as Error).message}`);
      return schedule();
    }
    socket.onopen = () => {
      delay = options.initialDelay ?? 1000;
      log(`listening for ${COLLECTIONS.join(", ")}`);
    };
    socket.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data)).catch((err) => log(`event failed: ${(err as Error).message}`));
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      socket = null;
      if (!stopped) schedule();
    };
  };

  const schedule = () => {
    if (stopped) return;
    log(`reconnecting in ${Math.round(delay / 1000)}s`);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, maxDelay);
  };

  void connect();

  return {
    /** Waits for queued events and whole-persona reads to finish (useful in tests). */
    idle: async () => {
      await queue;
      await backfills;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
