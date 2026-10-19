/**
 * Multi-Protocol Resolver & Normalizer (`src/resolver.ts`)
 * Fetches and normalizes CreativeID records from:
 * 1. AT Protocol PDS (via XRPC com.atproto.repo.getRecord or Jetstream commit events)
 * 2. Solid Data Pods (via HTTP GET of RDF Turtle or JSON-LD)
 * 3. Static Domains (via direct JSON-LD / Turtle URL or /.well-known/creativeid.jsonld)
 */

import { createHash } from "node:crypto";
import {
  IndexedArtist,
  IndexRequestInput,
  JetstreamCommitEvent,
  SourceProtocol,
} from "./types.js";

export const ATPROTO_COLLECTION = "org.creativepassport.actor.persona";

export function makeArtistId(protocol: SourceProtocol, canonicalKey: string): string {
  const hash = createHash("sha256")
    .update(`${protocol}:${canonicalKey.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
  return `pers_${protocol}_${hash}`;
}

export function buildNormalizedArtist(params: {
  name: string;
  biography: string;
  protocol: SourceProtocol;
  sourceUri: string;
  httpEndpoint?: string;
  did?: string;
  handle?: string;
  cid?: string;
  subjectId?: string;
  etag?: string;
  updatedAt?: string;
  now?: Date;
}): IndexedArtist {
  const nowIso = (params.now ?? new Date()).toISOString();
  const updatedAt = params.updatedAt || nowIso;
  const canonicalKey = params.did || params.sourceUri;
  const id = makeArtistId(params.protocol, canonicalKey);
  const subjectId = params.subjectId || params.sourceUri;

  return {
    id,
    name: params.name.trim(),
    biography: params.biography.trim(),
    protocol: params.protocol,
    sourceUri: params.sourceUri,
    httpEndpoint: params.httpEndpoint,
    did: params.did,
    handle: params.handle,
    cid: params.cid,
    subjectId,
    etag: params.etag,
    updatedAt,
    indexedAt: nowIso,
    jsonLd: {
      "@context": {
        "@vocab": "https://schema.org/",
        foaf: "http://xmlns.com/foaf/0.1/",
        creativeid: "https://www.cultureblocs.com/ns/creativeid#",
      },
      "@id": subjectId,
      "@type": ["Person", "creativeid:Persona"],
      name: params.name.trim(),
      description: params.biography.trim(),
      "foaf:name": params.name.trim(),
      dateModified: updatedAt,
      "creativeid:sourceProtocol": params.protocol,
      "creativeid:sourceUri": params.sourceUri,
      ...(params.did ? { "creativeid:did": params.did } : {}),
      ...(params.cid ? { "creativeid:cid": params.cid } : {}),
    },
  };
}

/**
 * Unescapes double-quoted RDF Turtle string literals.
 */
function unescapeTurtleLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Parses a CreativeID RDF Turtle (`text/turtle`) document into name, biography, updatedAt, and subjectId.
 */
export function parseTurtlePersona(
  turtle: string,
  fallbackSubjectUri: string
): {
  name: string;
  biography: string;
  updatedAt?: string;
  subjectId: string;
} {
  const subjectMatch = turtle.match(/^\s*<([^>]+)>\s*\n?\s*a\s+/m);
  const subjectId = subjectMatch ? subjectMatch[1] : fallbackSubjectUri;

  const nameMatch =
    turtle.match(/(?:schema:name|foaf:name)\s+"((?:[^"\\]|\\.)*)"/) ??
    turtle.match(/name\s+"((?:[^"\\]|\\.)*)"/);
  const bioMatch =
    turtle.match(/schema:description\s+"((?:[^"\\]|\\.)*)"/) ??
    turtle.match(/description\s+"((?:[^"\\]|\\.)*)"/);
  const modMatch = turtle.match(
    /schema:dateModified\s+"((?:[^"\\]|\\.)*)"(?:\^\^xsd:dateTime)?/
  );

  if (!nameMatch || !bioMatch) {
    throw new Error(
      "Invalid RDF Turtle CreativeID: missing schema:name or schema:description triple."
    );
  }

  return {
    name: unescapeTurtleLiteral(nameMatch[1]),
    biography: unescapeTurtleLiteral(bioMatch[1]),
    updatedAt: modMatch ? unescapeTurtleLiteral(modMatch[1]) : undefined,
    subjectId,
  };
}

/**
 * Parses a CreativeID JSON-LD document into name, biography, updatedAt, and subjectId.
 */
export function parseJsonLdPersona(
  rawJson: string,
  fallbackSubjectUri: string
): {
  name: string;
  biography: string;
  updatedAt?: string;
  subjectId: string;
} {
  const doc = JSON.parse(rawJson) as Record<string, unknown>;
  const name =
    (typeof doc.name === "string" && doc.name) ||
    (typeof doc["foaf:name"] === "string" && doc["foaf:name"]) ||
    (typeof doc["https://schema.org/name"] === "string" &&
      doc["https://schema.org/name"]);
  const biography =
    (typeof doc.description === "string" && doc.description) ||
    (typeof doc.biography === "string" && doc.biography) ||
    (typeof doc["https://schema.org/description"] === "string" &&
      doc["https://schema.org/description"]);

  if (!name || !biography) {
    throw new Error(
      "Invalid JSON-LD CreativeID: missing `name` or `description`."
    );
  }

  const updatedAt =
    typeof doc.dateModified === "string"
      ? doc.dateModified
      : typeof doc.updatedAt === "string"
        ? doc.updatedAt
        : undefined;
  const subjectId =
    typeof doc["@id"] === "string" && doc["@id"].trim()
      ? doc["@id"]
      : fallbackSubjectUri;

  return {
    name,
    biography,
    updatedAt,
    subjectId,
  };
}

/**
 * Detects the protocol (`atproto`, `solid`, or `static`) from a URI and optional hint.
 */
export function detectProtocol(
  uri: string,
  hint?: SourceProtocol
): SourceProtocol {
  if (hint) return hint;
  const trimmed = uri.trim();
  if (
    trimmed.startsWith("at://") ||
    trimmed.startsWith("did:") ||
    trimmed.includes("/xrpc/com.atproto.repo.getRecord")
  ) {
    return "atproto";
  }
  if (
    trimmed.endsWith(".ttl") ||
    trimmed.includes(".ttl#") ||
    trimmed.includes("solid") ||
    trimmed.includes("/sandbox/solid/")
  ) {
    return "solid";
  }
  return "static";
}

/**
 * Resolves and normalizes a CreativeID from any supported decentralized source.
 */
export async function resolveAndNormalizeArtist(
  input: IndexRequestInput,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<IndexedArtist> {
  const rawUri = input.uri.trim();
  if (!rawUri) {
    throw new Error("URI is required to resolve an artist.");
  }

  const protocol = detectProtocol(rawUri, input.sourceType);

  if (protocol === "atproto") {
    return resolveAtprotoArtist(rawUri, input, fetchImpl, now);
  }

  return resolveHttpLinkedDataArtist(rawUri, protocol, fetchImpl, now);
}

async function resolveAtprotoArtist(
  rawUri: string,
  input: IndexRequestInput,
  fetchImpl: typeof fetch,
  now: Date
): Promise<IndexedArtist> {
  let repo = rawUri;
  let collection = ATPROTO_COLLECTION;
  let rkey = "self";
  let pdsBaseUrl = (input.pdsUrl || "https://bsky.social").replace(/\/+$/, "");

  if (rawUri.startsWith("at://")) {
    // e.g. at://did:plc:123/org.creativepassport.actor.persona/self
    const withoutScheme = rawUri.slice("at://".length);
    const parts = withoutScheme.split("/");
    repo = parts[0];
    if (parts[1]) collection = parts[1];
    if (parts[2]) rkey = parts[2];
  } else if (rawUri.includes("/xrpc/com.atproto.repo.getRecord")) {
    const parsed = new URL(rawUri);
    pdsBaseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.split("/xrpc/")[0]}`;
    repo = parsed.searchParams.get("repo") || repo;
    collection = parsed.searchParams.get("collection") || collection;
    rkey = parsed.searchParams.get("rkey") || rkey;
  }

  const params = new URLSearchParams({
    repo,
    collection,
    rkey,
  });
  const endpoint = `${pdsBaseUrl}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;

  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch ATProto record from ${endpoint} (${response.status}): ${text}`
    );
  }

  const data = (await response.json()) as {
    uri?: string;
    cid?: string;
    value?: {
      name?: string;
      biography?: string;
      description?: string;
      updatedAt?: string;
    };
  };

  const name = data.value?.name;
  const biography = data.value?.biography ?? data.value?.description;

  if (!name || !biography) {
    throw new Error(
      "ATProto record is missing required `name` or `biography` fields."
    );
  }

  const did = repo.startsWith("did:")
    ? repo
    : data.uri?.startsWith("at://did:")
      ? data.uri.slice("at://".length).split("/")[0]
      : undefined;
  const canonicalAtUri =
    data.uri || `at://${did || repo}/${collection}/${rkey}`;

  return buildNormalizedArtist({
    name,
    biography,
    protocol: "atproto",
    sourceUri: canonicalAtUri,
    httpEndpoint: endpoint,
    did,
    handle: input.handle || (!repo.startsWith("did:") ? repo : undefined),
    cid: data.cid,
    subjectId: canonicalAtUri,
    updatedAt: data.value?.updatedAt,
    now,
  });
}

