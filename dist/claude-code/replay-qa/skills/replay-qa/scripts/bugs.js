#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const status = args.status || "open";
  const list = await qa.apiRequest(
    "GET",
    `/projects/${project.projectId}/bugs`,
    undefined,
    { status, page: args.page || 1, pageSize: args.pageSize || 50 }
  );

  if (!args.details && !args.save) {
    qa.printJson(list);
    return;
  }

  const ids = qa.extractIds(list);
  const details = [];
  for (const id of ids) {
    const detail = await qa.apiRequest("GET", `/bugs/${id}`);
    details.push(detail);

    if (args.save) {
      const outDir = path.join(project.root, ".replay", "qa-bugs");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${id}.json`), `${JSON.stringify(detail, null, 2)}\n`);
    }
  }

  qa.printJson({ project_id: project.projectId, status, count: details.length, bugs: details });
}

main().catch(qa.handleError);
