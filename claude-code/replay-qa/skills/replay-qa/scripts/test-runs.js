#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const response = await qa.apiRequest(
    "GET",
    `/projects/${project.projectId}/test-runs`,
    undefined,
    {
      journeyId: args.journeyId,
      page: args.page || 1,
      pageSize: args.pageSize || 50,
    }
  );
  qa.printJson(
    qa.normalizeList(response, "test_runs", {
      project_id: project.projectId,
      journey_id: args.journeyId,
    })
  );
}

main().catch(qa.handleError);
