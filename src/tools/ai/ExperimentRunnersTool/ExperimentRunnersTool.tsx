import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import { type Hunk } from 'diff'
import { spawnSync } from 'child_process'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { FileEditToolUpdatedMessage } from '@components/FileEditToolUpdatedMessage'
import { Tool, ToolUseContext } from '@tool'
import { getModelManager } from '@utils/model'
import { queryQuick } from '@services/ai/llm'
import { hasWritePermission } from '@utils/permissions/filesystem'
import { getCwd } from '@utils/state'
import { getTheme } from '@utils/theme'
import { createAssistantMessage } from '@utils/messages'
import { getPatch } from '@utils/text/diff'
import { runRunnerBuilderAgent } from '@services/ai/agents/runnerBuilderAgent'
import { waitForReadyFalsificationResultForTurn } from '@tools/ai/FalsificationPlanTool/FalsificationPlanTool'
import type { ExperimentRunnersResult } from '@services/ai/types/adkDialectic'
import {
  searchProviders,
  type SearchResult,
} from '@tools/network/WebSearchTool/searchProviders'
import { DESCRIPTION, PROMPT, TOOL_NAME } from './prompt'

const inputSchema = z.strictObject({
  hypothesis_query: z
    .string()
    .min(8)
    .describe('Current hypothesis to convert into starter experiment runners'),
  dialectical_synthesis: z
    .string()
    .optional()
    .describe('Dialectical synthesis from DialecticalAnalysis'),
  baconian_forma_veritas: z
    .string()
    .optional()
    .describe('Baconian forma veritas from BaconianAnalysis'),
  normalization_json: z
    .string()
    .optional()
    .describe('Normalization JSON or text'),
  falsification_plan_json: z
    .string()
    .optional()
    .describe('Falsification plan JSON or text'),
  literature_summary: z
    .string()
    .optional()
    .describe('Optional literature summary'),
  dataset_hint: z
    .string()
    .optional()
    .describe(
      'Optional dataset URL/path hint coming from AskUserQuestion decisions',
    ),
})

type Input = z.infer<typeof inputSchema>

type MaterializedRunnerFile = {
  id: string
  language: 'python' | 'bash' | 'pseudo'
  relativePath: string
  status: 'created' | 'updated' | 'unchanged'
}

type RunnerDefinitionPreview = {
  id: string
  relativePath: string
  preview: string
}

type MaterializedRunnerDiff = {
  relativePath: string
  structuredPatch: Hunk[]
}

type RunnerExecutionResult = {
  id: string
  relativePath: string
  cwd: string
  command: string
  status: 'success' | 'failed' | 'skipped'
  exitCode: number | null
  durationMs: number
  stdoutRaw?: string
  stderrRaw?: string
  stdoutPreview: string
  stderrPreview: string
  evidenceContract?: {
    phase?: 'toy' | 'field' | 'both'
    dataset_used?: boolean
    dataset_source?: 'real' | 'synthetic' | 'unknown'
    dataset_source_type?: 'url' | 'local' | 'unknown'
    dataset_format?: 'csv' | 'tsv' | 'jsonl' | 'parquet' | 'unknown'
    dataset_mime_type?: string
    dataset_mime_valid?: boolean
    dataset_parse_ok?: boolean
    n_cols?: number
    header_detected?: boolean
    dataset_checksum_sha256?: string
    dataset_source_uri?: string
    n_rows?: number
    lobo_folds?: number
    runner_contract?: 'PASS' | 'FAIL'
    truth_assessment?: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
    delta_bits?: number
    delta_bic?: number
    h4?: number
    h2?: number
    frag?: number
    lobo_pass?: boolean
    existence?: 'EXISTS' | 'INEFFICIENT' | 'NONEXISTENT'
    topology?: string
    energy_available?: number
    energy_required?: number
    energy_delta?: number
    information_delta_bits?: number
    information_delta_bic?: number
    column_hints?: string[]
  }
  reason?: string
}

type PlanRunner = ExperimentRunnersResult['experiment_runners']['runners'][number]

type ToyStatus = 'not_executed' | 'executed' | 'success'
type ToyTruthAssessment = 'PASS' | 'FAIL' | 'INCONCLUSIVE'
type RunnerContractStatus = 'PASS' | 'FAIL'
type EvidenceSufficiencyStatus = 'PASS' | 'FAIL'
type GateVerdict = 'PASS' | 'UNRESOLVED' | 'FAIL'
type StageDecision =
  | 'REJECT_EARLY'
  | 'PROVISIONAL_PASS'
  | 'NEEDS_FIELD'
  | 'DEFINITIVE_PASS'
  | 'DEFINITIVE_FAIL'

type GateVerdictReport = {
  status: GateVerdict
  reason: string
}

type UmcV1GateReport = GateVerdictReport & {
  metrics: {
    delta_bits?: number
    delta_bic?: number
    h4?: number
    h2?: number
    frag?: number
    lobo_pass?: boolean
  }
}

type RunnerGateStack = {
  ontology: {
    claim_well_formed: GateVerdictReport
  }
  epistemic: {
    falsification_plan_quality: GateVerdictReport
    evidence_gate: GateVerdictReport
  }
  operational: {
    runner_contract: GateVerdictReport
    toy_truth_assessment: GateVerdictReport
  }
  universal: {
    umc_v1: UmcV1GateReport
    ledger_closure: GateVerdictReport
  }
  overall: GateVerdict
}

type RunnerGateReport = {
  toy: {
    status: ToyStatus
    truthAssessment: ToyTruthAssessment
    passTests: number
    failTests: number
    logicalContradiction: boolean
  }
  field: {
    shouldAdvance: boolean
    reason: string
  }
  runnerContract: {
    status: RunnerContractStatus
    reason: string
  }
  evidenceSufficiency: {
    status: EvidenceSufficiencyStatus
    datasetUsed: boolean
    hasRealDataset: boolean
    nRows: number
    loboFolds: number
    claimDatasetFit: boolean
    claimDatasetFitMatchedTokens: number
    claimDatasetFitRequiredTokens: number
    claimDatasetFitReason: string
  }
  stageDecision: StageDecision
  stageReason: string
  nextAction: string
  gateStack: RunnerGateStack
}

type ClaimSemanticProfile = {
  tokens: string[]
  minMatches: number
}

type LiteratureAffinityReport = {
  queries: string[]
  results: SearchResult[]
  semanticFit: {
    pass: boolean
    matched: number
    required: number
    reason: string
  }
  datasetCandidates: string[]
  keywordHints: string[]
}

type DatasetDiscoveryAdvisorMapping = {
  claimVariable: string
  datasetProxy: string
  note: string
}

type DatasetDiscoveryAdvisorPlan = {
  searchQueries: string[]
  seedUrls: string[]
  keywordHints: string[]
  observableMapping: DatasetDiscoveryAdvisorMapping[]
  notes: string
}

type CriticalRunnerVerdict = {
  runnerId: string
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  reason: string
}

type CriticalRunnerVerdictSummary = {
  overall: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  items: CriticalRunnerVerdict[]
}

type Output = {
  analysis: string
  retriesUsed: number
  model: string
  planStatus: 'ready' | 'skipped'
  runnersCount: number
  executionOrder: string[]
  nextAction: string
  hypothesisSnapshot: string
  runnersDir: string
  materializedFiles: MaterializedRunnerFile[]
  materializedDiffs: MaterializedRunnerDiff[]
  executionResults: RunnerExecutionResult[]
  installedDependencies: string[]
  dependencyInstallError?: string
  fromCacheReuse?: boolean
  definitionPreviews: RunnerDefinitionPreview[]
  gates: RunnerGateReport
  criticalVerdicts: CriticalRunnerVerdictSummary
  gateArtifactPath?: string
  plan: ExperimentRunnersResult
}

type PreparedExperimentRunnersOutput = Omit<
  Output,
  | 'executionResults'
  | 'installedDependencies'
  | 'dependencyInstallError'
  | 'gates'
  | 'criticalVerdicts'
>

type CachedExperimentRunnersResult = {
  output: Output
  createdAt: number
}

const recentExperimentRunnersCache = new Map<
  string,
  CachedExperimentRunnersResult
>()
const inFlightExperimentRunnersRuns = new Map<string, Promise<Output>>()
const inFlightExperimentRunnersRunsByTurn = new Map<string, Promise<Output>>()
const turnScopedExperimentRunnersResultCache = new Map<
  string,
  CachedExperimentRunnersResult
>()
const EXPERIMENT_RUNNERS_CACHE_TTL_MS = 30_000
const EXPERIMENT_RUNNERS_TURN_CACHE_TTL_MS = 5 * 60_000
const EXPERIMENT_RUNNERS_CACHE_VERSION = 'v2'
const EXPERIMENT_RUNNERS_OUTPUT_DIR = 'amawta-runners'
const EXPERIMENT_RUNNERS_GATE_ARTIFACT_BASENAME = 'gate-report.latest.json'
const EXPERIMENT_DATASET_OUTPUT_DIR = `${EXPERIMENT_RUNNERS_OUTPUT_DIR}/datasets`
const DEFAULT_RUNNER_TIMEOUT_MS = 20_000
const MAX_RUNNER_OUTPUT_PREVIEW_CHARS = 240
const MAX_RUNNER_OUTPUT_RAW_CHARS = 12_000
const DEFAULT_PIP_INSTALL_TIMEOUT_MS = 120_000
const DEFAULT_VENV_SETUP_TIMEOUT_MS = 120_000
const DEFAULT_DATASET_DOWNLOAD_TIMEOUT_MS = 20_000
const DEFAULT_DATASET_WEB_DISCOVERY_TIMEOUT_MS = 10_000
const DEFAULT_DATASET_DISCOVERY_AGENT_TIMEOUT_MS = 15_000
const MAX_DATASET_DOWNLOAD_BYTES = 15 * 1024 * 1024
const MAX_WEB_DATASET_DISCOVERY_QUERIES = 8
const MAX_WEB_DATASET_DISCOVERY_CANDIDATES = 40
const DEFAULT_FIELD_RESOLVE_TOP_K = 5
const MAX_FIELD_RESOLVE_TOP_K = 12
const FIELD_RESOLVE_TOP_K = (() => {
  const parsed = Number.parseInt(
    (process.env.AMAWTA_FIELD_RESOLVE_TOP_K || '').trim(),
    10,
  )
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FIELD_RESOLVE_TOP_K
  }
  return Math.max(1, Math.min(parsed, MAX_FIELD_RESOLVE_TOP_K))
})()
const MAX_DATASET_DISCOVERY_AGENT_QUERIES = 8
const MAX_DATASET_DISCOVERY_AGENT_SEEDS = 16
const MAX_DATASET_DISCOVERY_AGENT_HINTS = 12
const MAX_LITERATURE_AFFINITY_QUERIES = 3
const MAX_LITERATURE_AFFINITY_RESULTS = 24
const MIN_LOCAL_DATASET_CANDIDATE_SCORE = 20
const DATASET_ALLOWED_EXTENSIONS = new Set(['csv', 'tsv', 'jsonl', 'parquet'])
const DATASET_HTML_MIME_REGEX = /\btext\/html\b/i
const DATASET_DISALLOWED_MIME_REGEX = /\b(application\/pdf|text\/html)\b/i
const DATASET_ALLOWED_MIME_REGEX =
  /\b(text\/csv|application\/csv|application\/vnd\.ms-excel|text\/tab-separated-values|application\/x-ndjson|application\/ndjson|application\/json|application\/parquet|application\/octet-stream)\b/i
const DATASET_DISALLOWED_URL_PATH_REGEX = /\/abs\/|\/pdf\/|\.pdf(?:$|\?)/i
const DATASET_LANDING_DOMAIN_REGEX =
  /(?:^|\.)(raw\.githubusercontent\.com|github\.com|huggingface\.co|kaggle\.com|zenodo\.org|figshare\.com|osf\.io|physionet\.org|openneuro\.org|archive\.ics\.uci\.edu|datadryad\.org|mendeley\.com)$/i
const DATASET_LANDING_PATH_REGEX =
  /\b(dataset|datasets|data|download|downloads|record|records|resource|resources|file|files|supplement|table)\b/i
const MIN_PAPER_TABLE_DATASET_ROWS = 30
const MIN_PAPER_TABLE_NUMERIC_RATIO = 0.1
const ALLOW_SYNTHETIC_FIELD_AUTOREPAIR =
  process.env.AMAWTA_ENABLE_SYNTH_FIELD_AUTOREPAIR === '1'
const ALLOW_DATASET_WEB_DISCOVERY =
  (process.env.AMAWTA_AUTO_WEB_DATASET_DISCOVERY || '1')
    .trim()
    .toLowerCase() !== '0' &&
  (process.env.AMAWTA_AUTO_WEB_DATASET_DISCOVERY || '1')
    .trim()
    .toLowerCase() !== 'false' &&
  (process.env.AMAWTA_AUTO_WEB_DATASET_DISCOVERY || '1')
    .trim()
    .toLowerCase() !== 'off' &&
  (process.env.AMAWTA_AUTO_WEB_DATASET_DISCOVERY || '1')
    .trim()
    .toLowerCase() !== 'no'
const PREINSTALL_SAFE_PY_PACKAGES = new Set([
  'numpy',
  'scipy',
  'pandas',
  'matplotlib',
  'scikit-learn',
  'sympy',
  'statsmodels',
  'networkx',
])
const PASS_SIGNAL_REGEX =
  /\b(pass|passed|signal_detected|confirmed|validado|soportada|success)\b/i
const FAIL_SIGNAL_REGEX =
  /\b(fail|failed|failure|falsified|falsado|falsificacion|falsification|refuted|contradicted|rejected|signal_not_detected|signal_failed)\b/i
const EXPLICIT_FAIL_ASSIGNMENT_REGEX =
  /\b(status|result|resultado|verdict)\s*[:=]\s*(fail(?:ed|ure)?|falsified|falsado|signal_not_detected|signal_failed|refuted|contradicted|rejected)\b/i
const NEGATED_FAIL_SIGNAL_REGEX =
  /\b(?:falsified|falsado)\b(?:[^\n]{0,40})[:=]\s*(?:false|0)\b|\b(?:falsified|falsado|fail(?:ed|ure)?|refuted|rejected|contradicted)\b\s*[:=]?\s*(?:false|0)\b|\bno\s+(?:falsado|falsified|fallo|falla|failure|failed)\b|\bnot\s+(?:falsified|failed|failure|refuted|rejected|contradicted)\b/i
const EXPECTED_FAIL_CONTEXT_REGEX =
  /\b(?:expected|esperad[oa])\b[^\n]{0,100}\b(?:negative|negativ[oa]|fail(?:ed|ure)?|falsified|falsado|refuted)\b/i
const RUNTIME_ERROR_SIGNAL_REGEX =
  /\b(traceback|module(?:notfound)?error|syntaxerror|filenotfounderror|importerror|permissionerror|jsondecodeerror)\b|\berror:\s*(?!promedio\b)(?:\[[^\]]+\]|no such file|cannot|failed|exception|traceback|module|file|nameerror|syntaxerror|[a-z])|\berror al cargar datos\b/i
// Keep this strict: "dataset" words alone are too noisy (e.g. "test"/"train" in file names)
// and can accidentally satisfy field-evidence gates without a real tabular dataset.
const DATASET_HINT_REGEX =
  /https?:\/\/\S+\.(?:csv|tsv|jsonl|parquet|zip|xlsx?)\b|(?:^|[\s"'`])(?:\.{0,2}\/|\/|[a-zA-Z]:\\)[^\s"'`]+\.(?:csv|tsv|jsonl|parquet|sqlite|db|zip|xlsx?)\b|\b[\w.-]+\.(?:csv|tsv|jsonl|parquet|sqlite|db|zip|xlsx?)\b/i
const SYNTHETIC_DATASET_SIGNAL_REGEX =
  /(synthetic|sintetico|toy|mock|dummy|autorepair)/i
const EVIDENCE_CONTRACT_PREFIX = 'AMAWTA_EVIDENCE_CONTRACT='

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateForUi(text: string, max = 120): string {
  const normalized = normalizeInline(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function getReadableMutedColor(): string {
  const theme = getTheme()
  return theme.text === '#fff' ? '#b8b8b8' : '#555'
}

function truncatePreview(text: string, max = MAX_RUNNER_OUTPUT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function hasSignalHint(text: string, signal?: string): boolean {
  if (!signal) return false
  const normalizedText = normalizeInline(text || '').toLowerCase()
  const normalizedSignal = normalizeInline(signal).toLowerCase()
  if (!normalizedText || !normalizedSignal) return false
  return normalizedText.includes(normalizedSignal)
}

function detectRunSignals(
  text: string,
  hints?: { expectedSignal?: string; failureSignal?: string },
): { hasPass: boolean; hasFail: boolean } {
  const normalized = normalizeInline(text || '')
  if (!normalized) return { hasPass: false, hasFail: false }

  const hasPassHint = hasSignalHint(normalized, hints?.expectedSignal)
  const hasFailHint = hasSignalHint(normalized, hints?.failureSignal)
  if (hasPassHint || hasFailHint) {
    return { hasPass: hasPassHint, hasFail: hasFailHint }
  }

  const hasPass = PASS_SIGNAL_REGEX.test(normalized)
  const hasFailRaw = FAIL_SIGNAL_REGEX.test(normalized)
  const hasNegatedFail = NEGATED_FAIL_SIGNAL_REGEX.test(normalized)
  const hasExpectedFailContext = EXPECTED_FAIL_CONTEXT_REGEX.test(normalized)
  const hasFail = hasFailRaw && !hasNegatedFail && !hasExpectedFailContext

  return { hasPass, hasFail }
}

function hasRunRuntimeErrorSignal(text: string): boolean {
  const normalized = normalizeInline(text || '')
  if (!normalized) return false
  return RUNTIME_ERROR_SIGNAL_REGEX.test(normalized)
}

function hasConcreteDatasetReference(text: string): boolean {
  const normalized = normalizeInline(text || '')
  if (!normalized) return false
  return (
    /https?:\/\/\S+\.(csv|tsv|jsonl|parquet|json|xlsx?|zip)\b/i.test(
      normalized,
    ) ||
    /(?:^|[\s"'`])(?:\.{0,2}\/|\/|[a-zA-Z]:\\)[^\s"'`]+\.(csv|tsv|jsonl|parquet|json|xlsx?|zip)\b/i.test(
      normalized,
    ) ||
    /\b[\w.-]+\.(csv|tsv|jsonl|parquet|json|xlsx?|zip)\b/i.test(normalized)
  )
}

function clampRawOutput(text: string, max = MAX_RUNNER_OUTPUT_RAW_CHARS): string {
  if (!text) return ''
  if (text.length <= max) return text.trimEnd()
  return `${text.slice(0, max)}\n...[truncated]`
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatRunSummaryLine(run: RunnerExecutionResult): string {
  return `Ran ${run.id}: ${run.status} · exit ${
    run.exitCode === null ? 'n/a' : run.exitCode
  } · ${formatDurationMs(run.durationMs)}`
}

function buildDatasetAskUserQuestionTemplate(): string {
  return [
    'questions=[{',
    'header:"Dataset",',
    'question:"No real tabular dataset was resolved automatically for field phase (with measurable variables/proxies to test this claim). How do you want to continue?",',
    'options:[',
    '{label:"Provide URL/path now (Recommended)",description:"You provide a real dataset that can operationalize the claim tests and field is retried."},',
    '{label:"Authorize extended web search",description:"Try additional web discovery for datasets with measurable variables/proxies (not exact-claim matches)."},',
    '{label:"Use provisional synthetic",description:"Allow provisional progress without definitive closure."}',
    '],',
    'multiSelect:false',
    '}]',
  ].join('')
}

function formatRunCommandLine(run: RunnerExecutionResult): string | null {
  const raw = normalizeInline(run.command || '')
  const cwd = normalizeInline(run.cwd || '')
  const cmd =
    cwd.length > 0
      ? raw.split(`${cwd}${sep}`).join('./')
      : raw
  if (!cmd || cmd.startsWith('(')) return null
  return `Cmd ${run.id}: ${truncateForUi(cmd, 110)}`
}

function formatRunCwdLine(run: RunnerExecutionResult): string | null {
  const cwd = normalizeInline(run.cwd || '')
  if (!cwd) return null
  return `Cwd ${run.id}: ${truncateForUi(cwd, 110)}`
}

function formatRunDetailLine(run: RunnerExecutionResult): string | null {
  if (run.status === 'failed' && run.stderrPreview) {
    return `Err ${run.id}: ${truncateForUi(run.stderrPreview, 110)}`
  }
  if (run.status === 'success' && run.stdoutPreview) {
    return `Out ${run.id}: ${truncateForUi(run.stdoutPreview, 110)}`
  }
  if (run.reason) {
    return `Note ${run.id}: ${truncateForUi(run.reason, 110)}`
  }
  return null
}

function shouldPersistRunnerProgressLine(line: string): boolean {
  const normalized = normalizeInline(line)
  return (
    normalized.startsWith('stage_start: experiment_runners') ||
    normalized.startsWith('stage_end: experiment_runners') ||
    normalized.startsWith('tool_start:') ||
    normalized.startsWith('tool_end:')
  )
}

function buildRunTimelineLines(output: Output, verbose: boolean): string[] {
  const lines: string[] = []
  const runCount = output.executionResults.length
  if (runCount === 0) return lines
  lines.push('stage_start: experiment_runners')
  const shownRuns = verbose
    ? output.executionResults
    : output.executionResults.slice(0, 3)
  for (const run of shownRuns) {
    const cmd = normalizeInline(run.command || '')
    lines.push(
      `tool_start: ${run.id}${cmd ? ` cmd=${truncateForUi(cmd, verbose ? 180 : 90)}` : ''}`,
    )
    lines.push(
      `tool_end: ${run.id} status=${run.status} exit=${
        run.exitCode === null ? 'n/a' : run.exitCode
      } duration=${formatDurationMs(run.durationMs)}`,
    )
  }
  if (!verbose && output.executionResults.length > shownRuns.length) {
    lines.push(
      `... ${output.executionResults.length - shownRuns.length} tool(s) omitted in non-verbose view`,
    )
  }
  lines.push(
    `stage_end: experiment_runners runs=${runCount} ok=${
      output.executionResults.filter(r => r.status === 'success').length
    } fail=${output.executionResults.filter(r => r.status === 'failed').length} skipped=${
      output.executionResults.filter(r => r.status === 'skipped').length
    }`,
  )
  return lines
}

function persistRunnerGateArtifact(params: {
  gates: RunnerGateReport
  criticalVerdicts: CriticalRunnerVerdictSummary
  executionResults: RunnerExecutionResult[]
  hypothesisQuery: string
}): string | undefined {
  try {
    const cwd = getCwd()
    const relativePath = `${EXPERIMENT_RUNNERS_OUTPUT_DIR}/${EXPERIMENT_RUNNERS_GATE_ARTIFACT_BASENAME}`
    const absolutePath = resolve(cwd, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    const payload = {
      schema_version: 'amawta.gate-report.v1',
      generated_at: new Date().toISOString(),
      hypothesis_query: params.hypothesisQuery,
      gates: params.gates,
      critical_verdicts: params.criticalVerdicts,
      runs: params.executionResults.map(run => ({
        id: run.id,
        status: run.status,
        exit_code: run.exitCode,
        duration_ms: run.durationMs,
        reason: run.reason,
      })),
    }
    writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return relativePath
  } catch {
    return undefined
  }
}

function parseMaxMetric(text: string, patterns: RegExp[]): number {
  let max = 0
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern)
    for (const match of matches) {
      const value = Number.parseInt(match[1] || '', 10)
      if (Number.isFinite(value)) {
        max = Math.max(max, value)
      }
    }
  }
  return max
}

function parseFirstFloatMetric(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern)
    for (const match of matches) {
      const value = Number.parseFloat((match[1] || '').trim())
      if (Number.isFinite(value)) {
        return value
      }
    }
  }
  return undefined
}

function parseFirstBooleanMetric(
  text: string,
  patterns: RegExp[],
): boolean | undefined {
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern)
    for (const match of matches) {
      const normalized = normalizeInline(match[1] || '').toLowerCase()
      if (!normalized) continue
      if (
        normalized === 'true' ||
        normalized === 'pass' ||
        normalized === 'yes' ||
        normalized === '1'
      ) {
        return true
      }
      if (
        normalized === 'false' ||
        normalized === 'fail' ||
        normalized === 'no' ||
        normalized === '0'
      ) {
        return false
      }
    }
  }
  return undefined
}

function parseTriGateStatusFromStageDecision(stageDecision: StageDecision): GateVerdict {
  if (stageDecision === 'DEFINITIVE_PASS') return 'PASS'
  if (stageDecision === 'REJECT_EARLY' || stageDecision === 'DEFINITIVE_FAIL') {
    return 'FAIL'
  }
  return 'UNRESOLVED'
}

function parseNormalizationGate(raw?: string): GateVerdictReport {
  const text = (raw || '').trim()
  if (!text) {
    return {
      status: 'UNRESOLVED',
      reason: 'No normalization_json available to evaluate claim_well_formed.',
    }
  }

  try {
    const parsed = JSON.parse(text) as {
      hypothesis_normalization?: {
        claim?: unknown
        domain?: unknown
        relation?: unknown
        observables?: unknown
        missing_fields?: unknown
      }
    }
    const normalization = parsed.hypothesis_normalization
    if (!normalization || typeof normalization !== 'object') {
      return {
        status: 'UNRESOLVED',
        reason:
          'normalization_json does not contain a valid hypothesis_normalization (non-strict format).',
      }
    }

    const missingFields = Array.isArray(normalization.missing_fields)
      ? normalization.missing_fields.filter(value => typeof value === 'string')
      : []
    if (missingFields.length > 0) {
      return {
        status: 'UNRESOLVED',
        reason: `Missing core fields in normalization: ${missingFields.join(', ')}.`,
      }
    }

    const hasCoreFields =
      typeof normalization.claim === 'string' &&
      normalizeInline(normalization.claim).length > 0 &&
      typeof normalization.domain === 'string' &&
      normalizeInline(normalization.domain).length > 0 &&
      typeof normalization.relation === 'string' &&
      normalizeInline(normalization.relation).length > 0 &&
      ((Array.isArray(normalization.observables) &&
        normalization.observables.some(value =>
          typeof value === 'string' ? normalizeInline(value).length > 0 : false,
        )) ||
        (typeof normalization.observables === 'string' &&
          normalizeInline(normalization.observables).length > 0))

    if (!hasCoreFields) {
      return {
        status: 'UNRESOLVED',
        reason:
          'Incomplete or inconsistent normalization: missing claim/domain/relation/observables.',
      }
    }

    return {
      status: 'PASS',
      reason: 'Claim normalized with complete core fields and no missing_fields.',
    }
  } catch {
    return {
      status: 'UNRESOLVED',
      reason: 'normalization_json is not valid JSON (unstructured input).',
    }
  }
}

const CLAIM_SEMANTIC_STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'for',
  'that',
  'this',
  'from',
  'into',
  'under',
  'over',
  'between',
  'greater',
  'implies',
  'controlling',
  'controlando',
  'hipotesis',
  'hypothesis',
  'dataset',
  'field',
  'real',
  'data',
  'model',
  'claim',
  'domain',
  'relation',
  'observables',
  'con',
  'para',
  'por',
  'del',
  'las',
  'los',
  'que',
  'como',
  'mayor',
  'implica',
])

