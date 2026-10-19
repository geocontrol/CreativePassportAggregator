/**
 * Persistent Artist Index & Full-Text Search Engine (`src/indexer.ts`)
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildNormalizedArtist } from "./resolver.js";
import {
  IndexedArtist,
  SearchQuery,
  SearchResult,
  SourceProtocol,
} from "./types.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@._:-]+/)
    .filter((t) => t.length > 0);
}

/**
 * Computes relevance score for a query against an IndexedArtist.
 * Higher weight on name/handle/DID matches, followed by biography keyword matches.
 */
function scoreArtist(artist: IndexedArtist, queryTokens: string[], rawQuery: string): number {
  if (queryTokens.length === 0) return 1;

  const lowerName = artist.name.toLowerCase();
  const lowerBio = artist.biography.toLowerCase();
  const lowerHandle = (artist.handle || "").toLowerCase();
  const lowerDid = (artist.did || "").toLowerCase();
  const lowerUri = artist.sourceUri.toLowerCase();
  const lowerRaw = rawQuery.toLowerCase().trim();

  // Exact identifier or phrase boost
  let score = 0;
  if (lowerName === lowerRaw || lowerHandle === lowerRaw || lowerDid === lowerRaw) {
    score += 100;
  } else if (lowerName.includes(lowerRaw)) {
    score += 40;
  } else if (lowerBio.includes(lowerRaw)) {
    score += 20;
  }

  for (const token of queryTokens) {
    let matchedToken = false;
    if (lowerName.includes(token)) {
      score += 15;
      matchedToken = true;
    }
    if (lowerHandle.includes(token) || lowerDid.includes(token)) {
      score += 12;
      matchedToken = true;
    }
    if (lowerBio.includes(token)) {
      score += 5;
      matchedToken = true;
    }
    if (lowerUri.includes(token)) {
      score += 4;
      matchedToken = true;
    }
    // Require all query tokens to match at least one field (AND semantics)
    if (!matchedToken) {
      return 0;
    }
  }

  return score;
}

export class ArtistIndexStore {
  public readonly filePath: string;
  private artists = new Map<string, IndexedArtist>();
  private loaded = false;

