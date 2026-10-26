import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

import {
  computeLoops,
  createAggregatorServer,
  demoBundles,
  fromAtprotoRecords,
  fromJsonLd,
  fromTurtle,
  IndexStore,
  isPrivateHost,
  jetstreamUrl,
  Loop,
  NSID,
  PersonaBundle,
  resolvePersona,
  SocketLike,
  startJetstream,
} from "../src/index.js";

const FIX = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIX), "utf8");
const NOW = new Date("2026-10-20T12:00:00Z");

/** Everything about a bundle except where it came from, for comparing formats. */
function essence(b: PersonaBundle) {
  const { id, protocol, sourceUri, httpEndpoint, did, handle, pdsUrl, cid, etag, indexedAt, updatedAt, ...persona } = b.persona;
  const strip = <T extends object>(o: T) => {
    const { uri, cid, personaId, did, indexedAt, ...rest } = o as Record<string, unknown>;
    return rest;
  };
  return { persona, works: b.works.map(strip), connections: b.connections.map(strip) };
}

describe("M6 · reading what the studio publishes", () => {
  it("JSON-LD: profile, works and both kinds of connection", async () => {
    const b = fromJsonLd(await fixture("studio-persona.jsonld"), { protocol: "static", docUrl: "https://elsewhere.example/x.jsonld", now: NOW });
    assert.equal(b.persona.name, 'Ama "Lighthouse" Owusu');
    assert.equal(b.persona.bio, "Lighting designer and performer.\nWorks across theatre, dance & installation — 光.");
    assert.deepEqual(b.persona.disciplines, ["lighting design", "performance"]);
    assert.deepEqual(b.persona.based, { name: "Peckham, London" });
    assert.deepEqual(b.persona.links, [{ uri: "https://ama.example", title: "Portfolio" }]);
    assert.deepEqual(b.persona.externalIds, [{ scheme: "isni", id: "0000 0004 1234 5678" }]);
    assert.equal(b.persona.sourceUri, "https://ama.example/.well-known/creativeid.jsonld#me", "@base wins over the fetch URL");
    assert.deepEqual(b.works.map((w) => w.title), ["Tidal", "Night Shift"]);
    assert.deepEqual(b.works[0].credits[1], { name: "Kofi", did: "did:plc:kofi123", role: "sound" });
    assert.equal(b.works[0].uri, "https://ama.example/.well-known/creativeid.jsonld#work-3lwkfixtidal2");
    assert.deepEqual(b.connections.map((c) => c.subject), [
      { did: "did:plc:venue456", name: "Larkfield Rooms" },
      { uri: "at://did:plc:gallery/com.cultureblocs.creative.work/3l4k2jxyz2222", cid: "bafyreiexamplecid" },
    ]);
  });

  it("JSON-LD without a base resolves against where it was fetched", async () => {
    const b = fromJsonLd(await fixture("studio-persona-relative.jsonld"), { protocol: "static", docUrl: "https://ama.example/.well-known/creativeid.jsonld" });
    assert.equal(b.persona.sourceUri, "https://ama.example/.well-known/creativeid.jsonld#me");
  });

  it("Turtle and ATProto records give exactly the same persona as JSON-LD", async () => {
    const fromJson = fromJsonLd(await fixture("studio-persona.jsonld"), { protocol: "static", docUrl: "https://ama.example/x", now: NOW });
    const fromTtl = fromTurtle(await fixture("studio-persona.ttl"), { protocol: "solid", docUrl: "https://ama.solid.example/public/creativeid.ttl", now: NOW });
    const records = JSON.parse(await fixture("studio-records.json")) as { collection: string; rkey: string; record: Record<string, unknown> }[];
    const did = "did:plc:ama";
    const rec = (r: (typeof records)[number]) => ({ uri: `at://${did}/${r.collection}/${r.rkey}`, cid: `cid-${r.rkey}`, value: r.record });
    const fromAt = fromAtprotoRecords(
      {
        did,
        profile: rec(records.find((r) => r.collection === NSID.profile)!),
        works: records.filter((r) => r.collection === NSID.work).map(rec),
        connections: records.filter((r) => r.collection === NSID.connection).map(rec),
      },
      NOW
    );
    // The records carry createdAt; the graph carries dateCreated — same value.
    assert.deepEqual(essence(fromTtl), essence(fromJson));
    assert.deepEqual(essence(fromAt), essence(fromJson));
  });

  it("treats published data as untrusted", () => {
    const b = fromJsonLd(
      JSON.stringify({
        "@graph": [
          {
            "@id": "#me",
            "@type": "Person",
            name: "N".repeat(500),
            description: 42,
            knowsAbout: ["ok", { evil: true }, "", "x".repeat(100)],
            "creativeid:links": [{ url: "javascript alert(1)" }, { url: "https://fine.example" }],
            identifier: [{ propertyID: "isni" }],
          },
          { "@id": "#work-a", "@type": "CreativeWork" },
          { "@id": "#claim-a", "@type": "creativeid:Connection", "creativeid:subject": { "creativeid:did": "not-a-did" }, "creativeid:relationship": "x" },
        ],
      }),
      { protocol: "static", docUrl: "https://x.example/p.jsonld" }
    );
    assert.equal([...new Intl.Segmenter().segment(b.persona.name)].length, 300);
    assert.equal(b.persona.bio, undefined);
    assert.deepEqual(b.persona.disciplines, ["ok", "x".repeat(64)]);
    assert.deepEqual(b.persona.links, [{ uri: "https://fine.example" }]);
    assert.deepEqual(b.persona.externalIds, []);
    assert.deepEqual([b.works.length, b.connections.length], [0, 0], "malformed records dropped, not fatal");
    assert.throws(() => fromJsonLd(JSON.stringify({ "@graph": [{ "@type": "Person" }] }), { protocol: "static", docUrl: "https://x.example" }), /No CreativeID profile/);
  });
});

