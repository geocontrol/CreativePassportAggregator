/**
 * Identity lookup (`src/identity.ts`) — M6. Same logic as the studio's
 * src/resolve.ts (kept as a copy so the aggregator stands alone).
 *
 * Lets the studio turn what a person pastes into a connection target into
 * something pinned and checkable:
 *   handle        → DID (via https://<handle>/.well-known/atproto-did, then
 *                   the public resolveHandle API)
 *   DID           → its handle and PDS (did:plc via plc.directory,
 *                   did:web via /.well-known/did.json)
 *   at:// URI     → the record's current CID, so a connection is CID-pinned
 * Only runs when the person asks (it touches the network); everything else in
 * the studio works offline.
 */

export interface ResolvedParty {
  kind: "party";
  did: string;
  handle?: string;
  pds?: string;
}

export interface ResolvedRecord {
  kind: "record";
  uri: string;
  cid: string;
  did: string;
  collection: string;
  rkey: string;
  handle?: string;
}

export type Resolved = ResolvedParty | ResolvedRecord;

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  plcDirectory?: string;
  publicApi?: string;
}

const HANDLE_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i;

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

async function get(url: string, opts: Required<Pick<ResolveOptions, "fetchImpl" | "timeoutMs">>): Promise<Response> {
  return opts.fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs), headers: { Accept: "application/json" } });
}

export async function resolveHandle(handle: string, options: ResolveOptions = {}): Promise<string> {
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_PATTERN.test(h)) throw new ResolveError(`"${handle}" is not a handle (expected something like alice.bsky.social).`);
  const opts = { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? 8000 };
  try {
    const res = await get(`https://${h}/.well-known/atproto-did`, opts);
    if (res.ok) {
      const did = (await res.text()).trim();
      if (did.startsWith("did:")) return did;
    }
  } catch {
    /* fall through to the public API */
  }
  const api = options.publicApi ?? "https://public.api.bsky.app";
  const res = await get(`${api}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`, opts);
  if (!res.ok) throw new ResolveError(`Couldn't find an account for ${h}.`);
  const body = (await res.json()) as { did?: string };
  if (!body.did) throw new ResolveError(`Couldn't find an account for ${h}.`);
  return body.did;
}

interface DidDocument {
  alsoKnownAs?: string[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
}

export async function resolveDid(did: string, options: ResolveOptions = {}): Promise<ResolvedParty> {
  const opts = { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? 8000 };
  let url: string;
  if (did.startsWith("did:plc:")) url = `${options.plcDirectory ?? "https://plc.directory"}/${did}`;
  else if (did.startsWith("did:web:")) url = `https://${decodeURIComponent(did.slice("did:web:".length))}/.well-known/did.json`;
  else throw new ResolveError(`Can't look up ${did}: only did:plc and did:web are supported.`);
  const res = await get(url, opts);
  if (!res.ok) throw new ResolveError(`Couldn't find ${did}.`);
  const doc = (await res.json()) as DidDocument;
  const handle = doc.alsoKnownAs?.find((a) => a.startsWith("at://"))?.slice(5);
  const pds = doc.service?.find((s) => s.id.endsWith("#atproto_pds"))?.serviceEndpoint;
  return { kind: "party", did, ...(handle ? { handle } : {}), ...(pds ? { pds } : {}) };
}

export async function resolveRecord(atUri: string, options: ResolveOptions = {}): Promise<ResolvedRecord> {
  const m = atUri.trim().match(/^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/);
  if (!m) throw new ResolveError(`"${atUri}" isn't a record link (expected at://account/collection/key).`);
  const [, repo, collection, rkey] = m;
  const did = repo.startsWith("did:") ? repo : await resolveHandle(repo, options);
  const party = await resolveDid(did, options);
  if (!party.pds) throw new ResolveError(`${did} has no PDS listed, so its records can't be read.`);
  const opts = { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? 8000 };
  const params = new URLSearchParams({ repo: did, collection, rkey });
  const res = await get(`${party.pds.replace(/\/+$/, "")}/xrpc/com.atproto.repo.getRecord?${params}`, opts);
  if (!res.ok) throw new ResolveError(`That record doesn't exist (or isn't public): at://${did}/${collection}/${rkey}.`);
  const body = (await res.json()) as { uri?: string; cid?: string };
  if (!body.cid) throw new ResolveError("The PDS returned the record without a CID.");
  return {
    kind: "record",
    uri: `at://${did}/${collection}/${rkey}`,
    cid: body.cid,
    did,
    collection,
    rkey,
    ...(party.handle ? { handle: party.handle } : {}),
  };
}

/** Resolves whatever was pasted: an at:// URI, a DID, or a handle. */
export async function resolveTarget(input: string, options: ResolveOptions = {}): Promise<Resolved> {
  const q = input.trim();
  if (q.startsWith("at://")) return resolveRecord(q, options);
  if (q.startsWith("did:")) return resolveDid(q, options);
  const did = await resolveHandle(q, options);
  const party: ResolvedParty = await resolveDid(did, options).catch(() => ({ kind: "party" as const, did }));
  return { ...party, handle: party.handle ?? q.replace(/^@/, "").toLowerCase() };
}
