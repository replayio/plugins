#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const bugId = args.bugId || args._[0];
  if (!bugId) {
    throw new Error("Provide a bug id with --bug-id or as the first argument.");
  }

  const response = await qa.apiRequest("GET", `/bugs/${bugId}`);
  if (args.save) {
    const root = qa.getProjectRoot();
    const outDir = path.join(root, ".replay", "qa-bugs");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${bugId}.json`), `${JSON.stringify(response, null, 2)}\n`);
  }
  qa.printJson(response);
}

main().catch(qa.handleError);
