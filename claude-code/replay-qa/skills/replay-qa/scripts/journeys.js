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
    const journeys = qa.listItems(response);
    const matches = journeys.length
      ? journeys.filter((journey) => journey && journey.id === args.journeyId)
      : qa.findObjectsByKeyValue(response, "id", args.journeyId);
    qa.printJson({
      project_id: project.projectId,
      journey_id: args.journeyId,
      count: matches.length,
      journeys: matches,
    });
  } else {
    qa.printJson(qa.normalizeList(response, "journeys", { project_id: project.projectId }));
  }
}

main().catch(qa.handleError);
