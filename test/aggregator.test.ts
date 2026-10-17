import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

import {
  ArtistIndexStore,
  createAggregatorServer,
  parseJsonLdPersona,
  parseTurtlePersona,
} from "../src/index.js";

describe("Creative Passport Aggregator: Multi-Protocol Resolution, Search, and API", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  const mockFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();

    // 1. Mock ATProto PDS XRPC getRecord
    if (url.includes("/xrpc/com.atproto.repo.getRecord")) {
      return new Response(
        JSON.stringify({
          uri: "at://did:plc:hollyherndon/org.creativepassport.actor.persona/self",
          cid: "bafyreihollyherndon123",
          value: {
            $type: "org.creativepassport.actor.persona",
            name: "Holly Herndon",
            biography:
              "Composer and sound artist exploring vocal AI, decentralized Choirs, and digital identity.",
            updatedAt: "2026-10-17T16:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Mock Solid Pod RDF Turtle endpoint
    if (url === "https://wendycarlos.solidweb.me/public/passport.ttl") {
      const ttl = [
        "@prefix schema: <https://schema.org/> .",
        "@prefix foaf: <http://xmlns.com/foaf/0.1/> .",
        "@prefix cp: <https://creativepassport.org/ns#> .",
        "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
        "",
        "<https://wendycarlos.solidweb.me/public/passport.ttl#me>",
        "  a schema:Person, foaf:Person, cp:CreativePersona ;",
        '  schema:name "Wendy Carlos" ;',
        '  schema:description "Electronic music pioneer, Moog synthesizer virtuoso, and film composer." ;',
        '  schema:dateModified "2026-10-17T16:05:00.000Z"^^xsd:dateTime .',
      ].join("\n");

      return new Response(ttl, {
        status: 200,
        headers: {
          "Content-Type": "text/turtle",
          ETag: '"etag-wendy-1"',
        },
      });
    }

    // 3. Mock Static Domain /.well-known/creative-passport.jsonld
    if (url === "https://aphex.example.org/.well-known/creative-passport.jsonld") {
      return new Response(
        JSON.stringify({
          "@context": { "@vocab": "https://schema.org/" },
          "@id": "https://aphex.example.org/#rdj",
          "@type": ["Person"],
          name: "Richard D. James",
          description: "Electronic musician and custom microtonal synth designer.",
          dateModified: "2026-10-17T16:10:00.000Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/ld+json" },
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  };

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cp-aggregator-test-"));
    const store = new ArtistIndexStore(join(tmpDir, "data", "index.json"));
    server = createAggregatorServer({ store, fetchImpl: mockFetch });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses RDF Turtle and JSON-LD documents accurately", () => {
    const ttl = `
      @prefix schema: <https://schema.org/> .
      <https://example.org/card#me>
        a schema:Person ;
        schema:name "Delia Derbyshire" ;
        schema:description "Sculptor of electronic sound and Doctor Who theme arranger." .
    `;
    const parsedTtl = parseTurtlePersona(ttl, "https://example.org/card#me");
    assert.equal(parsedTtl.name, "Delia Derbyshire");
    assert.match(parsedTtl.biography, /Doctor Who/);

    const jsonLd = JSON.stringify({
      "@id": "#delia",
      name: "Delia Derbyshire",
      description: "Tape manipulation pioneer.",
    });
    const parsedJson = parseJsonLdPersona(jsonLd, "#me");
    assert.equal(parsedJson.name, "Delia Derbyshire");
    assert.equal(parsedJson.subjectId, "#delia");
  });

  it("seeds demo artists and supports full-text search + protocol filtering", async () => {
    const seedRes = await fetch(`${baseUrl}/v1/seed`, { method: "POST" });
    assert.equal(seedRes.status, 200);
    const seedData = (await seedRes.json()) as { seededCount: number };
    assert.equal(seedData.seededCount, 5);

    // Search by keyword "Oramics"
    const searchOram = await fetch(`${baseUrl}/v1/artists?q=Oramics`);
    const oramData = (await searchOram.json()) as {
      total: number;
      results: Array<{ name: string; protocol: string }>;
    };
    assert.equal(oramData.total, 1);
    assert.equal(oramData.results[0].name, "Daphne Oram");
    assert.equal(oramData.results[0].protocol, "atproto");

    // Filter by protocol=solid
    const solidOnly = await fetch(`${baseUrl}/v1/artists?protocol=solid`);
    const solidData = (await solidOnly.json()) as {
      total: number;
      results: Array<{ protocol: string }>;
    };
    assert.equal(solidData.total, 2);
    assert.ok(solidData.results.every((r) => r.protocol === "solid"));
  });

  it("indexes live ATProto, Solid Pod, and Static domain URIs via POST /v1/index", async () => {
    // 1. Index ATProto record
    const atRes = await fetch(`${baseUrl}/v1/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: "at://did:plc:hollyherndon/org.creativepassport.actor.persona/self",
        pdsUrl: "https://eurosky.social",
        handle: "holly.eurosky.social",
      }),
    });
    assert.equal(atRes.status, 200);
    const atBody = (await atRes.json()) as {
      artist: { id: string; name: string; protocol: string; did: string };
    };
    assert.equal(atBody.artist.name, "Holly Herndon");
    assert.equal(atBody.artist.protocol, "atproto");

    // 2. Index Solid Pod Turtle resource
    const solidRes = await fetch(`${baseUrl}/v1/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: "https://wendycarlos.solidweb.me/public/passport.ttl",
      }),
    });
    assert.equal(solidRes.status, 200);
    const solidBody = (await solidRes.json()) as {
      artist: { name: string; protocol: string; etag: string };
    };
    assert.equal(solidBody.artist.name, "Wendy Carlos");
    assert.equal(solidBody.artist.protocol, "solid");
    assert.equal(solidBody.artist.etag, '"etag-wendy-1"');

    // 3. Index Static bare domain via /.well-known/creative-passport.jsonld
    const staticRes = await fetch(`${baseUrl}/v1/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: "aphex.example.org",
        sourceType: "static",
      }),
    });
    assert.equal(staticRes.status, 200);
    const staticBody = (await staticRes.json()) as {
      artist: { name: string; protocol: string };
    };
    assert.equal(staticBody.artist.name, "Richard D. James");
    assert.equal(staticBody.artist.protocol, "static");

    // 4. Lookup by DID via GET /v1/artists/:identifier?view=jsonld
    const lookupRes = await fetch(
      `${baseUrl}/v1/artists/did:plc:hollyherndon?view=jsonld`
    );
    assert.equal(lookupRes.status, 200);
    const jsonLd = (await lookupRes.json()) as {
      name: string;
      "cp:sourceProtocol": string;
    };
    assert.equal(jsonLd.name, "Holly Herndon");
    assert.equal(jsonLd["cp:sourceProtocol"], "atproto");
  });

  it("ingests real-time ATProto Jetstream commit events via POST /v1/jetstream/event", async () => {
    const jetRes = await fetch(`${baseUrl}/v1/jetstream/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: "did:plc:kaitlynaureliasmith",
        handle: "kaitlyn.bsky.social",
        kind: "commit",
        commit: {
          operation: "create",
          collection: "org.creativepassport.actor.persona",
          rkey: "self",
          cid: "bafyreikaitlyn999",
          record: {
            $type: "org.creativepassport.actor.persona",
            name: "Kaitlyn Aurelia Smith",
            biography: "Composer and Buchla synthesizer artist.",
            updatedAt: "2026-10-17T16:30:00.000Z",
          },
        },
      }),
    });
    assert.equal(jetRes.status, 200);

    const verifyRes = await fetch(
      `${baseUrl}/v1/artists/did:plc:kaitlynaureliasmith`
    );
    assert.equal(verifyRes.status, 200);
    const artist = (await verifyRes.json()) as { name: string };
    assert.equal(artist.name, "Kaitlyn Aurelia Smith");
  });
});
