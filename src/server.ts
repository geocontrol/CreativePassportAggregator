/**
 * Creative Passport Aggregator HTTP API Server (`src/server.ts`)
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ArtistIndexStore } from "./indexer.js";
import {
  ATPROTO_COLLECTION,
  normalizeJetstreamCommit,
  resolveAndNormalizeArtist,
} from "./resolver.js";
import {
  IndexRequestInput,
  JetstreamCommitEvent,
  SourceProtocol,
} from "./types.js";

export interface AggregatorServerOptions {
  store?: ArtistIndexStore;
  publicDir?: string;
  fetchImpl?: typeof fetch;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function createAggregatorServer(
  options: AggregatorServerOptions = {}
): Server {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = resolve(__dirname, "..");
  const store =
    options.store ?? new ArtistIndexStore(join(projectRoot, "data", "index.json"));
  const publicDir = options.publicDir ?? join(projectRoot, "public");
  const fetchImpl = options.fetchImpl ?? fetch;

  return createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "localhost:3500";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
        });
        res.end();
        return;
      }

      // -----------------------------------------------------------------------
      // 1. GET /v1/stats — Aggregator Statistics
      // -----------------------------------------------------------------------
      if (pathname === "/v1/stats" && method === "GET") {
        const stats = await store.stats();
        return sendJson(res, 200, stats);
      }

      // -----------------------------------------------------------------------
      // 2. GET /v1/artists — Search & Filter Indexed Artists
      // -----------------------------------------------------------------------
      if (pathname === "/v1/artists" && method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const rawProtocol = url.searchParams.get("protocol");
        const protocol =
          rawProtocol === "atproto" ||
          rawProtocol === "solid" ||
          rawProtocol === "static"
            ? (rawProtocol as SourceProtocol)
            : undefined;
        const limit = Number(url.searchParams.get("limit") || 20);
        const offset = Number(url.searchParams.get("offset") || 0);

        const searchResult = await store.search({ q, protocol, limit, offset });
        return sendJson(res, 200, searchResult);
      }

      // -----------------------------------------------------------------------
      // 3. GET /v1/artists/:identifier — Lookup Artist by ID, DID, Handle, or URI
      // -----------------------------------------------------------------------
      if (pathname.startsWith("/v1/artists/") && method === "GET") {
        const identifier = decodeURIComponent(
          pathname.slice("/v1/artists/".length)
        );
        let artist = await store.findByIdentifier(identifier);

        // Optional on-demand read-through resolution if ?resolve=true
        if (!artist && url.searchParams.get("resolve") === "true") {
          const pdsUrl = url.searchParams.get("pdsUrl") || undefined;
          artist = await resolveAndNormalizeArtist(
            { uri: identifier, pdsUrl },
            fetchImpl
          );
          await store.upsert(artist);
        }

        if (!artist) {
          return sendJson(res, 404, {
            error: `Artist not found for identifier "${identifier}"`,
          });
        }

        // If client explicitly asks for JSON-LD only (`?view=jsonld`)
        if (url.searchParams.get("view") === "jsonld") {
          return sendJson(res, 200, artist.jsonLd);
        }

        return sendJson(res, 200, artist);
      }

      // -----------------------------------------------------------------------
      // 4. POST /v1/index — Ping-on-Publish / Live URI Resolution & Indexing
      // -----------------------------------------------------------------------
      if (pathname === "/v1/index" && method === "POST") {
        const body = await readJsonBody<IndexRequestInput>(req);
        if (!body.uri || !body.uri.trim()) {
          return sendJson(res, 400, {
            error: "Field `uri` is required (e.g. at://..., https://..., or domain).",
          });
        }

        const normalized = await resolveAndNormalizeArtist(body, fetchImpl);
        const saved = await store.upsert(normalized);

        return sendJson(res, 200, {
          indexed: true,
          artist: saved,
        });
      }

      // -----------------------------------------------------------------------
      // 5. POST /v1/jetstream/event — Ingest ATProto Jetstream Commit Event
      // -----------------------------------------------------------------------
      if (pathname === "/v1/jetstream/event" && method === "POST") {
        const event = await readJsonBody<JetstreamCommitEvent & { handle?: string }>(
          req
        );

        if (
          event.kind === "commit" &&
          event.commit?.collection === ATPROTO_COLLECTION &&
          event.commit?.operation === "delete"
        ) {
          const removed = await store.remove(event.did);
          return sendJson(res, 200, { deleted: removed, did: event.did });
        }

        const artist = normalizeJetstreamCommit(event, event.handle);
        if (!artist) {
          return sendJson(res, 202, {
            indexed: false,
            reason: "Ignored non-matching collection or incomplete record.",
          });
        }

        const saved = await store.upsert(artist);
        return sendJson(res, 200, { indexed: true, artist: saved });
      }

      // -----------------------------------------------------------------------
      // 6. POST /v1/seed — Seed Curated Demo Artists Across All Protocols
      // -----------------------------------------------------------------------
      if (pathname === "/v1/seed" && method === "POST") {
        const seeded = await store.seedDemoArtists();
        const stats = await store.stats();
        return sendJson(res, 200, {
          seededCount: seeded.length,
          stats,
          artists: seeded,
        });
      }

      // -----------------------------------------------------------------------
      // 7. Static Frontend Assets (Demo Search & API Explorer UI)
      // -----------------------------------------------------------------------
      if (method === "GET") {
        const assetPath = pathname === "/" ? "/index.html" : pathname;
        const resolvedAsset = resolve(publicDir, `.${assetPath}`);
        if (!resolvedAsset.startsWith(publicDir)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        try {
          const content = await readFile(resolvedAsset);
          const ext = extname(resolvedAsset);
          const mime = MIME_TYPES[ext] ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": "no-cache",
          });
          res.end(content);
          return;
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
      }

      sendJson(res, 404, { error: "Endpoint not found" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}
