/**
 * The index (`src/indexer.ts`) — M6.
 *
 * Personas, works and connections, persisted as one JSON file
 * (`data/index.json`, written atomically). It is a cache of what creatives
 * published: re-indexing a persona replaces everything the index held for
 * it, and any of it can be rebuilt from the sources.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { connectionFromRecord, makePersonaId, personaFromProfileRecord, workFromRecord } from "./graph.js";
import { computeLoops, loopsForWork, loopsInvolving } from "./loops.js";
import {
  IndexedConnection,
  IndexedPersona,
  IndexedWork,
  JetstreamCommitEvent,
  Loop,
  NSID,
  PersonaBundle,
  PersonaSummary,
  SearchQuery,
  SearchResult,
  SourceProtocol,
} from "./types.js";

interface IndexFile {
  version: 2;
  personas: IndexedPersona[];
  works: IndexedWork[];
  connections: IndexedConnection[];
}

const tokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}@._:-]+/u)
    .filter(Boolean);

export class IndexStore {
  readonly filePath: string;
  private personas = new Map<string, IndexedPersona>();
  private works = new Map<string, IndexedWork>();
  private connections = new Map<string, IndexedConnection>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private loopCache: Loop[] | null = null;

  constructor(filePath: string = resolve(process.cwd(), "data/index.json")) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as IndexFile | unknown[];
      if (Array.isArray(parsed)) {
        // v1 index (one record per "artist"): keep it beside us and start afresh.
        await rename(this.filePath, `${this.filePath}.v1.bak`);
      } else {
        for (const p of parsed.personas ?? []) this.personas.set(p.id, p);
        for (const w of parsed.works ?? []) this.works.set(w.uri, w);
        for (const c of parsed.connections ?? []) this.connections.set(c.uri, c);
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    this.loopCache = null;
    const snapshot: IndexFile = {
      version: 2,
      personas: [...this.personas.values()],
      works: [...this.works.values()],
      connections: [...this.connections.values()],
    };
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      await rename(tmp, this.filePath);
    });
    return this.writing;
  }

  // -------------------------------------------------------------- writes

  /** Replaces everything held for this persona with a freshly fetched copy. */
  async upsertBundle(bundle: PersonaBundle): Promise<PersonaBundle> {
    await this.init();
    this.dropRecordsOf(bundle.persona.id);
    this.personas.set(bundle.persona.id, bundle.persona);
    for (const w of bundle.works) this.works.set(w.uri, w);
    for (const c of bundle.connections) this.connections.set(c.uri, c);
    await this.persist();
    return bundle;
  }

  async removePersona(id: string): Promise<boolean> {
    await this.init();
    if (!this.personas.delete(id)) return false;
    this.dropRecordsOf(id);
    await this.persist();
    return true;
  }

  private dropRecordsOf(personaId: string) {
    for (const [k, w] of this.works) if (w.personaId === personaId) this.works.delete(k);
    for (const [k, c] of this.connections) if (c.personaId === personaId) this.connections.delete(k);
  }

  /**
   * Applies one Jetstream commit. Works and connections from an account
   * whose profile isn't indexed yet are still kept, so they appear the
   * moment the profile does.
   */
  async applyCommit(event: JetstreamCommitEvent, now: Date = new Date()): Promise<{ applied: boolean; reason?: string }> {
    await this.init();
    const c = event.commit;
    if (event.kind !== "commit" || !c) return { applied: false, reason: "Not a commit." };
    if (![NSID.profile, NSID.work, NSID.connection].includes(c.collection as never)) {
      return { applied: false, reason: `Ignored collection ${c.collection}.` };
    }
    const personaId = makePersonaId("atproto", event.did);
    const uri = `at://${event.did}/${c.collection}/${c.rkey}`;

    if (c.operation === "delete") {
      if (c.collection === NSID.profile) await this.removePersona(personaId);
      else {
        this.works.delete(uri);
        this.connections.delete(uri);
        await this.persist();
      }
      return { applied: true };
    }

    const rec = { uri, cid: c.cid, value: c.record ?? {} };
    if (c.collection === NSID.profile) {
      const existing = this.personas.get(personaId);
      const persona = personaFromProfileRecord(rec, { did: event.did, handle: existing?.handle, pdsUrl: existing?.pdsUrl }, now);
      if (!persona) return { applied: false, reason: "Profile has no name." };
      this.personas.set(personaId, persona);
    } else if (c.collection === NSID.work) {
      const work = workFromRecord(rec, personaId, event.did, now);
      if (!work) return { applied: false, reason: "Work has no title." };
      this.works.set(uri, work);
    } else {
      const conn = connectionFromRecord(rec, personaId, event.did, now);
      if (!conn) return { applied: false, reason: "Connection has no subject or relationship." };
      this.connections.set(uri, conn);
    }
    await this.persist();
    return { applied: true };
  }

  /** Records a handle change from a Jetstream identity event. */
  async setHandle(did: string, handle: string | undefined): Promise<void> {
    await this.init();
    const p = this.personas.get(makePersonaId("atproto", did));
    if (p && p.handle !== handle) {
      this.personas.set(p.id, { ...p, handle });
      await this.persist();
    }
  }

  // -------------------------------------------------------------- reads

  /** By index id, DID, handle, profile URI, document URL or (for files) domain. */
  async find(identifier: string): Promise<IndexedPersona | null> {
    await this.init();
    const q = identifier.trim().replace(/^@/, "").toLowerCase();
    for (const p of this.personas.values()) {
      const host = p.httpEndpoint && p.protocol !== "atproto" ? safeHost(p.httpEndpoint) : undefined;
      if (
        [p.id, p.did, p.handle, p.sourceUri, p.httpEndpoint, host].some((v) => v?.toLowerCase() === q) ||
        p.sourceUri.split("#")[0].toLowerCase() === q.split("#")[0]
      ) {
        return p;
      }
    }
    return null;
  }

  async worksOf(personaId: string): Promise<IndexedWork[]> {
    await this.init();
    return [...this.works.values()].filter((w) => w.personaId === personaId);
  }

  async connectionsOf(persona: IndexedPersona): Promise<{ outgoing: IndexedConnection[]; incoming: IndexedConnection[] }> {
    await this.init();
    const all = [...this.connections.values()];
    return {
      outgoing: all.filter((c) => c.personaId === persona.id),
      incoming: persona.did ? all.filter((c) => c.personaId !== persona.id && "did" in c.subject && c.subject.did === persona.did) : [],
    };
  }

  async work(uri: string): Promise<IndexedWork | null> {
    await this.init();
    return this.works.get(uri) ?? null;
  }

  async persona(id: string): Promise<IndexedPersona | null> {
    await this.init();
    return this.personas.get(id) ?? null;
  }

  async loops(): Promise<Loop[]> {
    await this.init();
    this.loopCache ??= computeLoops({ personas: this.personas.values(), works: this.works, connections: this.connections.values() });
    return this.loopCache;
  }

  async loopsFor(persona: IndexedPersona): Promise<Loop[]> {
    return loopsInvolving(await this.loops(), persona);
  }

  async loopsForWork(uri: string): Promise<Loop[]> {
    return loopsForWork(await this.loops(), uri);
  }

  async summarise(p: IndexedPersona): Promise<PersonaSummary> {
    const { outgoing } = await this.connectionsOf(p);
    return {
      ...p,
      counts: { works: (await this.worksOf(p.id)).length, connections: outgoing.length, loops: (await this.loopsFor(p)).length },
    };
  }

  async search(query: SearchQuery = {}): Promise<SearchResult> {
    await this.init();
    const tokens = tokenize(query.q ?? "");
    const discipline = query.discipline?.trim().toLowerCase();
    const based = query.based?.trim().toLowerCase();
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const scored: { p: IndexedPersona; score: number }[] = [];
    for (const p of this.personas.values()) {
      if (query.protocol && p.protocol !== query.protocol) continue;
      if (discipline && !p.disciplines.some((d) => d.toLowerCase().includes(discipline))) continue;
      if (based && !(p.based?.name ?? "").toLowerCase().includes(based)) continue;
      const score = scorePersona(p, tokens);
      if (score > 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
    const page = scored.slice(offset, offset + limit);
    return {
      total: scored.length,
      limit,
      offset,
      query: { ...query, limit, offset },
      results: await Promise.all(page.map(({ p }) => this.summarise(p))),
    };
  }

  /** Disciplines in use, most common first, for filter suggestions. */
  async disciplines(): Promise<{ discipline: string; count: number }[]> {
    await this.init();
    const counts = new Map<string, { label: string; count: number }>();
    for (const p of this.personas.values()) {
      for (const d of p.disciplines) {
        const k = d.toLowerCase();
        const e = counts.get(k) ?? { label: d, count: 0 };
        e.count++;
        counts.set(k, e);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map((e) => ({ discipline: e.label, count: e.count }));
  }

  async stats() {
    await this.init();
    const byProtocol: Record<SourceProtocol, number> = { atproto: 0, solid: 0, static: 0 };
    let lastIndexedAt: string | null = null;
    for (const p of this.personas.values()) {
      byProtocol[p.protocol]++;
      if (!lastIndexedAt || p.indexedAt > lastIndexedAt) lastIndexedAt = p.indexedAt;
    }
    const loops = await this.loops();
    return {
      personas: this.personas.size,
      works: this.works.size,
      connections: this.connections.size,
      loops: { peer: loops.filter((l) => l.type === "peer").length, work: loops.filter((l) => l.type === "work").length },
      byProtocol,
      lastIndexedAt,
    };
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** All query words must match somewhere; names and handles weigh most. */
function scorePersona(p: IndexedPersona, tokens: string[]): number {
  if (!tokens.length) return 1;
  const name = p.name.toLowerCase();
  const ids = `${p.handle ?? ""} ${p.did ?? ""}`.toLowerCase();
  const disciplines = p.disciplines.join(" ").toLowerCase();
  const bio = (p.bio ?? "").toLowerCase();
  const based = (p.based?.name ?? "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    let hit = 0;
    if (name.includes(t)) hit += 15;
    if (ids.includes(t)) hit += 12;
    if (disciplines.includes(t)) hit += 10;
    if (based.includes(t)) hit += 6;
    if (bio.includes(t)) hit += 4;
    if (!hit) return 0;
    score += hit;
  }
  return score;
}
