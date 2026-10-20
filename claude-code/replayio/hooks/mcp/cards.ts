// Which transcript rows are Replay MCP calls, and the card each one's result
// becomes. Kept free of JSX so tests run it under plain Node.

import { errorCard, genericCard, type Card, type ToolInput } from './card.ts'
import { PARSERS } from './tools/index.ts'

/** `mcp__replay__X` (a server added by hand) or `mcp__plugin_replayio_replay__X` (this plugin's). */
export function replayToolName(tool: string): string | null {
  const m = /^mcp__(?:.+_)?replay__([A-Z][A-Za-z]+)$/.exec(tool)
  return m ? m[1]! : null
}

/** The text of an MCP result as the transcript stores it: a string, content blocks, or `{ content }`. */
export function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>
    if ('content' in o) return resultText(o.content)
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

export function cardFor(tool: string, input: ToolInput, text: string, isErrored: boolean): Card {
  if (isErrored || /^\[(Error|InputValidation)\]/.test(text.trim())) return errorCard(tool, input, text)
  const parse = PARSERS[tool]
  try {
    return parse ? parse(input, text) : genericCard(tool, input, text)
  } catch {
    return genericCard(tool, input, text)
  }
}
