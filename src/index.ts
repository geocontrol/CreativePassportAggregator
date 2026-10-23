import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { IndexStore } from "./indexer.js";
import { startJetstream } from "./jetstream.js";
import { demoBundles } from "./seed.js";
import { createAggregatorServer } from "./server.js";

export * from "./types.js";
export * from "./graph.js";
export * from "./identity.js";
export * from "./resolver.js";
export * from "./loops.js";
export * from "./indexer.js";
export * from "./jetstream.js";
export * from "./seed.js";
export * from "./server.js";
export * from "./netguard.js";

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : "");
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT || 3500);
  const host = process.env.HOST || "127.0.0.1";
  const dataDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "data");
  const store = new IndexStore(join(dataDir, "index.json"));
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";

  const stats = await store.stats();
  if (stats.personas === 0 && process.env.SEED !== "off") {
    for (const b of demoBundles()) await store.upsertBundle(b);
    console.log("Loaded 5 fictional demo personas (SEED=off to start empty).");
  }

  if (process.env.JETSTREAM === "on" || process.env.JETSTREAM_URL) {
    startJetstream(store, { endpoint: process.env.JETSTREAM_URL || undefined, cursorFile: join(dataDir, "jetstream-cursor") });
  }

  createAggregatorServer({ store, allowPrivateHosts: local || process.env.ALLOW_PRIVATE_HOSTS === "true" }).listen(port, host, () => {
    console.log(`CreativeID Aggregator running at http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
  });
}