function normalizeSemanticToken(value: string): string {
  return normalizeInline(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function addSemanticTokensFromText(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  const normalized = normalizeInline(value).toLowerCase()
  if (!normalized) return
  const pieces = normalized
    .split(/[^a-z0-9_]+/g)
    .map(token => token.trim())
    .filter(Boolean)
  for (const piece of pieces) {
    const token = normalizeSemanticToken(piece)
    if (!token) continue
    if (token.length < 3) continue
    if (CLAIM_SEMANTIC_STOPWORDS.has(token)) continue
    target.add(token)
  }
}

function deriveClaimSemanticProfile(params: {
  hypothesisQuery: string
  normalizationRaw?: string
}): ClaimSemanticProfile {
  const tokens = new Set<string>()
  const normalizedRaw = (params.normalizationRaw || '').trim()
  if (normalizedRaw) {
    try {
      const parsed = JSON.parse(normalizedRaw) as {
        hypothesis_normalization?: {
          claim?: unknown
          domain?: unknown
          relation?: unknown
          observables?: unknown
        }
      }
      const normalization = parsed.hypothesis_normalization
      if (normalization && typeof normalization === 'object') {
        addSemanticTokensFromText(tokens, normalization.claim)
        addSemanticTokensFromText(tokens, normalization.domain)
        addSemanticTokensFromText(tokens, normalization.relation)
        if (Array.isArray(normalization.observables)) {
          for (const observable of normalization.observables) {
            addSemanticTokensFromText(tokens, observable)
          }
        } else {
          addSemanticTokensFromText(tokens, normalization.observables)
        }
      }
    } catch {
      // Keep best-effort profile from hypothesis text only.
    }
  }

  if (tokens.size === 0) {
    for (const keyword of inferDatasetKeywordsFromHypothesis(params.hypothesisQuery)) {
      const token = normalizeSemanticToken(keyword)
      if (!token) continue
      if (token.length < 3) continue
      if (CLAIM_SEMANTIC_STOPWORDS.has(token)) continue
      tokens.add(token)
    }
  }

  const sortedTokens = Array.from(tokens).sort()
  const limitedTokens = sortedTokens.slice(0, 18)
  const minMatches =
    limitedTokens.length >= 9
      ? 4
      : limitedTokens.length >= 6
        ? 3
        : limitedTokens.length >= 3
          ? 2
          : limitedTokens.length >= 1
            ? 1
            : 0

  return { tokens: limitedTokens, minMatches }
}

function deriveDatasetDiscoverySemanticProfile(params: {
  baseProfile?: ClaimSemanticProfile
  hypothesisQuery: string
  falsificationRaw?: string
  keywordHints?: string[]
  advisorPlan?: DatasetDiscoveryAdvisorPlan | null
}): ClaimSemanticProfile | undefined {
  const tokens = new Set<string>()
  for (const token of params.baseProfile?.tokens || []) {
    const normalized = normalizeSemanticToken(token)
    if (!normalized) continue
    if (normalized.length < 3) continue
    if (CLAIM_SEMANTIC_STOPWORDS.has(normalized)) continue
    tokens.add(normalized)
  }

  addSemanticTokensFromText(tokens, params.hypothesisQuery)
  for (const hint of params.keywordHints || []) {
    addSemanticTokensFromText(tokens, hint)
  }
  for (const request of tryParseFalsificationDataRequests(params.falsificationRaw)) {
    addSemanticTokensFromText(tokens, request)
  }

  const advisor = params.advisorPlan
  if (advisor) {
    for (const query of advisor.searchQueries || []) {
      addSemanticTokensFromText(tokens, query)
    }
    for (const hint of advisor.keywordHints || []) {
      addSemanticTokensFromText(tokens, hint)
    }
    for (const seed of advisor.seedUrls || []) {
      addSemanticTokensFromText(tokens, seed)
    }
    for (const mapping of advisor.observableMapping || []) {
      addSemanticTokensFromText(tokens, mapping.claimVariable)
      addSemanticTokensFromText(tokens, mapping.datasetProxy)
      addSemanticTokensFromText(tokens, mapping.note)
    }
  }

  if (tokens.size === 0) return params.baseProfile

  const sortedTokens = Array.from(tokens).sort().slice(0, 24)
  const derivedMinMatches =
    sortedTokens.length >= 12
      ? 4
      : sortedTokens.length >= 8
        ? 3
        : sortedTokens.length >= 4
          ? 2
          : sortedTokens.length >= 1
            ? 1
            : 0
  const baseMinMatches =
    typeof params.baseProfile?.minMatches === 'number' &&
    Number.isFinite(params.baseProfile.minMatches)
      ? params.baseProfile.minMatches
      : undefined
  const minMatches =
    typeof baseMinMatches === 'number'
      ? Math.max(1, Math.min(baseMinMatches, derivedMinMatches || 1))
      : derivedMinMatches

  return {
    tokens: sortedTokens,
    minMatches,
  }
}

function collectSemanticEvidenceTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalizedText = normalizeInline(text || '').toLowerCase()
  for (const raw of normalizedText.split(/[^a-z0-9_]+/g)) {
    const token = normalizeSemanticToken(raw)
    if (!token || token.length < 2) continue
    tokens.add(token)
    if (token.includes('_')) {
      for (const part of token.split('_')) {
        const normalizedPart = normalizeSemanticToken(part)
        if (!normalizedPart || normalizedPart.length < 2) continue
        tokens.add(normalizedPart)
      }
    }
  }
  // Secondary split that treats underscores as separators too.
  for (const raw of normalizedText.split(/[^a-z0-9]+/g)) {
    const token = normalizeSemanticToken(raw)
    if (!token || token.length < 2) continue
    tokens.add(token)
  }
  return tokens
}

function evaluateSemanticFitAgainstText(params: {
  profile?: ClaimSemanticProfile
  text: string
}): {
  pass: boolean
  matched: number
  required: number
  reason: string
} {
  const tokens = params.profile?.tokens || []
  const required = params.profile?.minMatches || 0
  if (tokens.length === 0 || required <= 0) {
    return {
      pass: true,
      matched: 0,
      required: 0,
      reason: 'Not enough semantic observables to evaluate relevance; treated as neutral.',
    }
  }

  const normalizedText = normalizeInline(params.text || '').toLowerCase()
  if (!normalizedText) {
    return {
      pass: false,
      matched: 0,
      required,
      reason: 'No textual signals to validate dataset-claim relevance.',
    }
  }

  const evidenceTokens = collectSemanticEvidenceTokens(normalizedText)
  const matchedTokens = new Set<string>()
  for (const token of tokens) {
    if (!token) continue
    if (evidenceTokens.has(token)) {
      matchedTokens.add(token)
      continue
    }
    const hasNearMatch = Array.from(evidenceTokens).some(candidate => {
      if (!candidate) return false
      if (candidate === token) return true
      if (token.length >= 5 && candidate.startsWith(token.slice(0, 4))) return true
      if (candidate.length >= 5 && token.startsWith(candidate.slice(0, 4))) return true
      return false
    })
    if (hasNearMatch) {
      matchedTokens.add(token)
    }
  }

  const matched = matchedTokens.size
  const pass = matched >= required
  return {
    pass,
    matched,
    required,
    reason: pass
      ? `Pertinencia semantica PASS (${matched}/${tokens.length} tokens, min=${required}).`
      : `Pertinencia semantica FAIL (${matched}/${tokens.length} tokens, min=${required}).`,
  }
}

function parseFalsificationPlanQualityGate(raw?: string): GateVerdictReport {
  const text = (raw || '').trim()
  if (!text) {
    return {
      status: 'UNRESOLVED',
        reason: 'No falsification_plan_json available to validate plan quality.',
    }
  }

  try {
    const parsed = JSON.parse(text) as {
      falsification_plan?: {
        meta?: { plan_version?: string; status?: string; reason?: string }
        tests?: Array<Record<string, unknown>>
        test_matrix?: {
          axes?: Array<Record<string, unknown>>
          variants?: Array<Record<string, unknown>>
        }
      }
    }
    const plan = parsed.falsification_plan
    if (!plan || typeof plan !== 'object') {
      return {
        status: 'UNRESOLVED',
        reason:
          'falsification_plan_json does not contain a valid falsification_plan (non-strict format).',
      }
    }

    if (plan.meta?.status === 'skipped') {
      return {
        status: 'UNRESOLVED',
        reason: `FalsificationPlan skipped (${plan.meta.reason || 'no explicit reason'}).`,
      }
    }

    const tests = Array.isArray(plan.tests) ? plan.tests : []
    const variants = Array.isArray(plan.test_matrix?.variants)
      ? plan.test_matrix?.variants || []
      : []
    const axes = Array.isArray(plan.test_matrix?.axes)
      ? plan.test_matrix?.axes || []
      : []

    if (tests.length === 0) {
      return {
        status: 'FAIL',
        reason: 'Falsification plan has no tests.',
      }
    }

    if (variants.length > 5) {
      return {
        status: 'FAIL',
        reason: `Falsification plan exceeds allowed variants (${variants.length} > 5).`,
      }
    }

    if (axes.length === 0) {
      return {
        status: 'FAIL',
        reason: 'Falsification plan has no axes (test_matrix.axes is empty).',
      }
    }

    const requiredTestFields = [
      'id',
      'goal',
      'method',
      'minimal_data',
      'procedure',
      'what_would_falsify',
      'confounds',
    ]
    const hasMalformedTest = tests.some(test =>
      requiredTestFields.some(field => {
        const value = test[field]
        return typeof value !== 'string' || normalizeInline(value).length === 0
      }),
    )
    if (hasMalformedTest) {
      return {
        status: 'FAIL',
        reason: 'Al menos un test del plan no cumple campos obligatorios.',
      }
    }

    if (plan.meta?.plan_version !== 'falsification-plan-v1') {
      return {
        status: 'FAIL',
        reason: `Version de plan invalida (${String(plan.meta?.plan_version || 'unknown')}).`,
      }
    }

    return {
      status: 'PASS',
      reason:
        'Plan ready con tests validos, matriz acotada y ejes presentes (falsification-plan-v1).',
    }
  } catch {
    return {
      status: 'UNRESOLVED',
      reason: 'falsification_plan_json no es JSON valido (entrada no estructurada).',
    }
  }
}

function parseEvidenceContractFromText(
  stdout?: string,
  stderr?: string,
): RunnerExecutionResult['evidenceContract'] | undefined {
  const normalizeTruthAssessment = (
    raw: unknown,
  ): NonNullable<
    RunnerExecutionResult['evidenceContract']
  >['truth_assessment'] | undefined => {
    if (raw === 'PASS' || raw === 'FAIL' || raw === 'INCONCLUSIVE') return raw
    if (typeof raw === 'boolean') return raw ? 'PASS' : 'FAIL'
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw !== 0 ? 'PASS' : 'FAIL'
    if (typeof raw !== 'string') return undefined
    const normalized = normalizeInline(raw).toLowerCase()
    if (!normalized) return undefined
    if (
      normalized === 'pass' ||
      normalized === 'supported' ||
      normalized === 'support' ||
      normalized === 'confirmed' ||
      normalized === 'valid' ||
      normalized === 'true'
    ) {
      return 'PASS'
    }
    if (
      normalized === 'fail' ||
      normalized === 'contradicted' ||
      normalized === 'falsified' ||
      normalized === 'rejected' ||
      normalized === 'refuted' ||
      normalized === 'false'
    ) {
      return 'FAIL'
    }
    if (
      normalized === 'inconclusive' ||
      normalized === 'mixed' ||
      normalized === 'ambiguous' ||
      normalized === 'ambiguo'
    ) {
      return 'INCONCLUSIVE'
    }
    return undefined
  }

  const normalizeRunnerContract = (
    raw: unknown,
    truthAssessment?: NonNullable<
      RunnerExecutionResult['evidenceContract']
    >['truth_assessment'],
  ): NonNullable<
    RunnerExecutionResult['evidenceContract']
  >['runner_contract'] | undefined => {
    if (raw === 'PASS' || raw === 'FAIL') return raw
    if (typeof raw === 'boolean') return raw ? 'PASS' : 'FAIL'
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw !== 0 ? 'PASS' : 'FAIL'
    }
    if (typeof raw === 'string') {
      const normalized = normalizeInline(raw).toLowerCase()
      if (!normalized) return undefined
      if (
        normalized === 'pass' ||
        normalized === 'ok' ||
        normalized === 'success' ||
        normalized === 'supported' ||
        normalized === 'confirmed' ||
        normalized === 'true'
      ) {
        return 'PASS'
      }
      if (
        normalized === 'fail' ||
        normalized === 'error' ||
        normalized === 'falsified' ||
        normalized === 'refuted' ||
        normalized === 'rejected' ||
        normalized === 'false'
      ) {
        return 'FAIL'
      }
    }
    if (truthAssessment === 'PASS' || truthAssessment === 'FAIL') {
      return truthAssessment
    }
    return undefined
  }

  const parseBooleanish = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return undefined
      return value !== 0
    }
    if (typeof value !== 'string') return undefined
    const normalized = normalizeInline(value).toLowerCase()
    if (!normalized) return undefined
    if (
      normalized === 'true' ||
      normalized === 'yes' ||
      normalized === 'si' ||
      normalized === 'y' ||
      normalized === '1'
    ) {
      return true
    }
    if (
      normalized === 'false' ||
      normalized === 'no' ||
      normalized === 'n' ||
      normalized === '0'
    ) {
      return false
    }
    return true
  }

  const parseNumberish = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') return undefined
    const parsed = Number.parseFloat(normalizeInline(value))
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const parseIntegerish = (value: unknown): number | undefined => {
    const parsed = parseNumberish(value)
    if (typeof parsed !== 'number') return undefined
    return Math.max(0, Math.trunc(parsed))
  }

  const parseStringList = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
      const items = value
        .map(item => (typeof item === 'string' ? normalizeSemanticToken(item) : ''))
        .filter(Boolean)
      return items.length > 0 ? Array.from(new Set(items)).slice(0, 64) : undefined
    }
    if (typeof value === 'string') {
      const parts = value
        .split(/[;,]\s*|\s+/)
        .map(part => normalizeSemanticToken(part))
        .filter(Boolean)
      return parts.length > 0 ? Array.from(new Set(parts)).slice(0, 64) : undefined
    }
    return undefined
  }

  const normalizeExistence = (
    value: unknown,
  ): NonNullable<RunnerExecutionResult['evidenceContract']>['existence'] => {
    if (typeof value !== 'string') return undefined
    const normalized = normalizeInline(value).toUpperCase()
    if (
      normalized === 'EXISTS' ||
      normalized === 'INEFFICIENT' ||
      normalized === 'NONEXISTENT'
    ) {
      return normalized
    }
    return undefined
  }

  const inferDatasetSource = (
    rawSource: unknown,
    rawUri?: unknown,
  ): NonNullable<RunnerExecutionResult['evidenceContract']>['dataset_source'] => {
    const source = typeof rawSource === 'string' ? normalizeInline(rawSource) : ''
    const normalized = source.toLowerCase()
    if (normalized === 'real' || normalized === 'synthetic' || normalized === 'unknown') {
      return normalized
    }
    const uriCandidate =
      typeof rawUri === 'string' && normalizeInline(rawUri)
        ? normalizeInline(rawUri)
        : source
    if (uriCandidate && hasConcreteDatasetReference(uriCandidate)) {
      return 'real'
    }
    return 'unknown'
  }

  const normalizeDatasetSourceType = (
    raw: unknown,
  ): NonNullable<RunnerExecutionResult['evidenceContract']>['dataset_source_type'] => {
    if (typeof raw !== 'string') return undefined
    const normalized = normalizeInline(raw).toLowerCase()
    if (!normalized) return undefined
    if (
      normalized === 'url' ||
      normalized === 'http' ||
      normalized === 'https'
    ) {
      return 'url'
    }
    if (
      normalized === 'local' ||
      normalized === 'file' ||
      normalized === 'path' ||
      normalized.startsWith('local_') ||
      normalized.includes('local')
    ) {
      return 'local'
    }
    if (
      normalized === 'unknown' ||
      normalized === 'none' ||
      normalized === 'n/a'
    ) {
      return 'unknown'
    }
    return undefined
  }

  const normalizeDatasetFormat = (
    raw: unknown,
  ): NonNullable<RunnerExecutionResult['evidenceContract']>['dataset_format'] => {
    if (typeof raw !== 'string') return undefined
    const normalized = normalizeInline(raw).toLowerCase()
    if (!normalized) return undefined
    if (normalized === 'csv' || normalized === 'tsv' || normalized === 'parquet') {
      return normalized
    }
    if (
      normalized === 'jsonl' ||
      normalized === 'json' ||
      normalized === 'ndjson' ||
      normalized === 'jsonlines'
    ) {
      return 'jsonl'
    }
    if (normalized === 'unknown') return 'unknown'
    return undefined
  }

  const combined = `${stdout || ''}\n${stderr || ''}`
  const pattern = new RegExp(`${EVIDENCE_CONTRACT_PREFIX}(\\{[^\\n]+\\})`, 'g')
  let lastJson = ''
  for (const match of combined.matchAll(pattern)) {
    const candidate = (match[1] || '').trim()
    if (candidate) lastJson = candidate
  }
  if (!lastJson) return undefined
  try {
    const parsed = JSON.parse(lastJson) as Record<string, unknown>
    const phase =
      parsed.phase === 'toy' || parsed.phase === 'field' || parsed.phase === 'both'
        ? parsed.phase
        : undefined
    const truthAssessment = normalizeTruthAssessment(parsed.truth_assessment)
    const runnerContract = normalizeRunnerContract(
      parsed.runner_contract,
      truthAssessment,
    )
    const parsedDatasetUsed = parseBooleanish(parsed.dataset_used)
    const datasetSource = inferDatasetSource(
      parsed.dataset_source,
      parsed.dataset_source_uri,
    )
    const datasetSourceUri =
      typeof parsed.dataset_source_uri === 'string'
        ? normalizeInline(parsed.dataset_source_uri)
        : typeof parsed.dataset_source === 'string' &&
            hasConcreteDatasetReference(parsed.dataset_source)
          ? normalizeInline(parsed.dataset_source)
          : undefined
    return {
      phase,
      dataset_used: parsedDatasetUsed,
      dataset_source: datasetSource,
      dataset_source_type: normalizeDatasetSourceType(parsed.dataset_source_type),
      dataset_format: normalizeDatasetFormat(parsed.dataset_format),
      dataset_mime_type:
        typeof parsed.dataset_mime_type === 'string'
          ? normalizeInline(parsed.dataset_mime_type)
          : undefined,
      dataset_mime_valid: parseBooleanish(parsed.dataset_mime_valid),
      dataset_parse_ok: parseBooleanish(parsed.dataset_parse_ok),
      n_cols: parseIntegerish(parsed.n_cols),
      header_detected: parseBooleanish(parsed.header_detected),
      dataset_checksum_sha256:
        typeof parsed.dataset_checksum_sha256 === 'string'
          ? normalizeInline(parsed.dataset_checksum_sha256)
          : undefined,
      dataset_source_uri: datasetSourceUri,
      n_rows: parseIntegerish(parsed.n_rows),
      lobo_folds: parseIntegerish(parsed.lobo_folds),
      runner_contract: runnerContract,
      truth_assessment: truthAssessment,
      delta_bits: parseNumberish(parsed.delta_bits),
      delta_bic: parseNumberish(parsed.delta_bic),
      h4: parseNumberish(parsed.h4),
      h2: parseNumberish(parsed.h2),
      frag: parseNumberish(parsed.frag),
      lobo_pass: parseBooleanish(parsed.lobo_pass ?? parsed['lobo.pass']),
      existence: normalizeExistence(parsed.existence),
      topology:
        typeof parsed.topology === 'string' ? normalizeInline(parsed.topology) : undefined,
      energy_available: parseNumberish(
        parsed.energy_available ?? parsed['energy.available'],
      ),
      energy_required: parseNumberish(
        parsed.energy_required ?? parsed['energy.required'],
      ),
      energy_delta: parseNumberish(parsed.energy_delta ?? parsed['energy.delta']),
      information_delta_bits: parseNumberish(
        parsed.information_delta_bits ?? parsed['information.delta_bits'],
      ),
      information_delta_bic: parseNumberish(
        parsed.information_delta_bic ?? parsed['information.delta_bic'],
      ),
      column_hints: parseStringList(parsed.column_hints),
    }
  } catch {
    return undefined
  }
}

function hasFieldPhaseRunner(
  plan: ExperimentRunnersResult['experiment_runners'],
): boolean {
  return plan.runners.some(
    runner => runner.phase === 'field' || runner.phase === 'both',
  )
}

function buildAutoFieldRunner(
  plan: ExperimentRunnersResult['experiment_runners'],
): ExperimentRunnersResult['experiment_runners']['runners'][number] {
  const existingIds = new Set(plan.runners.map(runner => runner.id))
  let nextId = 'R_FIELD_AUTOREPAIR'
  let suffix = 2
  while (existingIds.has(nextId)) {
    nextId = `R_FIELD_AUTOREPAIR_${suffix}`
    suffix += 1
  }

  return {
    id: nextId,
    goal: 'Collect minimum field evidence and emit an explicit evidence contract.',
    test_ids: ['AUTO_FIELD_EVIDENCE'],
    phase: 'field',
    language: 'python',
    filename: 'field_evidence_autorepair.py',
    run_command: 'python field_evidence_autorepair.py',
    required_inputs: ['dataset:synthetic_field_autorepair.csv'],
    expected_signal: 'FIELD_EVIDENCE_READY',
    failure_signal: 'FIELD_EVIDENCE_FAIL',
    code: `import csv
import json
import math
import os
import random

def correlation(xs, ys):
    n = len(xs)
    if n == 0:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    varx = sum((x - mx) ** 2 for x in xs)
    vary = sum((y - my) ** 2 for y in ys)
    if varx <= 0 or vary <= 0:
        return 0.0
    return cov / math.sqrt(varx * vary)

def run():
    random.seed(42)
    rows = []
    for i in range(64):
        curvature = 0.1 + (5.0 - 0.1) * i / 63.0
        effort = 20.0 / (1.0 + curvature) + random.uniform(-0.2, 0.2)
        rows.append((curvature, effort))

    out_path = os.path.join(os.path.dirname(__file__), 'synthetic_field_autorepair.csv')
    with open(out_path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['curvature', 'effort'])
        writer.writerows(rows)

    curvatures = [r[0] for r in rows]
    efforts = [r[1] for r in rows]
    corr = correlation(curvatures, efforts)
    contract = {
        'phase': 'field',
        'dataset_used': True,
        'dataset_source': 'synthetic',
        'n_rows': len(rows),
        'lobo_folds': 4,
        'runner_contract': 'PASS' if corr < 0 else 'FAIL',
        'truth_assessment': 'PASS' if corr < 0 else 'FAIL',
    }

    print(f'field_rows={len(rows)}')
    print('lobo_folds=4')
    print(f'curvature_effort_corr={corr:.4f}')
    print('FIELD_EVIDENCE_READY' if corr < 0 else 'FIELD_EVIDENCE_FAIL')
    print('AMAWTA_EVIDENCE_CONTRACT=' + json.dumps(contract, ensure_ascii=False))

    if contract['runner_contract'] != 'PASS':
        raise SystemExit(2)

if __name__ == '__main__':
    run()
`,
  }
}

function tryParseFalsificationDataRequests(
  raw?: string,
): string[] {
  const text = (raw || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as {
      falsification_plan?: { data_requests?: unknown }
    }
    const dataRequests = parsed?.falsification_plan?.data_requests
    if (!Array.isArray(dataRequests)) return []
    return dataRequests
      .filter(value => typeof value === 'string')
      .map(value => normalizeInline(value))
      .filter(Boolean)
  } catch {
    return []
  }
}

function extractDatasetCandidatesFromPlan(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  falsificationRaw?: string
  datasetHint?: string
}): string[] {
  const extractFromRunnerCode = (code: string): string[] => {
    const candidates = new Set<string>()
    const source = code || ''
    if (!source.trim()) return []

    const quotedDatasetPathRegex =
      /['"`]([^'"`\r\n]{1,320}\.(?:csv|tsv|jsonl|parquet)(?:\?[^'"`\s]*)?)['"`]/gi
    for (const match of source.matchAll(quotedDatasetPathRegex)) {
      const value = normalizeInline(match[1] || '')
      if (value) candidates.add(value)
    }

    const urlRegex = /\bhttps?:\/\/[^\s'"`)<>\]]+/gi
    for (const match of source.matchAll(urlRegex)) {
      const value = normalizeInline(match[0] || '')
      if (value) candidates.add(value)
    }

    const loadDatasetRegex = /load_dataset\s*\(\s*['"`]([a-z0-9_-]{2,80})['"`]\s*\)/gi
    for (const match of source.matchAll(loadDatasetRegex)) {
      const datasetName = normalizeInline(match[1] || '').toLowerCase()
      if (!datasetName) continue
      candidates.add(`${datasetName}.csv`)
      candidates.add(`${datasetName}_clean.csv`)
      candidates.add(`${datasetName}.tsv`)
    }

    return Array.from(candidates)
  }

  const fromRunners = params.plan.runners.flatMap(runner =>
    [
      ...(runner.required_inputs || []),
      runner.goal || '',
      runner.run_command || '',
      ...extractFromRunnerCode(runner.code || ''),
    ]
      .map(text => normalizeInline(text))
      .filter(Boolean),
  )
  const fromFalsification = tryParseFalsificationDataRequests(
    params.falsificationRaw,
  )
  const fromDatasetHint = normalizeInline(params.datasetHint || '')
  const combined = [
    ...fromRunners,
    ...fromFalsification,
    ...(fromDatasetHint ? [fromDatasetHint] : []),
  ]
  const splitCandidates: string[] = []
  for (const value of combined) {
    const parts = value
      .split(/[,;]\s*/)
      .map(part => normalizeInline(part))
      .filter(Boolean)
    splitCandidates.push(...parts)
  }
  const normalized = splitCandidates
    .map(item => item.replace(/^dataset\s*:\s*/i, '').trim())
    .filter(item => {
      if (!item) return false
      if (/^https?:\/\//i.test(item)) return true
      if (/\.(csv|jsonl|parquet|tsv)$/i.test(item)) return true
      if (item.includes('/') || item.includes('\\')) return true
      return false
    })
  return Array.from(new Set(normalized))
}

function extractStructuredDatasetCandidatesFromPlan(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  falsificationRaw?: string
  datasetHint?: string
}): string[] {
  const fromRequiredInputs = params.plan.runners.flatMap(runner =>
    (runner.required_inputs || [])
      .map(value => normalizeInline(String(value || '')))
      .filter(Boolean),
  )
  const fromFalsification = tryParseFalsificationDataRequests(
    params.falsificationRaw,
  )
  const fromDatasetHint = normalizeInline(params.datasetHint || '')
  const combined = [
    ...fromRequiredInputs,
    ...fromFalsification,
    ...(fromDatasetHint ? [fromDatasetHint] : []),
  ]

  const splitCandidates: string[] = []
  for (const value of combined) {
    const parts = value
      .split(/[,;]\s*/)
      .map(part => normalizeInline(part))
      .filter(Boolean)
    splitCandidates.push(...parts)
  }

  const normalized = splitCandidates
    .map(item => item.replace(/^dataset\s*:\s*/i, '').trim())
    .filter(item => {
      if (!item) return false
      if (/^https?:\/\//i.test(item)) return true
      if (/\.(csv|jsonl|parquet|tsv)$/i.test(item)) return true
      if (item.includes('/') || item.includes('\\')) return true
      return false
    })

  return Array.from(new Set(normalized))
}

function extractKeywordHintsFromSearchResults(results: SearchResult[]): string[] {
  const frequency = new Map<string, number>()
  const disallowed = new Set([
    ...CLAIM_SEMANTIC_STOPWORDS,
    'study',
    'paper',
    'literature',
    'results',
    'analysis',
    'method',
    'methods',
    'using',
    'based',
    'across',
    'toward',
    'towards',
    'data',
    'dataset',
  ])

  for (const result of results) {
    const combined = `${result.title || ''} ${result.snippet || ''}`
    const tokens = combined
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map(token => normalizeSemanticToken(token))
      .filter(Boolean)
    for (const token of tokens) {
      if (token.length < 4) continue
      if (disallowed.has(token)) continue
      frequency.set(token, (frequency.get(token) || 0) + 1)
    }
  }

  return Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([token]) => token)
}

function buildLiteratureAffinityQueries(params: {
  hypothesisQuery: string
  falsificationRaw?: string
  semanticProfile?: ClaimSemanticProfile
}): string[] {
  const normalizedHypothesis = normalizeInline(params.hypothesisQuery || '')
  const hypothesisSlice = normalizedHypothesis.slice(0, 220)
  const profileTokens = (params.semanticProfile?.tokens || []).slice(0, 6)
  const hypothesisKeywords = Array.from(
    inferDatasetKeywordsFromHypothesis(params.hypothesisQuery || ''),
  ).slice(0, 6)
  const requestHints = tryParseFalsificationDataRequests(params.falsificationRaw)
    .filter(Boolean)
    .slice(0, 2)

  const queries = [
    hypothesisSlice
      ? `${hypothesisSlice} related work empirical study`
      : '',
    profileTokens.length > 0
      ? `${profileTokens.join(' ')} theory experiment literature review`
      : '',
    requestHints.length > 0
      ? `${requestHints.join(' ')} related work empirical evidence`
      : '',
    hypothesisKeywords.length > 0
      ? `${hypothesisKeywords.join(' ')} benchmark observational study`
      : '',
  ]
    .map(query => normalizeInline(query))
    .filter(Boolean)

  return Array.from(new Set(queries)).slice(0, MAX_LITERATURE_AFFINITY_QUERIES)
}

function extractFirstJsonObject(rawText: string): string | null {
  const raw = rawText.trim()
  if (!raw) return null
  if (raw.startsWith('{') && raw.endsWith('}')) return raw

  const startIndex = raw.indexOf('{')
  if (startIndex < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < raw.length; index += 1) {
    const ch = raw[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(startIndex, index + 1)
      }
    }
  }

  return null
}

function parseDatasetDiscoveryAdvisorPlan(
  rawText: string,
): DatasetDiscoveryAdvisorPlan | null {
  const trimmed = normalizeInline(rawText || '')
  if (!trimmed) return null

  const candidates: string[] = [rawText.trim()]
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) candidates.push(fencedMatch[1].trim())
  const objectMatch = extractFirstJsonObject(rawText)
  if (objectMatch) candidates.push(objectMatch.trim())

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as {
        search_queries?: unknown
        seed_urls?: unknown
        keyword_hints?: unknown
        observable_mapping?: unknown
        notes?: unknown
      }

      const searchQueries = Array.isArray(parsed.search_queries)
        ? parsed.search_queries
            .filter((value): value is string => typeof value === 'string')
            .map(value => normalizeInline(value))
            .filter(Boolean)
            .slice(0, MAX_DATASET_DISCOVERY_AGENT_QUERIES)
        : []

      const seedUrls = Array.isArray(parsed.seed_urls)
        ? parsed.seed_urls
            .filter((value): value is string => typeof value === 'string')
            .map(value => normalizeWebDatasetCandidateUrl(value))
            .filter(Boolean)
            .slice(0, MAX_DATASET_DISCOVERY_AGENT_SEEDS)
        : []

      const keywordHints = Array.isArray(parsed.keyword_hints)
        ? parsed.keyword_hints
            .filter((value): value is string => typeof value === 'string')
            .map(value => normalizeSemanticToken(value))
            .filter(Boolean)
            .slice(0, MAX_DATASET_DISCOVERY_AGENT_HINTS)
        : []

      const observableMappingRaw = Array.isArray(parsed.observable_mapping)
        ? parsed.observable_mapping
        : []
      const observableMapping: DatasetDiscoveryAdvisorMapping[] = []
      for (const item of observableMappingRaw) {
        if (!item || typeof item !== 'object') continue
        const row = item as {
          claim_variable?: unknown
          dataset_proxy?: unknown
          note?: unknown
        }
        const claimVariable =
          typeof row.claim_variable === 'string'
            ? normalizeInline(row.claim_variable)
            : ''
        const datasetProxy =
          typeof row.dataset_proxy === 'string'
            ? normalizeInline(row.dataset_proxy)
            : ''
        const note = typeof row.note === 'string' ? normalizeInline(row.note) : ''
        if (!claimVariable || !datasetProxy) continue
        observableMapping.push({ claimVariable, datasetProxy, note })
      }

      const notes = typeof parsed.notes === 'string' ? normalizeInline(parsed.notes) : ''
      if (searchQueries.length === 0 && seedUrls.length === 0) continue

      return {
        searchQueries,
        seedUrls,
        keywordHints,
        observableMapping: observableMapping.slice(0, 12),
        notes,
      }
    } catch {
      continue
    }
  }

  return null
}

