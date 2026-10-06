import type { CardParser } from '../card.ts'
import { CODE_PARSERS } from './code.ts'
import { OVERVIEW_PARSERS } from './overview.ts'
import { REACT_PARSERS } from './react.ts'

/** Replay MCP tool name -> its card. A tool missing here is drawn by `genericCard`. */
export const PARSERS: Record<string, CardParser> = {
  ...OVERVIEW_PARSERS,
  ...CODE_PARSERS,
  ...REACT_PARSERS,
}
