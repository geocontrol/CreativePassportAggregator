/**
 * Normalized Types & Schemas for CreativeID Aggregator (`src/types.ts`)
 */

export type SourceProtocol = "atproto" | "solid" | "static";

export interface IndexedArtist {
  /** Deterministic aggregator ID (e.g. slugified hash or DID/URI key) */
  id: string;
  /** Artist display name */
  name: string;
  /** Artist biography / creative statement */
  biography: string;
  /** Which decentralized protocol hosts the source of truth */
  protocol: SourceProtocol;
  /** Canonical URI of the remote record (at://..., https://pod.../creativeid.ttl#me, etc.) */
  sourceUri: string;
  /** Optional HTTP URL to inspect or dereference the source record */
  httpEndpoint?: string;
  /** Optional AT Protocol DID (e.g. did:plc:...) */
  did?: string;
  /** Optional AT Protocol handle (e.g. ada.eurosky.social) */
  handle?: string;
  /** Optional cryptographic content identifier (CID) for ATProto records */
  cid?: string;
  /** Optional Solid WebID or JSON-LD @id subject URI */
  subjectId?: string;
  /** Optional HTTP ETag for conditional polling of Solid/Static resources */
  etag?: string;
  /** Timestamp when the artist last updated their persona */
  updatedAt: string;
  /** Timestamp when the aggregator last fetched/verified this record */
  indexedAt: string;
  /** Canonical JSON-LD representation served to API consumers */
  jsonLd: {
    "@context": {
      "@vocab": "https://schema.org/";
      foaf: "http://xmlns.com/foaf/0.1/";
      creativeid: "https://www.cultureblocs.com/ns/creativeid#";
    };
    "@id": string;
    "@type": ["Person", "creativeid:Persona"];
    name: string;
    description: string;
    "foaf:name": string;
    dateModified: string;
    "creativeid:sourceProtocol": SourceProtocol;
    "creativeid:sourceUri": string;
    "creativeid:did"?: string;
    "creativeid:cid"?: string;
  };
}

export interface SearchQuery {
  q?: string;
  protocol?: SourceProtocol;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  total: number;
  limit: number;
  offset: number;
  query: string;
  protocol?: SourceProtocol;
  results: IndexedArtist[];
}

export interface IndexRequestInput {
  /** Target URI (at://..., https://..., or domain) */
  uri: string;
  /** Optional explicit protocol hint */
  sourceType?: SourceProtocol;
  /** Optional PDS URL override when indexing an at:// URI or handle/DID */
  pdsUrl?: string;
  /** Optional handle metadata for ATProto records */
  handle?: string;
}

/**
 * Payload emitted by AT Protocol Jetstream WebSocket when filtering by
 * `wantedCollections=org.creativepassport.actor.persona`
 */
export interface JetstreamCommitEvent {
  did: string;
  time_us?: number;
  kind: "commit";
  commit: {
    rev?: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid?: string;
    record?: {
      $type?: string;
      name?: string;
      biography?: string;
      updatedAt?: string;
    };
  };
}
