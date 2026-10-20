// CreativeID Directory — search and persona pages over the /v1 API (M6).
// Loops are written as plain sentences: facts, never badges or scores.

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false && c !== "") el.append(c);
  return el;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

const PROTOCOL = { atproto: "AT Protocol", solid: "a Solid Pod", static: "their own website" };

const VERB = {
  performed: "performed at or with",
  exhibited: "exhibited",
  curated: "curated",
  collaborated_on: "collaborated with",
  created: "made",
  released: "released",
  represented_by: "are represented by",
  member_of: "are a member of",
  references: "refers to",
  attests_to: "vouches for",
};
const verb = (rel) => VERB[rel] ?? rel.replace(/_/g, " ");
const partyName = (p) => p?.name || (p?.handle ? `@${p.handle}` : p?.did) || "someone";
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let current = null;

// ------------------------------------------------------------------ search

async function loadStats() {
  const s = await api("/v1/stats");
  const loops = s.loops.peer + s.loops.work;
  $("stats").textContent = `${plural(s.personas, "persona")}, ${plural(s.works, "work")}, ${plural(loops, "matched account")}`;
}

async function loadDisciplines() {
  const { disciplines } = await api("/v1/disciplines");
  $("discipline").append(...disciplines.map((d) => h("option", { value: d.discipline }, `${d.discipline} (${d.count})`)));
}

async function search() {
  const params = new URLSearchParams();
  for (const id of ["q", "discipline", "based", "protocol"]) {
    const v = $(id).value.trim();
    if (v) params.set(id, v);
  }
  const r = await api(`/v1/personas?${params}`);
  $("results-count").textContent = r.total ? `${plural(r.total, "persona")}` : "Nobody matches that yet. Try fewer words, or another discipline.";
  $("results").replaceChildren(
    ...r.results.map((p) => {
      const meta = [
        p.disciplines.slice(0, 3).join(", "),
        p.based?.name,
        [plural(p.counts.works, "work"), p.counts.loops ? plural(p.counts.loops, "match", "matches") : null].filter(Boolean).join(", "),
      ].filter(Boolean);
      return h("li", {},
        h("button", { type: "button", class: "result", "aria-current": current === p.id ? "true" : "false", "data-id": p.id, onclick: () => openPersona(p.id) },
          h("span", { class: "result-name" }, p.name),
          ...meta.map((m) => h("span", { class: "result-meta" }, m))));
    })
  );
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  search().catch(showError);
});
for (const id of ["discipline", "protocol"]) $(id).addEventListener("change", () => search().catch(showError));

// ------------------------------------------------------------------ persona page

function loopSentence(loop, viewer) {
  if (loop.type === "peer") {
    const [me, other, mine, theirs] =
      loop.a.personaId === viewer.id || loop.a.did === viewer.did
        ? [loop.a, loop.b, loop.aSays, loop.bSays]
        : [loop.b, loop.a, loop.bSays, loop.aSays];
    return h("span", { class: "loop" },
      `${partyName(me)} says they ${verb(mine.relationship)} ${partyName(other)}, and ${partyName(other)} says they ${verb(theirs.relationship)} ${partyName(me)}.`);
  }
  const when = loop.attestedAt ? ` (${formatDate(loop.attestedAt)})` : "";
  const isCreator = loop.creator.personaId === viewer.id;
  const text = isCreator
    ? `${partyName(loop.attester)} says they ${verb(loop.relationship)} this work${when}.`
    : `Says they ${verb(loop.relationship)} ${partyName(loop.creator)}'s “${loop.workTitle}”${when}, and ${partyName(loop.creator)} lists it as theirs.`;
  return h("span", { class: "loop" }, text,
    loop.changedSinceAttested ? h("span", { class: "loop changed" }, "The work has been edited since they said so.") : null,
    !loop.pinned ? h("span", { class: "meta" }, "Their statement isn't tied to a particular version of the work.") : null);
}

