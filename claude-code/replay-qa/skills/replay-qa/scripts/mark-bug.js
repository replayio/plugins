#!/usr/bin/env node
const qa = require("./replay-qa-lib");

const VALID_STATUSES = new Set(["fixed", "wontfix", "invalid", "reopened"]);

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const bugId = args.bugId || args._[0];
  const status = args.status || args._[1] || "fixed";

  if (!bugId) {
    throw new Error("Provide a bug id with --bug-id or as the first argument.");
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Unsupported bug status ${status}. Use fixed, wontfix, invalid, or reopened.`);
  }

  const response = await qa.apiRequest("PATCH", `/bugs/${bugId}`, { status });
  qa.printJson(response);
}

main().catch(qa.handleError);
