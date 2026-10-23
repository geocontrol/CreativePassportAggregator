/**
 * Outbound-request guard for a public index (`src/netguard.ts`).
 *
 * A public aggregator fetches URLs that strangers choose: handles, did:web
 * hosts, PDS endpoints named in DID documents, `pdsUrl` parameters and the
 * targets of redirects. Checking only the identifier string misses most of
 * those, so the guard sits on `fetch` itself and checks every hop:
 *
 *   1. only http: and https: URLs;
 *   2. the hostname is resolved and EVERY address it resolves to must be
 *      public (loopback, private, link-local, CGNAT, multicast, reserved,
 *      unique-local and IPv4-mapped/compatible IPv6 forms are refused);
 *   3. redirects are followed by hand (at most MAX_REDIRECTS), each one
 *      re-checked before it is requested.
 *
 * Residual risk: the address is checked and then `fetch` resolves the name
 * again, so a hostile DNS server with a zero TTL could still rebind between
 * the two lookups. Closing that fully needs a connect-time lookup hook
 * (an undici Agent with `connect.lookup`).
 */

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export class PrivateNetworkError extends Error {
  constructor(target: string) {
    super(`This index doesn't fetch from private networks (${target}).`);
    this.name = "PrivateNetworkError";
  }
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 (embeds IPv4)
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** The IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d) or -compatible IPv6 address. */
function embeddedIPv4(ip: string): string | null {
  const v = ip.toLowerCase();
  const dotted = v.match(/^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = v.match(/^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True for any address a public index must not connect to. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIPv4(bare);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(bare, "ipv6");
  }
  return true; // not an IP at all: refuse rather than guess
}

/**
 * The host an identifier would make the index contact: null if it names none
 * (e.g. did:plc), undefined if it cannot be parsed.
 */
export function hostOf(raw: string): string | null | undefined {
  const s = raw.trim();
  if (/^did:plc:/i.test(s)) return null;
  const web = s.match(/^did:web:([^#?/]+)/i);
  if (web) {
    // did:web:host%3Aport:path → host (the port is percent-encoded; path segments are colon-separated)
    try {
      return hostOf(`https://${decodeURIComponent(web[1].split(":")[0])}`);
    } catch {
      return undefined;
    }
  }
  const at = s.match(/^at:\/\/([^/?#]+)/i);
  if (at) return /^did:/i.test(at[1]) ? hostOf(at[1]) : at[1];
  const bare = s.replace(/^@/, "");
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? bare : `https://${bare}`);
    return u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined; // unparseable: callers fail closed
  }
}

/**
 * Quick, name-only pre-check for request inputs (no DNS). Fails closed on input
 * it cannot parse. The authoritative check is `guardFetch`, which also covers
 * hosts discovered later (DID documents, redirects).
 */
export function isPrivateHost(raw: string): boolean {
  const host = hostOf(raw);
  if (host === null) return false;
  if (host === undefined || host === "") return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return isIP(host) ? isPrivateAddress(host) : false;
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

async function assertPublic(target: URL, lookup: LookupFn): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new PrivateNetworkError(target.href);
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new PrivateNetworkError(target.host);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new PrivateNetworkError(target.host);
    return;
  }
  const addrs = await lookup(host);
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new PrivateNetworkError(target.host);
}

/**
 * Wrap a fetch so every request, and every redirect it follows, is refused if
 * it would reach a private or reserved address.
 */
export function guardFetch(base: typeof fetch, options: { lookup?: LookupFn } = {}): typeof fetch {
  const lookup = options.lookup ?? defaultLookup;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // The resolvers only ever pass URL strings; refuse Request objects rather than drop their options.
    if (input instanceof Request) throw new TypeError("guardFetch takes a URL, not a Request.");
    let url = new URL(String(input));
    for (let hop = 0; ; hop++) {
      await assertPublic(url, lookup);
      const res = await base(url, { ...init, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url.href}.`);
      await res.body?.cancel().catch(() => undefined);
      url = new URL(location, url);
    }
  };
  return guarded as typeof fetch;
}
