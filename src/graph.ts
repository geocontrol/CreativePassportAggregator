/**
 * Normalising published personas (`src/graph.ts`) — M6.
 *
 * Three inputs, one output (a PersonaBundle):
 *   fromAtprotoRecords  com.cultureblocs.creative.{profile,work,connection}
 *   fromJsonLd          the studio's JSON-LD graph (or a v1 single node)
 *   fromTurtle          the studio's Turtle (parsed with n3)
 * Everything published is untrusted input: values are type-checked, trimmed
 * and capped at the lexicon limits, and anything malformed is dropped rather
 * than failing the whole persona.
 */

import { createHash } from "node:crypto";
import { BlankNode, NamedNode, Parser, Quad, Term } from "n3";

import {
  Credit,
  ExternalId,
  IndexedConnection,
  IndexedPersona,
  IndexedWork,
  Link,
  PersonaBundle,
  SourceProtocol,
  Subject,
} from "./types.js";

const SCHEMA = "https://schema.org/";
const CID_NS = "https://www.cultureblocs.com/ns/creativeid#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ---------------------------------------------------------------------------
// Ids and safe values
// ---------------------------------------------------------------------------

export function makePersonaId(protocol: SourceProtocol, key: string): string {
  const hash = createHash("sha256").update(`${protocol}:${key.trim().toLowerCase()}`).digest("hex").slice(0, 12);
  return `pers_${protocol}_${hash}`;
}

const seg = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A trimmed string capped at `max` graphemes, or undefined. */
export function str(value: unknown, max = 2000): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return undefined;
  let out = "";
  let n = 0;
  for (const { segment } of seg.segment(t)) {
    if (++n > max) break;
    out += segment;
  }
  return out;
}

const URI = /^[a-z][a-z0-9+.-]*:[^\s]+$/i;
const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const uri = (v: unknown) => {
  const s = str(v, 2000);
  return s && URI.test(s) ? s : undefined;
};
const did = (v: unknown) => {
  const s = str(v, 2000);
  return s && DID.test(s) ? s : undefined;
};
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : v === undefined ? [] : [v].slice(0, max));
const strings = (v: unknown, max: number, len: number) =>
  list(v, max).map((x) => str(x, len)).filter((x): x is string => !!x);

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

const toLinks = (v: unknown, max = 8): Link[] =>
  list(v, max)
    .map((l): Link | undefined => {
      const o = (l ?? {}) as Record<string, unknown>;
      const u = uri(o.uri ?? o.url ?? (o["@id"] as unknown));
      return u ? compact({ uri: u, title: str(o.title ?? o.name, 300) }) : undefined;
    })
    .filter((x): x is Link => !!x);

const toIds = (v: unknown, max = 20): ExternalId[] =>
  list(v, max)
    .map((x): ExternalId | undefined => {
      const o = (x ?? {}) as Record<string, unknown>;
      const scheme = str(o.scheme ?? o.propertyID, 64);
      const id = str(o.id ?? o.value, 200);
      return scheme && id ? compact({ scheme, id, uri: uri(o.uri ?? o.url) }) : undefined;
    })
    .filter((x): x is ExternalId => !!x);

const toCredits = (v: unknown, max = 20): Credit[] =>
  list(v, max)
    .map((x): Credit | undefined => {
      const o = (x ?? {}) as Record<string, unknown>;
      const name = str(o.name, 300);
      return name ? compact({ name, did: did(o.did ?? o["creativeid:did"]), role: str(o.role ?? o["creativeid:role"], 100) }) : undefined;
    })
    .filter((x): x is Credit => !!x);

function toSubject(v: unknown): Subject | undefined {
  const o = (v ?? {}) as Record<string, unknown>;
  const d = did(o.did ?? o["creativeid:did"]);
  if (d) return compact({ did: d, name: str(o.name, 300) });
  const u = uri(o.uri ?? o["creativeid:uri"]);
  if (u) return compact({ uri: u, cid: str(o.cid ?? o["creativeid:cid"], 200) });
  return undefined;
}

// ---------------------------------------------------------------------------
// ATProto records
// ---------------------------------------------------------------------------

export interface FetchedRecord {
  uri: string;
  cid?: string;
  value: Record<string, unknown>;
}

