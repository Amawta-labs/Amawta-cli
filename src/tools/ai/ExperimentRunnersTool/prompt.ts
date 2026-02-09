export const TOOL_NAME = 'ExperimentRunners'

export const DESCRIPTION =
  'Builds basic executable experiment runners from hypothesis + falsification context and runs them for first operational evidence.'

export const PROMPT = `Use this tool after FalsificationPlan in hypothesis workflows when you need concrete starter runners for first experiments.

Input guidance:
- hypothesis_query: current hypothesis text.
- dialectical_synthesis: synthesis from DialecticalAnalysis (optional).
- baconian_forma_veritas: forma veritas from BaconianAnalysis (optional).
- normalization_json: normalization JSON (optional but recommended).
- falsification_plan_json: strict falsification output JSON (recommended).
- literature_summary: short literature summary (optional).
- dataset_hint: URL/ruta sugerida por el usuario o selector de dataset (optional).

Output:
- Strict JSON contract under:
  - experiment_runners

Usage policy:
- Treat dataset resolution as a two-pass process:
  - Pass 1 (pre-toy): literature-affinity pass only, to check whether the hypothesis framing is close to existing work and to extract domain vocabulary.
- Pass 2 (post-toy, when field is needed): resolve real datasets that contain the required observables/proxies to test the claim.
- Do NOT require finding papers or datasets that state the exact same claim text.
- Default behavior in Pass 2: actively search and rank datasets by testability (measurable variables/proxies), even for novel claims with no direct literature phrasing match.
- Pass 1 must not force dataset-fit matching; it is an affinity/novelty check only.
- Pass 2 dataset relevance is defined by measurable observables/proxies, not by literal claim wording.
  - Good: dataset has variables that can operationalize the hypothesis tests.
  - Bad: dataset title/abstract matches the claim words but lacks required columns/signals.
- For each field runner in Pass 2, prefer explicit measurement mapping:
  - claim variable -> dataset column/proxy
  - control variables -> dataset columns/proxies
  - test target/outcome -> dataset column/proxy
- If you cannot map required observables/proxies in Pass 2, mark dataset as not fit and keep NEEDS_FIELD.
- Use this tool at most once per hypothesis in the same turn.
- Prefer running this after FalsificationPlan is ready.
- After materializing runner files, execute toy runners locally and report exit status/stdout/stderr evidence.
- If a Python runner fails due missing modules, attempt one automatic dependency install (python -m pip install ...) and retry once, then report the final status transparently.
- For field evidence, treat as real dataset ONLY if it is tabular and validated (dataset_mime_valid=true AND dataset_parse_ok=true).
- Do not treat paper pages/HTML/PDF endpoints (e.g., /abs/, /pdf/) as direct datasets; first attempt table extraction and accept it only when the extracted table looks like real field data (tabular, validated, >=30 rows, non-metadata).
- If no real validated dataset is found, keep NEEDS_FIELD and ask the user (AskUserQuestion) how to proceed.
- Field runners must print \`AMAWTA_EVIDENCE_CONTRACT=<json>\` with, at minimum:
  - phase, dataset_used, dataset_source, dataset_source_type, dataset_format, dataset_mime_valid, dataset_parse_ok, n_rows, lobo_folds, runner_contract, truth_assessment.
- When available, include advanced universal-gate metrics in the same contract:
  - delta_bits, delta_bic, h2, h4, frag, lobo_pass, existence, topology, energy_available, energy_required, energy_delta, information_delta_bits, information_delta_bic.
- Prefer explicit local/URL dataset references from \`dataset_hint\` when present.
- Do not hardcode fixed dataset URLs or absolute local paths in generated runners unless those references were explicitly provided in inputs (\`dataset_hint\`, falsification data_requests, or user prompt context).
- For field runners, prefer abstract \`required_inputs\` placeholders and let Pass 2 dataset discovery resolve/download the real dataset source.
- Before invoking this tool, tell the user in one short sentence what you will do.
- After tool execution, summarize runner ids/files/run commands briefly.

Few-shot guidance:
1) Pass 2 example, novel claim with known observables (penguins):
   - Claim: "Controlling for species and sex, larger flipper length implies larger body mass."
   - Correct dataset search target: tables with columns/proxies for
     flipper_length_mm, body_mass_g, species, sex.
   - Incorrect target: papers that explicitly claim this exact sentence.
2) Pass 2 example, theoretical claim with proxy validation:
   - Claim: "Higher curvature proxy implies lower control effort under convex costs."
   - Correct dataset search target: time-series/experimental tables with measurable proxies for curvature and effort, plus controls.
   - If only concept papers are found (no usable tabular measurements), keep NEEDS_FIELD and ask user for URL/path or extended search.` 
