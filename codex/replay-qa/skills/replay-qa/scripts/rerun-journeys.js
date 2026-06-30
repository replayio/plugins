#!/usr/bin/env node
const qa = require("./replay-qa-lib");

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));

  if (args.bugId) {
    const response = await qa.apiRequest("PATCH", `/bugs/${args.bugId}`, { status: "fixed" });
    qa.printSection(
      "Bug marked fixed",
      "Replay QA automatically retries the affected journey after a bug is marked fixed."
    );
    qa.printJson(response);
    return;
  }

  const project = await qa.getProjectId(args);

  if (args.journeyId) {
    const response = await qa.apiRequest(
      "GET",
      `/projects/${project.projectId}/test-runs`,
      undefined,
      { journeyId: args.journeyId, page: args.page || 1, pageSize: args.pageSize || 50 }
    );
    qa.printSection(
      "No direct journey rerun endpoint",
      "The current Replay QA OpenAPI spec does not expose a manual single-journey rerun endpoint. Showing prior test runs for the requested journey instead."
    );
    qa.printJson(
      qa.normalizeList(response, "test_runs", {
        project_id: project.projectId,
        journey_id: args.journeyId,
      })
    );
    return;
  }

  if (args.description || args._.length) {
    const description = args.description || args._.join(" ").trim();
    const body = { description };
    if (args.title) {
      body.title = args.title;
    }
    const response = await qa.apiRequest(
      "POST",
      `/projects/${project.projectId}/report-missing-bug`,
      body
    );
    qa.printSection(
      "Missing bug reported",
      "Replay QA creates an investigation journey for missing-bug reports."
    );
    qa.printJson(response);
    return;
  }

  const journeys = await qa.apiRequest(
    "GET",
    `/projects/${project.projectId}/journeys`,
    undefined,
    { page: 1, pageSize: 50 }
  );
  qa.printSection(
    "Supported rerun alternatives",
    [
      "No direct single-journey rerun endpoint is exposed by the current OpenAPI spec.",
      "Use --bug-id <id> after fixing a bug to trigger the automatic affected-journey retry.",
      "Use --journey-id <id> to review prior test runs for that journey.",
      "Pass a description to report a missing bug and spawn an investigation journey.",
    ].join("\n")
  );
  qa.printSection("Journeys", qa.normalizeList(journeys, "journeys", { project_id: project.projectId }));
}

main().catch(qa.handleError);
