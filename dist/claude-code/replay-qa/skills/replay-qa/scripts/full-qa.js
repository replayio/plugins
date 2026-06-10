#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.ensureProject(args);

  qa.printSection("Replay QA project", {
    project_id: project.projectId,
    source: project.source,
    project_root: project.root,
    config_path: project.configPath,
  });

  const status = await qa.apiRequest("GET", `/projects/${project.projectId}/status`);
  qa.printSection("Project status", status);

  try {
    const proxy = await qa.apiRequest("GET", `/projects/${project.projectId}/reverse-proxy`);
    qa.printSection("Reverse proxy", proxy);
    if (typeof proxy.instructions === "string" && proxy.instructions.trim()) {
      qa.printSection("Runbook", proxy.instructions.trim());
    }
  } catch (error) {
    process.stderr.write(`Reverse proxy setup unavailable: ${error.message}\n`);
  }

  const openBugs = await qa.apiRequest(
    "GET",
    `/projects/${project.projectId}/bugs`,
    undefined,
    { status: "open", page: 1, pageSize: 100 }
  );
  const bugIds = qa.extractIds(openBugs);
  qa.printSection("Open bug ids", bugIds);

  const bugDetails = [];
  for (const bugId of bugIds) {
    bugDetails.push(await qa.apiRequest("GET", `/bugs/${bugId}`));
  }
  qa.printSection("Open bug details", bugDetails);

  qa.printSection(
    "Next steps",
    bugIds.length
      ? "Read each bug report, fix the code, then run mark-bug.js <bug-id> fixed. Replay QA will retry the affected journey."
      : "No open Replay QA bugs were returned. Keep polling status until QA is idle or start a focused exploration if the user asks for one."
  );
}

main().catch(qa.handleError);
