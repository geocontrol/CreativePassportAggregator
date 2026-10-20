# CreativeID Aggregator

A directory of creative personas published with [CreativeID Studio](https://github.com/geocontrol/creativeid-studio): to AT Protocol, Solid Pods, or a file on someone's own website. It reads what people published, keeps a copy to search, and shows where two people's accounts match. It owns nothing: every entry can be rebuilt from its source, and anyone can run another directory.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and why, and [SCOPE.md](SCOPE.md) for what it does and doesn't do.

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3500**. On first start it loads five fictional demo personas (`SEED=off` to start empty).

| Setting | Effect |
| --- | --- |
| `PORT` (default 3500), `HOST` (default 127.0.0.1) | Where it listens |
| `JETSTREAM=on` | Listen live to AT Protocol (only the three CultureBlocs creative collections). Off by default, so a local run makes no network connections of its own. |
| `JETSTREAM_URL` | Use another Jetstream instance |
| `ALLOW_PRIVATE_HOSTS=true` | Let `/v1/index` fetch from localhost and private networks when not bound to localhost. On automatically for a local run, so a studio on the same machine can be indexed. |

## What it indexes

| Record | From AT Protocol | From a file or Solid Pod |
| --- | --- | --- |
| Persona | `com.cultureblocs.creative.profile` | the `#me` node |
| Work | `com.cultureblocs.creative.work` | `#work-…` nodes |
| Connection | `com.cultureblocs.creative.connection` | `#claim-…` nodes |

Ways in:
- **Studio ping:** add this directory under *Publish → Directories to tell* in the studio, and every publish tells it where to look.
- **`POST /v1/index`** with an at:// link, DID, @handle, https URL, or a bare domain (its `/.well-known/creativeid.jsonld` is read).
- **Jetstream** (`JETSTREAM=on`): creates, edits and deletes arrive live.

Published data is treated as untrusted: values are type-checked and capped at the lexicon limits, documents are limited to 256 KB and 10 s, and a public instance refuses to fetch from private networks.

## Matches ("loops")

Nobody approves anything. A match exists when two parties independently say the same thing:
- **Peer:** A names B, and B names A.
- **Work:** someone (a venue, a gallery) points at a work in another person's repository. If they pinned the work's version (CID) and the work has since been edited, the directory says so.

Matches are reported as plain facts. There are no badges or scores, and a one-sided claim is shown as "only their side so far", which is normal.

## API

Read-only routes allow any origin (CORS).

| Endpoint | |
| --- | --- |
| `GET /v1/personas?q=&discipline=&based=&protocol=&limit=&offset=` | Search, with counts of works, connections and matches |
| `GET /v1/personas/:id` | `:id` = index id, DID, handle, document URL or domain. `?resolve=true` fetches it if not indexed yet |
| `GET /v1/personas/:id/works` | Works, each with its matches |
| `GET /v1/personas/:id/connections` | `{ outgoing, incoming }` |
| `GET /v1/personas/:id/loops` | Every match involving them |
| `GET /v1/works/:uri` | One work, its persona and its matches |
| `GET /v1/disciplines` | Disciplines in use, most common first |
| `GET /v1/stats` | Counts by record type, protocol and match type |
| `POST /v1/index` | `{ uri, sourceType?, pdsUrl?, handle? }`: fetch and (re)index one persona |
| `POST /v1/jetstream/event` | Apply one Jetstream commit (for bridges and tests) |
| `POST /v1/seed` | Load the fictional demo personas |

## Development

```bash
npm test           # parsing, fetching, matches, the index, Jetstream, API
npm run typecheck
npm run build
```

`test/fixtures/` holds a persona exactly as the studio publishes it (JSON-LD, Turtle and AT Protocol records), regenerated from the studio's own code, so the two can't drift silently.
