export const TOOL_NAME = 'LiteratureDiscovery'

export const DESCRIPTION =
  'Runs a dedicated literature-discovery subagent using the claim and forma veritas, with active web navigation.'

export const PROMPT = `Use this tool after BaconianAnalysis when you need to check whether a claim is novel or already covered by existing literature.

Input guidance:
- hypothesis_query: the main claim/hypothesis.
- baconian_forma_veritas: forma veritas from BaconianAnalysis.
- dialectical_synthesis: optional synthesis from DialecticalAnalysis.
- domain_hint/context: optional focus constraints.

What this tool does:
- Uses a dedicated LLM subagent that actively searches and fetches web sources.
- Produces a structured summary of overlap vs novelty.
- Returns source-grounded findings usable by downstream normalization/falsification/runners.

Usage policy:
- Prefer this tool over manual ad-hoc WebSearch when novelty/overlap assessment is needed.
- Before invoking this tool, tell the user in one short sentence what you will do.
- After tool execution, provide a concise synthesis and proceed with the next pipeline step.`
