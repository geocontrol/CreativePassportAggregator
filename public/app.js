const state = {
  protocol: "",
  query: "",
  results: [],
};

const els = {
  statTotal: document.getElementById("stat-total"),
  statAtproto: document.getElementById("stat-atproto"),
  statSolid: document.getElementById("stat-solid"),
  statStatic: document.getElementById("stat-static"),
  seedBtn: document.getElementById("seed-btn"),
  searchInput: document.getElementById("search-input"),
  searchBtn: document.getElementById("search-btn"),
  filterPills: document.querySelectorAll(".filter-pill"),
  liveEndpointUrl: document.getElementById("live-endpoint-url"),
  resultsCount: document.getElementById("results-count"),
  resultsList: document.getElementById("results-list"),
  inspectorEndpoint: document.getElementById("inspector-endpoint"),
  inspectorCode: document.getElementById("inspector-code"),
  copyJsonBtn: document.getElementById("copy-json-btn"),
  indexForm: document.getElementById("index-form"),
  indexUri: document.getElementById("index-uri"),
  indexProtocol: document.getElementById("index-protocol"),
  indexPds: document.getElementById("index-pds"),
  indexStatus: document.getElementById("index-status"),
  fillLocalAtproto: document.getElementById("fill-local-atproto"),
  fillLocalSolid: document.getElementById("fill-local-solid"),
};

function setStatus(el, msg, cls = "") {
  el.textContent = msg;
  el.className = `status-msg ${cls}`.trim();
}

async function refreshStats() {
  const res = await fetch("/v1/stats");
  const stats = await res.json();
  els.statTotal.textContent = stats.total;
  els.statAtproto.textContent = stats.byProtocol.atproto;
  els.statSolid.textContent = stats.byProtocol.solid;
  els.statStatic.textContent = stats.byProtocol.static;
}

function renderResults(data) {
  els.resultsCount.textContent = `Showing ${data.results.length} of ${data.total} artist(s)`;
  els.resultsList.innerHTML = "";

  if (data.results.length === 0) {
    els.resultsList.innerHTML = `<div class="panel"><p class="hint">No matching artists found. Try clearing filters or indexing a new artist URI.</p></div>`;
    return;
  }

  for (const artist of data.results) {
    const card = document.createElement("article");
    card.className = "artist-card";

    const identitySubtitle = artist.handle
      ? `@${artist.handle} (${artist.did || ""})`
      : artist.did || artist.subjectId || artist.id;

    card.innerHTML = `
      <div class="artist-card-top">
        <div>
          <h3 class="artist-name"></h3>
          <div class="artist-handle"></div>
        </div>
        <span class="proto-badge ${artist.protocol}">${artist.protocol}</span>
      </div>
      <p class="artist-bio"></p>
      <div class="artist-meta">
        <div>
          Source: <code class="artist-uri"></code>
        </div>
        <div class="artist-actions">
          <button type="button" class="btn btn-small btn-ghost inspect-full-btn">Inspect API JSON</button>
          <button type="button" class="btn btn-small btn-ghost inspect-jsonld-btn">JSON-LD</button>
        </div>
      </div>
    `;

    card.querySelector(".artist-name").textContent = artist.name;
    card.querySelector(".artist-handle").textContent = identitySubtitle;
    card.querySelector(".artist-bio").textContent = artist.biography;
    card.querySelector(".artist-uri").textContent = artist.sourceUri;

    card.querySelector(".inspect-full-btn").addEventListener("click", async () => {
      const url = `/v1/artists/${encodeURIComponent(artist.id)}`;
      const res = await fetch(url);
      const body = await res.json();
      els.inspectorEndpoint.textContent = `GET ${url}`;
      els.inspectorCode.textContent = JSON.stringify(body, null, 2);
    });

    card.querySelector(".inspect-jsonld-btn").addEventListener("click", async () => {
      const url = `/v1/artists/${encodeURIComponent(artist.id)}?view=jsonld`;
      const res = await fetch(url);
      const body = await res.json();
      els.inspectorEndpoint.textContent = `GET ${url}`;
      els.inspectorCode.textContent = JSON.stringify(body, null, 2);
    });

    els.resultsList.appendChild(card);
  }
}

async function runSearch() {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.protocol) params.set("protocol", state.protocol);

  const queryStr = params.toString();
  const endpoint = `/v1/artists${queryStr ? `?${queryStr}` : ""}`;
  els.liveEndpointUrl.textContent = `GET ${endpoint}`;

  const res = await fetch(endpoint);
  const data = await res.json();
  state.results = data.results;
  renderResults(data);

  els.inspectorEndpoint.textContent = `GET ${endpoint}`;
  els.inspectorCode.textContent = JSON.stringify(data, null, 2);
}

els.searchBtn.addEventListener("click", () => {
  state.query = els.searchInput.value;
  runSearch();
});

els.searchInput.addEventListener("input", () => {
  state.query = els.searchInput.value;
  runSearch();
});

els.filterPills.forEach((pill) => {
  pill.addEventListener("click", () => {
    els.filterPills.forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    state.protocol = pill.dataset.protocol || "";
    runSearch();
  });
});

els.copyJsonBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.inspectorCode.textContent);
  const orig = els.copyJsonBtn.textContent;
  els.copyJsonBtn.textContent = "Copied!";
  setTimeout(() => {
    els.copyJsonBtn.textContent = orig;
  }, 1400);
});

els.seedBtn.addEventListener("click", async () => {
  await fetch("/v1/seed", { method: "POST" });
  await refreshStats();
  await runSearch();
});

// Quick-fill helpers to pull from a local CreativeID Studio instance on port 3400
els.fillLocalAtproto.addEventListener("click", () => {
  els.indexUri.value =
    "at://did:plc:sandboxadacreativeidlocal/org.creativepassport.actor.persona/self";
  els.indexProtocol.value = "atproto";
  els.indexPds.value = "http://localhost:3400/sandbox/atproto";
});

els.fillLocalSolid.addEventListener("click", () => {
  els.indexUri.value = "http://localhost:3400/sandbox/solid/public/creativeid.ttl#me";
  els.indexProtocol.value = "solid";
  els.indexPds.value = "";
});

els.indexForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus(els.indexStatus, "Resolving & indexing...", "");
  try {
    const res = await fetch("/v1/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: els.indexUri.value,
        sourceType: els.indexProtocol.value || undefined,
        pdsUrl: els.indexPds.value || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(els.indexStatus, data.error || "Failed to index", "err");
      return;
    }
    setStatus(els.indexStatus, `Indexed ${data.artist.name}!`, "ok");
    els.inspectorEndpoint.textContent = "POST /v1/index";
    els.inspectorCode.textContent = JSON.stringify(data, null, 2);
    await refreshStats();
    await runSearch();
  } catch (err) {
    setStatus(els.indexStatus, err.message, "err");
  }
});

refreshStats();
runSearch();
