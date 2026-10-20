/**
 * Index types for the CreativeID Aggregator (`src/types.ts`) — M6.
 *
 * The index holds three kinds of record, normalised from wherever they were
 * published (an ATProto PDS, a Solid Pod, or a static file):
 *   personas      com.cultureblocs.creative.profile, or the #me node of a graph
 *   works         com.cultureblocs.creative.work, or #work-… nodes
 *   connections   com.cultureblocs.creative.connection, or #claim-… nodes
 * Everything here is a cache of what creatives published; it can be rebuilt
 * at any time and nothing in it is the only copy.
 */

export type SourceProtocol = "atproto" | "solid" | "static";

export const NSID = {
  profile: "com.cultureblocs.creative.profile",
  work: "com.cultureblocs.creative.work",
  connection: "com.cultureblocs.creative.connection",
} as const;
export const COLLECTIONS = [NSID.profile, NSID.work, NSID.connection] as const;

export interface Link {
  uri: string;
  title?: string;
}

export interface ExternalId {
  scheme: string;
  id: string;
  uri?: string;
}

export interface Credit {
  name: string;
  did?: string;
  role?: string;
}

export type Subject = { did: string; name?: string } | { uri: string; cid?: string };

export interface IndexedPersona {
  /** Stable index id, derived from the DID (ATProto) or the document URL. */
  id: string;
  protocol: SourceProtocol;
  /** at://…/profile/self, or <document>#me. */
  sourceUri: string;
  /** Where the index fetches it from. */
  httpEndpoint?: string;
  did?: string;
  handle?: string;
  pdsUrl?: string;
  cid?: string;
  etag?: string;
  name: string;
  bio?: string;
  disciplines: string[];
  based?: { name?: string; did?: string };
  links: Link[];
  externalIds: ExternalId[];
  createdAt?: string;
  updatedAt?: string;
  indexedAt: string;
}

export interface IndexedWork {
  /** at://did/com.cultureblocs.creative.work/<rkey>, or <document>#work-<tid>. */
  uri: string;
  cid?: string;
  personaId: string;
  did?: string;
  title: string;
  referenceUrl?: string;
  completionDate?: string;
  description?: string;
  credits: Credit[];
  tags: string[];
  links: Link[];
  externalIds: ExternalId[];
  createdAt?: string;
  indexedAt: string;
}

export interface IndexedConnection {
  uri: string;
  cid?: string;
  personaId: string;
  did?: string;
  subject: Subject;
  relationship: string;
  role?: string;
  note?: string;
  createdAt?: string;
  indexedAt: string;
}

/** Everything one persona published, as fetched in one go. */
export interface PersonaBundle {
  persona: IndexedPersona;
  works: IndexedWork[];
  connections: IndexedConnection[];
}

export interface PartyRef {
  personaId?: string;
  did?: string;
  name?: string;
  handle?: string;
}

/**
 * A closed loop: two parties independently saying the same thing.
 * Facts, not scores — readers decide what they mean.
 */
export type Loop =
  | {
      type: "peer";
      /** Both directions of the claim. */
      a: PartyRef;
      b: PartyRef;
      aSays: { relationship: string; role?: string; uri: string; createdAt?: string };
      bSays: { relationship: string; role?: string; uri: string; createdAt?: string };
    }
  | {
      type: "work";
      workUri: string;
      workTitle: string;
      creator: PartyRef;
      attester: PartyRef;
      relationship: string;
      role?: string;
      connectionUri: string;
      attestedAt?: string;
      /** The attestation names the exact version (CID) of the work. */
      pinned: boolean;
      /** Pinned to a version that is no longer the current one. */
      changedSinceAttested: boolean;
    };

export interface SearchQuery {
  q?: string;
  discipline?: string;
  based?: string;
  protocol?: SourceProtocol;
  limit?: number;
  offset?: number;
}

export interface PersonaSummary extends IndexedPersona {
  counts: { works: number; connections: number; loops: number };
}

export interface SearchResult {
  total: number;
  limit: number;
  offset: number;
  query: SearchQuery;
  results: PersonaSummary[];
}

export interface IndexRequestInput {
  /** at:// URI, DID, handle, https URL, or a bare domain. */
  uri: string;
  sourceType?: SourceProtocol;
  /** Use this PDS instead of looking it up from the DID (e.g. a local sandbox). */
  pdsUrl?: string;
  handle?: string;
}

/** A Jetstream commit event for one of the creative collections. */
export interface JetstreamCommitEvent {
  did: string;
  time_us?: number;
  kind: "commit" | "identity" | "account";
  commit?: {
    rev?: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid?: string;
    record?: Record<string, unknown>;
  };
  identity?: { did: string; handle?: string };
}