describe("M6 · fetching personas", () => {
  const records = (rkeys: string[], collection: string, did: string) =>
    rkeys.map((rkey) => ({ uri: `at://${did}/${collection}/${rkey}`, cid: `cid${rkey}`, value: collection === NSID.work ? { $type: collection, title: `Work ${rkey}`, createdAt: "2026-10-01T00:00:00Z" } : { $type: collection, subject: { did: "did:plc:x" }, relationship: "performed", createdAt: "2026-10-01T00:00:00Z" } }));

  const network: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...headers } });
    if (url.href === "https://ama.example/.well-known/atproto-did") return new Response("did:plc:ama");
    if (url.href === "https://plc.directory/did:plc:ama") {
      return json({ alsoKnownAs: ["at://ama.example"], service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }] });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
      return url.searchParams.get("repo") === "did:plc:ama"
        ? json({ uri: "at://did:plc:ama/com.cultureblocs.creative.profile/self", cid: "cidprofile", value: { $type: NSID.profile, name: "Ama", disciplines: ["lighting design"], createdAt: "2026-09-01T00:00:00Z" } })
        : json({ error: "RecordNotFound" }, 400);
    }
    if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
      const c = url.searchParams.get("collection")!;
      if (c === NSID.work) {
        return url.searchParams.get("cursor") === "p2"
          ? json({ records: records(["w3"], c, "did:plc:ama") })
          : json({ records: records(["w1", "w2"], c, "did:plc:ama"), cursor: "p2" });
      }
      return json({ records: records(["c1"], c, "did:plc:ama") });
    }
    if (url.href === "https://tomas.example/.well-known/creativeid.jsonld") {
      return json(await fixture("studio-persona-relative.jsonld"), 200, { ETag: '"v1"' });
    }
    if (url.href === "https://mira.solid.example/public/creativeid.ttl") {
      return new Response(await fixture("studio-persona.ttl"), { headers: { "Content-Type": "text/turtle" } });
    }
    if (url.href === "https://huge.example/.well-known/creativeid.jsonld") return json("x".repeat(300 * 1024));
    return json({ error: "unexpected" }, 404);
  };

  it("ATProto by handle: finds the DID and PDS, reads every page of records", async () => {
    const b = await resolvePersona({ uri: "@ama.example" }, { fetchImpl: network, now: NOW });
    assert.equal(b.persona.did, "did:plc:ama");
    assert.equal(b.persona.handle, "ama.example");
    assert.equal(b.persona.pdsUrl, "https://pds.example");
    assert.deepEqual(b.works.map((w) => w.title), ["Work w1", "Work w2", "Work w3"]);
    assert.equal(b.connections.length, 1);
  });

  it("ATProto by any at:// link from the account", async () => {
    const b = await resolvePersona({ uri: "at://did:plc:ama/com.cultureblocs.creative.work/w1" }, { fetchImpl: network });
    assert.equal(b.persona.name, "Ama");
  });

  it("explains an account without a CreativeID profile", async () => {
    await assert.rejects(
      resolvePersona({ uri: "did:plc:nobody", pdsUrl: "https://pds.example" }, { fetchImpl: network }),
      /hasn't published a CreativeID profile/
    );
  });

  it("a bare domain means its /.well-known/creativeid.jsonld", async () => {
    const b = await resolvePersona({ uri: "tomas.example" }, { fetchImpl: network });
    assert.equal(b.persona.protocol, "static");
    assert.equal(b.persona.etag, '"v1"');
    assert.equal(b.persona.sourceUri, "https://tomas.example/.well-known/creativeid.jsonld#me");
    assert.equal(b.works.length, 2);
  });

  it("Solid Turtle, and a size limit on documents", async () => {
    const b = await resolvePersona({ uri: "https://mira.solid.example/public/creativeid.ttl" }, { fetchImpl: network });
    assert.equal(b.persona.protocol, "solid");
    assert.equal(b.connections.length, 2);
    await assert.rejects(resolvePersona({ uri: "huge.example" }, { fetchImpl: network }), /too large/);
  });
});