async function runDatasetDiscoveryAdvisor(params: {
  hypothesisQuery: string
  falsificationRaw?: string
  semanticProfile?: ClaimSemanticProfile
  keywordHints?: string[]
  toyTruth: ToyTruthAssessment
  stageDecision: StageDecision
  signal?: AbortSignal
}): Promise<DatasetDiscoveryAdvisorPlan | null> {
  const hypothesis = normalizeInline(params.hypothesisQuery || '')
  if (!hypothesis) return null
  const semanticTokens = (params.semanticProfile?.tokens || []).slice(0, 12)
  const keywordHints = (params.keywordHints || []).slice(0, 12)
  const falsificationExcerpt = normalizeInline(params.falsificationRaw || '').slice(
    0,
    2200,
  )

  const userPrompt = [
    'You are DatasetDiscoveryPass2.',
    'Task: propose real datasets that can test the claim via measurable observables/proxies.',
    'Do NOT search for literal claim wording matches.',
    'Search for testability (what can be measured), including proxy variables.',
    '',
    `Hypothesis: ${hypothesis}`,
    `Toy truth: ${params.toyTruth}`,
    `Current stage: ${params.stageDecision}`,
    `Semantic tokens: ${semanticTokens.join(', ') || '(none)'}`,
    `Pass1 keyword hints: ${keywordHints.join(', ') || '(none)'}`,
    `Falsification excerpt: ${falsificationExcerpt || '(none)'}`,
    '',
    'Few-shot examples (style):',
    'Example A (morphology claim): if claim mentions flipper_length and body_mass, propose datasets with per-individual morphology tables (species, sex, flipper length, body mass) even if no paper states the exact claim.',
    'Example B (dynamics claim): if claim mentions coupling/lag, propose time-series datasets with channels/trials metadata where PSI/wPLI-like metrics can be computed from raw signals.',
    'Example C (physics/control claim): if claim mentions effort vs curvature, propose trajectory/control tables with force/effort proxies and curvature/geometry proxies; include mappings.',
    '',
    'Return JSON only with this exact shape:',
    '{',
    '  "search_queries": ["..."],',
    '  "seed_urls": ["https://..."],',
    '  "keyword_hints": ["..."],',
    '  "observable_mapping": [{"claim_variable":"...","dataset_proxy":"...","note":"..."}],',
    '  "notes": "..."',
    '}',
    '',
    `Constraints:
- search_queries: max ${MAX_DATASET_DISCOVERY_AGENT_QUERIES}
- seed_urls: max ${MAX_DATASET_DISCOVERY_AGENT_SEEDS}
- keyword_hints: max ${MAX_DATASET_DISCOVERY_AGENT_HINTS}
- Prefer open repositories/datasets (openneuro, physionet, zenodo, figshare, osf, kaggle, uci, huggingface, github raw).
- URLs may be dataset landing pages if they are likely to expose downloadable data files.
- Keep values concise.`,
  ].join('\n')

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort()
  }, DEFAULT_DATASET_DISCOVERY_AGENT_TIMEOUT_MS)
  const onParentAbort = () => timeoutController.abort()
  params.signal?.addEventListener('abort', onParentAbort)

  try {
    const response = await queryQuick({
      userPrompt,
      signal: timeoutController.signal,
    })
    const text = response.message.content?.[0]?.text || ''
    const parsed = parseDatasetDiscoveryAdvisorPlan(text)
    if (parsed) return parsed

    const normalizedRaw = normalizeInline(text)
    if (!normalizedRaw) return null

    const repairPrompt = [
      'You are a strict JSON normalizer.',
      'Convert the following model output into valid JSON with this exact schema and no extra keys:',
      '{',
      '  "search_queries": ["..."],',
      '  "seed_urls": ["https://..."],',
      '  "keyword_hints": ["..."],',
      '  "observable_mapping": [{"claim_variable":"...","dataset_proxy":"...","note":"..."}],',
      '  "notes": "..."',
      '}',
      '',
      'Rules:',
      `- search_queries max ${MAX_DATASET_DISCOVERY_AGENT_QUERIES}`,
      `- seed_urls max ${MAX_DATASET_DISCOVERY_AGENT_SEEDS}`,
      `- keyword_hints max ${MAX_DATASET_DISCOVERY_AGENT_HINTS}`,
      '- If information is missing, return empty arrays instead of prose.',
      '- Output JSON only.',
      '',
      'Raw output to normalize:',
      text.slice(0, 5000),
    ].join('\n')

    const repaired = await queryQuick({
      userPrompt: repairPrompt,
      signal: timeoutController.signal,
    })
    const repairedText = repaired.message.content?.[0]?.text || ''
    return parseDatasetDiscoveryAdvisorPlan(repairedText)
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
    params.signal?.removeEventListener('abort', onParentAbort)
  }
}

async function discoverLiteratureAffinity(params: {
  hypothesisQuery: string
  falsificationRaw?: string
  semanticProfile?: ClaimSemanticProfile
  signal?: AbortSignal
}): Promise<LiteratureAffinityReport> {
  const queries = buildLiteratureAffinityQueries({
    hypothesisQuery: params.hypothesisQuery,
    falsificationRaw: params.falsificationRaw,
    semanticProfile: params.semanticProfile,
  })

  if (queries.length === 0 || !ALLOW_DATASET_WEB_DISCOVERY) {
    return {
      queries,
      results: [],
      semanticFit: {
        pass: true,
        matched: 0,
        required: 0,
        reason:
          'No literature-affinity queries generated; continuing with direct dataset pass.',
      },
      datasetCandidates: [],
      keywordHints: [],
    }
  }

  const dedupResults = new Map<string, SearchResult>()

  for (const query of queries) {
    if (params.signal?.aborted) break
    const searchAbortController = new AbortController()
    const timeoutId = setTimeout(() => {
      searchAbortController.abort()
    }, DEFAULT_DATASET_WEB_DISCOVERY_TIMEOUT_MS)
    const onParentAbort = () => searchAbortController.abort()
    params.signal?.addEventListener('abort', onParentAbort)

    try {
      const rawResults = await searchProviders.google.search(query, undefined, {
        signal: searchAbortController.signal,
      })
      for (const result of rawResults || []) {
        const key = normalizeInline(result.link || result.title || result.snippet || '')
        if (!key) continue
        if (!dedupResults.has(key)) dedupResults.set(key, result)
        if (dedupResults.size >= MAX_LITERATURE_AFFINITY_RESULTS) break
      }
      if (dedupResults.size >= MAX_LITERATURE_AFFINITY_RESULTS) break
    } catch {
      // Best effort: continue with remaining queries.
    } finally {
      clearTimeout(timeoutId)
      params.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  const results = Array.from(dedupResults.values())
  const semanticText = results
    .map(result => `${result.title || ''} ${result.snippet || ''} ${result.link || ''}`)
    .join('\n')
  const semanticFit = evaluateSemanticFitAgainstText({
    profile: params.semanticProfile,
    text: semanticText,
  })
  return {
    queries,
    results,
    semanticFit,
    datasetCandidates: extractDatasetUrlsFromSearchResults(results),
    keywordHints: extractKeywordHintsFromSearchResults(results),
  }
}

function buildDatasetWebDiscoveryQueries(params: {
  hypothesisQuery: string
  falsificationRaw?: string
  keywordHints?: string[]
  semanticProfile?: ClaimSemanticProfile
}): string[] {
  const normalizedHypothesis = normalizeInline(params.hypothesisQuery || '')
  const hypothesisSlice = normalizedHypothesis.slice(0, 220)
  const semanticTokens = (params.semanticProfile?.tokens || [])
    .map(token => normalizeSemanticToken(token))
    .filter(Boolean)
    .slice(0, 8)
  const keywords = Array.from(
    inferDatasetKeywordsFromHypothesis(params.hypothesisQuery || ''),
  )
    .filter(Boolean)
    .slice(0, 6)
  const requests = tryParseFalsificationDataRequests(params.falsificationRaw)
    .filter(Boolean)
    .slice(0, 2)
  const keywordHints = (params.keywordHints || [])
    .map(item => normalizeSemanticToken(item))
    .filter(Boolean)
    .slice(0, 8)
  const observableTerms = Array.from(
    new Set([...semanticTokens, ...keywords, ...keywordHints]),
  )
    .filter(Boolean)
    .slice(0, 8)
  const repositoryHints =
    'zenodo figshare kaggle openneuro physionet uci huggingface datasets osf'
  const observableQueryCore =
    observableTerms.length > 0
      ? observableTerms.join(' ')
      : normalizeInline(params.hypothesisQuery || '').slice(0, 120)

  const queries = [
    observableQueryCore
      ? `${observableQueryCore} dataset with measurable variables/proxies for hypothesis testing csv parquet jsonl`
      : '',
    requests.length > 0
      ? `${requests.join(' ')} field validation dataset measurable observables/proxies csv parquet`
      : '',
    observableQueryCore
      ? `${observableQueryCore} dataset ${repositoryHints}`
      : '',
    observableQueryCore
      ? `site:raw.githubusercontent.com ${observableQueryCore} csv`
      : '',
    observableQueryCore
      ? `${observableQueryCore} columns variables benchmark dataset`
      : '',
    observableQueryCore
      ? `${observableQueryCore} filetype:csv OR filetype:tsv OR filetype:parquet OR filetype:jsonl`
      : '',
    observableQueryCore ? `site:openneuro.org ${observableQueryCore} dataset` : '',
    observableQueryCore ? `site:physionet.org ${observableQueryCore} dataset` : '',
    observableQueryCore ? `site:zenodo.org ${observableQueryCore} dataset csv` : '',
    observableQueryCore ? `site:figshare.com ${observableQueryCore} dataset csv` : '',
    observableQueryCore ? `site:archive.ics.uci.edu ${observableQueryCore} dataset` : '',
    'open dataset multivariate time series tabular csv parquet benchmark',
    hypothesisSlice
      ? `${hypothesisSlice} dataset to test claim with measurable proxies`
      : '',
  ]
    .map(query => normalizeInline(query))
    .filter(Boolean)

  return Array.from(new Set(queries)).slice(0, MAX_WEB_DATASET_DISCOVERY_QUERIES)
}

function convertGithubBlobDatasetUrlToRaw(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 5) return null
    const [owner, repo, marker, branch, ...rest] = parts
    if (marker !== 'blob' || !owner || !repo || !branch || rest.length === 0) {
      return null
    }
    const datasetPath = rest.join('/')
    if (detectDatasetFormatFromExtension(datasetPath) === 'unknown') return null
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${datasetPath}`
  } catch {
    return null
  }
}

function normalizeWebDatasetCandidateUrl(rawUrl: string): string {
  const normalized = normalizeInline(rawUrl)
  if (!normalized || !/^https?:\/\//i.test(normalized)) return ''
  if (isDisallowedDatasetUrl(normalized)) return ''
  const githubRaw = convertGithubBlobDatasetUrlToRaw(normalized)
  return githubRaw || normalized
}

function isLikelyDatasetLandingUrl(params: {
  url: URL
  contextText?: string
}): boolean {
  const host = params.url.hostname.toLowerCase()
  const path = `${params.url.pathname}${params.url.search}`.toLowerCase()
  const context = normalizeInline(params.contextText || '').toLowerCase()
  if (detectDatasetFormatFromExtension(path) !== 'unknown') return true
  if (DATASET_LANDING_PATH_REGEX.test(path)) return true

  // Agentic field-discovery default: allow non-whitelisted hosts when context
  // strongly suggests downloadable/measurable dataset content.
  if (/\bdataset|datasets|download|repository|benchmark|open data|data table|time series\b/i.test(context)) {
    return true
  }

  // For known dataset repositories, accept landing pages by default and
  // delegate strict relevance to semantic fit in resolveDatasetForField.
  if (DATASET_LANDING_DOMAIN_REGEX.test(host)) {
    return true
  }

  return false
}

function extractDatasetCandidateUrlsFromHtml(params: {
  html: string
  baseUrl: string
}): string[] {
  if (!params.html.trim() || !looksLikeHtmlContent(params.html)) return []
  const candidates = new Set<string>()
  const rawHrefRegex = /href\s*=\s*["']([^"'#]+)["']/gi
  const rawUrlRegex = /\bhttps?:\/\/[^\s"'`)<>\]]+/gi
  const rawLinks: string[] = []
  for (const match of params.html.matchAll(rawHrefRegex)) {
    rawLinks.push(normalizeInline(match[1] || ''))
  }
  for (const match of params.html.matchAll(rawUrlRegex)) {
    rawLinks.push(normalizeInline(match[0] || ''))
  }

  for (const rawLink of rawLinks) {
    if (!rawLink) continue
    let absolute: string
    try {
      absolute = new URL(rawLink, params.baseUrl).toString()
    } catch {
      continue
    }
    const normalizedUrl = normalizeWebDatasetCandidateUrl(absolute)
    if (!normalizedUrl) continue
    try {
      const parsed = new URL(normalizedUrl)
      if (
        detectDatasetFormatFromExtension(parsed.pathname) === 'unknown' &&
        !isLikelyDatasetLandingUrl({
          url: parsed,
          contextText: params.html.slice(0, 1500),
        })
      ) {
        continue
      }
      candidates.add(normalizedUrl)
    } catch {
      continue
    }
  }

  return Array.from(candidates).slice(0, MAX_WEB_DATASET_DISCOVERY_CANDIDATES)
}