export function personaFromProfileRecord(
  rec: FetchedRecord,
  meta: { did: string; handle?: string; pdsUrl?: string; httpEndpoint?: string },
  now: Date
): IndexedPersona | undefined {
  const v = rec.value;
  const name = str(v.name, 300);
  if (!name) return undefined;
  const based = v.based as Record<string, unknown> | undefined;
  return compact({
    id: makePersonaId("atproto", meta.did),
    protocol: "atproto" as const,
    sourceUri: rec.uri,
    httpEndpoint: meta.httpEndpoint,
    did: meta.did,
    handle: meta.handle,
    pdsUrl: meta.pdsUrl,
    cid: rec.cid,
    name,
    bio: str(v.bio, 2000),
    disciplines: strings(v.disciplines, 8, 64),
    based: based ? compact({ name: str(based.name, 300), did: did(based.did) }) : undefined,
    links: toLinks(v.links),
    externalIds: toIds(v.externalIds),
    createdAt: str(v.createdAt, 64),
    indexedAt: now.toISOString(),
  });
}

export function workFromRecord(rec: FetchedRecord, personaId: string, ownerDid: string | undefined, now: Date): IndexedWork | undefined {
  const v = rec.value;
  const title = str(v.title, 300);
  if (!title) return undefined;
  return compact({
    uri: rec.uri,
    cid: rec.cid,
    personaId,
    did: ownerDid,
    title,
    referenceUrl: uri(v.referenceUrl),
    completionDate: str(v.completionDate, 100),
    description: str(v.description, 2000),
    credits: toCredits(v.credits),
    tags: strings(v.tags, 8, 64),
    links: toLinks(v.links),
    externalIds: toIds(v.externalIds),
    createdAt: str(v.createdAt, 64),
    indexedAt: now.toISOString(),
  });
}

export function connectionFromRecord(
  rec: FetchedRecord,
  personaId: string,
  ownerDid: string | undefined,
  now: Date
): IndexedConnection | undefined {
  const v = rec.value;
  const subject = toSubject(v.subject);
  const relationship = str(v.relationship, 64);
  if (!subject || !relationship) return undefined;
  return compact({
    uri: rec.uri,
    cid: rec.cid,
    personaId,
    did: ownerDid,
    subject,
    relationship,
    role: str(v.role, 100),
    note: str(v.note, 500),
    createdAt: str(v.createdAt, 64),
    indexedAt: now.toISOString(),
  });
}

export function fromAtprotoRecords(
  input: {
    did: string;
    handle?: string;
    pdsUrl?: string;
    httpEndpoint?: string;
    profile: FetchedRecord;
    works: FetchedRecord[];
    connections: FetchedRecord[];
  },
  now: Date = new Date()
): PersonaBundle {
  const persona = personaFromProfileRecord(input.profile, input, now);
  if (!persona) throw new Error(`The profile record at ${input.profile.uri} has no name.`);
  return {
    persona,
    works: input.works.map((r) => workFromRecord(r, persona.id, input.did, now)).filter((x): x is IndexedWork => !!x),
    connections: input.connections
      .map((r) => connectionFromRecord(r, persona.id, input.did, now))
      .filter((x): x is IndexedConnection => !!x),
  };
}

// ---------------------------------------------------------------------------
// Linked Data (static files and Solid)
// ---------------------------------------------------------------------------

/** A node read from JSON-LD or Turtle, with keys in the studio's compact form. */
type Node = Record<string, unknown>;

interface LinkedDataInput {
  protocol: "solid" | "static";
  /** The document URL (no fragment). */
  docUrl: string;
  etag?: string;
  now?: Date;
}

const hasType = (node: Node, ...names: string[]) => {
  const types = list(node["@type"], 10).map(String);
  return types.some((t) => names.includes(t));
};

function absolute(id: unknown, base: string): string | undefined {
  if (typeof id !== "string" || !id) return undefined;
  try {
    return new URL(id, base).href;
  } catch {
    return undefined;
  }
}