describe("M6 · loops", () => {
  const loops = computeLoops({
    personas: demoBundles(NOW).map((b) => b.persona),
    works: new Map(demoBundles(NOW).flatMap((b) => b.works).map((w) => [w.uri, w])),
    connections: demoBundles(NOW).flatMap((b) => b.connections),
  });
  const work = (title: string) => loops.find((l): l is Extract<Loop, { type: "work" }> => l.type === "work" && l.workTitle === title)!;

  it("finds the peer loop once, with both sides of the story", () => {
    const peers = loops.filter((l): l is Extract<Loop, { type: "peer" }> => l.type === "peer");
    assert.equal(peers.length, 1);
    const names = [peers[0].a.name, peers[0].b.name].sort();
    assert.deepEqual(names, ["Ama Owusu", "Saltmarsh Collective"]);
    assert.deepEqual([peers[0].aSays.relationship, peers[0].bSays.relationship].sort(), ["collaborated_on", "member_of"]);
  });

  it("a venue confirming a work, pinned to its current version", () => {
    const tidal = work("Tidal");
    assert.equal(tidal.attester.name, "Larkfield Rooms");
    assert.equal(tidal.creator.name, "Ama Owusu");
    assert.deepEqual([tidal.pinned, tidal.changedSinceAttested], [true, false]);
  });

  it("says when a work changed after it was confirmed", () => {
    assert.deepEqual([work("Night Shift").pinned, work("Night Shift").changedSinceAttested], [true, true]);
  });

  it("one-way claims are not loops (and that's normal)", () => {
    assert.equal(loops.length, 3);
    assert.equal(loops.some((l) => l.type === "peer" && [l.a.name, l.b.name].includes("Mira Sato")), false);
  });
});

describe("M6 · the index", () => {
  let dir: string;
  let store: IndexStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-agg-"));
    store = new IndexStore(join(dir, "index.json"));
    for (const b of demoBundles(NOW)) await store.upsertBundle(b);
  });

  it("finds personas by handle, DID, domain or document URL", async () => {
    assert.equal((await store.find("@ama-owusu.example"))?.name, "Ama Owusu");
    assert.equal((await store.find("did:plc:demosaltmarsh"))?.name, "Saltmarsh Collective");
    assert.equal((await store.find("tomas-reyes.example"))?.name, "Tomás Reyes");
    assert.equal((await store.find("https://mira-sato.solid.example/public/creativeid.ttl"))?.name, "Mira Sato");
  });

  it("searches by words, discipline, place and protocol", async () => {
    const names = async (q: Parameters<IndexStore["search"]>[0]) => (await store.search(q)).results.map((r) => r.name).sort();
    assert.deepEqual(await names({ discipline: "sound" }), ["Saltmarsh Collective", "Tomás Reyes"]);
    assert.deepEqual(await names({ based: "glasgow" }), ["Larkfield Rooms"]);
    assert.deepEqual(await names({ protocol: "solid" }), ["Mira Sato"]);
    assert.deepEqual(await names({ q: "tidal coast" }), ["Saltmarsh Collective"]);
    assert.deepEqual(await names({ q: "tomás" }), ["Tomás Reyes"], "accented words");
    const ama = (await store.search({ q: "ama" })).results[0];
    assert.deepEqual(ama.counts, { works: 2, connections: 2, loops: 3 });
  });

  it("re-indexing replaces a persona's records: deleted at source means deleted here", async () => {
    const [ama] = demoBundles(NOW);
    await store.upsertBundle({ ...ama, works: ama.works.slice(0, 1) });
    assert.deepEqual((await store.worksOf(ama.persona.id)).map((w) => w.title), ["Tidal"]);
    assert.equal((await store.stats()).loops.work, 1, "the loop on the removed work is gone too");
  });

  it("applies Jetstream commits: create, update and delete", async () => {
    const did = "did:plc:demoamaowusu";
    const commit = (operation: "create" | "update" | "delete", collection: string, rkey: string, record?: object) =>
      store.applyCommit({ did, kind: "commit", commit: { operation, collection, rkey, cid: `cid-${operation}`, record: record as Record<string, unknown> } }, NOW);
    assert.deepEqual(await commit("create", NSID.work, "new1", { title: "Undertow", createdAt: "2026-10-20T00:00:00Z" }), { applied: true });
    assert.equal((await store.worksOf((await store.find(did))!.id)).length, 3);
    await commit("update", NSID.profile, "self", { name: "Ama Owusu", disciplines: ["lighting design"], createdAt: "2026-09-02T10:00:00.000Z" });
    assert.deepEqual((await store.find(did))!.disciplines, ["lighting design"]);
    assert.equal((await store.find(did))!.handle, "ama-owusu.example", "handle survives a profile update");
    await commit("delete", NSID.work, "new1");
    assert.equal((await store.worksOf((await store.find(did))!.id)).length, 2);
    assert.equal((await commit("create", "app.bsky.feed.post", "x", { text: "hi" })).applied, false);
    await commit("delete", NSID.profile, "self");
    assert.equal(await store.find(did), null);
    assert.equal((await store.stats()).works, 3, "only the other personas' works remain");
  });

  it("persists, and sets aside a v1 index file instead of misreading it", async () => {
    const reopened = new IndexStore(join(dir, "index.json"));
    assert.equal((await reopened.stats()).personas, 5);
    const v1Path = join(dir, "old.json");
    await writeFile(v1Path, JSON.stringify([{ id: "pers_atproto_x", name: "Old" }]));
    const old = new IndexStore(v1Path);
    assert.equal((await old.stats()).personas, 0);
    await access(`${v1Path}.v1.bak`);
  });
});