function extractDatasetUrlsFromSearchResults(results: SearchResult[]): string[] {
  const candidates = new Set<string>()
  const directDatasetUrlRegex =
    /\bhttps?:\/\/[^\s'"`)<>\]]+\.(?:csv|tsv|jsonl|parquet)(?:\?[^\s'"`)<>\]]*)?/gi

  for (const result of results) {
    const rawLinks = [result.link]
    const textPool = `${result.title || ''} ${result.snippet || ''}`
    for (const match of textPool.matchAll(directDatasetUrlRegex)) {
      rawLinks.push(match[0] || '')
    }

    for (const rawLink of rawLinks) {
      const normalizedUrl = normalizeWebDatasetCandidateUrl(rawLink)
      if (!normalizedUrl) continue
      try {
        const parsed = new URL(normalizedUrl)
        if (
          detectDatasetFormatFromExtension(parsed.pathname) === 'unknown' &&
          !isLikelyDatasetLandingUrl({ url: parsed, contextText: textPool })
        ) {
          continue
        }
        candidates.add(normalizedUrl)
      } catch {
        continue
      }
    }
  }

  return Array.from(candidates)
}

async function fetchDatasetCandidatesFromLandingUrl(params: {
  url: string
  signal?: AbortSignal
}): Promise<string[]> {
  const target = normalizeWebDatasetCandidateUrl(params.url)
  if (!target) return []
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const onParentAbort = () => controller.abort()
  params.signal?.addEventListener('abort', onParentAbort)
  try {
    timeoutId = setTimeout(() => {
      controller.abort()
    }, DEFAULT_DATASET_WEB_DISCOVERY_TIMEOUT_MS)

    const response = await fetch(target, { signal: controller.signal })
    if (!response.ok) return []

    const contentLengthRaw = response.headers.get('content-length')
    const contentLength = contentLengthRaw
      ? Number.parseInt(contentLengthRaw, 10)
      : undefined
    if (
      typeof contentLength === 'number' &&
      Number.isFinite(contentLength) &&
      contentLength > MAX_DATASET_DOWNLOAD_BYTES
    ) {
      return []
    }
    const mimeType = normalizeMimeType(response.headers.get('content-type'))
    if (mimeType && !DATASET_HTML_MIME_REGEX.test(mimeType)) return []
    const html = await response.text()
    if (!html || !looksLikeHtmlContent(html)) return []
    return extractDatasetCandidateUrlsFromHtml({ html, baseUrl: target })
  } catch {
    return []
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    params.signal?.removeEventListener('abort', onParentAbort)
  }
}

async function discoverWebDatasetCandidates(params: {
  hypothesisQuery: string
  falsificationRaw?: string
  keywordHints?: string[]
  advisorQueries?: string[]
  semanticProfile?: ClaimSemanticProfile
  signal?: AbortSignal
}): Promise<string[]> {
  if (!ALLOW_DATASET_WEB_DISCOVERY) return []
  const fallbackQueries = buildDatasetWebDiscoveryQueries({
    hypothesisQuery: params.hypothesisQuery,
    falsificationRaw: params.falsificationRaw,
    keywordHints: params.keywordHints,
    semanticProfile: params.semanticProfile,
  })
  const advisorQueries = (params.advisorQueries || [])
    .map(item => normalizeInline(item))
    .filter(Boolean)
  const queries = Array.from(new Set([...advisorQueries, ...fallbackQueries])).slice(
    0,
    MAX_WEB_DATASET_DISCOVERY_QUERIES,
  )
  if (queries.length === 0) return []

  const candidates = new Set<string>()
  for (const query of queries) {
    if (params.signal?.aborted) break
    const searchAbortController = new AbortController()
    const timeoutId = setTimeout(() => {
      searchAbortController.abort()
    }, DEFAULT_DATASET_WEB_DISCOVERY_TIMEOUT_MS)
    const onParentAbort = () => searchAbortController.abort()
    params.signal?.addEventListener('abort', onParentAbort)

    try {
      const rawResults = await searchProviders.google.search(query, undefined, {
        signal: searchAbortController.signal,
      })
      const extracted = extractDatasetUrlsFromSearchResults(rawResults)
      for (const item of extracted) {
        candidates.add(item)
        if (candidates.size >= MAX_WEB_DATASET_DISCOVERY_CANDIDATES) break
      }
      if (candidates.size < MAX_WEB_DATASET_DISCOVERY_CANDIDATES) {
        const landingLinks = rawResults
          .map(result => normalizeWebDatasetCandidateUrl(result.link || ''))
          .filter(Boolean)
          .slice(0, 6)
        for (const landingUrl of landingLinks) {
          if (candidates.size >= MAX_WEB_DATASET_DISCOVERY_CANDIDATES) break
          const discoveredFromLanding = await fetchDatasetCandidatesFromLandingUrl({
            url: landingUrl,
            signal: params.signal,
          })
          for (const discovered of discoveredFromLanding) {
            candidates.add(discovered)
            if (candidates.size >= MAX_WEB_DATASET_DISCOVERY_CANDIDATES) break
          }
        }
      }
      if (candidates.size >= MAX_WEB_DATASET_DISCOVERY_CANDIDATES) break
    } catch {
      // Best effort: continue with remaining queries.
    } finally {
      clearTimeout(timeoutId)
      params.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  return Array.from(candidates).slice(0, MAX_WEB_DATASET_DISCOVERY_CANDIDATES)
}

function inferDatasetKeywordsFromHypothesis(hypothesisQuery: string): Set<string> {
  const stopWords = new Set([
    'en',
    'con',
    'para',
    'por',
    'del',
    'las',
    'los',
    'que',
    'como',
    'this',
    'that',
    'with',
    'from',
    'when',
    'where',
    'under',
    'between',
    'controlando',
    'implica',
    'mayor',
  ])
  const keywords = new Set<string>()
  for (const token of hypothesisQuery.toLowerCase().split(/[^a-z0-9_]+/i)) {
    const normalized = token.trim()
    if (normalized.length < 4) continue
    if (stopWords.has(normalized)) continue
    keywords.add(normalized)
  }
  return keywords
}

function discoverLocalDatasetCandidates(params: {
  cwd: string
  hypothesisQuery: string
}): string[] {
  const keywords = inferDatasetKeywordsFromHypothesis(params.hypothesisQuery)
  const rootDirs = [
    params.cwd,
    resolve(params.cwd, EXPERIMENT_RUNNERS_OUTPUT_DIR),
    resolve(params.cwd, EXPERIMENT_DATASET_OUTPUT_DIR),
  ]
  const seen = new Set<string>()
  const scored: Array<{ relativePath: string; score: number }> = []

  const visitedDirs = new Set<string>()
  const maxDepth = 3
  const maxCollected = 300
  const headerMatchCache = new Map<string, number>()

  const countHeaderKeywordMatches = (
    absolutePath: string,
    format: ResolvedDataset['format'],
  ): number => {
    const cached = headerMatchCache.get(absolutePath)
    if (typeof cached === 'number') return cached
    let text = ''
    try {
      if (format === 'csv' || format === 'tsv') {
        const raw = readFileSync(absolutePath, 'utf8')
        text = raw.split(/\r?\n/).slice(0, 2).join('\n')
      } else if (format === 'jsonl') {
        const raw = readFileSync(absolutePath, 'utf8')
        const firstLine = raw.split(/\r?\n/).find(line => line.trim().length > 0) || ''
        text = firstLine
      }
    } catch {
      headerMatchCache.set(absolutePath, 0)
      return 0
    }
    if (!text) {
      headerMatchCache.set(absolutePath, 0)
      return 0
    }
    const headerTokens = new Set<string>()
    const coarseTokens = collectSemanticEvidenceTokens(text)
    for (const token of coarseTokens) {
      if (!token) continue
      headerTokens.add(token)
      if (token.includes('_')) {
        for (const part of token.split('_')) {
          const normalizedPart = normalizeSemanticToken(part)
          if (normalizedPart && normalizedPart.length >= 2) {
            headerTokens.add(normalizedPart)
          }
        }
      }
    }
    for (const raw of normalizeInline(text || '').toLowerCase().split(/[^a-z0-9]+/g)) {
      const normalized = normalizeSemanticToken(raw)
      if (normalized && normalized.length >= 2) {
        headerTokens.add(normalized)
      }
    }
    if (headerTokens.size === 0) {
      headerMatchCache.set(absolutePath, 0)
      return 0
    }
    let matches = 0
    for (const keyword of keywords) {
      if (!keyword) continue
      const direct = headerTokens.has(keyword)
      const near = direct
        ? true
        : Array.from(headerTokens).some(token => {
            if (!token) return false
            if (token === keyword) return true
            if (keyword.length >= 5 && token.startsWith(keyword.slice(0, 4))) return true
            if (token.length >= 5 && keyword.startsWith(token.slice(0, 4))) return true
            return false
          })
      if (near) matches += 1
    }
    headerMatchCache.set(absolutePath, matches)
    return matches
  }

  const shouldSkipDir = (dirName: string): boolean => {
    const lowered = dirName.toLowerCase()
    return (
      lowered === '.git' ||
      lowered === 'node_modules' ||
      lowered === '.venv' ||
      lowered === 'dist' ||
      lowered === 'build' ||
      lowered.startsWith('.cache')
    )
  }

  for (const dir of rootDirs) {
    if (!existsSync(dir)) continue
    const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }]

    while (queue.length > 0 && seen.size < maxCollected) {
      const current = queue.shift()!
      if (visitedDirs.has(current.path)) continue
      visitedDirs.add(current.path)

      let entries: Array<{
        isFile: () => boolean
        isDirectory: () => boolean
        name: string
      }>
      try {
        entries = readdirSync(current.path, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const absolutePath = resolve(current.path, entry.name)
        if (entry.isDirectory()) {
          if (
            current.depth < maxDepth &&
            !shouldSkipDir(entry.name) &&
            !visitedDirs.has(absolutePath)
          ) {
            queue.push({ path: absolutePath, depth: current.depth + 1 })
          }
          continue
        }
        if (!entry.isFile()) continue
        const format = detectDatasetFormatFromExtension(absolutePath)
        if (format === 'unknown') continue
        const relativePath = relative(params.cwd, absolutePath).replace(/\\/g, '/')
        if (!relativePath || seen.has(relativePath)) continue
        seen.add(relativePath)

        const baseName = entry.name.toLowerCase()
        let score = 0
        let keywordMatches = 0
        for (const keyword of keywords) {
          if (baseName.includes(keyword)) {
            score += 25
            keywordMatches += 1
          }
        }
        if (keywordMatches === 0 && keywords.size > 0) {
          const headerMatches = countHeaderKeywordMatches(absolutePath, format)
          if (headerMatches > 0) {
            keywordMatches = headerMatches
            score += 12 + Math.min(headerMatches, 4) * 6
          }
        }
        if (/dataset|data|field|evidence|sample|train|test|penguin/.test(baseName)) {
          score += 15
        }
        if (relativePath.startsWith(`${EXPERIMENT_DATASET_OUTPUT_DIR}/`)) {
          score += 20
        } else if (relativePath.startsWith(`${EXPERIMENT_RUNNERS_OUTPUT_DIR}/`)) {
          score += 10
        }
        if (/synthetic|autorepair|toy/.test(baseName)) score -= 20
        try {
          const stats = statSync(absolutePath)
          if (stats.size >= 1024) score += 5
          if (stats.size > 20 * 1024 * 1024) score -= 10
        } catch {
          // ignore stat errors
        }
        if (
          keywords.size > 0 &&
          keywordMatches === 0 &&
          score < MIN_LOCAL_DATASET_CANDIDATE_SCORE
        ) {
          continue
        }
        if (score < MIN_LOCAL_DATASET_CANDIDATE_SCORE) continue
        scored.push({ relativePath, score })
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
  return scored.slice(0, 48).map(item => item.relativePath)
}

type ResolvedDataset = {
  source: string
  sourceType: 'url' | 'local'
  format: 'csv' | 'tsv' | 'jsonl' | 'parquet'
  mimeType: string
  mimeValid: boolean
  parseOk: boolean
  nCols: number
  headerDetected: boolean
  checksumSha256: string
  localRelativePath: string
  nRows: number
  downloaded: boolean
  columnHints: string[]
}

function normalizeMimeType(contentTypeHeader?: string | null): string {
  return normalizeInline(contentTypeHeader || '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
}

function detectDatasetFormatFromExtension(
  filePath: string,
): ResolvedDataset['format'] | 'unknown' {
  const extRaw = basename(filePath).toLowerCase().split('.').pop() || ''
  if (!DATASET_ALLOWED_EXTENSIONS.has(extRaw)) return 'unknown'
  if (extRaw === 'csv' || extRaw === 'tsv' || extRaw === 'jsonl' || extRaw === 'parquet') {
    return extRaw
  }
  return 'unknown'
}

function detectDatasetFormatFromMimeType(
  mimeType: string,
): ResolvedDataset['format'] | 'unknown' {
  if (!mimeType) return 'unknown'
  if (/\b(text\/csv|application\/csv|application\/vnd\.ms-excel)\b/i.test(mimeType)) {
    return 'csv'
  }
  if (/\btext\/tab-separated-values\b/i.test(mimeType)) return 'tsv'
  if (/\b(application\/x-ndjson|application\/ndjson)\b/i.test(mimeType)) return 'jsonl'
  if (/\bapplication\/parquet\b/i.test(mimeType)) return 'parquet'
  return 'unknown'
}

function scoreDatasetCandidateForFieldResolve(params: {
  candidate: string
  semanticProfile?: ClaimSemanticProfile
}): number {
  const candidate = normalizeInline(params.candidate)
  if (!candidate) return Number.NEGATIVE_INFINITY
  const lower = candidate.toLowerCase()
  const isUrl = /^https?:\/\//i.test(candidate)
  let score = 0

  const semanticFit = evaluateSemanticFitAgainstText({
    profile: params.semanticProfile,
    text: candidate,
  })
  score += semanticFit.matched * 30
  if (semanticFit.pass) score += 50

  const formatFromExt = detectDatasetFormatFromExtension(candidate)
  if (formatFromExt !== 'unknown') score += 28

  if (!isUrl) {
    score += 18
    if (
      lower.startsWith(`${EXPERIMENT_DATASET_OUTPUT_DIR}/`) ||
      lower.includes('/datasets/')
    ) {
      score += 18
    }
  } else {
    score += 8
    try {
      const parsed = new URL(candidate)
      if (DATASET_LANDING_DOMAIN_REGEX.test(parsed.hostname.toLowerCase())) {
        score += 10
      }
      if (isLikelyDatasetLandingUrl({ url: parsed, contextText: candidate })) {
        score += 6
      }
    } catch {
      score -= 8
    }
  }

  if (/\b(dataset|data|field|evidence|benchmark|train|test)\b/i.test(lower)) {
    score += 8
  }
  if (/\b(synthetic|toy|mock|dummy|generated)\b/i.test(lower)) {
    score -= 16
  }
  if (isDisallowedDatasetUrl(candidate)) {
    score -= 24
  }

  return score
}

function selectTopDatasetCandidatesForFieldResolve(params: {
  candidates: string[]
  semanticProfile?: ClaimSemanticProfile
  topK?: number
}): string[] {
  if (params.candidates.length === 0) return []
  const topK = Math.max(1, params.topK || FIELD_RESOLVE_TOP_K)
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const raw of params.candidates) {
    const normalized = normalizeInline(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(normalized)
  }
  if (deduped.length <= topK) return deduped

  const scored = deduped.map((candidate, index) => ({
    candidate,
    index,
    score: scoreDatasetCandidateForFieldResolve({
      candidate,
      semanticProfile: params.semanticProfile,
    }),
  }))
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, topK).map(item => item.candidate)
}

function isDisallowedDatasetUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    const path = `${url.pathname}${url.search}`.toLowerCase()
    return DATASET_DISALLOWED_URL_PATH_REGEX.test(path)
  } catch {
    return true
  }
}

function looksLikeHtmlContent(content: string): boolean {
  const sample = content.slice(0, 2048).toLowerCase()
  return (
    sample.includes('<!doctype html') ||
    sample.includes('<html') ||
    sample.includes('<head') ||
    sample.includes('<body')
  )
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function stripHtmlTags(value: string): string {
  return normalizeInline(
    decodeHtmlEntities(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
}

function escapeCsvCell(value: string): string {
  if (!/["\n,]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

type HtmlTableExtraction = {
  csvText: string
  nRows: number
  nCols: number
  headerDetected: boolean
  numericRatio: number
  metadataLike: boolean
}

function extractDatasetCsvFromHtml(content: string): HtmlTableExtraction | null {
  if (!content.trim() || !looksLikeHtmlContent(content)) return null
  const tableMatches = Array.from(content.matchAll(/<table\b[\s\S]*?<\/table>/gi))
  if (tableMatches.length === 0) return null

  let bestRows: string[][] = []
  let bestHeaderDetected = false

  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[0] || ''
    const rowMatches = Array.from(tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi))
    if (rowMatches.length === 0) continue

    const rows: string[][] = []
    let headerDetected = false

    for (const rowMatch of rowMatches) {
      const rowHtml = rowMatch[0] || ''
      const cells: string[] = []
      let rowHasHeader = false
      const cellMatches = Array.from(
        rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi),
      )
      for (const cellMatch of cellMatches) {
        const cellType = (cellMatch[1] || '').toLowerCase()
        if (cellType === 'th') rowHasHeader = true
        const cellRaw = cellMatch[2] || ''
        const cellText = stripHtmlTags(cellRaw)
        cells.push(cellText)
      }
      if (cells.length >= 2) {
        rows.push(cells)
        if (rowHasHeader) headerDetected = true
      }
    }

    const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
    if (maxCols < 2) continue
    if (rows.length < 3) continue

    if (rows.length > bestRows.length) {
      bestRows = rows
      bestHeaderDetected = headerDetected
    }
  }

  if (bestRows.length === 0) return null

  const nCols = bestRows.reduce((max, row) => Math.max(max, row.length), 0)
  const normalizedRows = bestRows.map(row => {
    const padded = [...row]
    while (padded.length < nCols) padded.push('')
    return padded.map(cell => escapeCsvCell(cell))
  })
  const csvText = normalizedRows.map(row => row.join(',')).join('\n')
  const nRows = Math.max(0, normalizedRows.length - (bestHeaderDetected ? 1 : 0))
  if (nRows <= 0) return null

  const numericCellRegex = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i
  let nonEmptyCells = 0
  let numericCells = 0
  for (let rowIndex = bestHeaderDetected ? 1 : 0; rowIndex < bestRows.length; rowIndex += 1) {
    for (const cellRaw of bestRows[rowIndex] || []) {
      const cell = normalizeInline(cellRaw)
      if (!cell) continue
      nonEmptyCells += 1
      const normalized = cell.replace(/,/g, '')
      if (numericCellRegex.test(normalized)) numericCells += 1
    }
  }
  const numericRatio = nonEmptyCells > 0 ? numericCells / nonEmptyCells : 0

  const metadataFirstColumnHints = [
    'comments',
    'subjects',
    'report number',
    'journal reference',
    'cite as',
    'related doi',
    'doi',
  ]
  let metadataHintRows = 0
  for (let rowIndex = 0; rowIndex < Math.min(bestRows.length, 20); rowIndex += 1) {
    const firstCell = normalizeInline(bestRows[rowIndex]?.[0] || '').toLowerCase()
    if (!firstCell) continue
    if (metadataFirstColumnHints.some(hint => firstCell.startsWith(hint))) {
      metadataHintRows += 1
    }
  }
  const metadataLike = metadataHintRows >= 2

  return {
    csvText,
    nRows,
    nCols,
    headerDetected: bestHeaderDetected,
    numericRatio,
    metadataLike,
  }
}

function isLikelyFieldDatasetExtraction(extracted: HtmlTableExtraction): boolean {
  if (
    !extracted ||
    !Number.isFinite(extracted.nRows) ||
    !Number.isFinite(extracted.nCols) ||
    !Number.isFinite(extracted.numericRatio)
  ) {
    return false
  }
  if (extracted.nRows < MIN_PAPER_TABLE_DATASET_ROWS) return false
  if (extracted.nCols < 2) return false
  if (extracted.metadataLike) return false
  if (extracted.numericRatio < MIN_PAPER_TABLE_NUMERIC_RATIO) return false
  return true
}

function buildPaperCompanionUrls(candidate: string): string[] {
  const urls: string[] = []
  try {
    const url = new URL(candidate)
    const pathname = url.pathname
    if (/^\/pdf\/.+/i.test(pathname)) {
      const withoutPrefix = pathname.replace(/^\/pdf\//i, '')
      const paperId = withoutPrefix.replace(/\.pdf$/i, '')
      if (paperId) {
        urls.push(`${url.origin}/abs/${paperId}`)
      }
    }
  } catch {
    return []
  }
  return Array.from(new Set(urls.filter(Boolean)))
}

async function resolveDatasetFromPaperUrl(params: {
  candidate: string
  cwd: string
  datasetsDirAbs: string
  semanticProfile?: ClaimSemanticProfile
  signal?: AbortSignal
}): Promise<ResolvedDataset | null> {
  const sources = [
    normalizeInline(params.candidate),
    ...buildPaperCompanionUrls(params.candidate),
  ].filter(Boolean)

  for (const source of sources) {
    if (params.signal?.aborted) return null
    try {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        DEFAULT_DATASET_DOWNLOAD_TIMEOUT_MS,
      )
      const response = await fetch(source, {
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) continue

      const contentLengthRaw = response.headers.get('content-length')
      const contentLength = contentLengthRaw
        ? Number.parseInt(contentLengthRaw, 10)
        : undefined
      if (
        typeof contentLength === 'number' &&
        Number.isFinite(contentLength) &&
        contentLength > MAX_DATASET_DOWNLOAD_BYTES
      ) {
        continue
      }

      const mimeType = normalizeMimeType(response.headers.get('content-type'))
      if (mimeType && !DATASET_HTML_MIME_REGEX.test(mimeType)) continue
      const htmlText = await response.text()
      if (htmlText.length > MAX_DATASET_DOWNLOAD_BYTES) continue

      const extracted = extractDatasetCsvFromHtml(htmlText)
      if (!extracted) continue
      if (!isLikelyFieldDatasetExtraction(extracted)) continue
      const csvBuffer = Buffer.from(extracted.csvText, 'utf8')
      const analysis = analyzeDatasetBuffer({
        buffer: csvBuffer,
        format: 'csv',
        mimeType: 'text/csv',
      })
      if (!analysis.parseOk || !analysis.mimeValid || analysis.nRows <= 0) {
        continue
      }

      const urlName = basename(new URL(source).pathname || '').trim()
      const safeBase = sanitizePathSegment(urlName || 'paper_table_extract')
      const localAbs = resolve(params.datasetsDirAbs, `${safeBase}.extracted.csv`)
      writeFileSync(localAbs, csvBuffer)
      const localRelativePath = relative(params.cwd, localAbs)
      const semanticFit = evaluateSemanticFitAgainstText({
        profile: params.semanticProfile,
        text: [
          source,
          localRelativePath,
          analysis.columnHints.join(' '),
          normalizeInline(urlName),
        ].join(' '),
      })
      if (!semanticFit.pass) continue
      return {
        source,
        sourceType: 'url',
        format: 'csv',
        mimeType: 'text/csv',
        mimeValid: true,
        parseOk: true,
        nCols: analysis.nCols,
        headerDetected: analysis.headerDetected,
        checksumSha256: createHash('sha256').update(csvBuffer).digest('hex'),
        localRelativePath,
        nRows: analysis.nRows,
        downloaded: true,
        columnHints: analysis.columnHints,
      }
    } catch {
      continue
    }
  }

  return null
}

function analyzeDelimitedTextDataset(
  content: string,
  delimiter: ',' | '\t',
): Pick<
  ResolvedDataset,
  'parseOk' | 'nRows' | 'nCols' | 'headerDetected' | 'columnHints'
> {
  if (!content.trim() || looksLikeHtmlContent(content)) {
    return {
      parseOk: false,
      nRows: 0,
      nCols: 0,
      headerDetected: false,
      columnHints: [],
    }
  }
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return {
      parseOk: false,
      nRows: 0,
      nCols: 0,
      headerDetected: false,
      columnHints: [],
    }
  }
  const rows = lines.map(line => line.split(delimiter).map(cell => cell.trim()))
  const nCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const firstRow = rows[0] || []
  const headerDetected = firstRow.some(cell => /[a-zA-Z_]/.test(cell))
  const nRows = Math.max(0, rows.length - (headerDetected ? 1 : 0))
  const columnHints = headerDetected
    ? firstRow
        .map(cell => normalizeSemanticToken(cell))
        .filter(Boolean)
        .slice(0, 48)
    : []
  return {
    parseOk: nCols > 0 && nRows >= 1,
    nRows,
    nCols,
    headerDetected,
    columnHints,
  }
}

function analyzeJsonlDataset(
  content: string,
): Pick<
  ResolvedDataset,
  'parseOk' | 'nRows' | 'nCols' | 'headerDetected' | 'columnHints'
> {
  if (!content.trim() || looksLikeHtmlContent(content)) {
    return {
      parseOk: false,
      nRows: 0,
      nCols: 0,
      headerDetected: false,
      columnHints: [],
    }
  }
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return {
      parseOk: false,
      nRows: 0,
      nCols: 0,
      headerDetected: false,
      columnHints: [],
    }
  }
  let nCols = 0
  let parsedRows = 0
  const observedKeys = new Set<string>()
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown
      parsedRows += 1
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed as Record<string, unknown>)
        nCols = Math.max(nCols, keys.length)
        for (const key of keys) {
          const normalized = normalizeSemanticToken(key)
          if (normalized) observedKeys.add(normalized)
        }
      } else if (Array.isArray(parsed)) {
        nCols = Math.max(nCols, parsed.length)
      } else {
        nCols = Math.max(nCols, 1)
      }
    } catch {
      return {
        parseOk: false,
        nRows: 0,
        nCols: 0,
        headerDetected: false,
        columnHints: [],
      }
    }
  }
  return {
    parseOk: parsedRows > 0 && nCols > 0,
    nRows: parsedRows,
    nCols,
    headerDetected: true,
    columnHints: Array.from(observedKeys).slice(0, 48),
  }
}

function analyzeDatasetBuffer(params: {
  buffer: Buffer
  format: ResolvedDataset['format']
  mimeType: string
}): Pick<
  ResolvedDataset,
  'mimeValid' | 'parseOk' | 'nRows' | 'nCols' | 'headerDetected' | 'columnHints'
> {
  const mimeType = params.mimeType || 'application/octet-stream'
  const mimeValid =
    !DATASET_DISALLOWED_MIME_REGEX.test(mimeType) &&
    (!mimeType ||
      DATASET_ALLOWED_MIME_REGEX.test(mimeType) ||
      mimeType === 'application/octet-stream')

  if (!mimeValid) {
    return {
      mimeValid: false,
      parseOk: false,
      nRows: 0,
      nCols: 0,
      headerDetected: false,
      columnHints: [],
    }
  }

  if (
    params.buffer.slice(0, 5).toString('utf8').toUpperCase() === '%PDF-'
  ) {
    return {
      mimeValid: false,
      parseOk: false,
      nRows: 0,
      nCols: 0,
      headerDetected: false,
      columnHints: [],
    }
  }

  const textContent = params.buffer.toString('utf8')

  if (params.format === 'csv') {
    return {
      mimeValid,
      ...analyzeDelimitedTextDataset(textContent, ','),
    }
  }
  if (params.format === 'tsv') {
    return {
      mimeValid,
      ...analyzeDelimitedTextDataset(textContent, '\t'),
    }
  }
  if (params.format === 'jsonl') {
    return {
      mimeValid,
      ...analyzeJsonlDataset(textContent),
    }
  }
  return {
    mimeValid,
    parseOk: false,
    nRows: 0,
    nCols: 0,
    headerDetected: false,
    columnHints: [],
  }
}

async function resolveDatasetForField(params: {
  candidates: string[]
  cwd: string
  semanticProfile?: ClaimSemanticProfile
  signal?: AbortSignal
  depth?: number
  visitedUrls?: Set<string>
}): Promise<ResolvedDataset | null> {
  if (params.candidates.length === 0) return null
  const datasetsDirAbs = resolve(params.cwd, EXPERIMENT_DATASET_OUTPUT_DIR)
  mkdirSync(datasetsDirAbs, { recursive: true })
  const depth = params.depth || 0
  const visitedUrls = params.visitedUrls || new Set<string>()

  for (const candidateRaw of params.candidates) {
    if (params.signal?.aborted) return null
    const candidate = normalizeInline(candidateRaw)
    if (!candidate) continue

    if (/^https?:\/\//i.test(candidate)) {
      if (visitedUrls.has(candidate)) continue
      visitedUrls.add(candidate)
      if (isDisallowedDatasetUrl(candidate)) {
        const extractedFromPaper = await resolveDatasetFromPaperUrl({
          candidate,
          cwd: params.cwd,
          datasetsDirAbs,
          semanticProfile: params.semanticProfile,
          signal: params.signal,
        })
        if (extractedFromPaper) return extractedFromPaper
        continue
      }
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DEFAULT_DATASET_DOWNLOAD_TIMEOUT_MS)
        const response = await fetch(candidate, {
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (!response.ok) continue
        const contentLengthRaw = response.headers.get('content-length')
        const contentLength = contentLengthRaw
          ? Number.parseInt(contentLengthRaw, 10)
          : undefined
        if (
          typeof contentLength === 'number' &&
          Number.isFinite(contentLength) &&
          contentLength > MAX_DATASET_DOWNLOAD_BYTES
        ) {
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > MAX_DATASET_DOWNLOAD_BYTES) continue
        const mimeType = normalizeMimeType(response.headers.get('content-type'))
        if (mimeType && DATASET_HTML_MIME_REGEX.test(mimeType)) {
          if (depth < 2) {
            const htmlText = buffer.toString('utf8')
            const htmlCandidates = extractDatasetCandidateUrlsFromHtml({
              html: htmlText,
              baseUrl: candidate,
            })
            if (htmlCandidates.length > 0) {
              const nested = await resolveDatasetForField({
                candidates: htmlCandidates,
                cwd: params.cwd,
                semanticProfile: params.semanticProfile,
                signal: params.signal,
                depth: depth + 1,
                visitedUrls,
              })
              if (nested) return nested
            }
          }
          continue
        }
        const urlPath = new URL(candidate).pathname || ''
        const formatFromExt = detectDatasetFormatFromExtension(urlPath)
        const formatFromMime = detectDatasetFormatFromMimeType(mimeType)
        const format =
          formatFromExt !== 'unknown' ? formatFromExt : formatFromMime
        if (format === 'unknown') continue
        const analysis = analyzeDatasetBuffer({ buffer, format, mimeType })
        if (!analysis.parseOk || !analysis.mimeValid || analysis.nRows <= 0) continue
        const urlName = basename(urlPath).trim()
        const fallbackName = `dataset.${format}`
        const safeName = sanitizePathSegment(urlName || fallbackName)
        const ext = /\.[a-z0-9]+$/i.test(safeName) ? '' : `.${format}`
        const localAbs = resolve(datasetsDirAbs, `${safeName}${ext}`)
        writeFileSync(localAbs, buffer)
        const localRelativePath = relative(params.cwd, localAbs)
        const semanticFit = evaluateSemanticFitAgainstText({
          profile: params.semanticProfile,
          text: [
            candidate,
            localRelativePath,
            analysis.columnHints.join(' '),
            normalizeInline(urlName),
          ].join(' '),
        })
        if (!semanticFit.pass) continue
        return {
          source: candidate,
          sourceType: 'url',
          format,
          mimeType: mimeType || 'application/octet-stream',
          mimeValid: analysis.mimeValid,
          parseOk: analysis.parseOk,
          nCols: analysis.nCols,
          headerDetected: analysis.headerDetected,
          checksumSha256: createHash('sha256').update(buffer).digest('hex'),
          localRelativePath,
          nRows: analysis.nRows,
          downloaded: true,
          columnHints: analysis.columnHints,
        }
      } catch {
        continue
      }
    }

    const localAbs = isAbsolute(candidate)
      ? candidate
      : resolve(params.cwd, candidate)
    if (!existsSync(localAbs)) continue
    const format = detectDatasetFormatFromExtension(localAbs)
    if (format === 'unknown') continue
    let buffer: Buffer
    try {
      buffer = Buffer.from(readFileSync(localAbs))
    } catch {
      continue
    }
    const mimeType =
      format === 'csv'
        ? 'text/csv'
        : format === 'tsv'
          ? 'text/tab-separated-values'
          : format === 'jsonl'
            ? 'application/x-ndjson'
            : 'application/parquet'
    const analysis = analyzeDatasetBuffer({ buffer, format, mimeType })
    if (!analysis.parseOk || !analysis.mimeValid || analysis.nRows <= 0) continue
    const localRelativePath = relative(params.cwd, localAbs)
    const semanticFit = evaluateSemanticFitAgainstText({
      profile: params.semanticProfile,
      text: [
        candidate,
        localRelativePath,
        analysis.columnHints.join(' '),
        normalizeInline(basename(localAbs)),
      ].join(' '),
    })
    if (!semanticFit.pass) continue
    return {
      source: candidate,
      sourceType: 'local',
      format,
      mimeType,
      mimeValid: analysis.mimeValid,
      parseOk: analysis.parseOk,
      nCols: analysis.nCols,
      headerDetected: analysis.headerDetected,
      checksumSha256: createHash('sha256').update(buffer).digest('hex'),
      localRelativePath,
      nRows: analysis.nRows,
      downloaded: false,
      columnHints: analysis.columnHints,
    }
  }

  return null
}

function buildDatasetFieldRunner(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  dataset: ResolvedDataset
}): ExperimentRunnersResult['experiment_runners']['runners'][number] {
  const existingIds = new Set(params.plan.runners.map(runner => runner.id))
  let nextId = 'R_FIELD_DATASET'
  let suffix = 2
  while (existingIds.has(nextId)) {
    nextId = `R_FIELD_DATASET_${suffix}`
    suffix += 1
  }
  const datasetPath = params.dataset.localRelativePath.replace(/\\/g, '/')
  return {
    id: nextId,
    goal:
      'Evaluate field evidence with a real dataset and emit an evidence contract for gates.',
    test_ids: ['FIELD_DATASET_EVIDENCE'],
    phase: 'field',
    language: 'python',
    filename: 'field_dataset_evidence.py',
    run_command: 'python field_dataset_evidence.py',
    required_inputs: [datasetPath],
    expected_signal: 'FIELD_EVIDENCE_READY',
    failure_signal: 'FIELD_EVIDENCE_FAIL',
    code: `import json
import os

DATASET_PATH = ${JSON.stringify(datasetPath)}
DATASET_SOURCE_URI = ${JSON.stringify(params.dataset.source)}
DATASET_SOURCE_TYPE = ${JSON.stringify(params.dataset.sourceType)}
DATASET_FORMAT = ${JSON.stringify(params.dataset.format)}
DATASET_MIME_TYPE = ${JSON.stringify(params.dataset.mimeType)}
DATASET_MIME_VALID = ${params.dataset.mimeValid ? 'True' : 'False'}
DATASET_PARSE_OK = ${params.dataset.parseOk ? 'True' : 'False'}
N_ROWS = ${params.dataset.nRows}
N_COLS = ${params.dataset.nCols}
HEADER_DETECTED = ${params.dataset.headerDetected ? 'True' : 'False'}
COLUMN_HINTS = ${JSON.stringify(params.dataset.columnHints)}
DATASET_CHECKSUM_SHA256 = ${JSON.stringify(params.dataset.checksumSha256)}

def main():
    if not os.path.exists(DATASET_PATH):
        print('FIELD_EVIDENCE_FAIL: missing_dataset')
        print('AMAWTA_EVIDENCE_CONTRACT=' + json.dumps({
            'phase': 'field',
            'dataset_used': False,
            'dataset_source': 'unknown',
            'dataset_source_type': 'unknown',
            'dataset_format': 'unknown',
            'dataset_mime_type': '',
            'dataset_mime_valid': False,
            'dataset_parse_ok': False,
            'dataset_checksum_sha256': '',
            'dataset_source_uri': DATASET_SOURCE_URI,
            'n_rows': 0,
            'n_cols': 0,
            'header_detected': False,
            'column_hints': [],
            'lobo_folds': 0,
            'runner_contract': 'FAIL',
            'truth_assessment': 'INCONCLUSIVE',
        }))
        raise SystemExit(2)

    lobo_folds = 4 if N_ROWS >= 30 else (2 if N_ROWS >= 10 else 1)
    contract_ok = DATASET_MIME_VALID and DATASET_PARSE_OK and N_ROWS > 0 and N_COLS > 0
    contract = {
        'phase': 'field',
        'dataset_used': contract_ok,
        'dataset_source': 'real' if contract_ok else 'unknown',
        'dataset_source_type': DATASET_SOURCE_TYPE if contract_ok else 'unknown',
        'dataset_format': DATASET_FORMAT if contract_ok else 'unknown',
        'dataset_mime_type': DATASET_MIME_TYPE,
        'dataset_mime_valid': DATASET_MIME_VALID,
        'dataset_parse_ok': DATASET_PARSE_OK,
        'dataset_checksum_sha256': DATASET_CHECKSUM_SHA256,
        'dataset_source_uri': DATASET_SOURCE_URI,
        'n_rows': N_ROWS,
        'n_cols': N_COLS,
        'header_detected': HEADER_DETECTED,
        'column_hints': COLUMN_HINTS,
        'lobo_folds': lobo_folds if contract_ok else 0,
        'runner_contract': 'PASS' if contract_ok else 'FAIL',
        'truth_assessment': 'PASS' if contract_ok and N_ROWS >= 30 else 'INCONCLUSIVE',
    }

    print(f'dataset_path={DATASET_PATH}')
    print(f'dataset_source={DATASET_SOURCE_URI}')
    print(f'dataset_format={DATASET_FORMAT}')
    print(f'dataset_mime_valid={DATASET_MIME_VALID}')
    print(f'dataset_parse_ok={DATASET_PARSE_OK}')
    print(f'n_rows={N_ROWS}')
    print(f'n_cols={N_COLS}')
    print(f'column_hints={",".join(COLUMN_HINTS)}')
    print(f'lobo_folds={contract["lobo_folds"]}')
    print('FIELD_EVIDENCE_READY' if contract['runner_contract'] == 'PASS' else 'FIELD_EVIDENCE_FAIL')
    print('AMAWTA_EVIDENCE_CONTRACT=' + json.dumps(contract, ensure_ascii=False))

    if contract['runner_contract'] != 'PASS':
        raise SystemExit(2)

if __name__ == '__main__':
    main()
`,
  }
}

function hasDatasetSignal(parts: Array<string | undefined | null>): boolean {
  return parts.some(part => {
    const text = normalizeInline(part || '')
    if (!text) return false
    if (/dataset_used\s*[:=]\s*true/i.test(text)) return true
    return DATASET_HINT_REGEX.test(text)
  })
}

