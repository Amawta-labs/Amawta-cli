export const TOOL_NAME = 'FalsificationPlan'

export const DESCRIPTION =
  'Builds a falsification plan + invariants evidence alignment using the dedicated ADK subagent.'

export const PROMPT = `Use this tool after the hypothesis pipeline has enough context (dialectical + baconian + literature) and you need an executable falsification blueprint.

Input guidance:
- hypothesis_query: current hypothesis text.
- dialectical_synthesis: synthesis from DialecticalAnalysis (optional alias; treated as hypothesis_cleaned fallback).
- hypothesis_cleaned: normalized/cleaned hypothesis (if available).
- veritas_form_json: JSON/string of forma veritas (if available).
- normalization_json: hypothesis normalization JSON (if available).
- literature_search_json: literature search output JSON/string (if available).
- literature_extract_json: literature extract output JSON/string (if available).
- invariants_catalog_md: invariants catalog markdown (if available).
- catalog_sha256: hash of invariants catalog (if available).
- normalization_ok: whether core normalization is complete.
- missing_fields: core missing fields list.

Output:
- Strict JSON contract with:
  - falsification_plan
  - invariants_match

Usage policy:
- Use this tool at most once per hypothesis in the same turn.
- Prefer running this after literature discovery has completed.
- Before invoking this tool, tell the user in one short sentence what you will do.
- After tool execution, summarize the key tests/variants/next action briefly.`
