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

  qa.printSection(
    "Project details",
    await qa.apiRequest("GET", `/projects/${project.projectId}`)
  );

  qa.printSection(
    "Project status",
    await qa.apiRequest("GET", `/projects/${project.projectId}/status`)
  );

  try {
    qa.printSection(
      "Reverse proxy setup",
      await qa.apiRequest("GET", `/projects/${project.projectId}/reverse-proxy`)
    );
  } catch (error) {
    process.stderr.write(`Reverse proxy setup unavailable: ${error.message}\n`);
  }
}

main().catch(qa.handleError);
