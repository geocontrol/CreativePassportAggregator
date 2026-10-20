/**
 * Closed loops (`src/loops.ts`) — M6.
 *
 * Nobody approves anything. A loop exists when two parties independently
 * publish matching claims, and any reader can compute it:
 *   peer   A has a connection whose subject is B's DID, and B has one whose
 *          subject is A's DID
 *   work   X has a connection pointing at a work record in Y's repository
 *          (X ≠ Y). If X pinned the work's CID and the work has changed
 *          since, the loop says so.
 * Loops are reported as facts, never as scores or badges.
 */

import { IndexedConnection, IndexedPersona, IndexedWork, Loop, NSID, PartyRef } from "./types.js";

export interface IndexSnapshot {
  personas: Iterable<IndexedPersona>;
  works: Map<string, IndexedWork>;
  connections: Iterable<IndexedConnection>;
}

const WORK_URI = new RegExp(`^at://([^/]+)/${NSID.work.replace(/\./g, "\\.")}/([^/]+)$`);

export function computeLoops(index: IndexSnapshot): Loop[] {
  const byDid = new Map<string, IndexedPersona>();
  for (const p of index.personas) if (p.did) byDid.set(p.did, p);

  const party = (did?: string, fallbackName?: string): PartyRef => {
    const p = did ? byDid.get(did) : undefined;
    return { personaId: p?.id, did, name: p?.name ?? fallbackName, handle: p?.handle };
  };

  const loops: Loop[] = [];
  const directed = new Map<string, IndexedConnection>();
  const conns = [...index.connections];

  for (const c of conns) {
    if (c.did && "did" in c.subject && c.subject.did !== c.did) {
      const key = `${c.did} ${c.subject.did}`;
      if (!directed.has(key)) directed.set(key, c);
    }
  }

  for (const [key, c] of directed) {
    const [from, to] = key.split(" ");
    if (from > to) continue; // report each pair once
    const back = directed.get(`${to} ${from}`);
    if (!back) continue;
    loops.push({
      type: "peer",
      a: party(from),
      b: party(to, "name" in c.subject ? c.subject.name : undefined),
      aSays: { relationship: c.relationship, role: c.role, uri: c.uri, createdAt: c.createdAt },
      bSays: { relationship: back.relationship, role: back.role, uri: back.uri, createdAt: back.createdAt },
    });
  }

  for (const c of conns) {
    if (!("uri" in c.subject)) continue;
    const m = c.subject.uri.match(WORK_URI);
    if (!m || m[1] === c.did) continue;
    const work = index.works.get(c.subject.uri);
    if (!work) continue;
    const pinned = !!c.subject.cid;
    loops.push({
      type: "work",
      workUri: work.uri,
      workTitle: work.title,
      creator: party(work.did),
      attester: party(c.did),
      relationship: c.relationship,
      role: c.role,
      connectionUri: c.uri,
      attestedAt: c.createdAt,
      pinned,
      changedSinceAttested: pinned && !!work.cid && c.subject.cid !== work.cid,
    });
  }
  return loops;
}

export function loopsInvolving(loops: Loop[], persona: IndexedPersona): Loop[] {
  const mine = (p: PartyRef) => p.personaId === persona.id || (!!persona.did && p.did === persona.did);
  return loops.filter((l) => (l.type === "peer" ? mine(l.a) || mine(l.b) : mine(l.creator) || mine(l.attester)));
}

export const loopsForWork = (loops: Loop[], workUri: string) =>
  loops.filter((l) => l.type === "work" && l.workUri === workUri);
