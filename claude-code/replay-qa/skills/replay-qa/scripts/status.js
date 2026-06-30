#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const intervalMs = Number(args.intervalMs || 15000);

  do {
    qa.printSection(
      `Project status ${project.projectId}`,
      await qa.apiRequest("GET", `/projects/${project.projectId}/status`)
    );
    if (!args.watch) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
}

main().catch(qa.handleError);
