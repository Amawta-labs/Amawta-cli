export const TOOL_NAME = 'BaconianAnalysis'

export const DESCRIPTION =
  "Runs a Baconian analysis using the dialectical output (idols, clearing, truth tables, forma veritas)."

export const PROMPT = `Use this tool after DialecticalAnalysis when the user hypothesis needs Baconian framing.

Input guidance:
- hypothesis_query: the original hypothesis/claim.
- dialectical_summary/hypothesis/antithesis/synthesis: pass these from DialecticalAnalysis output.
- context: optional extra framing.

Output:
- Structured Baconian analysis with:
  Idols (tribe/cave/market/theater)
  Clearing of idols
  Truth tables (presence/absence/degrees)
  Forma veritas

Usage policy:
- Do not call this tool before DialecticalAnalysis for the same hypothesis.
- Call this tool at most once per hypothesis in the same turn.
- Before invoking this tool, tell the user in one short sentence what you will do.
- After tool execution, give a concise synthesis to the user.`
