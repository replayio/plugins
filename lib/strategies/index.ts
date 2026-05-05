import type { BuildContext } from "../build-helpers.ts";
import type { Connector } from "../connectors.ts";
import claudeCode from "./claude-code.ts";
import codex from "./codex.ts";
import cursor from "./cursor.ts";
import opencode from "./opencode.ts";

export interface Strategy {
  readonly name: Connector["id"];
  readonly connector: Connector;
  readonly build: (context: BuildContext, connector: Connector) => Promise<void>;
}

export default [codex, cursor, opencode, claudeCode] satisfies readonly Strategy[];
