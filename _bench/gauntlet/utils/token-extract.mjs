/**
 * Token extraction utilities for both agents.
 *
 * Forge: parses --json output, reads data.mainModelUsage.
 * opencode: reads JSON event stream, sums tokens from step_finish events.
 */

/**
 * Extract token usage from forge --json output.
 * @param {string} stdout - forge run --json stdout
 * @returns {{ inputTokens: number, outputTokens: number, calls: number } | null}
 */
export function extractForgeTokens(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed?.data?.mainModelUsage) {
      return {
        inputTokens: parsed.data.mainModelUsage.inputTokens ?? 0,
        outputTokens: parsed.data.mainModelUsage.outputTokens ?? 0,
        cacheReadTokens: parsed.data.mainModelUsage.cacheReadTokens ?? 0,
        calls: parsed.data.mainModelUsage.calls ?? 0,
      }
    }
    // Fallback: check if data itself has mainModelUsage
    if (parsed?.mainModelUsage) {
      return {
        inputTokens: parsed.mainModelUsage.inputTokens ?? 0,
        outputTokens: parsed.mainModelUsage.outputTokens ?? 0,
        cacheReadTokens: parsed.mainModelUsage.cacheReadTokens ?? 0,
        calls: parsed.mainModelUsage.calls ?? 0,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract token usage from opencode --format json event stream.
 * Sums tokens from all step_finish events.
 * @param {string} stdout - opencode --format json stdout
 * @returns {{ inputTokens: number, outputTokens: number, calls: number } | null}
 */
export function extractOpencodeTokens(stdout) {
  let input = 0
  let output = 0
  let calls = 0
  let found = false

  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'step_finish' && event.part?.tokens) {
        input += event.part.tokens.input ?? event.part.tokens.total ?? 0
        output += event.part.tokens.output ?? 0
        calls++
        found = true
      }
    } catch {
      // skip unparseable lines
    }
  }

  return found ? { inputTokens: input, outputTokens: output, calls } : null
}

/**
 * Count tokens using a rough heuristic (chars / 4).
 * Fallback when structured token data is unavailable.
 */
export function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4)
}
