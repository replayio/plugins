#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const response = await qa.apiRequest(
    "GET",
    `/projects/${project.projectId}/journeys`,
    undefined,
    { page: args.page || 1, pageSize: args.pageSize || 50 }
  );

  if (args.journeyId) {
    qa.printJson(qa.findObjectsByKeyValue(response, "id", args.journeyId));
  } else {
    qa.printJson(response);
  }
}

main().catch(qa.handleError);
