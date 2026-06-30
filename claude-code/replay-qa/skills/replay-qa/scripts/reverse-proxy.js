#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const intervalMs = Number(args.intervalMs || 10000);

  do {
    const response = await qa.apiRequest(
      "GET",
      `/projects/${project.projectId}/reverse-proxy`
    );
    qa.printSection(`Reverse proxy ${project.projectId}`, response);

    const instructions =
      typeof response.instructions === "string" ? response.instructions.trim() : "";
    if (!args.wait || instructions) {
      if (instructions) {
        qa.printSection("Runbook", instructions);
      }
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
}

main().catch(qa.handleError);