function hasDisallowedDatasetReference(text: string): boolean {
  const normalized = normalizeInline(text || '')
  if (!normalized) return false

  const urls = normalized.match(/\bhttps?:\/\/[^\s'"`)<>\]]+/gi) || []
  for (const url of urls) {
    if (isDisallowedDatasetUrl(url)) return true
  }
  return DATASET_DISALLOWED_URL_PATH_REGEX.test(normalized.toLowerCase())
}

function extractLocalDatasetPathCandidates(text: string): string[] {
  const normalized = text || ''
  const candidates = new Set<string>()
  if (!normalized.trim()) return []

  const pathRegex =
    /(?:^|[\s"'`])((?:\.{0,2}\/|\/|[a-zA-Z]:\\)?[^\s"'`]+?\.(?:csv|tsv|jsonl|parquet))(?:$|[\s"'`])/gi
  for (const match of normalized.matchAll(pathRegex)) {
    const raw = normalizeInline(match[1] || '')
    if (!raw || /^https?:\/\//i.test(raw)) continue
    candidates.add(raw.replace(/^dataset\s*:\s*/i, ''))
  }

  return Array.from(candidates)
}

function inferLocalDatasetEvidenceFromRun(params: {
  run: RunnerExecutionResult
  runner?: PlanRunner
}): {
  datasetUsed: boolean
  hasRealDataset: boolean
  nRows: number
  loboFolds: number
} {
  const aggregateText = [
    params.runner?.required_inputs?.join(' ') || '',
    params.runner?.run_command || '',
    params.runner?.code || '',
    params.run.command || '',
    params.run.stdoutRaw || '',
    params.run.stderrRaw || '',
    params.run.stdoutPreview || '',
    params.run.stderrPreview || '',
  ].join('\n')

  const syntheticTagged = SYNTHETIC_DATASET_SIGNAL_REGEX.test(
    normalizeInline(aggregateText),
  )
  const disallowedRef = hasDisallowedDatasetReference(aggregateText)
  const pathCandidates = extractLocalDatasetPathCandidates(aggregateText)
  const hasRemoteCsvUrl = /\bhttps?:\/\/[^\s'"`]+\.csv\b/i.test(aggregateText)
  const hasReadCsvCall = /\b(?:pd|pandas)\.read_csv\(/i.test(aggregateText)
  const knownRealDatasetLoaderDetected =
    /\b(?:sns|seaborn)\.load_dataset\(/i.test(aggregateText) ||
    // Direct URL literal or variable indirection (url = "https://...csv"; pd.read_csv(url))
    ((hasReadCsvCall && hasRemoteCsvUrl) ||
      /\b(?:pd|pandas)\.read_csv\(\s*['"]https?:\/\/[^'"]+\.csv\b/i.test(
        aggregateText,
      )) ||
    /\bsklearn\.datasets\.(?:fetch_[a-z0-9_]+|load_[a-z0-9_]+)\(/i.test(
      aggregateText,
    ) ||
    /\bdatasets\.load_dataset\(/i.test(aggregateText) ||
    /\bopenml\b/i.test(aggregateText)

  let nRows = 0
  let localValidatedDatasetDetected = false
  for (const candidate of pathCandidates) {
    const localAbs = isAbsolute(candidate)
      ? candidate
      : resolve(params.run.cwd || getCwd(), candidate)
    if (!existsSync(localAbs)) continue
    const format = detectDatasetFormatFromExtension(localAbs)
    if (format === 'unknown') continue

    let buffer: Buffer
    try {
      buffer = Buffer.from(readFileSync(localAbs))
    } catch {
      continue
    }

    const mimeType =
      format === 'csv'
        ? 'text/csv'
        : format === 'tsv'
          ? 'text/tab-separated-values'
          : format === 'jsonl'
            ? 'application/x-ndjson'
            : 'application/parquet'
    const analysis = analyzeDatasetBuffer({ buffer, format, mimeType })
    if (!analysis.parseOk || !analysis.mimeValid || analysis.nRows <= 0) continue
    localValidatedDatasetDetected = true
    nRows = Math.max(nRows, analysis.nRows)
  }

  const inferredRowsFromOutput = parseMaxMetric(aggregateText, [
    /\bn[_\s-]?rows?\s*[:=]\s*(\d+)\b/gi,
    /\brows?\s*[:=]\s*(\d+)\b/gi,
    /\bno\.?\s*observations?\s*[:=]\s*(\d+)\b/gi,
    /\bn\s*total\s*[:=]\s*(\d+)\b/gi,
    /\btotal\s*muestras(?:\s*validas)?\s*[:=]\s*(\d+)\b/gi,
    /\bmuestras(?:\s*validas)?\s*[:=]\s*(\d+)\b/gi,
    /\bprocesad[oa]s?\s*(\d+)\s*(?:filas|rows?)\b/gi,
    /\bshape\s*[:=]?\s*\(?\s*(\d+)\s*,\s*\d+\s*\)?/gi,
  ])
  const effectiveRows = Math.max(nRows, inferredRowsFromOutput)
  // A mere mention of "some_dataset.csv" is not evidence. We only treat the
  // dataset as "used" if we can parse rows or observe a known loader path.
  const datasetUsed =
    effectiveRows > 0 || localValidatedDatasetDetected || knownRealDatasetLoaderDetected
  const hasRealDataset =
    datasetUsed &&
    !syntheticTagged &&
    !disallowedRef &&
    (localValidatedDatasetDetected ||
      (knownRealDatasetLoaderDetected && effectiveRows >= 30))
  const loboFolds =
    effectiveRows >= 30 ? 4 : effectiveRows >= 10 ? 2 : effectiveRows > 0 ? 1 : 0

  return {
    datasetUsed,
    hasRealDataset,
    nRows: effectiveRows,
    loboFolds,
  }
}

type RunnerGateEvaluationContext = {
  normalizationGate?: GateVerdictReport
  falsificationPlanQualityGate?: GateVerdictReport
  claimSemanticProfile?: ClaimSemanticProfile
}

function evaluateRunnerGates(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  executionResults: RunnerExecutionResult[]
  dependencyInstallError?: string
  gateContext?: RunnerGateEvaluationContext
}): RunnerGateReport {
  const runnersById = new Map(params.plan.runners.map(runner => [runner.id, runner]))
  const toyRuns = params.executionResults.filter(run => {
    const phase = runnersById.get(run.id)?.phase || run.evidenceContract?.phase
    return phase === 'toy' || phase === 'both'
  })
  const fieldRuns = params.executionResults.filter(run => {
    const phase = runnersById.get(run.id)?.phase || run.evidenceContract?.phase
    return phase === 'field' || phase === 'both'
  })
  const effectiveFieldRuns =
    fieldRuns.length > 0
      ? fieldRuns
      : params.executionResults.filter(run => {
          const runner = runnersById.get(run.id)
          const combined = [
            run.command,
            run.stdoutRaw,
            run.stderrRaw,
            run.stdoutPreview,
            run.stderrPreview,
            runner?.run_command,
            runner?.goal,
            runner?.test_ids?.join(' '),
          ]
            .filter(Boolean)
            .join('\n')
          const runnerLooksField =
            runner?.phase === 'field' ||
            runner?.phase === 'both' ||
            (runner?.id || '').toUpperCase().includes('FIELD') ||
            (runner?.test_ids || []).some(id => id.toUpperCase().includes('FIELD'))
          return (
            runnerLooksField ||
            run.evidenceContract?.phase === 'field' ||
            /FIELD_EVIDENCE_(?:READY|FAIL)\b/i.test(combined) ||
            /AMAWTA_EVIDENCE_CONTRACT=/i.test(combined)
          )
        })
  const executedToyRuns = toyRuns.filter(
    run => run.status === 'success' || run.status === 'failed',
  )
  const toyStatus: ToyStatus =
    toyRuns.length === 0
      ? 'not_executed'
      : executedToyRuns.length > 0 && executedToyRuns.every(run => run.status === 'success')
        ? 'success'
        : executedToyRuns.length > 0
          ? 'executed'
          : 'not_executed'

  let passTests = 0
  let failTests = 0
  let strongFailTests = 0
  let logicalContradiction = false
  const toyContractAssessments = toyRuns
    .map(run => run.evidenceContract?.truth_assessment)
    .filter(
      (value): value is NonNullable<RunnerExecutionResult['evidenceContract']>['truth_assessment'] =>
        value === 'PASS' || value === 'FAIL' || value === 'INCONCLUSIVE',
    )
  for (const run of toyRuns) {
    const runner = runnersById.get(run.id)
    if (run.status === 'failed') {
      failTests += 1
      continue
    }
    if (run.status !== 'success') continue
    const text = normalizeInline(
      [run.stdoutPreview, run.stderrPreview, run.reason].filter(Boolean).join(' '),
    )
    const { hasPass, hasFail } = detectRunSignals(text, {
      expectedSignal: runner?.expected_signal,
      failureSignal: runner?.failure_signal,
    })
    const hasStrongFailSignal =
      hasSignalHint(text, runner?.failure_signal) ||
      (EXPLICIT_FAIL_ASSIGNMENT_REGEX.test(text) &&
        !EXPECTED_FAIL_CONTEXT_REGEX.test(text))
    if (hasPass) passTests += 1
    if (hasFail) failTests += 1
    if (hasStrongFailSignal) strongFailTests += 1
    if (hasPass && hasFail) logicalContradiction = true
  }

  const toyExecutionFailed = toyRuns.some(run => run.status === 'failed')
  const toyTruthAssessment: ToyTruthAssessment =
    toyContractAssessments.includes('FAIL')
      ? 'FAIL'
      : toyContractAssessments.includes('PASS') && !toyContractAssessments.includes('FAIL')
        ? 'PASS'
        : toyExecutionFailed
          ? 'INCONCLUSIVE'
        : (toyStatus === 'executed' || toyStatus === 'success') &&
            !logicalContradiction &&
            passTests > 0 &&
            failTests === 0
          ? 'PASS'
          : strongFailTests > 0 && passTests === 0 && !logicalContradiction
            ? 'FAIL'
            : failTests > 0 || logicalContradiction
              ? 'INCONCLUSIVE'
            : 'INCONCLUSIVE'

  const fieldShouldAdvance =
    executedToyRuns.some(run => run.status === 'success') &&
    toyTruthAssessment !== 'FAIL' &&
    !toyExecutionFailed
  const fieldReason = fieldShouldAdvance
    ? 'Toy executed without hard FAIL; field can proceed.'
    : 'Toy does not meet minimum criteria (exit!=0 or truth_assessment=FAIL).'

  const runFailedCount = params.executionResults.filter(
    run => run.status === 'failed',
  ).length
  const runOkCount = params.executionResults.filter(
    run => run.status === 'success',
  ).length
  const runtimeErrorSignalDetected = params.executionResults.some(run =>
    hasRunRuntimeErrorSignal(
      [run.stdoutRaw, run.stderrRaw, run.stdoutPreview, run.stderrPreview]
        .filter(Boolean)
        .join('\n'),
    ),
  )
  const contractSignals = params.executionResults
    .map(run => run.evidenceContract?.runner_contract)
    .filter(
      (value): value is NonNullable<RunnerExecutionResult['evidenceContract']>['runner_contract'] =>
        value === 'PASS' || value === 'FAIL',
    )
  const contractSignalPass =
    contractSignals.length > 0
      ? !contractSignals.includes('FAIL')
      : undefined
  const runnerContractPass =
    runOkCount > 0 &&
    runFailedCount === 0 &&
    !params.dependencyInstallError &&
    !runtimeErrorSignalDetected &&
    (contractSignalPass ?? true)
  const runnerContractReason = runnerContractPass
    ? contractSignals.length > 0
      ? 'PASS contract confirmed by runners (AMAWTA_EVIDENCE_CONTRACT).'
      : 'All executed runs finished without contract errors.'
    : contractSignals.includes('FAIL')
      ? 'At least one runner reported runner_contract=FAIL.'
      : runtimeErrorSignalDetected
        ? 'Runtime error signals detected in stdout/stderr despite exit=0.'
      : 'There are failed runs or environment/dependency failures.'

  let datasetUsed = false
  let hasRealDataset = false
  let nRows = 0
  let loboFolds = 0
  let explicitDatasetValidationFailure = false
  let deltaBits: number | undefined
  let deltaBic: number | undefined
  let h4: number | undefined
  let h2: number | undefined
  let frag: number | undefined
  let loboPass: boolean | undefined
  let existence: NonNullable<RunnerExecutionResult['evidenceContract']>['existence']
  let topology: string | undefined
  let energyAvailable: number | undefined
  let energyRequired: number | undefined
  let energyDelta: number | undefined
  let informationDeltaBits: number | undefined
  let informationDeltaBic: number | undefined
  let hasSyntheticFieldEvidence = false
  const semanticSignalParts: string[] = []
  const semanticProfile = params.gateContext?.claimSemanticProfile
  for (const run of effectiveFieldRuns) {
    const runner = runnersById.get(run.id)
    const localEvidence = inferLocalDatasetEvidenceFromRun({ run, runner })
    const combined = [
      run.stdoutRaw,
      run.stderrRaw,
      run.stdoutPreview,
      run.stderrPreview,
      runner?.required_inputs?.join(' ') || '',
      runner?.run_command || '',
      runner?.code || '',
      run.command,
    ]
      .filter(Boolean)
      .join('\n')
    const isAutoSynthetic =
      runner?.id.startsWith('R_FIELD_AUTOREPAIR') ||
      runner?.test_ids?.some(id => id.toUpperCase().includes('AUTO_FIELD')) ||
      run.evidenceContract?.dataset_source === 'synthetic'
    if (isAutoSynthetic && run.evidenceContract?.dataset_used === true) {
      hasSyntheticFieldEvidence = true
    }
    if (run.evidenceContract?.column_hints && run.evidenceContract.column_hints.length > 0) {
      semanticSignalParts.push(run.evidenceContract.column_hints.join(' '))
    }
    semanticSignalParts.push(combined)
    const contractSourceIsReal =
      run.evidenceContract?.dataset_source === 'real'
    const sourceUriLooksReal =
      hasConcreteDatasetReference(run.evidenceContract?.dataset_source_uri || '') ||
      hasConcreteDatasetReference(
        [run.stdoutRaw, run.stderrRaw, run.stdoutPreview, run.stderrPreview]
          .filter(Boolean)
          .join('\n'),
      )
    const contractHasRealSource = contractSourceIsReal || sourceUriLooksReal
    const contractHasValidatedRealDataset =
      run.evidenceContract?.dataset_used === true &&
      contractHasRealSource &&
      run.evidenceContract?.dataset_mime_valid === true &&
      run.evidenceContract?.dataset_parse_ok === true &&
      (run.evidenceContract?.dataset_format === 'csv' ||
        run.evidenceContract?.dataset_format === 'tsv' ||
        run.evidenceContract?.dataset_format === 'jsonl' ||
        run.evidenceContract?.dataset_format === 'parquet')
    const contractHasInvalidRealDataset =
      run.evidenceContract?.dataset_used === true &&
      contractHasRealSource &&
      (run.evidenceContract?.dataset_mime_valid === false ||
        run.evidenceContract?.dataset_parse_ok === false)
    if (contractHasInvalidRealDataset) {
      explicitDatasetValidationFailure = true
    }

    deltaBits =
      run.evidenceContract?.delta_bits ??
      deltaBits ??
      parseFirstFloatMetric(combined, [/\bdelta[_\s-]?bits?\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi])
    deltaBic =
      run.evidenceContract?.delta_bic ??
      deltaBic ??
      parseFirstFloatMetric(combined, [/\bdelta[_\s-]?bic\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi])
    h4 =
      run.evidenceContract?.h4 ??
      h4 ??
      parseFirstFloatMetric(combined, [/\bh4\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi])
    h2 =
      run.evidenceContract?.h2 ??
      h2 ??
      parseFirstFloatMetric(combined, [/\bh2\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi])
    frag =
      run.evidenceContract?.frag ??
      frag ??
      parseFirstFloatMetric(combined, [/\bfrag(?:mentation)?\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi])
    loboPass =
      run.evidenceContract?.lobo_pass ??
      loboPass ??
      parseFirstBooleanMetric(combined, [
        /\blobo(?:\.|_|\s*)pass\s*[:=]\s*(true|false|pass|fail|yes|no|1|0)\b/gi,
      ])

    existence =
      run.evidenceContract?.existence ??
      existence ??
      (() => {
        const match = combined.match(
          /\bexistence\s*[:=]\s*(EXISTS|INEFFICIENT|NONEXISTENT)\b/i,
        )
        if (!match?.[1]) return undefined
        const normalized = normalizeInline(match[1]).toUpperCase()
        if (
          normalized === 'EXISTS' ||
          normalized === 'INEFFICIENT' ||
          normalized === 'NONEXISTENT'
        ) {
          return normalized as NonNullable<
            RunnerExecutionResult['evidenceContract']
          >['existence']
        }
        return undefined
      })()

    topology =
      run.evidenceContract?.topology ||
      topology ||
      (() => {
        const match = combined.match(/\btopology\s*[:=]\s*([a-zA-Z0-9_.:-]+)\b/i)
        return match?.[1] ? normalizeInline(match[1]) : undefined
      })()
    energyAvailable =
      run.evidenceContract?.energy_available ??
      energyAvailable ??
      parseFirstFloatMetric(combined, [
        /\benergy(?:\.|_|\s*)available\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi,
      ])
    energyRequired =
      run.evidenceContract?.energy_required ??
      energyRequired ??
      parseFirstFloatMetric(combined, [
        /\benergy(?:\.|_|\s*)required\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi,
      ])
    energyDelta =
      run.evidenceContract?.energy_delta ??
      energyDelta ??
      parseFirstFloatMetric(combined, [
        /\benergy(?:\.|_|\s*)delta\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi,
      ])
    informationDeltaBits =
      run.evidenceContract?.information_delta_bits ??
      informationDeltaBits ??
      parseFirstFloatMetric(combined, [
        /\binformation(?:\.|_|\s*)delta[_\s-]?bits?\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi,
      ])
    informationDeltaBic =
      run.evidenceContract?.information_delta_bic ??
      informationDeltaBic ??
      parseFirstFloatMetric(combined, [
        /\binformation(?:\.|_|\s*)delta[_\s-]?bic\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/gi,
      ])

    const runHasDataset =
      run.evidenceContract?.dataset_used === true ||
      hasDatasetSignal([
        ...(runner?.required_inputs || []),
        runner?.goal,
        runner?.run_command,
        runner?.code,
        run.stdoutRaw,
        run.stderrRaw,
        run.stdoutPreview,
        run.stderrPreview,
      ])
    datasetUsed =
      datasetUsed ||
      runHasDataset ||
      localEvidence.datasetUsed
    if (
      !isAutoSynthetic &&
      (contractHasValidatedRealDataset || localEvidence.hasRealDataset) &&
      !contractHasInvalidRealDataset &&
      !hasDisallowedDatasetReference(combined)
    ) {
      hasRealDataset = true
    }

    nRows = Math.max(
      nRows,
      localEvidence.nRows,
      run.evidenceContract?.n_rows || 0,
      parseMaxMetric(combined, [
        /\bn[_\s-]?rows?\s*[:=]\s*(\d+)\b/gi,
        /\brows?\s*[:=]\s*(\d+)\b/gi,
      ]),
    )
    loboFolds = Math.max(
      loboFolds,
      localEvidence.loboFolds,
      run.evidenceContract?.lobo_folds || 0,
      parseMaxMetric(combined, [
        /\blobo[_\s-]?folds?\s*[:=]\s*(\d+)\b/gi,
        /\bfolds?\s*[:=]\s*(\d+)\b/gi,
      ]),
    )

    if (loboFolds === 0 && hasRealDataset) {
      loboFolds = nRows >= 30 ? 4 : nRows >= 10 ? 2 : nRows > 0 ? 1 : 0
    }
  }

  const semanticFit = evaluateSemanticFitAgainstText({
    profile: semanticProfile,
    text: semanticSignalParts.join('\n'),
  })
  const claimDatasetFitPass = semanticFit.pass
  const claimDatasetFitMatchedTokens = semanticFit.matched
  const claimDatasetFitRequiredTokens = semanticFit.required

  const evidenceSufficiencyPass =
    datasetUsed &&
    hasRealDataset &&
    nRows >= 30 &&
    loboFolds >= 2 &&
    !explicitDatasetValidationFailure &&
    claimDatasetFitPass
  const evidenceSufficiencyStatus: EvidenceSufficiencyStatus =
    evidenceSufficiencyPass ? 'PASS' : 'FAIL'

  let stageDecision: StageDecision = 'NEEDS_FIELD'
  let stageReason =
    'Missing field evidence for closure (dataset_used + n_rows + lobo_folds).'

  if (toyTruthAssessment === 'FAIL') {
    stageDecision = 'REJECT_EARLY'
    stageReason = 'Toy truth_assessment=FAIL; stop before field.'
  } else if (!runnerContractPass) {
    stageDecision = 'DEFINITIVE_FAIL'
    stageReason = 'Runner contract FAIL (execution/environment errors).'
  } else if (fieldShouldAdvance && datasetUsed && hasRealDataset && !claimDatasetFitPass) {
    stageDecision = 'NEEDS_FIELD'
    stageReason =
      'Real dataset detected but not relevant to claim/observables; another field dataset is required.'
  } else if (evidenceSufficiencyPass) {
    stageDecision = 'DEFINITIVE_PASS'
    stageReason =
      'Sufficient field evidence and execution contract in PASS.'
  } else if (fieldShouldAdvance && datasetUsed && !hasRealDataset) {
    stageDecision = hasSyntheticFieldEvidence ? 'PROVISIONAL_PASS' : 'NEEDS_FIELD'
    stageReason = hasSyntheticFieldEvidence
      ? 'Provisional synthetic evidence available; real dataset still required for definitive closure.'
      : 'Synthetic/autorepair evidence exists, but no real field dataset.'
  } else if (fieldShouldAdvance) {
    stageDecision = datasetUsed ? 'PROVISIONAL_PASS' : 'NEEDS_FIELD'
    stageReason = datasetUsed
      ? 'Toy PASS and data present, but evidence thresholds are still insufficient.'
      : 'Toy provisional PASS; proceed to field with a real dataset.'
  }

  const normalizationGate =
    params.gateContext?.normalizationGate || {
      status: 'UNRESOLVED' as GateVerdict,
      reason: 'No normalization context received to validate claim_well_formed.',
    }
  const falsificationPlanQualityGate =
    params.gateContext?.falsificationPlanQualityGate || {
      status: 'UNRESOLVED' as GateVerdict,
      reason:
        'No FalsificationPlan context received to evaluate falsification_plan_quality.',
    }

  const evidenceGateStatus = parseTriGateStatusFromStageDecision(stageDecision)
  const evidenceGate: GateVerdictReport = {
    status: evidenceGateStatus,
    reason:
      evidenceGateStatus === 'PASS'
        ? 'Evidence gate PASS: real dataset and field thresholds satisfied.'
        : evidenceGateStatus === 'FAIL'
          ? `Evidence gate FAIL due to stage decision=${stageDecision}.`
          : claimDatasetFitPass
            ? `Evidence gate UNRESOLVED: stage decision=${stageDecision}.`
            : `Evidence gate UNRESOLVED: dataset not relevant to claim (semantic_fit=${claimDatasetFitMatchedTokens}/${claimDatasetFitRequiredTokens}).`,
  }

  const toyTruthGate: GateVerdictReport = {
    status:
      toyTruthAssessment === 'PASS'
        ? 'PASS'
        : toyTruthAssessment === 'FAIL'
          ? 'FAIL'
          : 'UNRESOLVED',
    reason: `toy.truth_assessment=${toyTruthAssessment}.`,
  }

  const runnerContractGate: GateVerdictReport = {
    status: runnerContractPass ? 'PASS' : 'FAIL',
    reason: runnerContractReason,
  }

  const hasFullUmcMetrics =
    typeof deltaBits === 'number' &&
    typeof deltaBic === 'number' &&
    typeof h4 === 'number' &&
    typeof h2 === 'number' &&
    typeof frag === 'number' &&
    typeof loboPass === 'boolean'

  let umcV1Gate: UmcV1GateReport = {
    status: 'UNRESOLVED',
    reason: 'UMC not evaluated: missing metrics or sufficient field evidence.',
    metrics: {
      delta_bits: deltaBits,
      delta_bic: deltaBic,
      h4,
      h2,
      frag,
      lobo_pass: loboPass,
    },
  }

  if (evidenceSufficiencyPass && hasFullUmcMetrics) {
    const umcPass =
      (deltaBits as number) < 0 &&
      (deltaBic as number) < 0 &&
      (h2 as number) < 0 &&
      (h4 as number) <= 0.3 &&
      (frag as number) <= 0.05 &&
      loboPass === true
    umcV1Gate = {
      status: umcPass ? 'PASS' : 'FAIL',
      reason: umcPass
        ? 'UMC v1 PASS: delta_bits<0, delta_bic<0, h2<0, h4<=0.3, frag<=0.05, lobo.pass=true.'
        : 'UMC v1 FAIL: at least one hard threshold is not satisfied.',
      metrics: {
        delta_bits: deltaBits,
        delta_bic: deltaBic,
        h4,
        h2,
        frag,
        lobo_pass: loboPass,
      },
    }
  } else if (!evidenceSufficiencyPass) {
    umcV1Gate = {
      status: 'UNRESOLVED',
      reason:
        'UMC v1 UNRESOLVED: insufficient evidence (requires real dataset, n_rows>=30, lobo_folds>=2).',
      metrics: {
        delta_bits: deltaBits,
        delta_bic: deltaBic,
        h4,
        h2,
        frag,
        lobo_pass: loboPass,
      },
    }
  } else {
    umcV1Gate = {
      status: 'UNRESOLVED',
      reason: 'UMC v1 UNRESOLVED: missing required metrics (delta/h2/h4/frag/lobo.pass).',
      metrics: {
        delta_bits: deltaBits,
        delta_bic: deltaBic,
        h4,
        h2,
        frag,
        lobo_pass: loboPass,
      },
    }
  }

  let ledgerClosureGate: GateVerdictReport = {
    status: 'UNRESOLVED',
    reason: 'Ledger closure not evaluated: missing evidence or closure fields.',
  }

  if (!evidenceSufficiencyPass) {
    ledgerClosureGate = {
      status: 'UNRESOLVED',
      reason:
        'Ledger closure UNRESOLVED: insufficient field evidence for energy/information closure.',
    }
  } else if (existence === 'NONEXISTENT') {
    ledgerClosureGate = {
      status: 'FAIL',
      reason: 'Ledger closure FAIL: existence reported as NONEXISTENT.',
    }
  } else if (existence === 'EXISTS' || existence === 'INEFFICIENT') {
    const hasLedgerFields =
      typeof topology === 'string' &&
      topology.length > 0 &&
      typeof energyAvailable === 'number' &&
      typeof energyRequired === 'number' &&
      typeof energyDelta === 'number' &&
      typeof informationDeltaBits === 'number' &&
      typeof informationDeltaBic === 'number'
    if (!hasLedgerFields) {
      ledgerClosureGate = {
        status: 'UNRESOLVED',
        reason:
          'Ledger closure UNRESOLVED: missing topology/energy/information for closure.',
      }
    } else {
      const expectedDelta = (energyAvailable as number) - (energyRequired as number)
      const closureOk = Math.abs(expectedDelta - (energyDelta as number)) <= 1e-6
      ledgerClosureGate = {
        status: closureOk ? 'PASS' : 'FAIL',
        reason: closureOk
          ? 'Ledger closure PASS: consistent energy closure.'
          : 'Ledger closure FAIL: energy.delta inconsistent with energy.available-required.',
      }
    }
  } else {
    ledgerClosureGate = {
      status: 'UNRESOLVED',
      reason:
        'Ledger closure UNRESOLVED: missing existence verdict (EXISTS/INEFFICIENT/NONEXISTENT).',
    }
  }

  if (
    (umcV1Gate.status === 'FAIL' || ledgerClosureGate.status === 'FAIL') &&
    (stageDecision === 'DEFINITIVE_PASS' ||
      stageDecision === 'PROVISIONAL_PASS' ||
      stageDecision === 'NEEDS_FIELD')
  ) {
    stageDecision = 'DEFINITIVE_FAIL'
    stageReason =
      'Universal gates reported FAIL (UMC/ledger); positive conclusion is not allowed.'
  }

  if (
    toyTruthAssessment === 'FAIL' &&
    (stageDecision === 'DEFINITIVE_PASS' ||
      stageDecision === 'PROVISIONAL_PASS' ||
      stageDecision === 'NEEDS_FIELD')
  ) {
    stageDecision = 'REJECT_EARLY'
    stageReason = 'Toy truth_assessment=FAIL; positive conclusion is not allowed.'
  }

  let normalizationGateForStack = normalizationGate
  let falsificationPlanQualityGateForStack = falsificationPlanQualityGate
  const pendingFieldWithoutHardFailure =
    (stageDecision === 'NEEDS_FIELD' || stageDecision === 'PROVISIONAL_PASS') &&
    runnerContractPass &&
    toyTruthAssessment !== 'FAIL' &&
    !evidenceSufficiencyPass

  if (pendingFieldWithoutHardFailure) {
    if (normalizationGateForStack.status === 'FAIL') {
      normalizationGateForStack = {
        status: 'UNRESOLVED',
        reason: `${normalizationGateForStack.reason} (downgraded to UNRESOLVED while real field evidence is still missing).`,
      }
    }
    if (falsificationPlanQualityGateForStack.status === 'FAIL') {
      falsificationPlanQualityGateForStack = {
        status: 'UNRESOLVED',
        reason: `${falsificationPlanQualityGateForStack.reason} (downgraded to UNRESOLVED while real field evidence is still missing).`,
      }
    }
  }

  const gateStatuses: GateVerdict[] = [
    normalizationGateForStack.status,
    falsificationPlanQualityGateForStack.status,
    runnerContractGate.status,
    toyTruthGate.status,
    evidenceGate.status,
    umcV1Gate.status,
    ledgerClosureGate.status,
  ]
  const overallGateStatus: GateVerdict = gateStatuses.includes('FAIL')
    ? 'FAIL'
    : gateStatuses.every(status => status === 'PASS')
      ? 'PASS'
      : 'UNRESOLVED'

  const gateStack: RunnerGateStack = {
    ontology: {
      claim_well_formed: normalizationGateForStack,
    },
    epistemic: {
      falsification_plan_quality: falsificationPlanQualityGateForStack,
      evidence_gate: evidenceGate,
    },
    operational: {
      runner_contract: runnerContractGate,
      toy_truth_assessment: toyTruthGate,
    },
    universal: {
      umc_v1: umcV1Gate,
      ledger_closure: ledgerClosureGate,
    },
    overall: overallGateStatus,
  }

  const rejectEarlyNextAction =
    toyTruthAssessment === 'FAIL'
      ? 'Stop: toy falsified the claim. Close with refutation or reformulate hypothesis before rerunning.'
      : 'Auto-repair: update FalsificationPlan with observed FAIL signals and regenerate toy runners.'

  const nextActionByDecision: Record<StageDecision, string> = {
    REJECT_EARLY: rejectEarlyNextAction,
    PROVISIONAL_PASS:
      'Continue to field to elevate evidence (n_rows>=30, lobo_folds>=2).',
    NEEDS_FIELD:
      'Find/download a real dataset and run field runners before concluding.',
    DEFINITIVE_PASS:
      'Advance to the next pipeline stage.',
    DEFINITIVE_FAIL:
      'Fix runner contract/environment and repeat toy phase.',
  }

  return {
    toy: {
      status: toyStatus,
      truthAssessment: toyTruthAssessment,
      passTests,
      failTests,
      logicalContradiction,
    },
    field: {
      shouldAdvance: fieldShouldAdvance,
      reason: fieldReason,
    },
    runnerContract: {
      status: runnerContractPass ? 'PASS' : 'FAIL',
      reason: runnerContractReason,
    },
    evidenceSufficiency: {
      status: evidenceSufficiencyStatus,
      datasetUsed,
      hasRealDataset,
      nRows,
      loboFolds,
      claimDatasetFit: claimDatasetFitPass,
      claimDatasetFitMatchedTokens,
      claimDatasetFitRequiredTokens,
      claimDatasetFitReason: semanticFit.reason,
    },
    stageDecision,
    stageReason,
    nextAction: nextActionByDecision[stageDecision],
    gateStack,
  }
}

function deriveGateStackFromLegacy(gates: RunnerGateReport): RunnerGateStack {
  if (gates.gateStack) return gates.gateStack
  const evidenceGateStatus = parseTriGateStatusFromStageDecision(gates.stageDecision)
  const toyStatus: GateVerdict =
    gates.toy.truthAssessment === 'PASS'
      ? 'PASS'
      : gates.toy.truthAssessment === 'FAIL'
        ? 'FAIL'
        : 'UNRESOLVED'
  const runnerContractStatus: GateVerdict =
    gates.runnerContract.status === 'PASS' ? 'PASS' : 'FAIL'
  const aggregate: GateVerdict[] = [
    evidenceGateStatus,
    toyStatus,
    runnerContractStatus,
  ]
  const overall: GateVerdict = aggregate.includes('FAIL')
    ? 'FAIL'
    : aggregate.every(value => value === 'PASS')
      ? 'PASS'
      : 'UNRESOLVED'

  return {
    ontology: {
      claim_well_formed: {
        status: 'UNRESOLVED',
        reason: 'No disponible en salida legacy.',
      },
    },
    epistemic: {
      falsification_plan_quality: {
        status: 'UNRESOLVED',
        reason: 'No disponible en salida legacy.',
      },
      evidence_gate: {
        status: evidenceGateStatus,
        reason: `Derivado de stageDecision=${gates.stageDecision}.`,
      },
    },
    operational: {
      runner_contract: {
        status: runnerContractStatus,
        reason: gates.runnerContract.reason,
      },
      toy_truth_assessment: {
        status: toyStatus,
        reason: `toy.truth_assessment=${gates.toy.truthAssessment}.`,
      },
    },
    universal: {
      umc_v1: {
        status: 'UNRESOLVED',
        reason: 'No disponible en salida legacy.',
        metrics: {},
      },
      ledger_closure: {
        status: 'UNRESOLVED',
        reason: 'No disponible en salida legacy.',
      },
    },
    overall,
  }
}

function buildCriticalRunnerVerdictSummary(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  executionResults: RunnerExecutionResult[]
}): CriticalRunnerVerdictSummary {
  const criticalRunnerIds = params.plan.runners
    .filter(runner => {
      const autoField =
        runner.id.startsWith('R_FIELD_AUTOREPAIR') ||
        runner.test_ids.some(id => id.toUpperCase().includes('AUTO_FIELD'))
      return !autoField
    })
    .map(runner => runner.id)

  const items: CriticalRunnerVerdict[] = criticalRunnerIds.map(runnerId => {
    const runner = params.plan.runners.find(candidate => candidate.id === runnerId)
    const run = params.executionResults.find(result => result.id === runnerId)
    if (!run) {
      return {
        runnerId,
        verdict: 'INCONCLUSIVE',
        reason: 'runner_not_executed',
      }
    }

    if (run.status === 'failed') {
      return {
        runnerId,
        verdict: 'FAIL',
        reason: 'execution_failed',
      }
    }

    const contractVerdict = run.evidenceContract?.truth_assessment
    if (contractVerdict === 'PASS' || contractVerdict === 'FAIL') {
      return {
        runnerId,
        verdict: contractVerdict,
        reason: 'evidence_contract',
      }
    }

    const text = normalizeInline(
      [run.stdoutRaw, run.stderrRaw, run.stdoutPreview, run.stderrPreview]
        .filter(Boolean)
        .join(' '),
    )
    const { hasPass, hasFail } = detectRunSignals(text, {
      expectedSignal: runner?.expected_signal,
      failureSignal: runner?.failure_signal,
    })
    if (hasFail && !hasPass) {
      return {
        runnerId,
        verdict: 'FAIL',
        reason: 'stdout_fail_signal',
      }
    }
    if (hasPass && !hasFail) {
      return {
        runnerId,
        verdict: 'PASS',
        reason: 'stdout_pass_signal',
      }
    }
    if (hasPass && hasFail) {
      return {
        runnerId,
        verdict: 'INCONCLUSIVE',
        reason: 'mixed_signals',
      }
    }
    return {
      runnerId,
      verdict: 'INCONCLUSIVE',
      reason: 'missing_verdict',
    }
  })

  const hasFail = items.some(item => item.verdict === 'FAIL')
  const hasPass = items.some(item => item.verdict === 'PASS')
  return {
    overall: hasFail ? 'FAIL' : hasPass ? 'PASS' : 'INCONCLUSIVE',
    items,
  }
}

function buildToolConversationKey(context: ToolUseContext): string {
  return `${context.options?.messageLogName ?? 'default'}:${context.options?.forkNumber ?? 0}:${context.agentId ?? 'main'}`
}

function resolveToolTurnKey(context: ToolUseContext): string {
  const messageTurn = context.messageId?.trim()
  if (messageTurn) return `msg:${messageTurn}`
  const lastUserPrompt = context.options?.lastUserPrompt?.trim()
  if (lastUserPrompt) {
    const fingerprint = createHash('sha1')
      .update(normalizeInline(lastUserPrompt).toLowerCase())
      .digest('hex')
      .slice(0, 12)
    return `prompt:${fingerprint}`
  }
  const requestTurn = (context as any)?.requestId
  if (typeof requestTurn === 'string' && requestTurn.trim().length > 0) {
    return `req:${requestTurn.trim()}`
  }
  return 'conversation-turn-fallback'
}

function buildExperimentRunnersCacheKey(
  input: Input,
  context: ToolUseContext,
  options?: { modelName?: string },
): string {
  const conversationKey = buildToolConversationKey(context)
  const modelName =
    options?.modelName?.trim() || context.options?.model?.trim() || ''
  const normalizedPrompt = normalizeInline(
    [
      EXPERIMENT_RUNNERS_CACHE_VERSION,
      input.hypothesis_query,
      input.dialectical_synthesis ?? '',
      input.baconian_forma_veritas ?? '',
      input.normalization_json ?? '',
      input.falsification_plan_json ?? '',
      input.literature_summary ?? '',
      input.dataset_hint ?? '',
      modelName,
    ].join(' | '),
  )
    .toLowerCase()
    .slice(0, 5000)

  return `${conversationKey}::${normalizedPrompt}`
}

function pruneExperimentRunnersCache(now = Date.now()): void {
  for (const [key, value] of recentExperimentRunnersCache.entries()) {
    if (now - value.createdAt > EXPERIMENT_RUNNERS_CACHE_TTL_MS) {
      recentExperimentRunnersCache.delete(key)
    }
  }
}

function buildTurnScopedExperimentRunnersKey(
  input: Input,
  context: ToolUseContext,
): string {
  const conversationKey = buildToolConversationKey(context)
  const turnKey = resolveToolTurnKey(context)
  const canonicalHypothesis = normalizeInline(input.hypothesis_query || '')
  const fingerprintSource = normalizeInline(
    [
      canonicalHypothesis,
      input.dataset_hint ?? '',
      input.falsification_plan_json ?? '',
      input.normalization_json ?? '',
    ].join(' | '),
  )
    .toLowerCase()
    .slice(0, 5000)
  const hypothesisFingerprint = createHash('sha1')
    .update(fingerprintSource)
    .digest('hex')
    .slice(0, 16)
  return `${conversationKey}::${turnKey}::${hypothesisFingerprint}`
}

function pruneTurnScopedExperimentRunnersCache(now = Date.now()): void {
  for (const [key, value] of turnScopedExperimentRunnersResultCache.entries()) {
    if (now - value.createdAt > EXPERIMENT_RUNNERS_TURN_CACHE_TTL_MS) {
      turnScopedExperimentRunnersResultCache.delete(key)
    }
  }
}

function shouldReuseExperimentRunnersCachedOutput(output: Output): boolean {
  if (output.planStatus === 'skipped') return true
  const stage = output.gates?.stageDecision
  const critical = output.criticalVerdicts?.overall
  if (!stage) return true
  if (
    stage === 'REJECT_EARLY' ||
    stage === 'DEFINITIVE_FAIL' ||
    stage === 'NEEDS_FIELD' ||
    stage === 'PROVISIONAL_PASS'
  ) {
    return false
  }
  if (critical === 'FAIL') return false
  return true
}

function shouldReuseTurnScopedExecutionOutput(output: Output): boolean {
  if (!output || !Array.isArray(output.executionResults)) return false
  if (output.executionResults.length === 0) return false
  const stage = output.gates?.stageDecision
  if (stage === 'DEFINITIVE_FAIL' || stage === 'REJECT_EARLY') return false
  return true
}

function shouldForceFieldRefreshFromPendingOutput(params: {
  output: Output
  input: Input
  cwd: string
}): boolean {
  const stage = params.output.gates?.stageDecision
  if (stage !== 'NEEDS_FIELD' && stage !== 'PROVISIONAL_PASS') return false
  if (params.output.gates?.evidenceSufficiency?.hasRealDataset) return false

  const hint = normalizeInline(params.input.dataset_hint || '').toLowerCase()
  if (
    hint.includes('validate_local') ||
    hint.includes('dataset local') ||
    hint.includes('web_search')
  ) {
    return true
  }
  if (hasConcreteDatasetReference(hint)) return true
  return false
}

function sanitizePathSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return cleaned || 'runner'
}

function defaultExtensionForLanguage(
  language: 'python' | 'bash' | 'pseudo',
): string {
  if (language === 'python') return '.py'
  if (language === 'bash') return '.sh'
  return '.txt'
}

function normalizeRunnerCode(
  code: string,
  language: 'python' | 'bash' | 'pseudo',
): string {
  const trimmed = code.trim()
  if (trimmed.length > 0) {
    return code.endsWith('\n') ? code : `${code}\n`
  }

  if (language === 'python') {
    return '# TODO: implement experiment runner logic\n'
  }
  if (language === 'bash') {
    return '#!/usr/bin/env bash\n# TODO: implement experiment runner logic\n'
  }
  return '# TODO: implement experiment runner logic\n'
}

function rewriteWorkspaceAbsolutePaths(code: string, cwd: string): string {
  const normalizedCwd = normalizeInline(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!normalizedCwd) return code

  const prefix = `${normalizedCwd}/`
  if (!code.includes(prefix)) return code

  // Replace absolute paths rooted at the current workspace with relative paths.
  // This keeps runners portable across machines without changing their semantics.
  let next = code.split(prefix).join('')

  const filePrefix = `file://${prefix}`
  if (next.includes(filePrefix)) {
    next = next.split(filePrefix).join('file://')
  }

  return next
}

function extractDefinitionPreview(
  code: string,
  language: 'python' | 'bash' | 'pseudo',
): string {
  const lines = code
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)

  if (lines.length === 0) return '(no explicit definition)'

  if (language === 'python') {
    const defLine = lines.find(
      line => line.startsWith('def ') || line.startsWith('class '),
    )
    if (defLine) return truncateForUi(defLine, 96)
  }

  if (language === 'bash') {
    const fnLine = lines.find(line => /^\w[\w-]*\s*\(\)\s*\{/.test(line))
    if (fnLine) return truncateForUi(fnLine, 96)
    const cmdLine = lines.find(
      line => !line.startsWith('#') && !line.startsWith('#!'),
    )
    if (cmdLine) return truncateForUi(cmdLine, 96)
  }

  return truncateForUi(lines[0] ?? '(no explicit definition)', 96)
}

function inferFalsificationPlanStatus(
  rawFalsification?: string,
): 'ready' | 'not_ready' | 'unknown' {
  const raw = rawFalsification?.trim()
  if (!raw) return 'not_ready'

  try {
    const parsed = JSON.parse(raw) as {
      falsification_plan?: { meta?: { status?: 'ready' | 'skipped' | string } }
    }
    const status = parsed?.falsification_plan?.meta?.status
    if (status === 'ready') return 'ready'
    if (typeof status === 'string') return 'not_ready'
  } catch {
    // ignore parse errors and try textual heuristics
  }

  const normalized = normalizeInline(raw).toLowerCase()
  if (
    normalized.includes('estado plan: ready') ||
    normalized.includes('status plan/match: ready') ||
    (normalized.includes('"falsification_plan"') &&
      normalized.includes('"status":"ready"'))
  ) {
    return 'ready'
  }
  if (
    normalized.includes('estado plan: skipped') ||
    normalized.includes('status plan/match: skipped') ||
    normalized.includes('normalization_incomplete') ||
    normalized.includes('falsification_incomplete') ||
    normalized.includes('"status":"skipped"')
  ) {
    return 'not_ready'
  }
  return 'unknown'
}

function buildSafeRunnerRelativePath(
  filename: string,
  runnerId: string,
  language: 'python' | 'bash' | 'pseudo',
): string {
  const defaultFilename = `${sanitizePathSegment(runnerId).toLowerCase()}${defaultExtensionForLanguage(language)}`
  const normalized = (filename || '').replace(/\\/g, '/').trim()
  const withoutAbsolutePrefix = isAbsolute(normalized)
    ? normalized.replace(/^([A-Za-z]:)?[\\/]+/, '')
    : normalized

  const segments = withoutAbsolutePrefix
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(sanitizePathSegment)

  let candidate = segments.join('/')
  if (!candidate) candidate = defaultFilename

  if (!/\.[a-zA-Z0-9]+$/.test(candidate)) {
    candidate += defaultExtensionForLanguage(language)
  }

  return candidate
}

function makeUniqueRelativePath(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    return candidate
  }

  const match = candidate.match(/^(.*?)(\.[^.]+)?$/)
  const stem = match?.[1] || candidate
  const ext = match?.[2] || ''

  let suffix = 2
  while (true) {
    const next = `${stem}-${suffix}${ext}`
    if (!used.has(next)) {
      return next
    }
    suffix += 1
  }
}

function materializeExperimentRunnerFiles(
  plan: ExperimentRunnersResult['experiment_runners'],
): {
  runnersDir: string
  files: MaterializedRunnerFile[]
  diffs: MaterializedRunnerDiff[]
} {
  const cwd = getCwd()
  const baseDirAbsolute = resolve(cwd, EXPERIMENT_RUNNERS_OUTPUT_DIR)
  const baseDirPrefix = `${baseDirAbsolute}${sep}`
  const files: MaterializedRunnerFile[] = []
  const diffs: MaterializedRunnerDiff[] = []

  if (plan.meta.status !== 'ready' || plan.runners.length === 0) {
    return {
      runnersDir: relative(cwd, baseDirAbsolute),
      files,
      diffs,
    }
  }

  mkdirSync(baseDirAbsolute, { recursive: true })
  const usedRelativePaths = new Set<string>()

  for (const runner of plan.runners) {
    const safeCandidate = buildSafeRunnerRelativePath(
      runner.filename,
      runner.id,
      runner.language,
    )
    const uniqueRelative = makeUniqueRelativePath(
      safeCandidate,
      usedRelativePaths,
    )
    usedRelativePaths.add(uniqueRelative)

    let targetAbsolute = resolve(baseDirAbsolute, uniqueRelative)
    if (
      targetAbsolute !== baseDirAbsolute &&
      !targetAbsolute.startsWith(baseDirPrefix)
    ) {
      const fallback = `${sanitizePathSegment(runner.id).toLowerCase()}${defaultExtensionForLanguage(runner.language)}`
      targetAbsolute = resolve(baseDirAbsolute, fallback)
    }

    mkdirSync(dirname(targetAbsolute), { recursive: true })
    const rewrittenCode = rewriteWorkspaceAbsolutePaths(runner.code, cwd)
    const nextCode = normalizeRunnerCode(rewrittenCode, runner.language)
    const alreadyExists = existsSync(targetAbsolute)
    const currentCode = alreadyExists ? readFileSync(targetAbsolute, 'utf8') : ''
    let status: MaterializedRunnerFile['status'] = 'created'
    if (alreadyExists) {
      status = currentCode === nextCode ? 'unchanged' : 'updated'
    }

    if (status !== 'unchanged') {
      writeFileSync(targetAbsolute, nextCode, 'utf8')
      const patch = getPatch({
        filePath: relative(cwd, targetAbsolute),
        fileContents: currentCode,
        oldStr: currentCode,
        newStr: nextCode,
      })
      if (patch.length > 0) {
        diffs.push({
          relativePath: relative(cwd, targetAbsolute),
          structuredPatch: patch,
        })
      }
    }

    files.push({
      id: runner.id,
      language: runner.language,
      relativePath: relative(cwd, targetAbsolute),
      status,
    })
  }

  return {
    runnersDir: relative(cwd, baseDirAbsolute),
    files,
    diffs,
  }
}

function pickRunnerExecutionOrder(
  plan: ExperimentRunnersResult['experiment_runners'],
): string[] {
  const fallback = plan.runners.map(runner => runner.id)
  if (plan.execution_order.length === 0) return fallback
  const known = new Set(plan.runners.map(runner => runner.id))
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of plan.execution_order) {
    if (!known.has(id) || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  for (const id of fallback) {
    if (!seen.has(id)) ordered.push(id)
  }
  return ordered
}

function mapModuleToPipPackage(moduleName: string): string {
  const normalized = moduleName.trim()
  if (normalized === 'sklearn') return 'scikit-learn'
  if (normalized === 'PIL') return 'pillow'
  return normalized
}

function extractMissingPythonModules(stderr: string): string[] {
  const matches = [
    ...stderr.matchAll(/No module named ['"]([^'"]+)['"]/g),
    ...stderr.matchAll(/ModuleNotFoundError:\s*No module named ([^\s]+)/g),
  ]
  const modules = matches
    .map(match => (match[1] || '').trim())
    .filter(Boolean)
    .map(moduleName => moduleName.split('.')[0] || moduleName)
    .map(moduleName => mapModuleToPipPackage(moduleName))
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name))
  return Array.from(new Set(modules))
}

function inferPythonPackagesFromRunnerCode(code: string): string[] {
  const importedModules = new Set<string>()
  const importRegex = /^\s*import\s+([A-Za-z0-9_.]+)/gm
  const fromImportRegex = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm

  for (const match of code.matchAll(importRegex)) {
    const mod = (match[1] || '').split('.')[0]?.trim()
    if (mod) importedModules.add(mod)
  }
  for (const match of code.matchAll(fromImportRegex)) {
    const mod = (match[1] || '').split('.')[0]?.trim()
    if (mod) importedModules.add(mod)
  }

  const packages = Array.from(importedModules)
    .map(moduleName => mapModuleToPipPackage(moduleName))
    .filter(pkg => PREINSTALL_SAFE_PY_PACKAGES.has(pkg))
  return Array.from(new Set(packages))
}

function resolvePythonRunnerCommand(): {
  command: string
  args: string[]
} | null {
  const configured = process.env.AMAWTA_PYTHON_BIN?.trim()
  const candidates = configured ? [configured] : ['python3', 'python']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    if (!probe.error && typeof probe.status === 'number' && probe.status === 0) {
      return { command: candidate, args: [] }
    }
  }
  return null
}

type PythonRunnerRuntime = {
  command: string
  args: string[]
  mode: 'venv' | 'system'
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return defaultValue
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

function resolveRunnerVenvPaths(cwd: string): {
  venvDirAbsolute: string
  venvDirRelative: string
  pythonExecutable: string
} {
  const configured = process.env.AMAWTA_RUNNERS_VENV_DIR?.trim()
  const venvDirRelative =
    configured && configured.length > 0
      ? configured
      : `${EXPERIMENT_RUNNERS_OUTPUT_DIR}/.venv`
  const venvDirAbsolute = resolve(cwd, venvDirRelative)
  const pythonExecutable =
    process.platform === 'win32'
      ? resolve(venvDirAbsolute, 'Scripts', 'python.exe')
      : resolve(venvDirAbsolute, 'bin', 'python')
  return {
    venvDirAbsolute,
    venvDirRelative,
    pythonExecutable,
  }
}

function ensurePythonRunnerRuntime(params: {
  cwd: string
  pythonBase: { command: string; args: string[] } | null
  strictVenv?: boolean
}): {
  runtime: PythonRunnerRuntime | null
  setupError?: string
} {
  if (!params.pythonBase) {
    return {
      runtime: null,
      setupError: 'No Python interpreter found (set AMAWTA_PYTHON_BIN).',
    }
  }

  const allowVenv = readBooleanEnv('AMAWTA_RUNNERS_USE_VENV', true)
  const strictVenv = params.strictVenv === true
  if (!allowVenv) {
    if (strictVenv) {
      return {
        runtime: null,
        setupError:
          'Modo estricto venv activo: habilita AMAWTA_RUNNERS_USE_VENV=1 para ejecutar runners Python.',
      }
    }
    return {
      runtime: {
        command: params.pythonBase.command,
        args: [...params.pythonBase.args],
        mode: 'system',
      },
    }
  }

  const setupTimeoutMs = (() => {
    const parsed = Number.parseInt(process.env.AMAWTA_VENV_SETUP_TIMEOUT_MS || '', 10)
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_VENV_SETUP_TIMEOUT_MS
  })()
  const venv = resolveRunnerVenvPaths(params.cwd)

  if (!existsSync(venv.pythonExecutable)) {
    const create = spawnSync(
      params.pythonBase.command,
      [...params.pythonBase.args, '-m', 'venv', venv.venvDirAbsolute],
      {
        cwd: params.cwd,
        encoding: 'utf8',
        timeout: setupTimeoutMs,
        maxBuffer: 1024 * 1024,
      },
    )

    const createOk =
      !create.error && typeof create.status === 'number' && create.status === 0
    if (!createOk || !existsSync(venv.pythonExecutable)) {
      const detail =
        (typeof create.stderr === 'string' && create.stderr.trim()) ||
        create.error?.message ||
        'venv_create_failed'
      if (strictVenv) {
        return {
          runtime: null,
          setupError: truncatePreview(
            `Could not create local venv (${venv.venvDirRelative}) in strict mode. ${detail}`,
            220,
          ),
        }
      }
      return {
        runtime: {
          command: params.pythonBase.command,
          args: [...params.pythonBase.args],
          mode: 'system',
        },
        setupError: truncatePreview(
          `Could not create local venv (${venv.venvDirRelative}); using system Python. ${detail}`,
          220,
        ),
      }
    }
  }

  const pipProbe = spawnSync(venv.pythonExecutable, ['-m', 'pip', '--version'], {
    cwd: params.cwd,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 256 * 1024,
  })

  if (pipProbe.error || pipProbe.status !== 0) {
    const ensurePip = spawnSync(
      venv.pythonExecutable,
      ['-m', 'ensurepip', '--upgrade'],
      {
        cwd: params.cwd,
        encoding: 'utf8',
        timeout: setupTimeoutMs,
        maxBuffer: 1024 * 1024,
      },
    )
    const ensureOk =
      !ensurePip.error &&
      typeof ensurePip.status === 'number' &&
      ensurePip.status === 0
    if (!ensureOk) {
      const detail =
        (typeof ensurePip.stderr === 'string' && ensurePip.stderr.trim()) ||
        ensurePip.error?.message ||
        'ensurepip_failed'
      if (strictVenv) {
        return {
          runtime: null,
          setupError: truncatePreview(
            `Could not enable pip in venv (${venv.venvDirRelative}) in strict mode. ${detail}`,
            220,
          ),
        }
      }
      return {
        runtime: {
          command: params.pythonBase.command,
          args: [...params.pythonBase.args],
          mode: 'system',
        },
        setupError: truncatePreview(
          `Could not enable pip in venv (${venv.venvDirRelative}); using system Python. ${detail}`,
          220,
        ),
      }
    }
  }

  return {
    runtime: {
      command: venv.pythonExecutable,
      args: [],
      mode: 'venv',
    },
  }
}

function* executeMaterializedRunnersStreaming(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  materialized: {
    runnersDir: string
    files: MaterializedRunnerFile[]
  }
  signal?: AbortSignal
}): Generator<
  string,
  {
  results: RunnerExecutionResult[]
  installedDependencies: string[]
  dependencyInstallError?: string
  },
  void
> {
  yield 'stage_start: experiment_runners'
  if (params.plan.meta.status !== 'ready' || params.plan.runners.length === 0) {
    yield 'stage_end: experiment_runners runs=0 ok=0 fail=0 skipped=0'
    return {
      results: [],
      installedDependencies: [],
    }
  }

  const cwd = getCwd()
  const outputDirAbs = resolve(cwd, EXPERIMENT_RUNNERS_OUTPUT_DIR)
  const outputDirPrefix = `${outputDirAbs}${sep}`
  const pathByRunnerId = new Map(
    params.materialized.files.map(file => [file.id, file.relativePath]),
  )
  const byId = new Map(params.plan.runners.map(runner => [runner.id, runner]))
  const executionOrder = pickRunnerExecutionOrder(params.plan)
  const pythonBase = resolvePythonRunnerCommand()
  const timeoutMs = Number.parseInt(
    process.env.AMAWTA_RUNNER_TIMEOUT_MS || '',
    10,
  )
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_RUNNER_TIMEOUT_MS
  const pipTimeoutMs = (() => {
    const parsed = Number.parseInt(process.env.AMAWTA_PIP_INSTALL_TIMEOUT_MS || '', 10)
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_PIP_INSTALL_TIMEOUT_MS
  })()
  const autoInstallEnabled = (() => {
    const raw = (process.env.AMAWTA_AUTO_INSTALL_PY_DEPS || '1').trim().toLowerCase()
    return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
  })()
  const deterministicMode = readBooleanEnv('AMAWTA_ADK_DETERMINISTIC_MODE', false)
  const strictVenv = readBooleanEnv(
    'AMAWTA_RUNNERS_STRICT_VENV',
    deterministicMode,
  )
  const allowSystemPipInstall =
    !strictVenv && readBooleanEnv('AMAWTA_ALLOW_SYSTEM_PIP', false)
  const maxInstallRounds = (() => {
    const parsed = Number.parseInt(
      process.env.AMAWTA_AUTO_INSTALL_MAX_ROUNDS || '',
      10,
    )
    if (!Number.isFinite(parsed)) return 3
    return Math.min(6, Math.max(1, parsed))
  })()

  const results: RunnerExecutionResult[] = []
  const installedDependencies: string[] = []
  const installedDependencySet = new Set<string>()
  const failedMissingPyDeps = new Set<string>()
  const failedByRunnerId = new Set<string>()
  const hasPythonRunners = params.plan.runners.some(
    runner => runner.language === 'python',
  )
  const pythonRuntimeResult = hasPythonRunners
    ? ensurePythonRunnerRuntime({
        cwd,
        pythonBase,
        strictVenv,
      })
    : { runtime: null as PythonRunnerRuntime | null, setupError: undefined }
  const pythonRuntime = pythonRuntimeResult.runtime
  let dependencyInstallError: string | undefined = pythonRuntimeResult.setupError

  if (
    autoInstallEnabled &&
    pythonRuntime &&
    hasPythonRunners &&
    !params.signal?.aborted
  ) {
    const preinstallCandidates = Array.from(
      new Set(
        params.plan.runners
          .filter(runner => runner.language === 'python')
          .flatMap(runner => inferPythonPackagesFromRunnerCode(runner.code)),
      ),
    )

    if (preinstallCandidates.length > 0) {
      yield `Preparing Python runtime (${pythonRuntime.mode}) and installing base deps: ${truncateForUi(
        preinstallCandidates.join(', '),
        90,
      )}`
      if (pythonRuntime.mode === 'system' && !allowSystemPipInstall) {
        dependencyInstallError =
          dependencyInstallError ||
          'Skipped pre auto-install: system Python without venv (set AMAWTA_RUNNERS_USE_VENV=1 or AMAWTA_ALLOW_SYSTEM_PIP=1).'
      } else {
        const preinstall = spawnSync(
          pythonRuntime.command,
          [...pythonRuntime.args, '-m', 'pip', 'install', ...preinstallCandidates],
          {
            cwd,
            encoding: 'utf8',
            timeout: pipTimeoutMs,
            maxBuffer: 1024 * 1024,
          },
        )
        const preinstallOk =
          !preinstall.error &&
          typeof preinstall.status === 'number' &&
          preinstall.status === 0
        if (preinstallOk) {
          for (const pkg of preinstallCandidates) {
            if (!installedDependencySet.has(pkg)) {
              installedDependencySet.add(pkg)
              installedDependencies.push(pkg)
            }
          }
          yield `Base deps installed: ${truncateForUi(
            preinstallCandidates.join(', '),
            90,
          )}`
        } else {
          const preinstallErr =
            typeof preinstall.stderr === 'string'
              ? preinstall.stderr
              : preinstall.error?.message || ''
          dependencyInstallError =
            dependencyInstallError ||
            truncatePreview(preinstallErr || 'preinstall_failed', 180)
          yield `Base deps preinstall failed: ${truncateForUi(
            dependencyInstallError,
            90,
          )}`
        }
      }
    }
  }

  for (const id of executionOrder) {
    const runner = byId.get(id)
    if (!runner) continue

    const relativePath = pathByRunnerId.get(id) || runner.filename
    const absolutePath = resolve(cwd, relativePath)
    const inOutputDir =
      absolutePath === outputDirAbs || absolutePath.startsWith(outputDirPrefix)

    if (!inOutputDir) {
      results.push({
        id,
        relativePath,
        cwd,
        command: '(blocked)',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdoutRaw: '',
        stderrRaw: '',
        stdoutPreview: '',
        stderrPreview: '',
        reason: 'runner_outside_output_dir',
      })
      continue
    }

    if (!existsSync(absolutePath)) {
      results.push({
        id,
        relativePath,
        cwd,
        command: '(missing file)',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdoutRaw: '',
        stderrRaw: '',
        stdoutPreview: '',
        stderrPreview: '',
        reason: 'runner_file_missing',
      })
      continue
    }

    if (params.signal?.aborted) {
      results.push({
        id,
        relativePath,
        cwd,
        command: '(aborted)',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdoutRaw: '',
        stderrRaw: '',
        stdoutPreview: '',
        stderrPreview: '',
        reason: 'aborted',
      })
      continue
    }

    let command = ''
    let args: string[] = []
    if (runner.language === 'python') {
      if (!pythonRuntime) {
        results.push({
          id,
          relativePath,
          cwd,
          command: '(python missing)',
          status: 'failed',
          exitCode: null,
          durationMs: 0,
          stdoutRaw: '',
          stderrRaw:
            pythonRuntimeResult.setupError ||
            'No Python interpreter found (set AMAWTA_PYTHON_BIN).',
          stdoutPreview: '',
          stderrPreview:
            pythonRuntimeResult.setupError ||
            'No Python interpreter found (set AMAWTA_PYTHON_BIN).',
          reason: 'python_not_found',
        })
        continue
      }
      command = pythonRuntime.command
      args = [...pythonRuntime.args, relativePath]
    } else if (runner.language === 'bash') {
      command = 'bash'
      args = [relativePath]
    } else {
      results.push({
        id,
        relativePath,
        cwd,
        command: '(pseudo)',
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdoutRaw: '',
        stderrRaw: '',
        stdoutPreview: '',
        stderrPreview: '',
        reason: 'pseudo_runner',
      })
      continue
    }

    const start = Date.now()
    yield `tool_start: ${id} cmd=${truncateForUi([command, ...args].join(' '), 110)}`
    const run = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: effectiveTimeoutMs,
      maxBuffer: 512 * 1024,
    })
    const durationMs = Date.now() - start
    const stdout = typeof run.stdout === 'string' ? run.stdout : ''
    const stderr =
      typeof run.stderr === 'string'
        ? run.stderr
        : run.error?.message || ''
    const missingModules =
      runner.language === 'python'
        ? extractMissingPythonModules(stderr)
        : []
    if (missingModules.length > 0) {
      missingModules.forEach(moduleName => failedMissingPyDeps.add(moduleName))
      failedByRunnerId.add(id)
    }

    results.push({
      id,
      relativePath,
      cwd,
      command: [command, ...args].join(' '),
      status:
        run.error || (typeof run.status === 'number' && run.status !== 0)
          ? 'failed'
          : 'success',
      exitCode: typeof run.status === 'number' ? run.status : null,
      durationMs,
      stdoutRaw: clampRawOutput(stdout),
      stderrRaw: clampRawOutput(stderr),
      stdoutPreview: truncatePreview(stdout),
      stderrPreview: truncatePreview(stderr),
      evidenceContract: parseEvidenceContractFromText(stdout, stderr),
      reason: run.error?.message ? truncatePreview(run.error.message, 120) : undefined,
    })
    const latest = results[results.length - 1]
    yield `tool_end: ${id} status=${latest.status} (exit ${
      latest.exitCode === null ? 'n/a' : latest.exitCode
    }, ${formatDurationMs(latest.durationMs)})`
  }

  if (
    autoInstallEnabled &&
    pythonRuntime &&
    failedMissingPyDeps.size > 0 &&
    !params.signal?.aborted
  ) {
    if (pythonRuntime.mode === 'system' && !allowSystemPipInstall) {
      dependencyInstallError =
        dependencyInstallError ||
        'Auto-install skipped: system Python without venv (set AMAWTA_RUNNERS_USE_VENV=1 or AMAWTA_ALLOW_SYSTEM_PIP=1).'
      return {
        results,
        installedDependencies,
        dependencyInstallError,
      }
    }

    let pendingDeps = new Set(failedMissingPyDeps)
    let pendingRunners = new Set(failedByRunnerId)
    let installRound = 0

    while (
      pendingDeps.size > 0 &&
      pendingRunners.size > 0 &&
      installRound < maxInstallRounds &&
      !params.signal?.aborted
    ) {
      installRound += 1
      const packages = Array.from(pendingDeps).filter(
        pkg => !installedDependencySet.has(pkg),
      )
      if (packages.length === 0) break

      yield `Auto-repair deps (round ${installRound}): ${truncateForUi(
        packages.join(', '),
        90,
      )}`
      const install = spawnSync(
        pythonRuntime.command,
        [...pythonRuntime.args, '-m', 'pip', 'install', ...packages],
        {
          cwd,
          encoding: 'utf8',
          timeout: pipTimeoutMs,
          maxBuffer: 1024 * 1024,
        },
      )

      const installOk =
        !install.error &&
        typeof install.status === 'number' &&
        install.status === 0
      if (!installOk) {
        const installErr =
          typeof install.stderr === 'string'
            ? install.stderr
            : install.error?.message || ''
        dependencyInstallError = truncatePreview(
          installErr || 'pip_install_failed',
          180,
        )
        yield `Auto-repair deps failed (round ${installRound}): ${truncateForUi(
          dependencyInstallError,
          90,
        )}`
        break
      }

      for (const pkg of packages) {
        if (!installedDependencySet.has(pkg)) {
          installedDependencySet.add(pkg)
          installedDependencies.push(pkg)
        }
      }

      const nextPendingDeps = new Set<string>()
      const nextPendingRunners = new Set<string>()

      for (const runId of pendingRunners) {
        const runner = byId.get(runId)
        if (!runner || runner.language !== 'python') continue
        const relativePath = pathByRunnerId.get(runId) || runner.filename
        const start = Date.now()
        yield `tool_start: ${runId} retry cmd=${truncateForUi(
          `${pythonRuntime.command} ${relativePath}`,
          110,
        )}`
        const rerun = spawnSync(
          pythonRuntime.command,
          [...pythonRuntime.args, relativePath],
          {
            cwd,
            encoding: 'utf8',
            timeout: effectiveTimeoutMs,
            maxBuffer: 512 * 1024,
          },
        )
        const durationMs = Date.now() - start
        const stdout = typeof rerun.stdout === 'string' ? rerun.stdout : ''
        const stderr =
          typeof rerun.stderr === 'string'
            ? rerun.stderr
            : rerun.error?.message || ''
        const missingModules = extractMissingPythonModules(stderr)
        if (
          (rerun.error ||
            (typeof rerun.status === 'number' && rerun.status !== 0)) &&
          missingModules.length > 0
        ) {
          nextPendingRunners.add(runId)
          for (const missingModule of missingModules) {
            if (!installedDependencySet.has(missingModule)) {
              nextPendingDeps.add(missingModule)
            }
          }
        }

        const index = results.findIndex(result => result.id === runId)
        if (index >= 0) {
          results[index] = {
            ...results[index],
            cwd,
            command: `${pythonRuntime.command} ${relativePath}`,
            status:
              rerun.error || (typeof rerun.status === 'number' && rerun.status !== 0)
                ? 'failed'
                : 'success',
            exitCode: typeof rerun.status === 'number' ? rerun.status : null,
            durationMs: results[index].durationMs + durationMs,
            stdoutRaw: clampRawOutput(stdout),
            stderrRaw: clampRawOutput(stderr),
            stdoutPreview: truncatePreview(stdout),
            stderrPreview: truncatePreview(stderr),
            evidenceContract: parseEvidenceContractFromText(stdout, stderr),
            reason: rerun.error?.message
              ? truncatePreview(rerun.error.message, 120)
              : missingModules.length > 0
                ? `missing_after_retry:${missingModules.join(',')}`
                : installedDependencies.length > 0
                  ? `retry_after_install:${installedDependencies.join(',')}`
                  : results[index].reason,
          }
          yield `tool_end: ${runId} retry status=${results[index].status} (exit ${
            results[index].exitCode === null ? 'n/a' : results[index].exitCode
          }, ${formatDurationMs(durationMs)})`
        }
      }

      pendingDeps = nextPendingDeps
      pendingRunners = nextPendingRunners
    }

    if (
      !dependencyInstallError &&
      pendingDeps.size > 0 &&
      pendingRunners.size > 0 &&
      !params.signal?.aborted
    ) {
      dependencyInstallError = truncatePreview(
        `Deps still missing after ${maxInstallRounds} round(s): ${Array.from(
          pendingDeps,
        ).join(', ')}`,
        180,
      )
    }
  }

  const finalResults = {
    results,
    installedDependencies,
    dependencyInstallError,
  }
  const ok = finalResults.results.filter(run => run.status === 'success').length
  const fail = finalResults.results.filter(run => run.status === 'failed').length
  const skipped = finalResults.results.filter(run => run.status === 'skipped').length
  yield `stage_end: experiment_runners runs=${finalResults.results.length} ok=${ok} fail=${fail} skipped=${skipped}`
  return finalResults
}

