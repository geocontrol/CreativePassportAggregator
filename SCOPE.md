# CreativeID Aggregator — Scope & Prototype Architecture (v1)

> **Note (2026-10-20):** this describes the v1 prototype (one name + bio record, `/v1/artists`). Since M6 the aggregator indexes personas, works and connections from `com.cultureblocs.creative.*` and computes matches; see [README.md](README.md). This document is rewritten in M7.

## 1. Purpose
**CreativeID Aggregator** is an open indexing and lookup API service ("AppView" + Linked Data Indexer) that provides a unified interface to artist biography datasets published across heterogeneous decentralized stores:
- **AT Protocol PDS** (Bluesky, Eurosky, self-hosted PDS instances via `org.creativepassport.actor.persona`)
- **Solid Data Pods** (RDF Turtle `text/turtle` and `application/ld+json` documents)
- **Static Web Domains** (`/.well-known/creativeid.jsonld` or standalone `.jsonld` / `.ttl` URLs)

While primarily an **API service** consumed by third-party platforms (festivals, music apps, arts directories), it includes a **Demo Search & API Explorer Web UI** for testing queries, inspecting normalized JSON-LD responses, and indexing new artist URIs.

---

## 2. Prototype Scope (v1)

### Core Capabilities
1. **Multi-Protocol Resolver & Normalizer (`src/resolver.ts`)**
   - **AT Protocol**: Fetches `org.creativepassport.actor.persona` (`rkey: "self"`) from any PDS via XRPC (`com.atproto.repo.getRecord`), or ingests real-time **Jetstream** firehose commit events.
   - **Solid Pod**: Fetches RDF Turtle (`text/turtle`) or JSON-LD (`application/ld+json`) from a Solid Pod resource URL and extracts `schema:name` / `foaf:name` and `schema:description`.
   - **Static Domain**: Fetches standalone `.jsonld` / `.ttl` URLs or resolves bare domains via `https://<domain>/.well-known/creativeid.jsonld`.
   - Enforces HTTP timeouts and payload size limits, and tracks `ETag` / `Last-Modified` metadata for conditional re-polling.

2. **Full-Text Search & Index Store (`src/indexer.ts`)**
   - Persists normalized `IndexedArtist` records to disk (`data/index.json`).
   - Provides relevance-ranked full-text search across artist `name`, `biography`, `handle`, `did`, and `sourceUri`, plus filtering by `protocol` (`atproto` | `solid` | `static`).
   - Supports atomic updates, deduplication by canonical `sourceUri` / `did`, and sample dataset seeding for demo purposes.

3. **Public REST API (`src/server.ts`, default port `3500`)**
   - `GET /v1/artists` — Search and filter artists (`?q=...&protocol=atproto|solid|static&limit=20&offset=0`).
   - `GET /v1/artists/:identifier` — Retrieve a single artist's normalized CreativeID by ID, DID (`did:plc:...`), handle, or URI.
   - `POST /v1/index` — "Ping-on-Publish" endpoint (`{ uri, sourceType?, pdsUrl?, handle? }`) that fetches the live remote store, normalizes the record, and indexes it.
   - `POST /v1/jetstream/event` — Ingests an ATProto Jetstream commit event for `org.creativepassport.actor.persona`.
   - `POST /v1/seed` — Loads curated demo artist profiles across Eurosky, Bluesky, Solid Pods, and Static domains.
   - `GET /v1/stats` — Returns index statistics by protocol.

4. **Demo Search & API Explorer UI (`public/*`)**
   - Live full-text search and protocol filter pills (`All`, `ATProto PDS`, `Solid Pod`, `Static`).
   - Artist result cards with provenance badges (`DID`, `CID`, `WebID`, `Source URI`) and a **"View API JSON"** inspector.
   - **"Ping / Index Artist URI"** tool to index any live URI (including records published on a local `CreativeID Studio` instance at `http://localhost:3400`).
   - Live API endpoint tester for developers.
