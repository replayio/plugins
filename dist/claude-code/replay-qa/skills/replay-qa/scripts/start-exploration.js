#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const prompt = args.prompt || args._.join(" ").trim();

  if (!prompt) {
    throw new Error("Provide an exploration prompt with --prompt or as positional text.");
  }

  const response = await qa.apiRequest(
    "POST",
    `/projects/${project.projectId}/explorations`,
    { prompt }
  );
  qa.printJson(response);
}

main().catch(qa.handleError);
