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

  if (args.raw) {
    qa.printJson(list);
    return;
  }

  const bugs = qa.listItems(list);
  if (!args.details && !args.save) {
    qa.printJson(qa.normalizeList(list, "bugs", { project_id: project.projectId, status }));
    return;
  }

  const ids = qa.extractIds(bugs.length ? bugs : list);
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

  qa.printJson(
    qa.normalizeList(
      {
        items: details,
        total: list.total,
        resolvedCount: list.resolvedCount,
        page: list.page,
        pageSize: list.pageSize,
      },
      "bugs",
      { project_id: project.projectId, status }
    )
  );
}

main().catch(qa.handleError);
