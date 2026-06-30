#!/usr/bin/env node
const qa = require("./replay-qa-lib");

function pickDefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== "")
  );
}

function summarizeBug(projectId, bug) {
  return pickDefined({
    id: bug.id,
    severity: bug.severity,
    status: bug.status,
    title: bug.title,
    journey_id: bug.journey_id || bug.journeyId,
    url:
      bug.url ||
      (bug.id ? `https://qa.replay.io/projects/${projectId}/bugs/${bug.id}` : undefined),
  });
}

async function getOptional(label, request) {
  try {
    return { value: await request() };
  } catch (error) {
    return { error: `${label} unavailable: ${error.message || error}` };
  }
}

async function main() {
  const args = qa.parseArgs(process.argv.slice(2));
  const project = await qa.getProjectId(args);
  const context = {
    project_id: project.projectId,
    source: project.source,
    project_root: project.root,
    config_path: project.configPath,
    dashboard_url: `https://qa.replay.io/projects/${project.projectId}/bugs`,
  };

  const status = await getOptional("status", () =>
    qa.apiRequest("GET", `/projects/${project.projectId}/status`)
  );
  if (status.value) {
    context.status = status.value;
  } else {
    context.status_error = status.error;
  }

  const bugs = await getOptional("open bugs", () =>
    qa.apiRequest("GET", `/projects/${project.projectId}/bugs`, undefined, {
      status: "open",
      page: args.page || 1,
      pageSize: args.pageSize || 50,
    })
  );
  if (bugs.value) {
    const normalized = qa.normalizeList(bugs.value, "bugs");
    context.open_bugs = pickDefined({
      count: normalized.count,
      total: normalized.total,
      resolved_count: normalized.resolved_count,
      page: normalized.page,
      page_size: normalized.page_size,
      bugs: normalized.bugs.map((bug) => summarizeBug(project.projectId, bug)),
    });
  } else {
    context.open_bugs_error = bugs.error;
  }

  qa.printJson(context);
}

main().catch((error) => {
  qa.printJson({
    replay_qa_context_unavailable: error.message || String(error),
  });
});
