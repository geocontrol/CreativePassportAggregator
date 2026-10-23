import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

import {
  createAggregatorServer,
  guardFetch,
  IndexStore,
  isPrivateAddress,
  isPrivateHost,
  LookupFn,
  PrivateNetworkError,
} from "../src/index.js";

/** A fake DNS: name → addresses. Unknown names resolve to a public address. */
const fakeDns =
  (table: Record<string, string[]>): LookupFn =>
  async (host) =>
    (table[host] ?? ["93.184.215.14"]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

/** A fetch double that records the URLs it was asked for. */
function recordingFetch(respond: (url: string) => Response = () => Response.json({ ok: true })) {
  const calls: string[] = [];
  const f = (async (input: string | URL) => {
    calls.push(String(input));
    return respond(String(input));
  }) as typeof fetch;
  return { f, calls };
}

describe("netguard · addresses", () => {
  it("refuses loopback, private, link-local, CGNAT, reserved and multicast IPv4", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      assert.ok(isPrivateAddress(ip), ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "93.184.215.14", "100.128.0.1"]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it("refuses private IPv6, including IPv4-mapped and -compatible forms", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "[::ffff:10.0.0.1]", "64:ff9b::a9fe:a9fe"]) {
      assert.ok(isPrivateAddress(ip), ip);
    }
    for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it("refuses anything that isn't an IP address", () => {
    assert.ok(isPrivateAddress("not-an-ip"));
  });
});

describe("netguard · identifiers (name-only pre-check)", () => {
  it("catches did:web, mapped IPv6 and non-canonical IPv4 identifiers", () => {
    for (const h of ["did:web:127.0.0.1", "did:web:localhost%3A3400", "[::ffff:127.0.0.1]", "https://[::]/x", "0x7f.1", "2130706433", "１２７.０.０.１", "at://did:web:10.0.0.1/col/rkey", "metadata.internal"]) {
      assert.ok(isPrivateHost(h), h);
    }
  });

  it("lets public identifiers and did:plc through", () => {
    for (const h of ["did:plc:abc123", "at://did:plc:abc/col/rkey", "@ama.example", "did:web:ama.example", "https://bsky.social"]) {
      assert.equal(isPrivateHost(h), false, h);
    }
  });

  it("fails closed on input it cannot parse", () => {
    assert.ok(isPrivateHost("https://exa mple.com"));
  });
});

describe("netguard · guardFetch", () => {
  it("passes public requests through", async () => {
    const { f, calls } = recordingFetch();
    const res = await guardFetch(f, { lookup: fakeDns({}) })("https://ama.example/.well-known/did.json");
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["https://ama.example/.well-known/did.json"]);
  });

  it("refuses a public-looking name that resolves to a private address, before connecting", async () => {
    const { f, calls } = recordingFetch();
    const guarded = guardFetch(f, { lookup: fakeDns({ "evil.example": ["93.184.215.14", "169.254.169.254"] }) });
    await assert.rejects(guarded("https://evil.example/x"), PrivateNetworkError);
    assert.equal(calls.length, 0);
  });

  it("refuses IP-literal and non-http targets", async () => {
    const { f, calls } = recordingFetch();
    const guarded = guardFetch(f, { lookup: fakeDns({}) });
    for (const u of ["http://127.0.0.1:9/", "http://[::ffff:127.0.0.1]/", "http://0x7f.1/", "file:///etc/passwd", "http://localhost/"]) {
      await assert.rejects(guarded(u), PrivateNetworkError, u);
    }
    assert.equal(calls.length, 0);
  });

  it("re-checks every redirect hop", async () => {
    const { f, calls } = recordingFetch((url) =>
      url.startsWith("https://hop.example") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }) : Response.json({})
    );
    await assert.rejects(guardFetch(f, { lookup: fakeDns({}) })("https://hop.example/start"), PrivateNetworkError);
    assert.deepEqual(calls, ["https://hop.example/start"], "the metadata endpoint is never requested");
  });

  it("follows safe redirects, up to a limit", async () => {
    const { f } = recordingFetch((url) =>
      url.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : Response.json({ at: url })
    );
    const res = await guardFetch(f, { lookup: fakeDns({}) })("https://ok.example/a");
    assert.deepEqual(await res.json(), { at: "https://ok.example/b" });

    const { f: loop } = recordingFetch(() => new Response(null, { status: 302, headers: { location: "/again" } }));
    await assert.rejects(guardFetch(loop, { lookup: fakeDns({}) })("https://loop.example/"), /Too many redirects/);
  });
});

describe("netguard · public index API", () => {
  let dir: string;
  let server: Server;
  let base: string;
  const network = recordingFetch();

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-guard-"));
    server = createAggregatorServer({
      store: new IndexStore(join(dir, "index.json")),
      allowPrivateHosts: false,
      fetchImpl: network.f,
      lookup: fakeDns({ "rebind.example": ["10.0.0.7"] }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const resolve = (id: string, extra = "") => fetch(`${base}/v1/personas/${encodeURIComponent(id)}?resolve=true${extra}`);

  it("refuses did:web identifiers that point at private hosts", async () => {
    const res = await resolve("did:web:127.0.0.1");
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /private networks/);
  });

  it("refuses a private pdsUrl on the GET route", async () => {
    const res = await resolve("did:plc:someone", `&pdsUrl=${encodeURIComponent("http://169.254.169.254")}`);
    assert.equal(res.status, 400);
  });

  it("refuses names that resolve to private addresses, on GET and POST", async () => {
    assert.equal((await resolve("rebind.example")).status, 400);
    const post = await fetch(`${base}/v1/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: "https://rebind.example/creativeid.jsonld" }),
    });
    assert.equal(post.status, 400);
    assert.ok(!network.calls.some((u) => u.includes("rebind.example")), "never connected");
  });
});
