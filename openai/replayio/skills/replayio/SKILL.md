---
name: replayio
description: Debug an uploaded Replay recording using its URL or ID, including a recording preview, console and network failures, source execution, React rendering, and recorded application state.
---

# Debug a Replay recording

Use the connected Replay MCP tools for the recording the user supplied. Extract the recording ID from a Replay URL; if neither a recording nor its ID is available, ask for one. These tools analyze uploaded recordings. They do not control a live browser or create recordings.

Call `RecordingOverview` first. A cold recording can take several minutes to analyze. Use its summary to choose focused follow-up tools rather than querying every subsystem.

In hosts with MCP UI support, `RecordingOverview` opens an rrweb preview. The UI loads its own frames using `RecordingPreview`; leave those calls to the UI. The preview samples up to 30 browser DOM snapshots and can omit external assets. Use it to orient the investigation, and use execution, network, and state evidence for precise timing or causality. Recordings without a browser DOM still have text overviews. When embedded UI is unavailable, summarize the text result and provide the recording link.

Choose follow-up tools according to the evidence:

- Console output: `ConsoleMessages`, starting with `summary`. A console error is distinct from a runtime exception; use `UncaughtException` or `ReactException` for exceptions.
- Network failures: `NetworkRequest`, progressing from `summary` to `requests` and then `detail` for the relevant request ID or index.
- Execution and source: find paths with `ListSources` or `SearchSources`, then use `ReadSource`, `DescribePoint`, `GetStack`, or a narrowly scoped `Logpoint`. Use execution points returned by tools; do not invent them.
- React rendering: start with `ReactRenders` summary or `waste-rank`; use `ReactComponentTree` for component structure and the returned component or commit identifiers for detail.
- Application state: use the relevant Redux, Zustand, or TanStack Query tool. Inspect state shape before retrieving a focused path, event, or store.
- Visual evidence: use `Screenshot` for a timestamp returned by the tools. Use `GetPointLink` when a precise execution point would help the user inspect the result.

Keep results focused on the user's question. Cite recording links and relevant execution points, source locations, or request details. Distinguish observed facts from hypotheses and say when instrumentation or missing data limits the conclusion.

On an authentication error, ask the user to reconnect Replay through the host's sign-in flow. On access denied, explain that the connected Replay account needs access to that recording. Do not ask the user to paste tokens or passwords into chat, switch accounts to bypass permissions, or interpret an authorization failure as an empty recording.
