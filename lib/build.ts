import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBuildContext } from "./build-helpers.ts";
import strategies from "./strategies/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const cleanOnly = process.argv.includes("--clean");

if (cleanOnly) {
  await rm(dist, { recursive: true, force: true });
  process.exit(0);
}

await rm(dist, { recursive: true, force: true });

const context = await createBuildContext(root);

for (const strategy of strategies) {
  await strategy.build(context, strategy.connector);
}