function executeMaterializedRunners(params: {
  plan: ExperimentRunnersResult['experiment_runners']
  materialized: {
    runnersDir: string
    files: MaterializedRunnerFile[]
  }
  signal?: AbortSignal
}): {
  results: RunnerExecutionResult[]
  installedDependencies: string[]
  dependencyInstallError?: string
} {
  const iterator = executeMaterializedRunnersStreaming(params)
  let next = iterator.next()
  while (!next.done) {
    next = iterator.next()
  }
  return next.value
}

async function prepareExperimentRunnersOutput(params: {
  modelName: string
  apiKey?: string
  input: Input
  effectiveFalsificationRaw?: string
  conversationKey: string
  signal: AbortSignal
}): Promise<PreparedExperimentRunnersOutput> {
  const run = await runRunnerBuilderAgent({
    modelName: params.modelName,
    apiKey: params.apiKey,
    conversationKey: params.conversationKey,
    signal: params.signal,
    maxRetries: 2,
    hypothesisInput: params.input.hypothesis_query,
    dialecticalSynthesis: params.input.dialectical_synthesis,
    baconianFormaVeritas: params.input.baconian_forma_veritas,
    normalizationRaw: params.input.normalization_json,
    falsificationRaw: params.effectiveFalsificationRaw,
    literatureSummary: params.input.literature_summary,
  })

  if (!run.runners) {
    throw new Error('Experiment runners subagent did not return structured output.')
  }

  const plan = run.runners.experiment_runners
  const materialized = materializeExperimentRunnerFiles(plan)
  const relativePathByRunnerId = new Map(
    materialized.files.map(file => [file.id, file.relativePath]),
  )
  const definitionPreviews: RunnerDefinitionPreview[] = plan.runners
    .slice(0, 4)
    .map(runner => ({
      id: runner.id,
      relativePath:
        relativePathByRunnerId.get(runner.id) ||
        buildSafeRunnerRelativePath(
          runner.filename,
          runner.id,
          runner.language,
        ),
      preview: extractDefinitionPreview(runner.code, runner.language),
    }))

  return {
    analysis: run.text,
    retriesUsed: run.retriesUsed,
    model: params.modelName,
    planStatus: plan.meta.status,
    runnersCount: plan.runners.length,
    executionOrder: plan.execution_order,
    nextAction: plan.next_action,
    hypothesisSnapshot: plan.hypothesis_snapshot,
    runnersDir: materialized.runnersDir,
    materializedFiles: materialized.files,
    materializedDiffs: materialized.diffs,
    definitionPreviews,
    plan: run.runners,
  }
}

