# CreativeID Aggregator: scope (v2)

*Updated 2026-10-20 (M6–M7). The v1 scope (one name + bio record, `/v1/artists`) is in the git history at tag `v0.1.0-creative-passport`.*

## Purpose

An open directory of creative personas published with CreativeID: something a festival, venue, funder or another app can search and query, and anyone can run. It reads what people published and never asks them for anything.

## In scope (built)

- **Indexes** personas, works and connections from AT Protocol (`com.cultureblocs.creative.*`), Solid Pods and personal websites (`/.well-known/creativeid.jsonld`), as JSON-LD or Turtle.
- **Gets data** by ping on publish (`POST /v1/index`), live AT Protocol changes (Jetstream, opt-in) and on-demand look-up.
- **Computes matches** between independent claims (peer and work), including "changed since confirmed".
- **Search** by words, discipline, place and protocol; persona, work, connection and match endpoints; CORS for read-only routes.
- **Directory page** for people (search, persona pages, adding a persona) and an API list for developers.
- **Fictional demo data** that shows every kind of match.
- **Safety:** untrusted-input normalisation, size and time limits, no private-network fetches on public instances.

## Out of scope

- **Accounts, logins or editing.** A persona is changed only by its owner, at the source.
- **Verification, scores, badges or rankings** beyond plain-text matches.
- **Private data** of any kind: it only sees what was published publicly.
- **Being the source of truth.** It's a cache; deleting the index loses nothing.
- **Payments, rights registration or institutional identity** (later roadmap phases, and other services).

## Next candidates

SQLite storage · conditional re-polling of files · merging the same persona across protocols · a `<cultureblocs-persona>` embed fed by `/v1/personas/:id` · folding into the CultureBlocs AppView.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and [README.md](README.md) for running it and the API.
