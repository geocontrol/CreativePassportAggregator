/**
 * CreativeID Aggregator HTTP API (`src/server.ts`) — M6.
 *
 *   GET  /v1/personas?q=&discipline=&based=&protocol=&limit=&offset=
 *   GET  /v1/personas/:id                  :id = index id, DID, handle, URL or domain
 *                                          (?resolve=true fetches it if not indexed yet)
 *   GET  /v1/personas/:id/works            each with its loops
 *   GET  /v1/personas/:id/connections      { outgoing, incoming }
 *   GET  /v1/personas/:id/loops
 *   GET  /v1/works/:uri                    work + its persona + its loops
 *   GET  /v1/disciplines                   disciplines in use, for filters
 *   POST /v1/index                         { uri, sourceType?, pdsUrl?, handle? }
 *   POST /v1/jetstream/event               one Jetstream commit (for tests and bridges)
 *   POST /v1/seed                          load the fictional demo personas
 *   GET  /v1/stats
 * Read-only routes allow any origin (CORS), so other sites can query it.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { IndexStore } from "./indexer.js";
import { guardFetch, isPrivateHost, LookupFn, PrivateNetworkError } from "./netguard.js";
import { resolvePersona } from "./resolver.js";
import { demoBundles } from "./seed.js";
import { IndexedPersona, IndexRequestInput, JetstreamCommitEvent, SourceProtocol } from "./types.js";

export interface AggregatorServerOptions {
  store?: IndexStore;
  publicDir?: string;
  fetchImpl?: typeof fetch;
  /**
   * Allow /v1/index to fetch from localhost and private networks. Needed to
   * index a studio running on the same machine; leave off for a public index.
   */
  allowPrivateHosts?: boolean;
  /** DNS lookup used by the private-network guard (tests inject one). */
  lookup?: LookupFn;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 512 * 1024) throw new HttpError(413, "Request body too large.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

const PROTOCOLS = new Set(["atproto", "solid", "static"]);

export function createAggregatorServer(options: AggregatorServerOptions = {}): Server {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = resolve(__dirname, "..");
  const store = options.store ?? new IndexStore(join(projectRoot, "data", "index.json"));
  const publicDir = options.publicDir ?? join(projectRoot, "public");
  const allowPrivate = options.allowPrivateHosts ?? false;
  // A public index checks every outbound hop (handles, did:web, DID-document PDS
  // endpoints, pdsUrl, redirects), not just the identifier it was given.
  const fetchImpl = allowPrivate
    ? options.fetchImpl ?? fetch
    : guardFetch(options.fetchImpl ?? fetch, { lookup: options.lookup });

  const requirePersona = async (identifier: string): Promise<IndexedPersona> => {
    const p = await store.find(identifier);
    if (!p) throw new HttpError(404, `Nothing indexed for "${identifier}".`);
    return p;
  };

  const workWithLoops = async (uri: string) => {
    const work = await store.work(uri);
    return work ? { ...work, loops: await store.loopsForWork(uri) } : null;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost:3500"}`);
      const path = url.pathname;
      const method = req.method ?? "GET";
      let m: RegExpMatchArray | null;

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
        });
        res.end();
        return;
      }

      if (path === "/v1/stats" && method === "GET") return sendJson(res, 200, await store.stats());
      if (path === "/v1/disciplines" && method === "GET") return sendJson(res, 200, { disciplines: await store.disciplines() });

      if (path === "/v1/personas" && method === "GET") {
        const p = url.searchParams;
        const protocol = p.get("protocol");
        return sendJson(
          res,
          200,
          await store.search({
            q: p.get("q") ?? undefined,
            discipline: p.get("discipline") ?? undefined,
            based: p.get("based") ?? undefined,
            protocol: protocol && PROTOCOLS.has(protocol) ? (protocol as SourceProtocol) : undefined,
            limit: Number(p.get("limit") || 20),
            offset: Number(p.get("offset") || 0),
          })
        );
      }

      if ((m = path.match(/^\/v1\/personas\/([^/]+)(?:\/(works|connections|loops))?$/)) && method === "GET") {
        const identifier = decodeURIComponent(m[1]);
        let persona = await store.find(identifier);
        if (!persona && url.searchParams.get("resolve") === "true" && !m[2]) {
          const pdsUrl = url.searchParams.get("pdsUrl") ?? undefined;
          if (!allowPrivate && (isPrivateHost(identifier) || (pdsUrl && isPrivateHost(pdsUrl)))) {
            throw new HttpError(400, "This index doesn't fetch from private networks.");
          }
          const bundle = await resolvePersona({ uri: identifier, pdsUrl }, { fetchImpl });
          await store.upsertBundle(bundle);
          persona = bundle.persona;
        }
        if (!persona) throw new HttpError(404, `Nothing indexed for "${identifier}".`);
        if (m[2] === "works") {
          const works = await store.worksOf(persona.id);
          return sendJson(res, 200, { works: await Promise.all(works.map((w) => workWithLoops(w.uri))) });
        }
        if (m[2] === "connections") return sendJson(res, 200, await store.connectionsOf(persona));
        if (m[2] === "loops") return sendJson(res, 200, { loops: await store.loopsFor(persona) });
        return sendJson(res, 200, { persona: await store.summarise(persona) });
      }

      if ((m = path.match(/^\/v1\/works\/(.+)$/)) && method === "GET") {
        const uri = decodeURIComponent(m[1]);
        const work = await workWithLoops(uri);
        if (!work) throw new HttpError(404, `No work indexed at ${uri}.`);
        const persona = await store.persona(work.personaId);
        return sendJson(res, 200, { work, persona });
      }

      if (path === "/v1/index" && method === "POST") {
        const body = await readJsonBody<IndexRequestInput>(req);
        if (!body.uri?.trim()) throw new HttpError(400, "Give a `uri`: an at:// link, DID, handle, https URL or domain.");
        if (!allowPrivate && (isPrivateHost(body.uri) || (body.pdsUrl && isPrivateHost(body.pdsUrl)))) {
          throw new HttpError(400, "This index doesn't fetch from private networks.");
        }
        let bundle;
        try {
          bundle = await resolvePersona(body, { fetchImpl });
        } catch (err) {
          if (err instanceof PrivateNetworkError) throw err;
          throw new HttpError(422, (err as Error).message);
        }
        await store.upsertBundle(bundle);
        return sendJson(res, 200, {
          indexed: true,
          persona: await store.summarise(bundle.persona),
          works: bundle.works.length,
          connections: bundle.connections.length,
        });
      }

      if (path === "/v1/jetstream/event" && method === "POST") {
        const event = await readJsonBody<JetstreamCommitEvent>(req);
        const result = await store.applyCommit(event);
        return sendJson(res, result.applied ? 200 : 202, result);
      }

      if (path === "/v1/seed" && method === "POST") {
        for (const b of demoBundles()) await store.upsertBundle(b);
        return sendJson(res, 200, { seeded: demoBundles().length, stats: await store.stats() });
      }

      if (method === "GET" && !path.startsWith("/v1/")) {
        const assetPath = path === "/" ? "/index.html" : path;
        const file = resolve(publicDir, `.${assetPath}`);
        if (file !== publicDir && !file.startsWith(publicDir + sep)) throw new HttpError(403, "Forbidden");
        try {
          const content = await readFile(file);
          res.writeHead(200, { "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
          res.end(content);
          return;
        } catch {
          throw new HttpError(404, "Not found");
        }
      }

      throw new HttpError(404, "Endpoint not found");
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof PrivateNetworkError) return sendJson(res, 400, { error: err.message });
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
