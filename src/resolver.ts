/**
 * Fetching a published persona (`src/resolver.ts`) — M6.
 *
 *   ATProto  an at:// link to any creative record, a DID, an @handle, or a
 *            getRecord URL → the account's profile plus every work and
 *            connection record (listRecords, paginated)
 *   Static   an https URL, or a bare domain → /.well-known/creativeid.jsonld
 *   Solid    an https URL to a .ttl/.jsonld resource
 * Linked Data fetches are capped (256 KB, 10 s) because the URL is supplied
 * by whoever pings the index.
 */

import { fromAtprotoRecords, fromJsonLd, fromTurtle, FetchedRecord } from "./graph.js";
import { resolveDid, resolveHandle } from "./identity.js";
import { IndexRequestInput, NSID, PersonaBundle, SourceProtocol } from "./types.js";

export const WELL_KNOWN = "/.well-known/creativeid.jsonld";
export const MAX_DOCUMENT_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

export interface ResolveContext {
  fetchImpl?: typeof fetch;
  now?: Date;
  plcDirectory?: string;
  publicApi?: string;
}

export function detectProtocol(uri: string, hint?: SourceProtocol): SourceProtocol {
  if (hint) return hint;
  const t = uri.trim();
  if (t.startsWith("at://") || t.startsWith("did:") || t.startsWith("@") || t.includes("/xrpc/com.atproto.repo.")) {
    return "atproto";
  }
  let host = "";
  try {
    host = new URL(t.includes("://") ? t : `https://${t}`).hostname;
  } catch {
    /* not a URL; treated as static and rejected when fetched */
  }
  if (/\.ttl(#.*)?$/i.test(t) || /\/sandbox\/solid\//.test(t) || /solid/i.test(host)) {
    return "solid";
  }
  return "static";
}

export async function resolvePersona(input: IndexRequestInput, ctx: ResolveContext = {}): Promise<PersonaBundle> {
  const raw = input.uri?.trim();
  if (!raw) throw new Error("Give a URI, DID, handle or domain to index.");
  const protocol = detectProtocol(raw, input.sourceType);
  return protocol === "atproto" ? resolveAtproto(raw, input, ctx) : resolveLinkedData(raw, protocol, ctx);
}

// ---------------------------------------------------------------------------
// ATProto
// ---------------------------------------------------------------------------

async function getJson<T>(fetchImpl: typeof fetch, url: string): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}

async function listAll(fetchImpl: typeof fetch, pds: string, did: string, collection: string): Promise<FetchedRecord[]> {
  const out: FetchedRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ repo: did, collection, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const { ok, body } = await getJson<{ records?: FetchedRecord[]; cursor?: string }>(
      fetchImpl,
      `${pds}/xrpc/com.atproto.repo.listRecords?${params}`
    );
    if (!ok) break;
    out.push(...(body.records ?? []));
    if (!body.cursor || !body.records?.length) break;
    cursor = body.cursor;
  }
  return out;
}

async function resolveAtproto(raw: string, input: IndexRequestInput, ctx: ResolveContext): Promise<PersonaBundle> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const opts = { fetchImpl, plcDirectory: ctx.plcDirectory, publicApi: ctx.publicApi };
  let repo = raw.replace(/^@/, "");
  let pds = input.pdsUrl?.replace(/\/+$/, "");

  if (raw.startsWith("at://")) {
    repo = raw.slice(5).split("/")[0];
  } else if (raw.includes("/xrpc/com.atproto.repo.")) {
    const u = new URL(raw);
    pds = pds ?? `${u.origin}${u.pathname.split("/xrpc/")[0]}`;
    repo = u.searchParams.get("repo") ?? repo;
  }

  let handle = input.handle;
  const did = repo.startsWith("did:") ? repo : await resolveHandle(repo, opts);
  if (!repo.startsWith("did:")) handle = handle ?? repo;
  if (!pds) {
    const doc = await resolveDid(did, opts);
    pds = doc.pds?.replace(/\/+$/, "");
    handle = handle ?? doc.handle;
    if (!pds) throw new Error(`${did} has no PDS listed, so its records can't be read.`);
  } else if (!handle) {
    // A PDS was given (e.g. a local sandbox); the handle may still be published.
    handle = await resolveDid(did, opts).then((d) => d.handle, () => undefined);
  }

  const params = new URLSearchParams({ repo: did, collection: NSID.profile, rkey: "self" });
  const profileUrl = `${pds}/xrpc/com.atproto.repo.getRecord?${params}`;
  const profile = await getJson<FetchedRecord>(fetchImpl, profileUrl);
  if (!profile.ok || !profile.body?.value) {
    throw new Error(`${handle ?? did} hasn't published a CreativeID profile (${NSID.profile}).`);
  }
  const [works, connections] = await Promise.all([
    listAll(fetchImpl, pds, did, NSID.work),
    listAll(fetchImpl, pds, did, NSID.connection),
  ]);
  return fromAtprotoRecords(
    { did, handle, pdsUrl: pds, httpEndpoint: profileUrl, profile: profile.body, works, connections },
    ctx.now ?? new Date()
  );
}

// ---------------------------------------------------------------------------
// Linked Data
// ---------------------------------------------------------------------------

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > max) throw new Error(`Document is too large (${declared} bytes; the limit is ${max}).`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`Document is too large (over ${max} bytes).`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function resolveLinkedData(raw: string, protocol: "solid" | "static", ctx: ResolveContext): Promise<PersonaBundle> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/\/+$/, "")}${WELL_KNOWN}`;
  const docUrl = target.split("#")[0];
  const res = await fetchImpl(docUrl, {
    headers: { Accept: "application/ld+json, text/turtle;q=0.9, application/json;q=0.8" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Couldn't fetch ${docUrl} (${res.status}).`);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const etag = res.headers.get("etag") ?? undefined;
  const text = await readCapped(res, MAX_DOCUMENT_BYTES);
  const isTurtle = contentType.includes("turtle") || /\.ttl$/i.test(docUrl) || /^\s*@(prefix|base)/.test(text);
  const input = { protocol, docUrl, etag, now: ctx.now };
  return isTurtle ? fromTurtle(text, input) : fromJsonLd(text, input);
}
