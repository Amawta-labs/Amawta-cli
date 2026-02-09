export const TOOL_NAME = 'HypothesisNormalization'

export const DESCRIPTION =
  'Normalizes a hypothesis into structured claim fields, with transparent auto-correction and clarification guidance.'

export const PROMPT = `Use this tool before FalsificationPlan in hypothesis workflows.

Input guidance:
- hypothesis_query: original hypothesis text.
- dialectical_synthesis: synthesis from DialecticalAnalysis (optional but recommended).
- baconian_forma_veritas: forma veritas from BaconianAnalysis (optional but recommended).
- literature_summary: short literature summary/evidence notes (optional).

Behavior:
- The tool runs a strict normalization pass first.
- If critical fields are missing, it attempts one transparent auto-correction pass.
- It then reports what changed and what still needs user clarification.

Output:
- Structured normalization fields + critical missing fields status.
- Guidance for AskUserQuestion when clarification is still required.

Usage policy:
- Call at most once per hypothesis in the same turn.
- Before invoking this tool, tell the user briefly what you will do.
- If critical fields remain missing, call AskUserQuestion before FalsificationPlan.
- If normalization becomes complete, continue to FalsificationPlan.`
