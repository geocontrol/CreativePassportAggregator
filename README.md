# Creative Passport Aggregator (v1 Prototype)

An open **Aggregator, Normalizer, and Search API Service** ("AppView" + Linked Data Indexer) for artist biographies published with **Creative Passport** across:
- **AT Protocol PDS** (`org.creativepassport.actor.persona` on Bluesky, Eurosky, or self-hosted PDS)
- **Solid Data Pods** (`text/turtle` and `application/ld+json` resources)
- **Static Domains** (`/.well-known/creative-passport.jsonld` or standalone URLs)

## Quick Start

```bash
cd ~/Projects/CreativePassportAggregator
npm install
npm start
```

Open **http://localhost:3500** for the **Demo Search & API Explorer UI**.
*(On first startup, 5 demo artists across Eurosky, Bluesky, Solid Pods, and Static domains are automatically seeded).*

## REST API Endpoints

| Endpoint | Description |
| :--- | :--- |
| `GET /v1/artists?q=<query>&protocol=<atproto\|solid\|static>` | Full-text search and protocol filtering across indexed artists. |
| `GET /v1/artists/:identifier` | Lookup an artist by aggregator ID, DID (`did:plc:...`), handle (`daphne.eurosky.social`), or URI. Pass `?view=jsonld` for pure JSON-LD output, or `?resolve=true` for live read-through resolution. |
| `POST /v1/index` | "Ping-on-Publish" webhook (`{ "uri": "...", "pdsUrl": "..." }`) to fetch, normalize, and index a remote Creative Passport live. |
| `POST /v1/jetstream/event` | Ingest a filtered ATProto Jetstream commit event (`wantedCollections=org.creativepassport.actor.persona`). |
| `GET /v1/stats` | Protocol breakdown and index counts. |

## Testing With Local `CreativePassport` Studio
If you have the local authoring tool (`~/Projects/CreativePassport`) running on `http://localhost:3400`:
1. Publish your persona to the local ATProto or Solid sandbox on `:3400`.
2. In the Aggregator UI (`http://localhost:3500`), click **"From Local CreativePassport (ATProto :3400)"** or **"From Local CreativePassport (Solid :3400)"** and click **Fetch & Index Artist**.

## Running Tests & Build
```bash
npm test
npm run build
```