function bundleFromNodes(nodes: Node[], input: LinkedDataInput): PersonaBundle {
  const now = input.now ?? new Date();
  const personaTypes = ["Person", "creativeid:Persona", `${SCHEMA}Person`, `${CID_NS}Persona`];
  const workTypes = ["CreativeWork", "creativeid:Work", `${SCHEMA}CreativeWork`, `${CID_NS}Work`];
  const connTypes = ["creativeid:Connection", `${CID_NS}Connection`];

  const profile = nodes.find((n) => hasType(n, ...personaTypes)) ?? (nodes.length === 1 ? nodes[0] : undefined);
  const name = profile && str(profile.name, 300);
  if (!profile || !name) throw new Error(`No CreativeID profile (a node with a name) found in ${input.docUrl}.`);

  const id = makePersonaId(input.protocol, input.docUrl);
  const sourceUri = absolute(profile["@id"] ?? "#me", input.docUrl) ?? `${input.docUrl}#me`;
  const place = profile.homeLocation as Node | undefined;
  const persona: IndexedPersona = compact({
    id,
    protocol: input.protocol,
    sourceUri,
    httpEndpoint: input.docUrl,
    etag: input.etag,
    name,
    bio: str(profile.description, 2000),
    disciplines: strings(profile.knowsAbout, 8, 64),
    based: place ? compact({ name: str(place.name, 300), did: did(place["creativeid:did"]) }) : undefined,
    links: toLinks(profile["creativeid:links"]),
    externalIds: toIds(profile.identifier),
    createdAt: str(profile.dateCreated, 64),
    updatedAt: str(profile.dateModified, 64),
    indexedAt: now.toISOString(),
  });

  const works = nodes
    .filter((n) => n !== profile && hasType(n, ...workTypes))
    .slice(0, 1000)
    .map((n): IndexedWork | undefined => {
      const title = str(n.name, 300);
      const u = absolute(n["@id"], input.docUrl);
      if (!title || !u) return undefined;
      return compact({
        uri: u,
        personaId: id,
        title,
        referenceUrl: uri(n.url),
        completionDate: str(n["creativeid:completionDate"], 100),
        description: str(n.description, 2000),
        credits: toCredits(n["creativeid:credits"]),
        tags: strings(n.keywords, 8, 64),
        links: toLinks(n["creativeid:links"]),
        externalIds: toIds(n.identifier),
        createdAt: str(n.dateCreated, 64),
        indexedAt: now.toISOString(),
      });
    })
    .filter((x): x is IndexedWork => !!x);

  const connections = nodes
    .filter((n) => hasType(n, ...connTypes))
    .slice(0, 1000)
    .map((n): IndexedConnection | undefined => {
      const subject = toSubject(n["creativeid:subject"]);
      const relationship = str(n["creativeid:relationship"], 64);
      const u = absolute(n["@id"], input.docUrl);
      if (!subject || !relationship || !u) return undefined;
      return compact({
        uri: u,
        personaId: id,
        subject,
        relationship,
        role: str(n["creativeid:role"], 100),
        note: str(n["creativeid:note"], 500),
        createdAt: str(n.dateCreated, 64),
        indexedAt: now.toISOString(),
      });
    })
    .filter((x): x is IndexedConnection => !!x);

  return { persona, works, connections };
}

/** The studio's JSON-LD (a @graph), or a v1 single-node file. */
export function fromJsonLd(text: string, input: LinkedDataInput): PersonaBundle {
  const doc = JSON.parse(text) as Node;
  const ctx = doc["@context"] as Node | undefined;
  const base = (ctx && typeof ctx === "object" && typeof ctx["@base"] === "string" ? (ctx["@base"] as string) : input.docUrl).split("#")[0];
  const nodes = Array.isArray(doc["@graph"]) ? (doc["@graph"] as Node[]) : [doc];
  return bundleFromNodes(nodes.filter((n) => n && typeof n === "object"), { ...input, docUrl: base });
}

/** The studio's Turtle, parsed with n3 and folded back into the compact node shape. */
export function fromTurtle(text: string, input: LinkedDataInput): PersonaBundle {
  const quads: Quad[] = new Parser({ baseIRI: input.docUrl, format: "text/turtle" }).parse(text);
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.termType === "BlankNode" ? `_:${q.subject.value}` : q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }

  const keyFor = (predicate: string) =>
    predicate === RDF_TYPE
      ? "@type"
      : predicate.startsWith(SCHEMA)
        ? predicate.slice(SCHEMA.length)
        : predicate.startsWith(CID_NS)
          ? `creativeid:${predicate.slice(CID_NS.length)}`
          : predicate;

  const valueOf = (term: Term, depth: number): unknown => {
    if (term.termType === "Literal") return term.value;
    if (term.termType === "BlankNode") return depth > 3 ? undefined : nodeFor(`_:${(term as BlankNode).value}`, depth + 1);
    if (term.termType === "NamedNode") return (term as NamedNode).value;
    return undefined;
  };

  function nodeFor(key: string, depth = 0): Node {
    const node: Node = key.startsWith("_:") ? {} : { "@id": key };
    for (const q of bySubject.get(key) ?? []) {
      const k = keyFor(q.predicate.value);
      let v = valueOf(q.object, depth);
      if (k === "@type" && typeof v === "string") v = v.startsWith(SCHEMA) ? v.slice(SCHEMA.length) : v.startsWith(CID_NS) ? `creativeid:${v.slice(CID_NS.length)}` : v;
      if (v === undefined) continue;
      node[k] = k in node ? [...list(node[k], 1000), v] : v;
    }
    return node;
  }

  // Multi-valued properties must stay arrays even with one value.
  const nodes = [...bySubject.keys()].filter((k) => !k.startsWith("_:")).map((k) => nodeFor(k));
  return bundleFromNodes(nodes, input);
}