async function resolveHttpLinkedDataArtist(
  rawUri: string,
  protocol: "solid" | "static",
  fetchImpl: typeof fetch,
  now: Date
): Promise<IndexedArtist> {
  // Support bare domain lookup via /.well-known/creativeid.jsonld
  let targetUrl = rawUri;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://${targetUrl.replace(/\/+$/, "")}/.well-known/creativeid.jsonld`;
  }

  const fetchUrl = targetUrl.split("#")[0];
  const response = await fetchImpl(fetchUrl, {
    method: "GET",
    headers: {
      Accept: "application/ld+json, text/turtle;q=0.9, application/json;q=0.8",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch Linked Data resource ${fetchUrl} (${response.status}): ${text}`
    );
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const etag = response.headers.get("etag") || undefined;
  const body = await response.text();

  const isTurtle =
    contentType.includes("turtle") ||
    fetchUrl.endsWith(".ttl") ||
    body.trimStart().startsWith("@prefix");

  const parsed = isTurtle
    ? parseTurtlePersona(body, targetUrl)
    : parseJsonLdPersona(body, targetUrl);

  const resolvedSubject =
    parsed.subjectId.startsWith("#")
      ? `${fetchUrl}${parsed.subjectId}`
      : parsed.subjectId;

  return buildNormalizedArtist({
    name: parsed.name,
    biography: parsed.biography,
    protocol,
    sourceUri: targetUrl.includes("#") ? targetUrl : resolvedSubject,
    httpEndpoint: fetchUrl,
    subjectId: resolvedSubject,
    etag,
    updatedAt: parsed.updatedAt,
    now,
  });
}

/**
 * Normalizes a real-time AT Protocol Jetstream commit event directly into an IndexedArtist.
 */
export function normalizeJetstreamCommit(
  event: JetstreamCommitEvent,
  handle?: string,
  now: Date = new Date()
): IndexedArtist | null {
  if (
    event.kind !== "commit" ||
    event.commit.collection !== ATPROTO_COLLECTION ||
    event.commit.operation === "delete"
  ) {
    return null;
  }

  const record = event.commit.record;
  if (!record?.name || !record?.biography) {
    return null;
  }

  const sourceUri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
  return buildNormalizedArtist({
    name: record.name,
    biography: record.biography,
    protocol: "atproto",
    sourceUri,
    did: event.did,
    handle,
    cid: event.commit.cid,
    subjectId: sourceUri,
    updatedAt: record.updatedAt,
    now,
  });
}