  constructor(filePath: string = resolve(process.cwd(), "data/index.json")) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as IndexedArtist[];
      this.artists.clear();
      for (const item of parsed) {
        this.artists.set(item.id, item);
      }
    } catch (err: unknown) {
      if (
        !(
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code?: string }).code === "ENOENT"
        )
      ) {
        throw err;
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const list = Array.from(this.artists.values());
    await writeFile(tmpPath, JSON.stringify(list, null, 2) + "\n", "utf8");
    await rename(tmpPath, this.filePath);
  }

  async upsert(artist: IndexedArtist): Promise<IndexedArtist> {
    await this.init();
    this.artists.set(artist.id, artist);
    await this.persist();
    return artist;
  }

  async remove(idOrDidOrUri: string): Promise<boolean> {
    await this.init();
    const target = await this.findByIdentifier(idOrDidOrUri);
    if (!target) return false;
    this.artists.delete(target.id);
    await this.persist();
    return true;
  }

  async findByIdentifier(identifier: string): Promise<IndexedArtist | null> {
    await this.init();
    const clean = identifier.trim().toLowerCase();
    for (const artist of this.artists.values()) {
      if (
        artist.id.toLowerCase() === clean ||
        artist.did?.toLowerCase() === clean ||
        artist.handle?.toLowerCase() === clean ||
        artist.sourceUri.toLowerCase() === clean ||
        artist.subjectId?.toLowerCase() === clean
      ) {
        return artist;
      }
    }
    return null;
  }

  async search(query: SearchQuery = {}): Promise<SearchResult> {
    await this.init();
    const q = (query.q ?? "").trim();
    const tokens = tokenize(q);
    const protocolFilter = query.protocol;
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const scored: Array<{ artist: IndexedArtist; score: number }> = [];

    for (const artist of this.artists.values()) {
      if (protocolFilter && artist.protocol !== protocolFilter) {
        continue;
      }
      const score = scoreArtist(artist, tokens, q);
      if (score > 0) {
        scored.push({ artist, score });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.artist.updatedAt.localeCompare(a.artist.updatedAt);
    });

    const total = scored.length;
    const results = scored.slice(offset, offset + limit).map((s) => s.artist);

    return {
      total,
      limit,
      offset,
      query: q,
      protocol: protocolFilter,
      results,
    };
  }

  async stats(): Promise<{
    total: number;
    byProtocol: Record<SourceProtocol, number>;
    lastIndexedAt: string | null;
  }> {
    await this.init();
    const byProtocol: Record<SourceProtocol, number> = {
      atproto: 0,
      solid: 0,
      static: 0,
    };
    let lastIndexedAt: string | null = null;

    for (const artist of this.artists.values()) {
      byProtocol[artist.protocol]++;
      if (!lastIndexedAt || artist.indexedAt > lastIndexedAt) {
        lastIndexedAt = artist.indexedAt;
      }
    }

    return {
      total: this.artists.size,
      byProtocol,
      lastIndexedAt,
    };
  }

  /**
   * Seeds realistic multi-protocol artist records for demo and evaluation.
   */
  async seedDemoArtists(now: Date = new Date()): Promise<IndexedArtist[]> {
    await this.init();
    const demos: IndexedArtist[] = [
      buildNormalizedArtist({
        name: "Daphne Oram",
        biography:
          "Electronic composer, co-founder of the BBC Radiophonic Workshop, and creator of the Oramics drawn-sound synthesizer technique.",
        protocol: "atproto",
        sourceUri:
          "at://did:plc:euroskydaphneoram/org.creativepassport.actor.persona/self",
        httpEndpoint:
          "https://eurosky.social/xrpc/com.atproto.repo.getRecord?repo=did:plc:euroskydaphneoram&collection=org.creativepassport.actor.persona&rkey=self",
        did: "did:plc:euroskydaphneoram",
        handle: "daphne.eurosky.social",
        cid: "bafyreieuroskydaphne001",
        updatedAt: "2026-10-16T14:20:00.000Z",
        now,
      }),
      buildNormalizedArtist({
        name: "Brian Eno",
        biography:
          "Musician, producer, and visual artist exploring generative music, ambient soundscapes, and Oblique Strategies.",
        protocol: "atproto",
        sourceUri:
          "at://did:plc:bskybrianeno77/org.creativepassport.actor.persona/self",
        httpEndpoint:
          "https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=did:plc:bskybrianeno77&collection=org.creativepassport.actor.persona&rkey=self",
        did: "did:plc:bskybrianeno77",
        handle: "brianeno.bsky.social",
        cid: "bafyreibskybrianeno77",
        updatedAt: "2026-10-17T09:15:00.000Z",
        now,
      }),
      buildNormalizedArtist({
        name: "Vera Molnár",
        biography:
          "Pioneer of computer art and generative plotter drawings based on geometric abstraction and algorithmic permutations.",
        protocol: "solid",
        sourceUri: "https://veramolnar.solidweb.me/public/creativeid.ttl#me",
        httpEndpoint: "https://veramolnar.solidweb.me/public/creativeid.ttl",
        subjectId: "https://veramolnar.solidweb.me/public/creativeid.ttl#me",
        updatedAt: "2026-10-15T18:00:00.000Z",
        now,
      }),
      buildNormalizedArtist({
        name: "Ryoji Ikeda",
        biography:
          " audiovisual artist and electronic composer focusing on the essential characteristics of sound and light through mathematical precision.",
        protocol: "solid",
        sourceUri: "https://ikeda.solidcommunity.net/public/creativeid.jsonld#me",
        httpEndpoint: "https://ikeda.solidcommunity.net/public/creativeid.jsonld",
        subjectId: "https://ikeda.solidcommunity.net/public/creativeid.jsonld#me",
        updatedAt: "2026-10-17T11:30:00.000Z",
        now,
      }),
      buildNormalizedArtist({
        name: "Suzanne Ciani",
        biography:
          "Five-time Grammy-nominated composer, quadraphonic Buchla modular synthesizer pioneer, and sound designer.",
        protocol: "static",
        sourceUri:
          "https://sevwave.example.org/.well-known/creativeid.jsonld#me",
        httpEndpoint:
          "https://sevwave.example.org/.well-known/creativeid.jsonld",
        subjectId:
          "https://sevwave.example.org/.well-known/creativeid.jsonld#me",
        updatedAt: "2026-10-17T12:45:00.000Z",
        now,
      }),
    ];

    for (const artist of demos) {
      this.artists.set(artist.id, artist);
    }
    await this.persist();
    return demos;
  }
}
