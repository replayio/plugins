#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const description = args.description || args._.join(" ").trim();

  if (!description) {
    throw new Error("Provide a missing-bug description with --description or as positional text.");
  }

  const body = { description };
  if (args.title) {
    body.title = args.title;
  }

  const response = await qa.apiRequest(
    "POST",
    `/projects/${project.projectId}/report-missing-bug`,
    body
  );
  qa.printJson(response);
}

main().catch(qa.handleError);
