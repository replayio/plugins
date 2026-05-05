export type ConnectorId = "codex" | "cursor" | "opencode" | "claude-code";

export interface ConnectorArtifact {
  readonly source: string;
  readonly destination: string;
}

export interface Connector {
  readonly id: ConnectorId;
  readonly output: string;
  readonly artifacts: readonly ConnectorArtifact[];
}

export const connectors = {
  codex: {
    id: "codex",
    output: "dist/codex/replayio",
    artifacts: [{ source: ".app.json", destination: ".app.json" }],
  },
  cursor: {
    id: "cursor",
    output: "dist/cursor/replayio",
    artifacts: [{ source: ".mcp.json", destination: "mcp.json" }],
  },
  opencode: {
    id: "opencode",
    output: "dist/opencode/replayio",
    artifacts: [{ source: ".mcp.json", destination: "opencode.json" }],
  },
  claudeCode: {
    id: "claude-code",
    output: "dist/claude-code/replayio",
    artifacts: [{ source: ".mcp.json", destination: ".mcp.json" }],
  },
} as const satisfies Record<string, Connector>;

export const connectorList = [
  connectors.codex,
  connectors.cursor,
  connectors.opencode,
  connectors.claudeCode,
] as const;