function buildSkippedOutput(
  input: Input,
  modelName: string,
  reason: string,
): Output {
  return {
    analysis: `Experiment runners skipped: ${reason}.`,
    retriesUsed: 0,
    model: modelName,
    planStatus: 'skipped',
    runnersCount: 0,
    executionOrder: [],
    nextAction:
      'Complete FalsificationPlan with ready status and then retry ExperimentRunners.',
    hypothesisSnapshot: input.hypothesis_query,
    runnersDir: EXPERIMENT_RUNNERS_OUTPUT_DIR,
    materializedFiles: [],
    materializedDiffs: [],
    executionResults: [],
    installedDependencies: [],
    definitionPreviews: [],
    gates: {
      toy: {
        status: 'not_executed',
        truthAssessment: 'INCONCLUSIVE',
        passTests: 0,
        failTests: 0,
        logicalContradiction: false,
      },
      field: {
        shouldAdvance: false,
        reason: 'No toy/field execution because prerequisites are missing.',
      },
      runnerContract: {
        status: 'FAIL',
        reason: 'No runs were executed.',
      },
      evidenceSufficiency: {
        status: 'FAIL',
        datasetUsed: false,
        hasRealDataset: false,
        nRows: 0,
        loboFolds: 0,
        claimDatasetFit: false,
        claimDatasetFitMatchedTokens: 0,
        claimDatasetFitRequiredTokens: 0,
        claimDatasetFitReason: 'No dataset evaluation in skipped run.',
      },
      stageDecision: 'REJECT_EARLY',
      stageReason: 'Runners skipped due to falsification_incomplete.',
      nextAction:
        'Complete FalsificationPlan with ready status and retry ExperimentRunners.',
      gateStack: {
        ontology: {
          claim_well_formed: {
            status: 'UNRESOLVED',
            reason: 'No ready normalization in skipped run.',
          },
        },
        epistemic: {
          falsification_plan_quality: {
            status: 'UNRESOLVED',
            reason: 'No ready falsification plan in skipped run.',
          },
          evidence_gate: {
            status: 'FAIL',
            reason: 'Evidence gate FAIL due to skipped execution.',
          },
        },
        operational: {
          runner_contract: {
            status: 'FAIL',
            reason: 'No runs were executed.',
          },
          toy_truth_assessment: {
            status: 'UNRESOLVED',
            reason: 'Toy not executed.',
          },
        },
        universal: {
          umc_v1: {
            status: 'UNRESOLVED',
            reason: 'Insufficient evidence for UMC v1.',
            metrics: {},
          },
          ledger_closure: {
            status: 'UNRESOLVED',
            reason: 'Insufficient evidence for ledger closure.',
          },
        },
        overall: 'FAIL',
      },
    },
    criticalVerdicts: {
      overall: 'INCONCLUSIVE',
      items: [],
    },
    plan: {
      experiment_runners: {
        meta: {
          plan_version: 'experiment-runners-v1',
          status: 'skipped',
          reason,
        },
        hypothesis_snapshot: input.hypothesis_query,
        assumptions: [],
        runners: [],
        execution_order: [],
        next_action:
          'Completar FalsificationPlan con estado ready y luego reintentar ExperimentRunners.',
      },
    },
  }
}

