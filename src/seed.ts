/**
 * Demo personas (`src/seed.ts`) — M6.
 *
 * Fictional people and places on .example domains, across several practices
 * and all three protocols, arranged so that every kind of loop appears:
 *   - Ama Owusu ↔ Saltmarsh Collective: a peer loop (each names the other)
 *   - Larkfield Rooms exhibited Ama's "Tidal", pinned to its current version
 *   - Larkfield Rooms exhibited Ama's "Night Shift", pinned to an older
 *     version: the work changed after the venue said so
 *   - Mira Sato and Tomás Reyes make one-way claims (normal, not lesser)
 */

import { makePersonaId } from "./graph.js";
import { IndexedConnection, IndexedWork, NSID, PersonaBundle } from "./types.js";

const AMA = "did:plc:demoamaowusu";
const SALTMARSH = "did:plc:demosaltmarsh";
const LARKFIELD = "did:plc:demolarkfield";
const PDS = "https://pds.example";

const at = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;

export function demoBundles(now: Date = new Date()): PersonaBundle[] {
  const t = now.toISOString();
  const atPersona = (did: string, handle: string, rest: Partial<PersonaBundle["persona"]> & { name: string }) => ({
    id: makePersonaId("atproto", did),
    protocol: "atproto" as const,
    sourceUri: at(did, NSID.profile, "self"),
    did,
    handle,
    pdsUrl: PDS,
    cid: `bafyreidemo${handle.split(".")[0].replace(/-/g, "")}`,
    disciplines: [],
    links: [],
    externalIds: [],
    indexedAt: t,
    ...rest,
  });
  const work = (did: string, personaId: string, rkey: string, cid: string, rest: Partial<IndexedWork> & { title: string }): IndexedWork => ({
    uri: at(did, NSID.work, rkey),
    cid,
    personaId,
    did,
    credits: [],
    tags: [],
    links: [],
    externalIds: [],
    indexedAt: t,
    ...rest,
  });
  const conn = (did: string, personaId: string, rkey: string, rest: Omit<IndexedConnection, "uri" | "personaId" | "did" | "indexedAt">): IndexedConnection => ({
    uri: at(did, NSID.connection, rkey),
    personaId,
    did,
    indexedAt: t,
    ...rest,
  });

  const ama = atPersona(AMA, "ama-owusu.example", {
    name: "Ama Owusu",
    bio: "Lighting designer and performer working across theatre, dance and installation. Interested in how light changes the way a room is remembered.",
    disciplines: ["lighting design", "performance", "installation"],
    based: { name: "Peckham, London" },
    links: [{ uri: "https://ama-owusu.example", title: "Portfolio" }],
    createdAt: "2026-09-02T10:00:00.000Z",
  });
  const saltmarsh = atPersona(SALTMARSH, "saltmarsh.example", {
    name: "Saltmarsh Collective",
    bio: "A sound and installation collective working with tidal sites on the Kent coast.",
    disciplines: ["sound art", "installation", "collective"],
    based: { name: "Margate" },
    createdAt: "2026-08-14T09:00:00.000Z",
  });
  const larkfield = atPersona(LARKFIELD, "larkfield-rooms.example", {
    name: "Larkfield Rooms",
    bio: "An artist-run exhibition and performance space in a former print works.",
    disciplines: ["exhibition space", "performance venue"],
    based: { name: "Glasgow" },
    createdAt: "2026-07-01T12:00:00.000Z",
  });

  const tidal = work(AMA, ama.id, "3lwkdemotidal", "bafyreidemotidalv2", {
    title: "Tidal",
    completionDate: "Spring 2025",
    description: "A light installation timed to the Thames tide tables.",
    credits: [{ name: "Ama Owusu", did: AMA, role: "lighting design" }, { name: "Saltmarsh Collective", did: SALTMARSH, role: "sound" }],
    tags: ["light", "water"],
    createdAt: "2026-09-02T10:05:00.000Z",
  });
  const nightShift = work(AMA, ama.id, "3lwkdemonight", "bafyreidemonightv3", {
    title: "Night Shift",
    completionDate: "2024",
    credits: [{ name: "Ama Owusu", did: AMA, role: "lighting and performance" }],
    createdAt: "2026-09-02T10:06:00.000Z",
  });
  const lowWater = work(SALTMARSH, saltmarsh.id, "3lwkdemolowwater", "bafyreidemolowwater", {
    title: "Low Water",
    completionDate: "2023–ongoing",
    tags: ["field recording"],
    createdAt: "2026-08-14T09:10:00.000Z",
  });

  // Solid persona
  const miraDoc = "https://mira-sato.solid.example/public/creativeid.ttl";
  const miraId = makePersonaId("solid", miraDoc);
  // Static persona
  const tomasDoc = "https://tomas-reyes.example/.well-known/creativeid.jsonld";
  const tomasId = makePersonaId("static", tomasDoc);

  return [
    {
      persona: ama,
      works: [tidal, nightShift],
      connections: [
        conn(AMA, ama.id, "3lwkdemoamaconn1", { subject: { did: SALTMARSH, name: "Saltmarsh Collective" }, relationship: "member_of", createdAt: "2026-09-02T10:10:00.000Z" }),
        conn(AMA, ama.id, "3lwkdemoamaconn2", { subject: { did: LARKFIELD, name: "Larkfield Rooms" }, relationship: "performed", role: "lighting", createdAt: "2026-09-03T18:00:00.000Z" }),
      ],
    },
    {
      persona: saltmarsh,
      works: [lowWater],
      connections: [
        conn(SALTMARSH, saltmarsh.id, "3lwkdemosaltconn", { subject: { did: AMA, name: "Ama Owusu" }, relationship: "collaborated_on", role: "member", createdAt: "2026-08-20T11:00:00.000Z" }),
      ],
    },
    {
      persona: larkfield,
      works: [],
      connections: [
        conn(LARKFIELD, larkfield.id, "3lwkdemolarkconn1", { subject: { uri: tidal.uri, cid: tidal.cid }, relationship: "exhibited", note: "Spring season 2025", createdAt: "2026-09-10T09:00:00.000Z" }),
        conn(LARKFIELD, larkfield.id, "3lwkdemolarkconn2", { subject: { uri: nightShift.uri, cid: "bafyreidemonightv1" }, relationship: "exhibited", createdAt: "2026-09-10T09:05:00.000Z" }),
      ],
    },
    {
      persona: {
        id: miraId,
        protocol: "solid",
        sourceUri: `${miraDoc}#me`,
        httpEndpoint: miraDoc,
        name: "Mira Sato",
        bio: "Choreographer making work for non-theatre spaces: car parks, libraries, empty shops.",
        disciplines: ["choreography", "dance"],
        based: { name: "Leeds" },
        links: [],
        externalIds: [],
        indexedAt: t,
      },
      works: [
        { uri: `${miraDoc}#work-3lwkdemoground`, personaId: miraId, title: "Ground Truth", completionDate: "2025", credits: [], tags: ["site-specific"], links: [], externalIds: [], indexedAt: t },
      ],
      connections: [
        { uri: `${miraDoc}#claim-3lwkdemomira`, personaId: miraId, subject: { did: LARKFIELD, name: "Larkfield Rooms" }, relationship: "performed", indexedAt: t },
      ],
    },
    {
      persona: {
        id: tomasId,
        protocol: "static",
        sourceUri: `${tomasDoc}#me`,
        httpEndpoint: tomasDoc,
        name: "Tomás Reyes",
        bio: "Independent curator of sound and listening exhibitions.",
        disciplines: ["curating", "sound art"],
        based: { name: "Bristol" },
        links: [{ uri: "https://tomas-reyes.example", title: "Website" }],
        externalIds: [],
        indexedAt: t,
      },
      works: [
        {
          uri: `${tomasDoc}#work-3lwkdemosoundoff`,
          personaId: tomasId,
          title: "Sound Off",
          completionDate: "2026",
          description: "A group exhibition of listening works.",
          credits: [{ name: "Tomás Reyes", role: "curator" }, { name: "Saltmarsh Collective", did: SALTMARSH, role: "artists" }],
          tags: ["exhibition"],
          links: [],
          externalIds: [],
          indexedAt: t,
        },
      ],
      connections: [
        { uri: `${tomasDoc}#claim-3lwkdemotomas`, personaId: tomasId, subject: { did: SALTMARSH, name: "Saltmarsh Collective" }, relationship: "curated", indexedAt: t },
      ],
    },
  ];
}