describe("M6 · Jetstream listener", () => {
  it("subscribes to the creative collections, applies events, saves a cursor and reconnects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "creativeid-js-"));
    const store = new IndexStore(join(dir, "index.json"));
    const sockets: { url: string; s: SocketLike }[] = [];
    const js = startJetstream(store, {
      endpoint: "wss://jetstream.test/subscribe",
      cursorFile: join(dir, "cursor"),
      initialDelay: 5,
      log: () => undefined,
      backfill: false,
      createSocket: (url) => {
        const s: SocketLike = { onopen: null, onmessage: null, onclose: null, onerror: null, close: () => s.onclose?.({}) };
        sockets.push({ url, s });
        return s;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sockets[0].url, jetstreamUrl("wss://jetstream.test/subscribe"));
    assert.match(sockets[0].url, /wantedCollections=com\.cultureblocs\.creative\.profile&wantedCollections=com\.cultureblocs\.creative\.work/);
    const send = (o: unknown) => sockets.at(-1)!.s.onmessage?.({ data: JSON.stringify(o) });
    send({ did: "did:plc:live", time_us: 1_800_000_000_000_000, kind: "commit", commit: { operation: "create", collection: NSID.profile, rkey: "self", cid: "c1", record: { name: "Live Persona" } } });
    send({ did: "did:plc:live", time_us: 1_800_000_010_000_000, kind: "identity", identity: { did: "did:plc:live", handle: "live.example" } });
    send("not json");
    await js.idle();
    assert.equal((await store.find("live.example"))?.name, "Live Persona");
    assert.equal(await readFile(join(dir, "cursor"), "utf8"), "1800000010000000");

    sockets[0].s.onclose?.({});
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sockets.length, 2, "reconnected");
    assert.match(sockets[1].url, /cursor=1800000005000000/, "rewinds 5 s");
    js.stop();
  });
});