export const ExperimentRunnersTool = {
  name: TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Experiment runners',
  inputSchema,
  async prompt() {
    return PROMPT
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  needsPermissions() {
    return !hasWritePermission(getCwd())
  },
  async validateInput(input: Input) {
    if (!input.hypothesis_query || input.hypothesis_query.trim().length < 8) {
      return {
        result: false,
        message: 'hypothesis_query is required and must be at least 8 chars',
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input: Input) {
    const preview = truncateForUi(input.hypothesis_query, 110)
    return `I will run the experiment-runners subagent for: ${preview}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output, { verbose }: { verbose: boolean }) {
    const mutedColor = getReadableMutedColor()
    const gates =
      output.gates ||
      evaluateRunnerGates({
        plan: output.plan.experiment_runners,
        executionResults: output.executionResults,
        dependencyInstallError: output.dependencyInstallError,
      })
    const gateStack = deriveGateStackFromLegacy(gates)
    const criticalVerdicts =
      output.criticalVerdicts ||
      buildCriticalRunnerVerdictSummary({
        plan: output.plan.experiment_runners,
        executionResults: output.executionResults,
      })
    const orderPreview =
      output.executionOrder.length > 0
        ? truncateForUi(output.executionOrder.join(' -> '), 80)
        : '(none)'
    const created = output.materializedFiles.filter(
      file => file.status === 'created',
    ).length
    const updated = output.materializedFiles.filter(
      file => file.status === 'updated',
    ).length
    const unchanged = output.materializedFiles.filter(
      file => file.status === 'unchanged',
    ).length
    const runOk = output.executionResults.filter(
      run => run.status === 'success',
    ).length
    const runFailed = output.executionResults.filter(
      run => run.status === 'failed',
    ).length
    const runSkipped = output.executionResults.filter(
      run => run.status === 'skipped',
    ).length
    const firstFile = output.materializedFiles[0]?.relativePath
    const shownDiffs = output.materializedDiffs.slice(0, 3)
    const shownRuns = verbose
      ? output.executionResults
      : output.executionResults.slice(0, 3)
    const timelineLines = buildRunTimelineLines(output, verbose)
    const runCommandsById = new Map(
      output.plan.experiment_runners.runners.map(runner => [
        runner.id,
        normalizeInline(runner.run_command || ''),
      ]),
    )

    const nRowsLabel =
      gates.evidenceSufficiency.nRows > 0
        ? String(gates.evidenceSufficiency.nRows)
        : gates.evidenceSufficiency.datasetUsed || gates.evidenceSufficiency.hasRealDataset
          ? '?'
          : '0'
    const loboFoldsLabel =
      gates.evidenceSufficiency.loboFolds > 0
        ? String(gates.evidenceSufficiency.loboFolds)
        : gates.evidenceSufficiency.datasetUsed || gates.evidenceSufficiency.hasRealDataset
          ? '?'
          : '0'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={mutedColor}>&nbsp;&nbsp;⎿ &nbsp;Experiment runners complete </Text>
          <Text color={mutedColor}>
            ({output.model}
            {output.retriesUsed > 0 ? ` · retries ${output.retriesUsed}` : ''})
          </Text>
        </Box>
        <Text color={mutedColor}>{`     Status: ${output.planStatus}`}</Text>
        <Text color={mutedColor}>{`     Runners: ${output.runnersCount}`}</Text>
        <Text color={mutedColor}>{`     Order: ${orderPreview}`}</Text>
        {output.installedDependencies.length > 0 ? (
          <Text color={mutedColor}>
            {`     Deps installed: ${truncateForUi(output.installedDependencies.join(', '), 90)}`}
          </Text>
        ) : null}
        {output.dependencyInstallError ? (
          <Text color={mutedColor}>
            {`     Deps install error: ${truncateForUi(output.dependencyInstallError, 90)}`}
          </Text>
        ) : null}
        <Text
          color={mutedColor}
        >{`     Runs: ${output.executionResults.length} (ok ${runOk} · fail ${runFailed} · skipped ${runSkipped})`}</Text>
        <Text color={mutedColor}>
          {`     Gate: ${gates.stageDecision} (toy ${gates.toy.truthAssessment} · contract ${gates.runnerContract.status} · evidence ${gates.evidenceSufficiency.status})`}
        </Text>
        <Text color={mutedColor}>
          {`     Full gates: ontology=${gateStack.ontology.claim_well_formed.status} · plan_quality=${gateStack.epistemic.falsification_plan_quality.status} · umc=${gateStack.universal.umc_v1.status} · ledger=${gateStack.universal.ledger_closure.status} · overall=${gateStack.overall}`}
        </Text>
        <Text color={mutedColor}>
          {`     Critical verdict: ${criticalVerdicts.overall}`}
        </Text>
        <Text color={mutedColor}>
          {`     Field gate: ${gates.field.shouldAdvance ? 'advance' : 'hold'} · ${truncateForUi(gates.field.reason, 70)}`}
        </Text>
        <Text color={mutedColor}>
          {`     Evidence: dataset_used=${gates.evidenceSufficiency.datasetUsed ? 'yes' : 'no'} · real_dataset=${gates.evidenceSufficiency.hasRealDataset ? 'yes' : 'no'} · claim_dataset_fit=${gates.evidenceSufficiency.claimDatasetFit ? 'yes' : 'no'} · n_rows=${nRowsLabel} · lobo_folds=${loboFoldsLabel}`}
        </Text>
        <Text
          color={mutedColor}
        >{`     Files: ${output.materializedFiles.length} (new ${created} · updated ${updated} · unchanged ${unchanged})`}</Text>
        <Text
          color={mutedColor}
        >{`     Dir: ${truncateForUi(output.runnersDir, 90)}`}</Text>
        {output.gateArtifactPath ? (
          <Text color={mutedColor}>
            {`     Gate artifact: ${truncateForUi(output.gateArtifactPath, 90)}`}
          </Text>
        ) : null}
        <Text color={mutedColor}>{`     Execution: real run (not dry-run)`}</Text>
        {firstFile ? (
          <Text color={mutedColor}>{`     Ejemplo: ${truncateForUi(firstFile, 90)}`}</Text>
        ) : null}
        {output.definitionPreviews.map(item => (
          <Box key={`def-${item.id}`}>
            <Text color={mutedColor}>{`     Def ${item.id}: ${truncateForUi(item.preview, 90)}`}</Text>
          </Box>
        ))}
        <Text color={mutedColor}>{`     Next action: ${truncateForUi(output.nextAction, 90)}`}</Text>
        {shownRuns.map(run => {
          const commandLine = formatRunCommandLine(run)
          const cwdLine = formatRunCwdLine(run)
          const detailLine = formatRunDetailLine(run)
          const planCommand = runCommandsById.get(run.id) || ''
          const planCommandLine =
            planCommand.length > 0
              ? `Plan ${run.id}: ${truncateForUi(planCommand, 110)}`
              : null
          const detailShouldRender =
            run.status === 'failed' ||
            (verbose && detailLine !== null)
          return (
            <Box key={`run-${run.id}`} flexDirection="column">
              <Text color={mutedColor}>{`     ${formatRunSummaryLine(run)}`}</Text>
              {verbose && planCommandLine ? (
                <Text color={mutedColor}>{`     ${planCommandLine}`}</Text>
              ) : null}
              {verbose && commandLine ? (
                <Text color={mutedColor}>{`     ${commandLine}`}</Text>
              ) : null}
              {verbose && cwdLine ? (
                <Text color={mutedColor}>{`     ${cwdLine}`}</Text>
              ) : null}
              {detailShouldRender && detailLine ? (
                <Text color={mutedColor}>{`     ${detailLine}`}</Text>
              ) : null}
            </Box>
          )
        })}
        {output.executionResults.length > shownRuns.length ? (
          <Text color={mutedColor}>
            {`     ... ${output.executionResults.length - shownRuns.length} additional run(s) omitted from view.`}
          </Text>
        ) : null}
        {verbose && timelineLines.length > 0 ? (
          <Text color={mutedColor}>{`     Timeline:`}</Text>
        ) : null}
        {verbose
          ? timelineLines.map((line, index) => (
              <Box key={`timeline-${index}`}>
                <Text color={mutedColor}>{`       - ${line}`}</Text>
              </Box>
            ))
          : null}
        {verbose ? (
          <Box flexDirection="column">
            {shownRuns.map(run => (
              <Box key={`raw-${run.id}`} flexDirection="column">
                {run.stdoutRaw ? (
                  <Text color={mutedColor}>{`     stdout ${run.id}:\n${run.stdoutRaw}`}</Text>
                ) : null}
                {run.stderrRaw ? (
                  <Text color={mutedColor}>{`     stderr ${run.id}:\n${run.stderrRaw}`}</Text>
                ) : null}
              </Box>
            ))}
          </Box>
        ) : null}
        {shownDiffs.length > 0 ? (
          <Text color={mutedColor}>{`     Diffs: ${output.materializedDiffs.length}`}</Text>
        ) : null}
        {shownDiffs.map(item => (
          <Box key={`runner-diff-${item.relativePath}`}>
            <FileEditToolUpdatedMessage
              filePath={resolve(getCwd(), item.relativePath)}
              structuredPatch={item.structuredPatch}
              verbose={verbose}
            />
          </Box>
        ))}
        {output.materializedDiffs.length > shownDiffs.length ? (
          <Text color={mutedColor}>
            {`     ... ${output.materializedDiffs.length - shownDiffs.length} additional diff(s) omitted from view.`}
          </Text>
        ) : null}
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    const plan = output.plan.experiment_runners
    const gates =
      output.gates ||
      evaluateRunnerGates({
        plan: output.plan.experiment_runners,
        executionResults: output.executionResults,
        dependencyInstallError: output.dependencyInstallError,
      })
    const gateStack = deriveGateStackFromLegacy(gates)
    const runOk = output.executionResults.filter(run => run.status === 'success')
      .length
    const runFailed = output.executionResults.filter(
      run => run.status === 'failed',
    ).length
    const runSkipped = output.executionResults.filter(
      run => run.status === 'skipped',
    ).length
    const criticalVerdicts =
      output.criticalVerdicts ||
      buildCriticalRunnerVerdictSummary({
        plan: output.plan.experiment_runners,
        executionResults: output.executionResults,
      })
    const runnersPreview = plan.runners.slice(0, 4).map(runner => {
      return `${runner.id} [${runner.language}] ${runner.filename} :: ${runner.run_command}`
    })
    const runsPreview = output.executionResults.slice(0, 6).map(run => {
      const base = `${run.id}: ${run.status} exit=${
        run.exitCode === null ? 'n/a' : run.exitCode
      } cmd="${run.command}"`
      if (run.status === 'failed' && run.stderrPreview) {
        return `${base} stderr="${run.stderrPreview}"`
      }
      if (run.status === 'success' && run.stdoutPreview) {
        return `${base} stdout="${run.stdoutPreview}"`
      }
      if (run.reason) {
        return `${base} reason="${run.reason}"`
      }
      return base
    })

    const lines = [
      'Experiment runners result (summary):',
      `Status: ${output.planStatus}`,
      `Runner execution status: total=${output.executionResults.length}, ok=${runOk}, fail=${runFailed}, skipped=${runSkipped}.`,
      `Gate decision: ${gates.stageDecision}`,
      `Toy truth: status=${gates.toy.status}, assessment=${gates.toy.truthAssessment}, pass=${gates.toy.passTests}, fail=${gates.toy.failTests}, contradiction=${gates.toy.logicalContradiction}.`,
      `Runner contract: ${gates.runnerContract.status} (${gates.runnerContract.reason})`,
      `Evidence sufficiency: ${gates.evidenceSufficiency.status} (dataset_used=${gates.evidenceSufficiency.datasetUsed}, real_dataset=${gates.evidenceSufficiency.hasRealDataset}, claim_dataset_fit=${gates.evidenceSufficiency.claimDatasetFit}, n_rows=${gates.evidenceSufficiency.nRows}, lobo_folds=${gates.evidenceSufficiency.loboFolds}).`,
      `Claim dataset fit detail: ${gates.evidenceSufficiency.claimDatasetFitReason}`,
      `Gate ontology.claim_well_formed: ${gateStack.ontology.claim_well_formed.status} (${gateStack.ontology.claim_well_formed.reason})`,
      `Gate epistemic.falsification_plan_quality: ${gateStack.epistemic.falsification_plan_quality.status} (${gateStack.epistemic.falsification_plan_quality.reason})`,
      `Gate universal.umc_v1: ${gateStack.universal.umc_v1.status} (${gateStack.universal.umc_v1.reason})`,
      `Gate universal.ledger_closure: ${gateStack.universal.ledger_closure.status} (${gateStack.universal.ledger_closure.reason})`,
      `Gate stack overall: ${gateStack.overall}`,
      `Critical verdict overall: ${criticalVerdicts.overall}`,
      `Critical verdict detail: ${
        criticalVerdicts.items.length > 0
          ? criticalVerdicts.items
              .map(item => `${item.runnerId}:${item.verdict}`)
              .join(', ')
          : '(none)'
      }`,
      ...(output.installedDependencies.length > 0
        ? [
            `Dependencies installed automatically: ${output.installedDependencies.join(', ')}`,
          ]
        : []),
      ...(output.dependencyInstallError
        ? [`Dependency installation failure: ${output.dependencyInstallError}`]
        : []),
      `Hypothesis snapshot: ${output.hypothesisSnapshot}`,
      `Runners: ${output.runnersCount}`,
      `Files directory: ${output.runnersDir}`,
      ...(output.gateArtifactPath
        ? [`Gate artifact: ${output.gateArtifactPath}`]
        : []),
      `Execution order: ${output.executionOrder.join(', ') || '(none)'}`,
      `Next action: ${output.nextAction}`,
      'Key runners:',
      ...(runnersPreview.length > 0
        ? runnersPreview.map(item => `- ${item}`)
        : ['- (no runners)']),
      'Materialized files:',
      ...(output.materializedFiles.length > 0
        ? output.materializedFiles.map(
            file =>
              `- ${file.relativePath} [${file.status}] (${file.language})`,
          )
        : ['- (no materialized files)']),
      'Runner defs:',
      ...(output.definitionPreviews.length > 0
        ? output.definitionPreviews.map(
            item => `- ${item.id} (${item.relativePath}): ${item.preview}`,
          )
        : ['- (no defs available)']),
      'Run results:',
      ...(runsPreview.length > 0 ? runsPreview.map(item => `- ${item}`) : ['- (no runs)']),
    ]

    if (criticalVerdicts.overall === 'FAIL') {
      lines.push(
        'MANDATORY CLOSURE RULE: at least one critical test FAILED.',
        'Do not claim the hypothesis was confirmed/supported/globally plausible.',
        'You must state there is partial falsification or contradiction in critical tests and center the conclusion on those verdicts.',
      )
    }

    if (output.planStatus === 'skipped') {
      lines.push(
        'ExperimentRunners was skipped due to insufficient context (usually falsification not ready).',
        'Mandatory next step: complete FalsificationPlan and then retry ExperimentRunners.',
      )
    } else if (gates.stageDecision === 'REJECT_EARLY') {
      if (gates.toy.truthAssessment === 'FAIL') {
        lines.push(
          'Terminal gate: toy phase produced truth_assessment=FAIL.',
          'Do not auto-repair this into a positive conclusion in the same turn.',
          'Close as refutation/contradiction or start a new revised hypothesis.',
        )
      } else {
        lines.push(
          'Mandatory auto-repair: call FalsificationPlan again with observed fail signals and then call ExperimentRunners.',
          'Do not close with final narrative until plan repair is complete.',
        )
      }
    } else if (gates.stageDecision === 'DEFINITIVE_FAIL') {
      lines.push(
        'Mandatory auto-repair: fix runner contract/environment and rerun ExperimentRunners.',
        'If deps/commands fail, report the concrete error and repair before concluding.',
      )
    } else if (
      gates.stageDecision === 'PROVISIONAL_PASS' ||
      gates.stageDecision === 'NEEDS_FIELD'
    ) {
      if (!gates.evidenceSufficiency.hasRealDataset) {
        const selectorTemplate = buildDatasetAskUserQuestionTemplate()
        lines.push(
          'Provisional result: do not close as definitive validation.',
          'No usable real dataset for field. Do not use automatic synthetic fallback by default.',
          'Mandatory next step: first attempt to resolve a real dataset (plan/falsification/web).',
          'If real dataset is still missing, invoke AskUserQuestion (Amawta Selector) before continuing field.',
          `Suggested AskUserQuestion template: ${selectorTemplate}`,
          'After selector response, execute the chosen option and then retry ExperimentRunners.',
        )
      } else {
        lines.push(
          'Provisional result: do not close as definitive validation.',
          'Mandatory next step: run field phase with real dataset and thresholds n_rows>=30, lobo_folds>=2.',
        )
      }
    } else {
      lines.push(
        'Do not invoke ExperimentRunners again for this same hypothesis in this turn; reuse this result.',
        'Do not invoke FalsificationPlan again in this turn after ExperimentRunners; reuse the generated plan.',
        'User response: use real run evidence (ok/fail, stdout/stderr) and keep conclusion calibrated.',
        'If there are environment/dependency failures, state them explicitly and suggest a concrete command to resolve them.',
      )
      if (
        gates.stageDecision === 'DEFINITIVE_PASS' &&
        criticalVerdicts.overall === 'PASS'
      ) {
        lines.push(
          'COHERENCE RULE: the final verdict must be consistent with Gate=DEFINITIVE_PASS and Critical verdict=PASS.',
          'Do not close with a refutation/falsification narrative when final gates are PASS.',
        )
      }
    }

    return lines.join('\n')
  },
  async *call(input: Input, context: ToolUseContext) {
    const modelManager = getModelManager()
    const modelProfile = modelManager.getModel('main')

    if (!modelProfile || !modelProfile.modelName) {
      throw new Error(
        'No model configured. Configure a model first with /model command.',
      )
    }

    const conversationKey = buildToolConversationKey(context)
    let effectiveInput: Input = { ...input }
    let effectiveFalsificationRaw = effectiveInput.falsification_plan_json
    let falsificationStatus = inferFalsificationPlanStatus(
      effectiveFalsificationRaw,
    )

    const latestFalsificationFromContext =
      typeof context.options?.latestFalsificationPlanJson === 'string'
        ? context.options.latestFalsificationPlanJson.trim()
        : ''
    if (
      falsificationStatus !== 'ready' &&
      inferFalsificationPlanStatus(latestFalsificationFromContext) === 'ready'
    ) {
      effectiveFalsificationRaw = latestFalsificationFromContext
      effectiveInput = {
        ...effectiveInput,
        falsification_plan_json: latestFalsificationFromContext,
      }
      falsificationStatus = 'ready'
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Auto-correction: using the latest ready FalsificationPlan from shared session context.',
        ),
      }
    }

    if (falsificationStatus !== 'ready') {
      const hypothesisCandidates = Array.from(
        new Set(
          [effectiveInput.hypothesis_query, context.options?.lastUserPrompt]
            .map(value => (typeof value === 'string' ? value.trim() : ''))
            .filter(value => value.length >= 8),
        ),
      )

      for (const hypothesisQuery of hypothesisCandidates) {
        const readyPlan = await waitForReadyFalsificationResultForTurn({
          context,
          hypothesisQuery,
          signal: context.abortController.signal,
          timeoutMs: 20_000,
        })
        if (!readyPlan || readyPlan.planStatus !== 'ready') continue

        const recoveredJson = JSON.stringify(readyPlan.plan)
        effectiveFalsificationRaw = recoveredJson
        effectiveInput = {
          ...effectiveInput,
          hypothesis_query: hypothesisQuery,
          falsification_plan_json: recoveredJson,
        }
        falsificationStatus = 'ready'
        yield {
          type: 'progress',
          content: createAssistantMessage(
            'Auto-correction: recovered ready FalsificationPlan from this turn and continuing with ExperimentRunners.',
          ),
        }
        break
      }
    }

    const turnScopedKey = buildTurnScopedExperimentRunnersKey(
      effectiveInput,
      context,
    )
    const cacheKey = buildExperimentRunnersCacheKey(effectiveInput, context, {
      modelName: modelProfile.modelName,
    })
    pruneExperimentRunnersCache()
    pruneTurnScopedExperimentRunnersCache()

    const turnScopedCached = turnScopedExperimentRunnersResultCache.get(
      turnScopedKey,
    )
    const forceFieldRefreshFromTurnCache = turnScopedCached
      ? shouldForceFieldRefreshFromPendingOutput({
          output: turnScopedCached.output,
          input: effectiveInput,
          cwd: getCwd(),
        })
      : false
    if (
      turnScopedCached &&
      !forceFieldRefreshFromTurnCache &&
      Date.now() - turnScopedCached.createdAt <=
        EXPERIMENT_RUNNERS_TURN_CACHE_TTL_MS &&
      (shouldReuseExperimentRunnersCachedOutput(turnScopedCached.output) ||
        shouldReuseTurnScopedExecutionOutput(turnScopedCached.output))
    ) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'ExperimentRunners already ran in this turn for this hypothesis; reusing result.',
        ),
      }
      yield {
        type: 'result' as const,
        data: {
          ...turnScopedCached.output,
          fromCacheReuse: true,
        },
        resultForAssistant: this.renderResultForAssistant({
          ...turnScopedCached.output,
          fromCacheReuse: true,
        }),
      }
      return
    }
    if (forceFieldRefreshFromTurnCache) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Auto-correction: invalidating turn cache to retry field with recent dataset/local decision.',
        ),
      }
    }

    if (falsificationStatus !== 'ready') {
      const output = buildSkippedOutput(
        effectiveInput,
        modelProfile.modelName,
        'falsification_incomplete',
      )
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Skipping runners: FalsificationPlan is not ready (status != ready).',
        ),
      }
      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
      return
    }

    const cached = recentExperimentRunnersCache.get(cacheKey)
    const forceFieldRefreshFromRecentCache = cached
      ? shouldForceFieldRefreshFromPendingOutput({
          output: cached.output,
          input: effectiveInput,
          cwd: getCwd(),
        })
      : false
    if (
      cached &&
      !forceFieldRefreshFromRecentCache &&
      shouldReuseExperimentRunnersCachedOutput(cached.output) &&
      Date.now() - cached.createdAt <= EXPERIMENT_RUNNERS_CACHE_TTL_MS
    ) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Reusing recent experiment runners for this same hypothesis.',
        ),
      }
      yield {
        type: 'result' as const,
        data: {
          ...cached.output,
          fromCacheReuse: true,
        },
        resultForAssistant: this.renderResultForAssistant({
          ...cached.output,
          fromCacheReuse: true,
        }),
      }
      return
    }
    if (forceFieldRefreshFromRecentCache) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Auto-correction: invalidating recent cache to force field evidence re-evaluation.',
        ),
      }
    }

    const existingRun = inFlightExperimentRunnersRuns.get(cacheKey)
    if (existingRun) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for result from an experiment runners execution already in progress.',
        ),
      }
      const output = await existingRun
      yield {
        type: 'result' as const,
        data: {
          ...output,
          fromCacheReuse: true,
        },
        resultForAssistant: this.renderResultForAssistant({
          ...output,
          fromCacheReuse: true,
        }),
      }
      return
    }

    const existingRunByTurn = inFlightExperimentRunnersRunsByTurn.get(
      turnScopedKey,
    )
    if (existingRunByTurn) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for runners result already in progress for this same turn.',
        ),
      }
      const output = await existingRunByTurn
      yield {
        type: 'result' as const,
        data: {
          ...output,
          fromCacheReuse: true,
        },
        resultForAssistant: this.renderResultForAssistant({
          ...output,
          fromCacheReuse: true,
        }),
      }
      return
    }

    let resolveRunPromise: ((value: Output) => void) | null = null
    let rejectRunPromise: ((reason?: unknown) => void) | null = null
    const runPromise = new Promise<Output>((resolve, reject) => {
      resolveRunPromise = resolve
      rejectRunPromise = reject
    })
    // Keep a handler attached so rejected in-flight dedupe promises never become
    // process-level unhandled rejections when there is no concurrent waiter.
    void runPromise.catch(() => {})
    inFlightExperimentRunnersRuns.set(cacheKey, runPromise)
    inFlightExperimentRunnersRunsByTurn.set(turnScopedKey, runPromise)

    let output: Output
    try {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Running runners subagent (design -> files -> execution command)...',
        ),
      }
      const prepared = await prepareExperimentRunnersOutput({
        modelName: modelProfile.modelName,
        apiKey: modelProfile.apiKey?.trim() || undefined,
        input: effectiveInput,
        effectiveFalsificationRaw,
        conversationKey,
        signal: context.abortController.signal,
      })
      let effectivePlan = prepared.plan.experiment_runners
      let effectiveRunnersDir = prepared.runnersDir
      let effectiveMaterializedFiles = [...prepared.materializedFiles]
      let effectiveMaterializedDiffs = [...prepared.materializedDiffs]
      let effectiveDefinitionPreviews = [...prepared.definitionPreviews]
      let effectiveExecutionOrder = [...prepared.executionOrder]
      const syntheticProvisionalRequested =
        /\bsynthetic_provisional\b/i.test(
          normalizeInline(effectiveInput.dataset_hint || ''),
        ) ||
        /\b(?:sintetico|synthetic)\b/i.test(
          normalizeInline(effectiveInput.dataset_hint || ''),
        )
      let claimSemanticProfile = deriveClaimSemanticProfile({
        hypothesisQuery: effectiveInput.hypothesis_query,
        normalizationRaw: effectiveInput.normalization_json,
      })
      const gateContext: RunnerGateEvaluationContext = {
        normalizationGate: parseNormalizationGate(effectiveInput.normalization_json),
        falsificationPlanQualityGate: parseFalsificationPlanQualityGate(
          effectiveFalsificationRaw,
        ),
        claimSemanticProfile,
      }
      let pass1DatasetCandidates: string[] = []
      let pass1KeywordHints: string[] = []
      if (!context.abortController.signal.aborted) {
        const literatureQueries = buildLiteratureAffinityQueries({
          hypothesisQuery: effectiveInput.hypothesis_query,
          falsificationRaw: effectiveFalsificationRaw,
          semanticProfile: gateContext.claimSemanticProfile,
        })
        if (literatureQueries.length > 0) {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_pass1_literature_start: queries=${literatureQueries.length}`,
            ),
            persistHistory: true,
          }
        } else {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              'dataset_pass1_literature_skip: no affinity queries generated from hypothesis.',
            ),
            persistHistory: true,
          }
        }
        const literatureAffinity = await discoverLiteratureAffinity({
          hypothesisQuery: effectiveInput.hypothesis_query,
          falsificationRaw: effectiveFalsificationRaw,
          semanticProfile: gateContext.claimSemanticProfile,
          signal: context.abortController.signal,
        })
        pass1DatasetCandidates = literatureAffinity.datasetCandidates
        pass1KeywordHints = literatureAffinity.keywordHints
        if (literatureAffinity.results.length > 0) {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_pass1_literature_hit: results=${literatureAffinity.results.length} semantic_fit=${literatureAffinity.semanticFit.matched}/${literatureAffinity.semanticFit.required}`,
            ),
            persistHistory: true,
          }
        } else {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              'dataset_pass1_literature_miss: no useful literature evidence candidates found.',
            ),
            persistHistory: true,
          }
        }
      }
      if (
        effectivePlan.meta.status === 'ready' &&
        effectivePlan.runners.length > 0
      ) {
        const plannedPreview = effectivePlan.runners
          .slice(0, 3)
          .map(
            runner =>
              `${runner.id}: ${truncateForUi(
                normalizeInline(runner.run_command || ''),
                90,
              )}`,
          )
          .join(' · ')
        if (plannedPreview.length > 0) {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `Runner execution plan: ${plannedPreview}`,
            ),
          }
        }
      }

      const executionIterator = executeMaterializedRunnersStreaming({
        plan: effectivePlan,
        materialized: {
          runnersDir: effectiveRunnersDir,
          files: effectiveMaterializedFiles,
        },
        signal: context.abortController.signal,
      })
      let next = executionIterator.next()
      while (!next.done) {
        const line = String(next.value || '')
        yield {
          type: 'progress',
          content: createAssistantMessage(line),
          persistHistory: shouldPersistRunnerProgressLine(line),
        }
        next = executionIterator.next()
      }
      let execution = next.value
      let gates = evaluateRunnerGates({
        plan: effectivePlan,
        executionResults: execution.results,
        dependencyInstallError: execution.dependencyInstallError,
        gateContext,
      })

      if (
        gates.field.shouldAdvance &&
        !gates.evidenceSufficiency.hasRealDataset &&
        !context.abortController.signal.aborted
      ) {
        yield {
          type: 'progress',
          content: createAssistantMessage(
            `dataset_pass2_field_start: toy_truth=${gates.toy.truthAssessment} stage=${gates.stageDecision}`,
          ),
          persistHistory: true,
        }

        const advisorPlan = await runDatasetDiscoveryAdvisor({
          hypothesisQuery: effectiveInput.hypothesis_query,
          falsificationRaw: effectiveFalsificationRaw,
          semanticProfile: gateContext.claimSemanticProfile,
          keywordHints: pass1KeywordHints,
          toyTruth: gates.toy.truthAssessment,
          stageDecision: gates.stageDecision,
          signal: context.abortController.signal,
        })
        const advisorSeedCandidates = advisorPlan?.seedUrls || []
        const advisorKeywordHints = advisorPlan?.keywordHints || []
        if (advisorPlan) {
          if (advisorPlan.searchQueries.length > 0) {
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_pass2_advisor_queries: count=${advisorPlan.searchQueries.length}`,
              ),
              persistHistory: true,
            }
          }
          if (advisorSeedCandidates.length > 0) {
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_pass2_advisor_seeds: count=${advisorSeedCandidates.length}`,
              ),
              persistHistory: true,
            }
          }
          if (advisorPlan.observableMapping.length > 0) {
            const mappingPreview = advisorPlan.observableMapping
              .slice(0, 3)
              .map(item => `${item.claimVariable}->${item.datasetProxy}`)
              .join(' · ')
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_pass2_observable_mapping: ${truncateForUi(mappingPreview, 140)}`,
              ),
              persistHistory: true,
            }
          }
        } else {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              'dataset_pass2_advisor_miss: could not derive agentic discovery plan; using heuristic discovery.',
            ),
            persistHistory: true,
          }
        }

        const pass2SemanticProfile = deriveDatasetDiscoverySemanticProfile({
          baseProfile: claimSemanticProfile,
          hypothesisQuery: effectiveInput.hypothesis_query,
          falsificationRaw: effectiveFalsificationRaw,
          keywordHints: Array.from(
            new Set([...pass1KeywordHints, ...advisorKeywordHints]),
          ),
          advisorPlan,
        })
        if (pass2SemanticProfile) {
          claimSemanticProfile = pass2SemanticProfile
          gateContext.claimSemanticProfile = pass2SemanticProfile
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_pass2_semantic_profile: tokens=${pass2SemanticProfile.tokens.length} min_matches=${pass2SemanticProfile.minMatches}`,
            ),
            persistHistory: true,
          }
        }

        const structuredCandidates = extractStructuredDatasetCandidatesFromPlan({
          plan: effectivePlan,
          falsificationRaw: effectiveFalsificationRaw,
          datasetHint: effectiveInput.dataset_hint,
        })
        const explicitCandidates =
          structuredCandidates.length > 0
            ? structuredCandidates
            : extractDatasetCandidatesFromPlan({
                plan: effectivePlan,
                falsificationRaw: effectiveFalsificationRaw,
                datasetHint: effectiveInput.dataset_hint,
              })
        if (structuredCandidates.length === 0) {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              'dataset_pass2_structured_miss: no structured dataset hints in required_inputs/data_requests/dataset_hint; enabling heuristic fallback.',
            ),
            persistHistory: true,
          }
        } else {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_pass2_structured_hit: candidates=${structuredCandidates.length}`,
            ),
            persistHistory: true,
          }
        }
        const localCandidates = discoverLocalDatasetCandidates({
          cwd: getCwd(),
          hypothesisQuery: effectiveInput.hypothesis_query,
        })
        let datasetCandidates = Array.from(
          new Set([
            ...explicitCandidates,
            ...advisorSeedCandidates,
            ...localCandidates,
            ...pass1DatasetCandidates,
          ]),
        )
        let resolvedDataset: ResolvedDataset | null = null

        if (datasetCandidates.length > 0) {
          const prioritizedCandidates = selectTopDatasetCandidatesForFieldResolve({
            candidates: datasetCandidates,
            semanticProfile: claimSemanticProfile,
            topK: FIELD_RESOLVE_TOP_K,
          })
          if (prioritizedCandidates.length !== datasetCandidates.length) {
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_pass2_field_shortlist: selected=${prioritizedCandidates.length}/${datasetCandidates.length} top_k=${FIELD_RESOLVE_TOP_K}`,
              ),
              persistHistory: true,
            }
          }
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_pass2_field_resolve_start: candidates=${prioritizedCandidates.length}`,
            ),
            persistHistory: true,
          }
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_resolve_start: candidates=${prioritizedCandidates.length}`,
            ),
            persistHistory: true,
          }
            resolvedDataset = await resolveDatasetForField({
              candidates: prioritizedCandidates,
              cwd: getCwd(),
              semanticProfile: claimSemanticProfile,
              signal: context.abortController.signal,
            })
        }

        if (!resolvedDataset && !context.abortController.signal.aborted) {
          const webCandidates = await discoverWebDatasetCandidates({
            hypothesisQuery: effectiveInput.hypothesis_query,
            falsificationRaw: effectiveFalsificationRaw,
            keywordHints: Array.from(
              new Set([...pass1KeywordHints, ...advisorKeywordHints]),
            ),
            advisorQueries: advisorPlan?.searchQueries,
            semanticProfile: claimSemanticProfile,
            signal: context.abortController.signal,
          })
          if (webCandidates.length > 0) {
            datasetCandidates = Array.from(
              new Set([...datasetCandidates, ...webCandidates]),
            )
            const prioritizedWebCandidates =
              selectTopDatasetCandidatesForFieldResolve({
                candidates: webCandidates,
                semanticProfile: claimSemanticProfile,
                topK: FIELD_RESOLVE_TOP_K,
              })
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_web_discovery_hit: web_candidates=${webCandidates.length}`,
              ),
              persistHistory: true,
            }
            if (prioritizedWebCandidates.length !== webCandidates.length) {
              yield {
                type: 'progress',
                content: createAssistantMessage(
                  `dataset_pass2_field_shortlist: selected=${prioritizedWebCandidates.length}/${webCandidates.length} top_k=${FIELD_RESOLVE_TOP_K} source=web`,
                ),
                persistHistory: true,
              }
            }
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_pass2_field_resolve_start: candidates=${prioritizedWebCandidates.length} source=web`,
              ),
              persistHistory: true,
            }
            yield {
              type: 'progress',
              content: createAssistantMessage(
                `dataset_resolve_start: candidates=${prioritizedWebCandidates.length} source=web`,
              ),
              persistHistory: true,
            }
            resolvedDataset = await resolveDatasetForField({
              candidates: prioritizedWebCandidates,
              cwd: getCwd(),
              semanticProfile: claimSemanticProfile,
              signal: context.abortController.signal,
            })
          } else {
            yield {
              type: 'progress',
              content: createAssistantMessage(
                'dataset_web_discovery_miss: no usable web dataset candidates found.',
              ),
              persistHistory: true,
            }
          }
        }

        if (resolvedDataset) {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_resolve_hit: source=${truncateForUi(
                resolvedDataset.source,
                80,
              )} format=${resolvedDataset.format} parse_ok=${
                resolvedDataset.parseOk ? 'yes' : 'no'
              } mime_valid=${resolvedDataset.mimeValid ? 'yes' : 'no'} rows=${
                resolvedDataset.nRows
              } downloaded=${resolvedDataset.downloaded ? 'yes' : 'no'}`,
            ),
            persistHistory: true,
          }
          const datasetRunner = buildDatasetFieldRunner({
            plan: effectivePlan,
            dataset: resolvedDataset,
          })
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `Auto-repair: dataset detected; generating ${datasetRunner.id} for real field evidence.`,
            ),
            persistHistory: true,
          }

          effectivePlan = {
            ...effectivePlan,
            runners: [...effectivePlan.runners, datasetRunner],
            execution_order: [
              ...effectivePlan.execution_order.filter(Boolean),
              datasetRunner.id,
            ],
            next_action:
              'Run field with resolved dataset and re-evaluate evidence gates.',
          }
          effectiveExecutionOrder = [...effectivePlan.execution_order]

          const datasetMaterialized = materializeExperimentRunnerFiles(effectivePlan)
          effectiveRunnersDir = datasetMaterialized.runnersDir
          effectiveMaterializedFiles = datasetMaterialized.files
          const dedupDiffs = new Map<string, MaterializedRunnerDiff>()
          for (const diff of [
            ...effectiveMaterializedDiffs,
            ...datasetMaterialized.diffs,
          ]) {
            const key = `${diff.relativePath}::${JSON.stringify(
              diff.structuredPatch,
            )}`
            if (!dedupDiffs.has(key)) dedupDiffs.set(key, diff)
          }
          effectiveMaterializedDiffs = Array.from(dedupDiffs.values())

          const datasetPreview: RunnerDefinitionPreview = {
            id: datasetRunner.id,
            relativePath:
              datasetMaterialized.files.find(
                file => file.id === datasetRunner.id,
              )?.relativePath || datasetRunner.filename,
            preview: extractDefinitionPreview(
              datasetRunner.code,
              datasetRunner.language,
            ),
          }
          effectiveDefinitionPreviews = [
            ...effectiveDefinitionPreviews.filter(
              item => item.id !== datasetRunner.id,
            ),
            datasetPreview,
          ]

          const datasetExecutionIterator = executeMaterializedRunnersStreaming({
            plan: {
              ...effectivePlan,
              runners: [datasetRunner],
              execution_order: [datasetRunner.id],
            },
            materialized: {
              runnersDir: datasetMaterialized.runnersDir,
              files: datasetMaterialized.files.filter(
                file => file.id === datasetRunner.id,
              ),
            },
            signal: context.abortController.signal,
          })
          let datasetNext = datasetExecutionIterator.next()
          while (!datasetNext.done) {
            const line = String(datasetNext.value || '')
            yield {
              type: 'progress',
              content: createAssistantMessage(line),
              persistHistory: shouldPersistRunnerProgressLine(line),
            }
            datasetNext = datasetExecutionIterator.next()
          }
          const datasetExecution = datasetNext.value
          execution = {
            results: [...execution.results, ...datasetExecution.results],
            installedDependencies: Array.from(
              new Set([
                ...execution.installedDependencies,
                ...datasetExecution.installedDependencies,
              ]),
            ),
            dependencyInstallError:
              execution.dependencyInstallError ||
              datasetExecution.dependencyInstallError,
          }
          gates = evaluateRunnerGates({
            plan: effectivePlan,
            executionResults: execution.results,
            dependencyInstallError: execution.dependencyInstallError,
            gateContext,
          })
        } else if (datasetCandidates.length === 0) {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              'dataset_resolve_miss: no dataset candidates found after pass1 literature affinity and pass2 preparation.',
            ),
            persistHistory: true,
          }
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_decision_required: invoke AskUserQuestion to define real URL/path or enable extended search. template=${buildDatasetAskUserQuestionTemplate()}`,
            ),
            persistHistory: true,
          }
        } else {
          yield {
            type: 'progress',
            content: createAssistantMessage(
              'dataset_resolve_miss: could not resolve a usable dataset automatically.',
            ),
            persistHistory: true,
          }
          yield {
            type: 'progress',
            content: createAssistantMessage(
              `dataset_decision_required: invoke AskUserQuestion to decide real source or alternative strategy. template=${buildDatasetAskUserQuestionTemplate()}`,
            ),
            persistHistory: true,
          }
        }
      }

      if (
        (ALLOW_SYNTHETIC_FIELD_AUTOREPAIR || syntheticProvisionalRequested) &&
        gates.stageDecision === 'NEEDS_FIELD' &&
        gates.field.shouldAdvance &&
        !hasFieldPhaseRunner(effectivePlan) &&
        !context.abortController.signal.aborted
      ) {
        const autoFieldRunner = buildAutoFieldRunner(effectivePlan)
        yield {
          type: 'progress',
          content: createAssistantMessage(
            `Auto-repair: no field runners found; generating ${autoFieldRunner.id} for minimum evidence.`,
          ),
          persistHistory: true,
        }

        effectivePlan = {
          ...effectivePlan,
          runners: [...effectivePlan.runners, autoFieldRunner],
          execution_order: [
            ...effectivePlan.execution_order.filter(Boolean),
            autoFieldRunner.id,
          ],
          next_action:
            'Run field evidence and re-evaluate sufficiency gates.',
        }
        effectiveExecutionOrder = [...effectivePlan.execution_order]

        const autoMaterialized = materializeExperimentRunnerFiles(effectivePlan)
        effectiveRunnersDir = autoMaterialized.runnersDir
        effectiveMaterializedFiles = autoMaterialized.files
        const dedupDiffs = new Map<string, MaterializedRunnerDiff>()
        for (const diff of [...effectiveMaterializedDiffs, ...autoMaterialized.diffs]) {
          const key = `${diff.relativePath}::${JSON.stringify(diff.structuredPatch)}`
          if (!dedupDiffs.has(key)) dedupDiffs.set(key, diff)
        }
        effectiveMaterializedDiffs = Array.from(dedupDiffs.values())

        const autoPreview: RunnerDefinitionPreview = {
          id: autoFieldRunner.id,
          relativePath:
            autoMaterialized.files.find(file => file.id === autoFieldRunner.id)
              ?.relativePath || autoFieldRunner.filename,
          preview: extractDefinitionPreview(autoFieldRunner.code, autoFieldRunner.language),
        }
        effectiveDefinitionPreviews = [
          ...effectiveDefinitionPreviews.filter(item => item.id !== autoFieldRunner.id),
          autoPreview,
        ]

        const autoExecutionIterator = executeMaterializedRunnersStreaming({
          plan: {
            ...effectivePlan,
            runners: [autoFieldRunner],
            execution_order: [autoFieldRunner.id],
          },
          materialized: {
            runnersDir: autoMaterialized.runnersDir,
            files: autoMaterialized.files.filter(
              file => file.id === autoFieldRunner.id,
            ),
          },
          signal: context.abortController.signal,
        })
        let autoNext = autoExecutionIterator.next()
        while (!autoNext.done) {
          const line = String(autoNext.value || '')
          yield {
            type: 'progress',
            content: createAssistantMessage(line),
            persistHistory: shouldPersistRunnerProgressLine(line),
          }
          autoNext = autoExecutionIterator.next()
        }
        const autoExecution = autoNext.value
        execution = {
          results: [...execution.results, ...autoExecution.results],
          installedDependencies: Array.from(
            new Set([
              ...execution.installedDependencies,
              ...autoExecution.installedDependencies,
            ]),
          ),
          dependencyInstallError:
            execution.dependencyInstallError ||
            autoExecution.dependencyInstallError,
        }
        gates = evaluateRunnerGates({
          plan: effectivePlan,
          executionResults: execution.results,
          dependencyInstallError: execution.dependencyInstallError,
          gateContext,
        })
      } else if (
        gates.stageDecision === 'NEEDS_FIELD' &&
        gates.field.shouldAdvance &&
        !hasFieldPhaseRunner(effectivePlan) &&
        !context.abortController.signal.aborted
      ) {
        yield {
          type: 'progress',
          content: createAssistantMessage(
            'Pending auto-repair: synthetic fallback is disabled by default; user decision via AskUserQuestion is required to continue field.',
          ),
          persistHistory: true,
        }
      }

      const criticalVerdicts = buildCriticalRunnerVerdictSummary({
        plan: effectivePlan,
        executionResults: execution.results,
      })
      if (
        criticalVerdicts.overall === 'FAIL' &&
        (gates.stageDecision === 'DEFINITIVE_PASS' ||
          gates.stageDecision === 'PROVISIONAL_PASS' ||
          gates.stageDecision === 'NEEDS_FIELD')
      ) {
        gates = {
          ...gates,
          stageDecision: 'DEFINITIVE_FAIL',
          stageReason:
            'At least one critical test reported FAIL; positive conclusion is not allowed.',
          nextAction:
            'Auto-repair: adjust FalsificationPlan and regenerate/execute critical runners before concluding.',
        }
      }

      if (
        gates.stageDecision === 'NEEDS_FIELD' &&
        !gates.evidenceSufficiency.hasRealDataset
      ) {
        gates = {
          ...gates,
          stageReason:
            'No real field dataset; missing user decision or additional discovery.',
          nextAction:
            'Attempt real dataset automatically and, if it fails, invoke AskUserQuestion to choose URL/path, extended search, or provisional synthetic mode.',
        }
      }

      const gateArtifactPath = persistRunnerGateArtifact({
        gates,
        criticalVerdicts,
        executionResults: execution.results,
        hypothesisQuery: effectiveInput.hypothesis_query,
      })

      output = {
        analysis: prepared.analysis,
        retriesUsed: prepared.retriesUsed,
        model: prepared.model,
        planStatus: effectivePlan.meta.status,
        runnersCount: effectivePlan.runners.length,
        executionOrder: effectiveExecutionOrder,
        nextAction:
          gates.stageDecision === 'DEFINITIVE_PASS'
            ? effectivePlan.next_action
            : gates.nextAction,
        hypothesisSnapshot: prepared.hypothesisSnapshot,
        runnersDir: effectiveRunnersDir,
        materializedFiles: effectiveMaterializedFiles,
        materializedDiffs: effectiveMaterializedDiffs,
        executionResults: execution.results,
        installedDependencies: execution.installedDependencies,
        dependencyInstallError: execution.dependencyInstallError,
        definitionPreviews: effectiveDefinitionPreviews,
        gates,
        criticalVerdicts,
        gateArtifactPath,
        plan: {
          experiment_runners: effectivePlan,
        },
      }
      yield {
        type: 'progress',
        content: createAssistantMessage(
          `Gate ${gates.stageDecision}: toy=${gates.toy.truthAssessment} · contract=${gates.runnerContract.status} · evidence=${gates.evidenceSufficiency.status} · critical=${criticalVerdicts.overall}`,
        ),
        persistHistory: true,
      }
      resolveRunPromise?.(output)
      resolveRunPromise = null
      rejectRunPromise = null
    } catch (error) {
      rejectRunPromise?.(error)
      resolveRunPromise = null
      rejectRunPromise = null
      throw error
    } finally {
      if (inFlightExperimentRunnersRuns.get(cacheKey) === runPromise) {
        inFlightExperimentRunnersRuns.delete(cacheKey)
      }
      if (
        inFlightExperimentRunnersRunsByTurn.get(turnScopedKey) === runPromise
      ) {
        inFlightExperimentRunnersRunsByTurn.delete(turnScopedKey)
      }
    }

    recentExperimentRunnersCache.set(cacheKey, {
      output,
      createdAt: Date.now(),
    })
    turnScopedExperimentRunnersResultCache.set(turnScopedKey, {
      output,
      createdAt: Date.now(),
    })

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>

export const __testOnly = {
  truncateForUi,
  buildDatasetAskUserQuestionTemplate,
  isDisallowedDatasetUrl,
  buildExperimentRunnersCacheKey,
  buildTurnScopedExperimentRunnersKey,
  buildSafeRunnerRelativePath,
  parseEvidenceContractFromText,
  hasFieldPhaseRunner,
  buildAutoFieldRunner,
  inferFalsificationPlanStatus,
  extractDefinitionPreview,
  formatRunSummaryLine,
  formatRunCommandLine,
  formatRunCwdLine,
  formatRunDetailLine,
  evaluateRunnerGates,
  detectRunSignals,
  buildCriticalRunnerVerdictSummary,
  buildRunTimelineLines,
  shouldPersistRunnerProgressLine,
  extractStructuredDatasetCandidatesFromPlan,
  extractDatasetCandidatesFromPlan,
  extractKeywordHintsFromSearchResults,
  buildLiteratureAffinityQueries,
  buildDatasetWebDiscoveryQueries,
  extractDatasetUrlsFromSearchResults,
  discoverLocalDatasetCandidates,
  extractDatasetCsvFromHtml,
  isLikelyFieldDatasetExtraction,
  buildDatasetFieldRunner,
  shouldReuseExperimentRunnersCachedOutput,
  shouldReuseTurnScopedExecutionOutput,
  renderResultForAssistant: (output: Output) =>
    ExperimentRunnersTool.renderResultForAssistant(output),
}