async function openPersona(id, { updateHash = true } = {}) {
  current = id;
  document.querySelectorAll(".result").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
  if (updateHash) history.replaceState(null, "", `#/persona/${encodeURIComponent(id)}`);
  const enc = encodeURIComponent(id);
  const [{ persona: p }, { works }, conns, { loops }] = await Promise.all([
    api(`/v1/personas/${enc}`),
    api(`/v1/personas/${enc}/works`),
    api(`/v1/personas/${enc}/connections`),
    api(`/v1/personas/${enc}/loops`),
  ]);

  const sub = [p.disciplines.join(", "), p.based?.name ? `based in ${p.based.name}` : null].filter(Boolean).join(", ");
  const label = h("div", { class: "wall-label" },
    h("h2", { class: "wl-name" }, p.name),
    sub ? h("p", { class: "wl-sub" }, sub.charAt(0).toUpperCase() + sub.slice(1)) : null,
    p.bio ? h("p", { class: "wl-bio" }, p.bio) : null,
    p.links.length
      ? h("p", { class: "wl-sub" }, ...p.links.flatMap((l, i) => [i ? ", " : "", h("a", { href: l.uri, rel: "noopener nofollow" }, l.title || l.uri)]))
      : null);

  const workItems = works.map((w) =>
    h("li", {},
      h("span", { class: "work-title" }, w.title), w.completionDate ? `, ${w.completionDate}` : "",
      w.credits.length ? h("span", { class: "meta" }, w.credits.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join(", ")) : null,
      ...w.loops.map((l) => loopSentence(l, p))));

  const outgoing = conns.outgoing.map((c) => {
    const target = c.subject.did ? c.subject.name || c.subject.did : c.subject.uri;
    const matched = loops.find((l) => (l.type === "peer" && [l.aSays.uri, l.bSays.uri].includes(c.uri)) || (l.type === "work" && l.connectionUri === c.uri));
    return h("li", {},
      `Says they ${verb(c.relationship)} `, h("strong", {}, target), c.role ? ` (${c.role})` : "", ".",
      matched ? loopSentence(matched, p) : h("span", { class: "meta" }, "Only their side so far."));
  });

  const incomingItems = await Promise.all(
    conns.incoming.map(async (c) => {
      const from = await api(`/v1/personas/${encodeURIComponent(c.personaId)}`).then((r) => r.persona).catch(() => null);
      return h("li", {},
        from ? h("button", { type: "button", class: "btn-link", onclick: () => openPersona(from.id) }, from.name) : "Someone",
        ` says they ${verb(c.relationship)} ${p.name}${c.role ? ` (${c.role})` : ""}.`);
    })
  );

  const source = h("p", { class: "source" },
    `Published to ${PROTOCOL[p.protocol]}`, p.handle ? ` as @${p.handle}` : "", ". Source: ",
    p.protocol === "atproto" ? h("code", {}, p.sourceUri) : h("a", { href: p.httpEndpoint || p.sourceUri, rel: "noopener nofollow" }, p.httpEndpoint || p.sourceUri),
    `. Read by this directory on ${formatDate(p.indexedAt)}. `,
    h("a", { href: `/v1/personas/${enc}` }, "See it as JSON"), ".");

  $("detail").replaceChildren(
    label,
    h("h3", {}, works.length ? `Works (${works.length})` : "Works"),
    works.length ? h("ul", { class: "plain-list" }, ...workItems) : h("p", { class: "meta" }, "No works published yet."),
    h("h3", {}, "Worked with"),
    outgoing.length ? h("ul", { class: "plain-list" }, ...outgoing) : h("p", { class: "meta" }, "No connections published yet."),
    incomingItems.length ? h("h3", {}, "Others who name them") : null,
    incomingItems.length ? h("ul", { class: "plain-list" }, ...incomingItems) : null,
    source
  );
  if (updateHash) $("detail").focus({ preventScroll: window.innerWidth > 900 });
}

function showError(err) {
  $("results-count").textContent = err.message;
}

// ------------------------------------------------------------------ adding a persona

$("index-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("index-status");
  const uri = $("index-uri").value.trim();
  if (!uri) {
    status.textContent = "Paste where to find the persona first.";
    return;
  }
  status.textContent = "Fetching…";
  try {
    const body = { uri };
    if ($("index-pds").value.trim()) body.pdsUrl = $("index-pds").value.trim();
    const r = await api("/v1/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    status.textContent = `Added ${r.persona.name}: ${plural(r.works, "work")}, ${plural(r.connections, "connection")}.`;
    await Promise.all([loadStats(), search()]);
    await openPersona(r.persona.id);
  } catch (err) {
    status.textContent = err.message;
  }
});

// ------------------------------------------------------------------ start

async function start() {
  await Promise.all([loadStats(), loadDisciplines()]);
  await search();
  const m = location.hash.match(/^#\/persona\/(.+)$/);
  if (m) await openPersona(decodeURIComponent(m[1]), { updateHash: false });
}
start().catch(showError);