describe("Jetstream · reading a new account whole", () => {
  it("the first event from an unknown account reads its whole persona, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "creativeid-js-bf-"));
    const store = new IndexStore(join(dir, "index.json"));
    const DID = "did:plc:easelartist";
    const asked: string[] = [];
    let socket: SocketLike | undefined;
    const js = startJetstream(store, {
      endpoint: "wss://jetstream.test/subscribe",
      log: () => undefined,
      backfill: async (did) => {
        asked.push(did);
        const at = (c: string, k: string) => `at://${did}/${c}/${k}`;
        const now = "2026-10-26T19:00:00.000Z";
        return {
          persona: { id: `pers_atproto_x`, protocol: "atproto", did, name: "Mark Simpkins", disciplines: [], links: [], externalIds: [], source: at(NSID.profile, "self"), indexedAt: now } as never,
          works: [
            { uri: at(NSID.work, "jox7cmxrmd7cbo4u"), cid: "w1", personaId: "pers_atproto_x", did, title: "Reality Towards Enemy", indexedAt: now } as never,
            { uri: at(NSID.work, "gzbjlafmhnzs5xzu"), cid: "w2", personaId: "pers_atproto_x", did, title: "untitled", indexedAt: now } as never,
          ],
          connections: [],
        };
      },
      createSocket: () => {
        socket = { onopen: null, onmessage: null, onclose: null, onerror: null, close: () => undefined };
        return socket;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    const send = (o: unknown) => socket!.onmessage?.({ data: JSON.stringify(o) });
    const profile = { did: DID, time_us: 1, kind: "commit", commit: { operation: "update", collection: NSID.profile, rkey: "self", cid: "p2", record: { name: "Mark Simpkins" } } };
    send(profile);
    send({ ...profile, time_us: 2, commit: { ...profile.commit, cid: "p3" } });
    await js.idle();
    assert.deepEqual(asked, [DID], "read once, not on every event");
    assert.equal(store["works"].size, 2);
    js.stop();
  });
});

describe("M6 · API", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let open: Server;
  let openBase: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-api-"));
    const store = new IndexStore(join(dir, "index.json"));
    server = createAggregatorServer({ store, allowPrivateHosts: false });
    open = createAggregatorServer({ store: new IndexStore(join(dir, "open.json")), allowPrivateHosts: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => open.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    openBase = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
    await fetch(`${base}/v1/seed`, { method: "POST" });
  });

  after(async () => {
    for (const s of [server, open]) await new Promise<void>((r) => s.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const get = async (path: string, b = base) => {
    const res = await fetch(`${b}${path}`);
    return { status: res.status, json: (await res.json()) as any, cors: res.headers.get("access-control-allow-origin") };
  };

  it("searches with filters and returns counts", async () => {
    const r = await get("/v1/personas?discipline=installation");
    assert.equal(r.cors, "*");
    assert.deepEqual(r.json.results.map((p: any) => p.name).sort(), ["Ama Owusu", "Saltmarsh Collective"]);
    assert.ok(r.json.results.every((p: any) => p.counts));
    const d = await get("/v1/disciplines");
    assert.deepEqual(d.json.disciplines[0], { discipline: "installation", count: 2 });
  });

  it("a persona, its works with loops, its connections both ways, and its loops", async () => {
    const p = await get("/v1/personas/ama-owusu.example");
    assert.equal(p.json.persona.counts.loops, 3);
    const works = await get("/v1/personas/ama-owusu.example/works");
    const night = works.json.works.find((w: any) => w.title === "Night Shift");
    assert.equal(night.loops[0].changedSinceAttested, true);
    const conns = await get("/v1/personas/did:plc:demoamaowusu/connections");
    assert.deepEqual(conns.json.incoming.map((c: any) => c.relationship), ["collaborated_on"]);
    assert.equal(conns.json.outgoing.length, 2);
    const loops = await get("/v1/personas/saltmarsh.example/loops");
    assert.deepEqual(loops.json.loops.map((l: any) => l.type), ["peer"]);
  });

  it("a single work by its URI", async () => {
    const uri = "at://did:plc:demoamaowusu/com.cultureblocs.creative.work/3lwkdemotidal";
    const w = await get(`/v1/works/${encodeURIComponent(uri)}`);
    assert.equal(w.json.work.title, "Tidal");
    assert.equal(w.json.persona.name, "Ama Owusu");
    assert.equal(w.json.work.loops[0].attester.name, "Larkfield Rooms");
  });

  it("stats and clear errors", async () => {
    const s = await get("/v1/stats");
    assert.deepEqual([s.json.personas, s.json.works, s.json.connections, s.json.loops], [5, 5, 7, { peer: 1, work: 2 }]);
    assert.equal((await get("/v1/personas/nobody.example")).status, 404);
    assert.equal((await get("/v1/artists")).status, 404, "/v1/artists is retired");
  });

  it("a public index refuses to fetch from private networks; a local one allows it", async () => {
    for (const h of ["localhost", "127.0.0.1:3400", "http://10.0.0.5/x", "192.168.1.2", "studio.local", "[::1]"]) assert.ok(isPrivateHost(h), h);
    for (const h of ["ama.example", "https://bsky.social", "172.32.0.1"]) assert.equal(isPrivateHost(h), false, h);
    const post = (b: string) =>
      fetch(`${b}/v1/index`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uri: "http://127.0.0.1:9/nothing.jsonld" }) });
    const refused = await post(base);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as any).error, /private networks/);
    const tried = await post(openBase);
    assert.equal(tried.status, 422, "allowed to try, and reports the fetch failure");
  });
});
