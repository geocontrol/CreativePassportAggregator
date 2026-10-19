import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { ArtistIndexStore } from "./indexer.js";
import { createAggregatorServer } from "./server.js";

export * from "./types.js";
export * from "./resolver.js";
export * from "./indexer.js";
export * from "./server.js";

const isMain = (() => {
  try {
    const currentFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return currentFile === entryFile;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT || 3500);
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const store = new ArtistIndexStore(
    resolve(__dirname, "..", "data", "index.json")
  );

  store.stats().then(async (stats) => {
    if (stats.total === 0) {
      await store.seedDemoArtists();
      console.log(
        "Seeded 5 demo artists across ATProto (Eurosky & Bluesky), Solid Pods, and Static domains."
      );
    }
    const server = createAggregatorServer({ store });
    server.listen(port, "127.0.0.1", () => {
      console.log(
        `CreativeID Aggregator API & Demo UI running at http://localhost:${port}`
      );
    });
  });
}
