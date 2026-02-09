export const TOOL_NAME = 'DialecticalAnalysis'

export const DESCRIPTION =
  'Runs a dialectical analysis (hypothesis-antithesis-synthesis) using the dedicated ADK subagent.'

export const PROMPT = `Use this tool when the user presents a hypothesis, causal claim, or proposition that should be stress-tested through dialectical reasoning.

Input guidance:
- hypothesis_query: the exact hypothesis or claim to analyze.
- context: optional extra framing.

Output:
- Structured analysis with sections:
  Summary
  Hypothesis
  Antithesis
  Synthesis

Usage policy:
- Use this tool by default for hypothesis/proposition analysis.
- Do not use AskExpertModel as first route for hypothesis analysis.
- Do not call this tool more than once for the same hypothesis in the same turn.
- After this tool, call BaconianAnalysis once for the same hypothesis when the user expects a full analysis.
- Before invoking this tool, tell the user in one short sentence what you will do.
- After tool execution, summarize and explain the conclusion to the user.`
