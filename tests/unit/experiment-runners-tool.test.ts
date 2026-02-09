import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { __testOnly } from '@tools/ai/ExperimentRunnersTool/ExperimentRunnersTool'

describe('ExperimentRunnersTool helpers', () => {
  test('builds stable cache key for normalized hypothesis payload', () => {
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
    } as any

    const keyA = __testOnly.buildExperimentRunnersCacheKey(
      {
        hypothesis_query: 'X causa Y',
      },
      context,
    )

    const keyB = __testOnly.buildExperimentRunnersCacheKey(
      {
        hypothesis_query: 'X   causa   Y',
      },
      context,
    )

    expect(keyA).toBe(keyB)
  })

  test('cache key changes when model changes', () => {
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
    } as any

    const keyA = __testOnly.buildExperimentRunnersCacheKey(
      { hypothesis_query: 'X causa Y' } as any,
      context,
      { modelName: 'gemini-3-flash-preview' },
    )
    const keyB = __testOnly.buildExperimentRunnersCacheKey(
      { hypothesis_query: 'X causa Y' } as any,
      context,
      { modelName: 'gemini-2.5-pro' },
    )

    expect(keyA).not.toBe(keyB)
  })

  test('uses requestId as turn fallback when messageId is missing', () => {
    const key = __testOnly.buildTurnScopedExperimentRunnersKey(
      { hypothesis_query: 'X causa Y' } as any,
      {
        options: {
          messageLogName: 'default',
          forkNumber: 0,
        },
        agentId: 'main',
        messageId: undefined,
        requestId: 'req-abc',
      } as any,
    )
    expect(key).toContain('req:req-abc')
  })

  test('turn-scoped key changes when dataset hint changes', () => {
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
      requestId: 'req-abc',
    } as any

    const keyA = __testOnly.buildTurnScopedExperimentRunnersKey(
      { hypothesis_query: 'X causa Y' } as any,
      context,
    )
    const keyB = __testOnly.buildTurnScopedExperimentRunnersKey(
      {
        hypothesis_query: 'X causa Y',
        dataset_hint: '__dataset_decision:validate_local',
      } as any,
      context,
    )

    expect(keyA).not.toBe(keyB)
  })

  test('sanitizes unsafe runner filenames and appends extension', () => {
    const safe = __testOnly.buildSafeRunnerRelativePath(
      '../../tmp/../evil runner',
      'R1',
      'python',
    )
    expect(safe.includes('..')).toBe(false)
    expect(safe.includes('\\')).toBe(false)
    expect(safe.endsWith('.py')).toBe(true)
  })

  test('infers falsification status from strict JSON and textual summaries', () => {
    const strictReady = JSON.stringify({
      falsification_plan: { meta: { status: 'ready' } },
    })
    expect(__testOnly.inferFalsificationPlanStatus(strictReady)).toBe('ready')

    const textualReady = 'Status plan/match: ready / ready'
    expect(__testOnly.inferFalsificationPlanStatus(textualReady)).toBe('ready')

    const notReady = 'FalsificationPlan fue omitido por normalization_incomplete.'
    expect(__testOnly.inferFalsificationPlanStatus(notReady)).toBe('not_ready')
  })

  test('extracts definition previews from runner code', () => {
    const pyCode = `
import math

def run_experiment(alpha: float, beta: float) -> float:
    return alpha + beta
`
    expect(__testOnly.extractDefinitionPreview(pyCode, 'python')).toContain(
      'def run_experiment',
    )

    const bashCode = `
#!/usr/bin/env bash
# comment
run_case() {
  echo ok
}
`
    expect(__testOnly.extractDefinitionPreview(bashCode, 'bash')).toContain(
      'run_case()',
    )
  })

  test('formats runner execution lines with command and details', () => {
    const baseRun = {
      id: 'R1',
      relativePath: 'amawta-runners/r1.py',
      cwd: '/mnt/kairos-dev/acli/Amawta-cli',
      command: 'python3 amawta-runners/r1.py',
      status: 'success',
      exitCode: 0,
      durationMs: 1250,
      stdoutPreview: 'SIGNAL_DETECTED',
      stderrPreview: '',
    } as any

    expect(__testOnly.formatRunSummaryLine(baseRun)).toContain('Ran R1: success')
    expect(__testOnly.formatRunSummaryLine(baseRun)).toContain('1.3s')
    expect(__testOnly.formatRunCommandLine(baseRun)).toContain(
      'Cmd R1: python3 amawta-runners/r1.py',
    )
    expect(__testOnly.formatRunCwdLine(baseRun)).toContain(
      'Cwd R1: /mnt/kairos-dev/acli/Amawta-cli',
    )
    expect(__testOnly.formatRunDetailLine(baseRun)).toContain(
      'Out R1: SIGNAL_DETECTED',
    )

    const failedRun = {
      ...baseRun,
      status: 'failed',
      exitCode: 1,
      stdoutPreview: '',
      stderrPreview: 'ModuleNotFoundError: No module named scipy',
    } as any
    expect(__testOnly.formatRunDetailLine(failedRun)).toContain('Err R1:')

    const pseudoRun = {
      ...baseRun,
      command: '(pseudo)',
      stdoutPreview: '',
      reason: 'pseudo_runner',
    } as any
    expect(__testOnly.formatRunCommandLine(pseudoRun)).toBeNull()
    expect(__testOnly.formatRunDetailLine(pseudoRun)).toContain('Note R1:')
  })

  test('builds timeline lines for experiment runners output', () => {
    const output = {
      executionResults: [
        {
          id: 'R1',
          command: 'python3 amawta-runners/r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 600,
        },
        {
          id: 'R2',
          command: 'python3 amawta-runners/r2.py',
          status: 'failed',
          exitCode: 1,
          durationMs: 900,
        },
      ],
    } as any

    const compact = __testOnly.buildRunTimelineLines(output, false).join('\n')
    expect(compact).toContain('stage_start: experiment_runners')
    expect(compact).toContain('tool_start: R1')
    expect(compact).toContain('tool_end: R2 status=failed')
    expect(compact).toContain('stage_end: experiment_runners runs=2')

    const verbose = __testOnly.buildRunTimelineLines(output, true).join('\n')
    expect(verbose).toContain('cmd=python3 amawta-runners/r1.py')
  })

  test('marks tool lifecycle progress lines as persistent in UI history', () => {
    expect(
      __testOnly.shouldPersistRunnerProgressLine(
        'tool_start: R1 cmd=python3 amawta-runners/r1.py',
      ),
    ).toBe(true)
    expect(
      __testOnly.shouldPersistRunnerProgressLine(
        'tool_end: R1 status=success exit=0 duration=123ms',
      ),
    ).toBe(true)
    expect(
      __testOnly.shouldPersistRunnerProgressLine(
        'stage_start: experiment_runners',
      ),
    ).toBe(true)
    expect(
      __testOnly.shouldPersistRunnerProgressLine(
        'Preparando entorno Python (venv)...',
      ),
    ).toBe(false)
  })

  test('evaluates gates and marks REJECT_EARLY when toy fails', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'failed',
          exitCode: 1,
          durationMs: 120,
          stdoutPreview: '',
          stderrPreview: 'FAILURE: crashed',
        },
      ],
    })

    expect(gates.toy.truthAssessment).toBe('FAIL')
    expect(gates.stageDecision).toBe('REJECT_EARLY')
    expect(gates.field.shouldAdvance).toBe(false)
  })

  test('evaluates gates and marks NEEDS_FIELD when toy passes without field evidence', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
      ],
    })

    expect(gates.toy.truthAssessment).toBe('PASS')
    expect(gates.stageDecision).toBe('NEEDS_FIELD')
    expect(gates.evidenceSufficiency.status).toBe('FAIL')
  })

  test('does not hard-fail gate stack on structural parse issues while field evidence is still pending', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
      ],
      gateContext: {
        normalizationGate: {
          status: 'FAIL',
          reason: 'normalization_json no es JSON valido.',
        },
        falsificationPlanQualityGate: {
          status: 'FAIL',
          reason: 'falsification_plan_json no es JSON valido.',
        },
      },
    })

    expect(gates.stageDecision).toBe('NEEDS_FIELD')
    expect(gates.gateStack.ontology.claim_well_formed.status).toBe('UNRESOLVED')
    expect(gates.gateStack.epistemic.falsification_plan_quality.status).toBe(
      'UNRESOLVED',
    )
    expect(gates.gateStack.overall).toBe('UNRESOLVED')
  })

  test('parses explicit AMAWTA_EVIDENCE_CONTRACT from runner output', () => {
    const parsed = __testOnly.parseEvidenceContractFromText(
      [
        'some line',
        'AMAWTA_EVIDENCE_CONTRACT={"phase":"field","dataset_used":true,"dataset_source":"real","dataset_source_type":"url","dataset_format":"csv","dataset_mime_type":"text/csv","dataset_mime_valid":true,"dataset_parse_ok":true,"n_rows":64,"n_cols":5,"header_detected":true,"lobo_folds":4,"runner_contract":"PASS","truth_assessment":"PASS"}',
      ].join('\n'),
      '',
    )

    expect(parsed?.phase).toBe('field')
    expect(parsed?.dataset_used).toBe(true)
    expect(parsed?.dataset_source).toBe('real')
    expect(parsed?.dataset_source_type).toBe('url')
    expect(parsed?.dataset_format).toBe('csv')
    expect(parsed?.dataset_mime_valid).toBe(true)
    expect(parsed?.dataset_parse_ok).toBe(true)
    expect(parsed?.n_rows).toBe(64)
    expect(parsed?.n_cols).toBe(5)
    expect(parsed?.lobo_folds).toBe(4)
    expect(parsed?.runner_contract).toBe('PASS')
  })

  test('parses flexible evidence contract values from runner output', () => {
    const parsed = __testOnly.parseEvidenceContractFromText(
      [
        'AMAWTA_EVIDENCE_CONTRACT={"phase":"field","dataset_used":"palmerpenguins","dataset_source":"https://raw.githubusercontent.com/allisonhorst/palmerpenguins/master/inst/extdata/penguins.csv","dataset_source_type":"url","dataset_format":"csv","dataset_mime_valid":true,"dataset_parse_ok":true,"n_rows":333,"lobo_folds":0,"runner_contract":"PASS","truth_assessment":"SUPPORTED"}',
      ].join('\n'),
      '',
    )

    expect(parsed?.dataset_used).toBe(true)
    expect(parsed?.dataset_source).toBe('real')
    expect(parsed?.dataset_source_uri).toContain('githubusercontent.com')
    expect(parsed?.truth_assessment).toBe('PASS')
  })

  test('parses numeric-string contract fields and local source aliases', () => {
    const parsed = __testOnly.parseEvidenceContractFromText(
      [
        'AMAWTA_EVIDENCE_CONTRACT={"phase":"field","dataset_used":"true","dataset_source":"/tmp/penguins_clean.csv","dataset_source_type":"local_tabular","dataset_format":"json","dataset_mime_valid":"true","dataset_parse_ok":"true","n_rows":"333","n_cols":"8","lobo_folds":"4","runner_contract":"PASS","truth_assessment":"supported"}',
      ].join('\n'),
      '',
    )

    expect(parsed?.dataset_used).toBe(true)
    expect(parsed?.dataset_source).toBe('real')
    expect(parsed?.dataset_source_type).toBe('local')
    expect(parsed?.dataset_format).toBe('jsonl')
    expect(parsed?.dataset_mime_valid).toBe(true)
    expect(parsed?.dataset_parse_ok).toBe(true)
    expect(parsed?.n_rows).toBe(333)
    expect(parsed?.n_cols).toBe(8)
    expect(parsed?.lobo_folds).toBe(4)
    expect(parsed?.truth_assessment).toBe('PASS')
  })

  test('treats flexible field contract as real evidence for gate progression', () => {
    const flexibleContract = __testOnly.parseEvidenceContractFromText(
      [
        'AMAWTA_EVIDENCE_CONTRACT={"phase":"field","dataset_used":"palmerpenguins","dataset_source":"https://raw.githubusercontent.com/allisonhorst/palmerpenguins/master/inst/extdata/penguins.csv","dataset_source_type":"url","dataset_format":"csv","dataset_mime_valid":true,"dataset_parse_ok":true,"n_rows":333,"lobo_folds":0,"runner_contract":"PASS","truth_assessment":"SUPPORTED"}',
      ].join('\n'),
      '',
    )
    const gates = __testOnly.evaluateRunnerGates({
      plan: {
        meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
        hypothesis_snapshot: 'h',
        assumptions: [],
        runners: [
          {
            id: 'R1',
            goal: 'toy',
            test_ids: ['T1'],
            phase: 'toy',
            language: 'python',
            filename: 'r1.py',
            run_command: 'python r1.py',
            required_inputs: [],
            expected_signal: 'SIGNAL_DETECTED',
            failure_signal: 'FALSIFIED',
            code: 'print("SIGNAL_DETECTED")',
          },
          {
            id: 'R2',
            goal: 'field',
            test_ids: ['T2'],
            phase: 'field',
            language: 'python',
            filename: 'r2.py',
            run_command: 'python r2.py',
            required_inputs: [],
            expected_signal: 'FIELD_EVIDENCE_READY',
            failure_signal: 'FIELD_EVIDENCE_FAIL',
            code: 'print("FIELD_EVIDENCE_READY")',
          },
        ],
        execution_order: ['R1', 'R2'],
        next_action: 'next',
      } as any,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 100,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
        {
          id: 'R2',
          relativePath: 'amawta-runners/r2.py',
          cwd: '/tmp',
          command: 'python r2.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview:
            'FIELD_EVIDENCE_READY AMAWTA_EVIDENCE_CONTRACT={...}',
          stderrPreview: '',
          evidenceContract: flexibleContract,
        },
      ] as any,
    })

    expect(gates.evidenceSufficiency.hasRealDataset).toBe(true)
    expect(gates.evidenceSufficiency.nRows).toBe(333)
    expect(gates.evidenceSufficiency.loboFolds).toBeGreaterThanOrEqual(2)
  })

  test('evaluates gates as DEFINITIVE_PASS when evidence contract satisfies field thresholds', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
        {
          id: 'R2',
          goal: 'field',
          test_ids: ['T2'],
          phase: 'field',
          language: 'python',
          filename: 'r2.py',
          run_command: 'python r2.py',
          required_inputs: ['dataset:field.csv'],
          expected_signal: 'FIELD_EVIDENCE_READY',
          failure_signal: 'FIELD_EVIDENCE_FAIL',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1', 'R2'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: '',
          stderrPreview: '',
          evidenceContract: {
            phase: 'toy',
            truth_assessment: 'PASS',
            runner_contract: 'PASS',
          },
        },
        {
          id: 'R2',
          relativePath: 'amawta-runners/r2.py',
          cwd: '/tmp',
          command: 'python r2.py',
          status: 'success',
          exitCode: 0,
          durationMs: 240,
          stdoutPreview: '',
          stderrPreview: '',
          evidenceContract: {
            phase: 'field',
            dataset_used: true,
            dataset_source: 'real',
            dataset_source_type: 'url',
            dataset_format: 'csv',
            dataset_mime_type: 'text/csv',
            dataset_mime_valid: true,
            dataset_parse_ok: true,
            n_rows: 64,
            n_cols: 5,
            header_detected: true,
            lobo_folds: 4,
            runner_contract: 'PASS',
          },
        },
      ],
    })

    expect(gates.runnerContract.status).toBe('PASS')
    expect(gates.evidenceSufficiency.status).toBe('PASS')
    expect(gates.stageDecision).toBe('DEFINITIVE_PASS')
  })

  test('marks runner contract FAIL when stdout contains runtime error signals', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 80,
          stdoutPreview: 'Error: [Errno 2] No such file or directory',
          stderrPreview: '',
          evidenceContract: {
            phase: 'toy',
            truth_assessment: 'PASS',
            runner_contract: 'PASS',
          },
        },
      ],
    })

    expect(gates.runnerContract.status).toBe('FAIL')
    expect(gates.stageDecision).toBe('DEFINITIVE_FAIL')
  })

  test('treats concrete dataset URI as real field evidence even when dataset_source is unknown', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
        {
          id: 'R2',
          goal: 'field',
          test_ids: ['T2'],
          phase: 'field',
          language: 'python',
          filename: 'r2.py',
          run_command: 'python r2.py',
          required_inputs: ['dataset:penguins_clean.csv'],
          expected_signal: 'FIELD_EVIDENCE_READY',
          failure_signal: 'FIELD_EVIDENCE_FAIL',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1', 'R2'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: '',
          stderrPreview: '',
          evidenceContract: {
            phase: 'toy',
            truth_assessment: 'PASS',
            runner_contract: 'PASS',
          },
        },
        {
          id: 'R2',
          relativePath: 'amawta-runners/r2.py',
          cwd: '/tmp',
          command: 'python r2.py',
          status: 'success',
          exitCode: 0,
          durationMs: 240,
          stdoutPreview: 'dataset_source=penguins_clean.csv',
          stderrPreview: '',
          evidenceContract: {
            phase: 'field',
            dataset_used: true,
            dataset_source: 'unknown',
            dataset_source_type: 'local',
            dataset_source_uri: 'penguins_clean.csv',
            dataset_format: 'csv',
            dataset_mime_type: 'text/csv',
            dataset_mime_valid: true,
            dataset_parse_ok: true,
            n_rows: 333,
            n_cols: 8,
            header_detected: true,
            lobo_folds: 4,
            runner_contract: 'PASS',
          },
        },
      ],
    })

    expect(gates.evidenceSufficiency.hasRealDataset).toBe(true)
    expect(gates.evidenceSufficiency.status).toBe('PASS')
    expect(gates.stageDecision).toBe('DEFINITIVE_PASS')
  })

  test('does not mark definitive pass with synthetic-only field evidence', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
        {
          id: 'R_FIELD_AUTOREPAIR',
          goal: 'field synthetic',
          test_ids: ['AUTO_FIELD_EVIDENCE'],
          phase: 'field',
          language: 'python',
          filename: 'field_evidence_autorepair.py',
          run_command: 'python field_evidence_autorepair.py',
          required_inputs: ['dataset:synthetic_field_autorepair.csv'],
          expected_signal: 'FIELD_EVIDENCE_READY',
          failure_signal: 'FIELD_EVIDENCE_FAIL',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1', 'R_FIELD_AUTOREPAIR'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
        {
          id: 'R_FIELD_AUTOREPAIR',
          relativePath: 'amawta-runners/field_evidence_autorepair.py',
          cwd: '/tmp',
          command: 'python field_evidence_autorepair.py',
          status: 'success',
          exitCode: 0,
          durationMs: 40,
          stdoutPreview: 'FIELD_EVIDENCE_READY',
          stderrPreview: '',
          evidenceContract: {
            phase: 'field',
            dataset_used: true,
            dataset_source: 'synthetic',
            dataset_source_type: 'local',
            dataset_format: 'csv',
            dataset_mime_type: 'text/csv',
            dataset_mime_valid: true,
            dataset_parse_ok: true,
            n_rows: 64,
            n_cols: 3,
            header_detected: true,
            lobo_folds: 4,
            runner_contract: 'PASS',
            truth_assessment: 'PASS',
          },
        },
      ],
    })

    expect(gates.evidenceSufficiency.datasetUsed).toBe(true)
    expect(gates.evidenceSufficiency.hasRealDataset).toBe(false)
    expect(gates.evidenceSufficiency.status).toBe('FAIL')
    expect(gates.stageDecision).toBe('PROVISIONAL_PASS')
  })

  test('infers real field evidence from local tabular input when contract is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'amawta-local-dataset-'))
    const datasetPath = join(tempDir, 'penguins_local.csv')
    writeFileSync(
      datasetPath,
      [
        'flipper_length_mm,body_mass_g,species,sex',
        ...Array.from({ length: 64 }, (_, i) => `${180 + i},${3500 + i * 8},Adelie,male`),
      ].join('\n'),
    )

    try {
      const plan = {
        meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
        hypothesis_snapshot: 'h',
        assumptions: [],
        runners: [
          {
            id: 'R1',
            goal: 'toy',
            test_ids: ['T1'],
            phase: 'toy',
            language: 'python',
            filename: 'toy.py',
            run_command: 'python toy.py',
            required_inputs: [],
            expected_signal: 'SIGNAL_DETECTED',
            failure_signal: 'FALSIFIED',
            code: 'print("SIGNAL_DETECTED")',
          },
          {
            id: 'R2',
            goal: 'field',
            test_ids: ['T2'],
            phase: 'field',
            language: 'python',
            filename: 'field.py',
            run_command: 'python field.py',
            required_inputs: [datasetPath],
            expected_signal: 'FIELD_EVIDENCE_READY',
            failure_signal: 'FIELD_EVIDENCE_FAIL',
            code: `import pandas as pd\ndf = pd.read_csv(${JSON.stringify(datasetPath)})\nprint(len(df))`,
          },
        ],
        execution_order: ['R1', 'R2'],
        next_action: 'next',
      } as any

      const gates = __testOnly.evaluateRunnerGates({
        plan,
        executionResults: [
          {
            id: 'R1',
            relativePath: 'amawta-runners/toy.py',
            cwd: tempDir,
            command: 'python toy.py',
            status: 'success',
            exitCode: 0,
            durationMs: 50,
            stdoutPreview: 'SIGNAL_DETECTED',
            stderrPreview: '',
          },
          {
            id: 'R2',
            relativePath: 'amawta-runners/field.py',
            cwd: tempDir,
            command: 'python field.py',
            status: 'success',
            exitCode: 0,
            durationMs: 70,
            stdoutPreview: 'rows=64',
            stderrPreview: '',
          },
        ],
      })

      expect(gates.evidenceSufficiency.datasetUsed).toBe(true)
      expect(gates.evidenceSufficiency.hasRealDataset).toBe(true)
      expect(gates.evidenceSufficiency.nRows).toBe(64)
      expect(gates.evidenceSufficiency.loboFolds).toBe(4)
      expect(gates.stageDecision).toBe('DEFINITIVE_PASS')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('infers real field evidence from known external dataset loaders when rows are sufficient', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'toy.py',
          run_command: 'python toy.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("SIGNAL_DETECTED")',
        },
        {
          id: 'R2',
          goal: 'field',
          test_ids: ['T2'],
          phase: 'field',
          language: 'python',
          filename: 'field.py',
          run_command: 'python field.py',
          required_inputs: [],
          expected_signal: 'FIELD_EVIDENCE_READY',
          failure_signal: 'FIELD_EVIDENCE_FAIL',
          code: `import seaborn as sns\ndf = sns.load_dataset("penguins").dropna()\nprint(f"rows={len(df)}")`,
        },
      ],
      execution_order: ['R1', 'R2'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/toy.py',
          cwd: process.cwd(),
          command: 'python toy.py',
          status: 'success',
          exitCode: 0,
          durationMs: 50,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
        {
          id: 'R2',
          relativePath: 'amawta-runners/field.py',
          cwd: process.cwd(),
          command: 'python field.py',
          status: 'success',
          exitCode: 0,
          durationMs: 70,
          stdoutPreview: 'rows=333',
          stderrPreview: '',
        },
      ],
    })

    expect(gates.evidenceSufficiency.datasetUsed).toBe(true)
    expect(gates.evidenceSufficiency.hasRealDataset).toBe(true)
    expect(gates.evidenceSufficiency.nRows).toBe(333)
    expect(gates.evidenceSufficiency.loboFolds).toBe(4)
    expect(gates.stageDecision).toBe('DEFINITIVE_PASS')
  })

  test('does not infer real field evidence from synthetic local dataset names without contract', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'amawta-synth-dataset-'))
    const datasetPath = join(tempDir, 'synthetic_field_sample.csv')
    writeFileSync(
      datasetPath,
      [
        'curvature,effort',
        ...Array.from({ length: 64 }, (_, i) => `${(i + 1) / 10},${100 - i}`),
      ].join('\n'),
    )

    try {
      const plan = {
        meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
        hypothesis_snapshot: 'h',
        assumptions: [],
        runners: [
          {
            id: 'R1',
            goal: 'toy',
            test_ids: ['T1'],
            phase: 'toy',
            language: 'python',
            filename: 'toy.py',
            run_command: 'python toy.py',
            required_inputs: [],
            expected_signal: 'SIGNAL_DETECTED',
            failure_signal: 'FALSIFIED',
            code: 'print("SIGNAL_DETECTED")',
          },
          {
            id: 'R2',
            goal: 'field synthetic',
            test_ids: ['T2'],
            phase: 'field',
            language: 'python',
            filename: 'field.py',
            run_command: 'python field.py',
            required_inputs: [datasetPath],
            expected_signal: 'FIELD_EVIDENCE_READY',
            failure_signal: 'FIELD_EVIDENCE_FAIL',
            code: `print(${JSON.stringify(datasetPath)})`,
          },
        ],
        execution_order: ['R1', 'R2'],
        next_action: 'next',
      } as any

      const gates = __testOnly.evaluateRunnerGates({
        plan,
        executionResults: [
          {
            id: 'R1',
            relativePath: 'amawta-runners/toy.py',
            cwd: tempDir,
            command: 'python toy.py',
            status: 'success',
            exitCode: 0,
            durationMs: 50,
            stdoutPreview: 'SIGNAL_DETECTED',
            stderrPreview: '',
          },
          {
            id: 'R2',
            relativePath: 'amawta-runners/field.py',
            cwd: tempDir,
            command: 'python field.py',
            status: 'success',
            exitCode: 0,
            durationMs: 70,
            stdoutPreview: 'rows=64',
            stderrPreview: '',
          },
        ],
      })

      expect(gates.evidenceSufficiency.datasetUsed).toBe(true)
      expect(gates.evidenceSufficiency.hasRealDataset).toBe(false)
      expect(gates.stageDecision).toBe('NEEDS_FIELD')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('infers real field evidence from remote csv url without explicit contract', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'toy.py',
          run_command: 'python toy.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("SIGNAL_DETECTED")',
        },
        {
          id: 'R2',
          goal: 'field',
          test_ids: ['T2'],
          phase: 'field',
          language: 'python',
          filename: 'field.py',
          run_command: 'python field.py',
          required_inputs: [],
          expected_signal: 'FIELD_EVIDENCE_READY',
          failure_signal: 'FIELD_EVIDENCE_FAIL',
          code: [
            'import pandas as pd',
            "url = 'https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv'",
            'df = pd.read_csv(url)',
            "print(f'No. Observations: {len(df)}')",
          ].join('\n'),
        },
      ],
      execution_order: ['R1', 'R2'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/toy.py',
          cwd: '/tmp',
          command: 'python toy.py',
          status: 'success',
          exitCode: 0,
          durationMs: 50,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
        {
          id: 'R2',
          relativePath: 'amawta-runners/field.py',
          cwd: '/tmp',
          command: 'python field.py',
          status: 'success',
          exitCode: 0,
          durationMs: 70,
          stdoutPreview: 'No. Observations: 333',
          stderrPreview: '',
        },
      ],
    })

    expect(gates.evidenceSufficiency.datasetUsed).toBe(true)
    expect(gates.evidenceSufficiency.hasRealDataset).toBe(true)
    expect(gates.evidenceSufficiency.nRows).toBe(333)
    expect(gates.evidenceSufficiency.loboFolds).toBe(4)
    expect(gates.stageDecision).toBe('DEFINITIVE_PASS')
  })

  test('builds an auto field runner when plan has no field phase', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'ok',
          failure_signal: 'fail',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    expect(__testOnly.hasFieldPhaseRunner(plan)).toBe(false)
    const auto = __testOnly.buildAutoFieldRunner(plan)
    expect(auto.phase).toBe('field')
    expect(auto.filename).toContain('field_evidence_autorepair.py')
    expect(auto.code).toContain('AMAWTA_EVIDENCE_CONTRACT=')
  })

  test('treats FALSIFIED signal as critical FAIL verdict', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: 'STATUS: FALSIFIED - Pendiente no negativa',
          stderrPreview: '',
        },
      ],
    })
    const critical = __testOnly.buildCriticalRunnerVerdictSummary({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: 'STATUS: FALSIFIED - Pendiente no negativa',
          stderrPreview: '',
        },
      ],
    })

    expect(gates.toy.truthAssessment).toBe('FAIL')
    expect(gates.stageDecision).toBe('REJECT_EARLY')
    expect(critical.overall).toBe('FAIL')
  })

  test('does not treat negated falsified markers as fail', () => {
    const signals = __testOnly.detectRunSignals('Falsado por T1/T2: False')
    expect(signals.hasPass).toBe(false)
    expect(signals.hasFail).toBe(false)

    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'next',
    } as any

    const executionResults = [
      {
        id: 'R1',
        relativePath: 'amawta-runners/r1.py',
        cwd: '/tmp',
        command: 'python r1.py',
        status: 'success' as const,
        exitCode: 0,
        durationMs: 120,
        stdoutPreview: 'Falsado por T1/T2: False',
        stderrPreview: '',
      },
    ]

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults,
    })
    const critical = __testOnly.buildCriticalRunnerVerdictSummary({
      plan,
      executionResults,
    })

    expect(gates.stageDecision).toBe('NEEDS_FIELD')
    expect(critical.overall).toBe('INCONCLUSIVE')
  })

  test('extracts dataset candidates from runners and falsification data_requests', () => {
    const plan = {
      runners: [
        {
          id: 'R1',
          required_inputs: [
            'dataset:https://example.org/data.csv',
            'relative/path/local.csv',
          ],
          goal: 'usar dataset sleep_health_and_lifestyle.csv',
          run_command: 'python r1.py',
          code: `
import pandas as pd
url = "https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv"
df = pd.read_csv(url)
df2 = pd.read_csv("datasets/local_field.csv")
`,
        },
      ],
    } as any
    const falsificationRaw = JSON.stringify({
      falsification_plan: {
        data_requests: [
          'https://example.com/another.csv',
          '/tmp/external_dataset.csv',
          'nota sin dataset',
        ],
      },
    })

    const candidates = __testOnly.extractDatasetCandidatesFromPlan({
      plan,
      falsificationRaw,
    })

    expect(candidates).toContain('https://example.org/data.csv')
    expect(candidates).toContain('relative/path/local.csv')
    expect(candidates).toContain('https://example.com/another.csv')
    expect(candidates).toContain('/tmp/external_dataset.csv')
    expect(candidates).toContain(
      'https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv',
    )
    expect(candidates).toContain('datasets/local_field.csv')
  })

  test('extracts structured dataset candidates without scanning runner code', () => {
    const plan = {
      runners: [
        {
          id: 'R1',
          required_inputs: [
            'dataset:https://example.org/data.csv',
            'relative/path/local.csv',
          ],
          code: `
import pandas as pd
df = pd.read_csv("https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv")
`,
        },
      ],
    } as any
    const falsificationRaw = JSON.stringify({
      falsification_plan: {
        data_requests: ['https://example.com/another.csv'],
      },
    })

    const structured = __testOnly.extractStructuredDatasetCandidatesFromPlan({
      plan,
      falsificationRaw,
      datasetHint: 'dataset:penguins_clean.csv',
    })

    expect(structured).toContain('https://example.org/data.csv')
    expect(structured).toContain('relative/path/local.csv')
    expect(structured).toContain('https://example.com/another.csv')
    expect(structured).toContain('penguins_clean.csv')
    expect(
      structured.some((item: string) =>
        item.includes(
          'raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv',
        ),
      ),
    ).toBe(false)
  })

  test('includes dataset_hint as dataset candidate', () => {
    const plan = {
      runners: [],
    } as any
    const candidates = __testOnly.extractDatasetCandidatesFromPlan({
      plan,
      datasetHint: 'penguins_clean.csv',
    })
    expect(candidates).toContain('penguins_clean.csv')
  })

  test('builds dataset field runner with evidence contract output', () => {
    const plan = {
      runners: [{ id: 'R1' }],
    } as any
    const runner = __testOnly.buildDatasetFieldRunner({
      plan,
      dataset: {
        source: 'https://example.org/data.csv',
        sourceType: 'url',
        format: 'csv',
        mimeType: 'text/csv',
        mimeValid: true,
        parseOk: true,
        nCols: 5,
        headerDetected: true,
        checksumSha256: 'abc123',
        localRelativePath: 'amawta-runners/datasets/data.csv',
        nRows: 64,
        downloaded: true,
      },
    })

    expect(runner.id).toMatch(/^R_FIELD_DATASET/)
    expect(runner.phase).toBe('field')
    expect(runner.required_inputs).toContain('amawta-runners/datasets/data.csv')
    expect(runner.code).toContain('AMAWTA_EVIDENCE_CONTRACT=')
    expect(runner.code).toContain('DATASET_MIME_VALID = True')
    expect(runner.code).toContain('DATASET_PARSE_OK = True')
  })

  test('blocks disallowed dataset urls such as arxiv abs/pdf pages', () => {
    expect(__testOnly.isDisallowedDatasetUrl('https://arxiv.org/abs/hep-th/0101228')).toBe(
      true,
    )
    expect(__testOnly.isDisallowedDatasetUrl('https://arxiv.org/pdf/1201.3345.pdf')).toBe(
      true,
    )
    expect(__testOnly.isDisallowedDatasetUrl('https://example.org/data.csv')).toBe(
      false,
    )
  })

  test('extracts csv dataset from html table pages', () => {
    const html = `
<!doctype html>
<html>
  <body>
    <h1>Paper</h1>
    <table>
      <tr><th>curvature</th><th>effort</th></tr>
      <tr><td>0.1</td><td>10.2</td></tr>
      <tr><td>0.2</td><td>9.8</td></tr>
      <tr><td>0.3</td><td>9.1</td></tr>
    </table>
  </body>
</html>
`
    const extracted = __testOnly.extractDatasetCsvFromHtml(html)
    expect(extracted).not.toBeNull()
    expect(extracted?.nRows).toBe(3)
    expect(extracted?.nCols).toBe(2)
    expect(extracted?.numericRatio).toBeGreaterThan(0.5)
    expect(extracted?.metadataLike).toBe(false)
    expect(extracted?.csvText).toContain('curvature,effort')
    expect(extracted?.csvText).toContain('0.2,9.8')
  })

  test('does not extract dataset from html pages without tables', () => {
    const html = `
<!doctype html>
<html>
  <body>
    <h1>Abstract</h1>
    <p>This paper studies non-commutative geometry and gauge curvature.</p>
  </body>
</html>
`
    const extracted = __testOnly.extractDatasetCsvFromHtml(html)
    expect(extracted).toBeNull()
  })

  test('rejects paper metadata-like tables as field datasets', () => {
    const html = `
<!doctype html>
<html>
  <body>
    <table>
      <tr><td>Comments:</td><td>18 pages, revised version</td></tr>
      <tr><td>Subjects:</td><td>High Energy Physics - Theory</td></tr>
      <tr><td>Report number:</td><td>IC/2001/4</td></tr>
      <tr><td>Journal reference:</td><td>Phys.Rev. D63 (2001) 125011</td></tr>
    </table>
  </body>
</html>
`
    const extracted = __testOnly.extractDatasetCsvFromHtml(html)
    expect(extracted).not.toBeNull()
    expect(extracted?.metadataLike).toBe(true)
    expect(__testOnly.isLikelyFieldDatasetExtraction(extracted!)).toBe(false)
  })

  test('accepts sufficiently large numeric html tables as field datasets', () => {
    const rows = Array.from({ length: 35 }, (_, index) => {
      const curvature = (index + 1) / 10
      const effort = 100 / (1 + curvature)
      return `<tr><td>${curvature.toFixed(2)}</td><td>${effort.toFixed(3)}</td></tr>`
    }).join('\n')
    const html = `
<!doctype html>
<html>
  <body>
    <table>
      <tr><th>curvature</th><th>effort</th></tr>
      ${rows}
    </table>
  </body>
</html>
`
    const extracted = __testOnly.extractDatasetCsvFromHtml(html)
    expect(extracted).not.toBeNull()
    expect(extracted?.nRows).toBe(35)
    expect(extracted?.numericRatio).toBeGreaterThan(0.8)
    expect(__testOnly.isLikelyFieldDatasetExtraction(extracted!)).toBe(true)
  })

  test('rejects malformed extraction payloads for field dataset gate', () => {
    expect(
      __testOnly.isLikelyFieldDatasetExtraction({
        csvText: 'a,b\n1,2',
        nRows: Number.NaN as any,
        nCols: 2,
        headerDetected: true,
        numericRatio: 0.5,
        metadataLike: false,
      } as any),
    ).toBe(false)
  })

  test('does not mark definitive pass if real dataset lacks parse/mime validation', () => {
    const plan = {
      meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
      hypothesis_snapshot: 'h',
      assumptions: [],
      runners: [
        {
          id: 'R1',
          goal: 'toy',
          test_ids: ['T1'],
          phase: 'toy',
          language: 'python',
          filename: 'r1.py',
          run_command: 'python r1.py',
          required_inputs: [],
          expected_signal: 'SIGNAL_DETECTED',
          failure_signal: 'FALSIFIED',
          code: 'print("ok")',
        },
        {
          id: 'R2',
          goal: 'field',
          test_ids: ['T2'],
          phase: 'field',
          language: 'python',
          filename: 'r2.py',
          run_command: 'python r2.py',
          required_inputs: ['dataset:data.csv'],
          expected_signal: 'FIELD_EVIDENCE_READY',
          failure_signal: 'FIELD_EVIDENCE_FAIL',
          code: 'print("ok")',
        },
      ],
      execution_order: ['R1', 'R2'],
      next_action: 'next',
    } as any

    const gates = __testOnly.evaluateRunnerGates({
      plan,
      executionResults: [
        {
          id: 'R1',
          relativePath: 'amawta-runners/r1.py',
          cwd: '/tmp',
          command: 'python r1.py',
          status: 'success',
          exitCode: 0,
          durationMs: 100,
          stdoutPreview: 'SIGNAL_DETECTED',
          stderrPreview: '',
        },
        {
          id: 'R2',
          relativePath: 'amawta-runners/r2.py',
          cwd: '/tmp',
          command: 'python r2.py',
          status: 'success',
          exitCode: 0,
          durationMs: 120,
          stdoutPreview: 'FIELD_EVIDENCE_READY',
          stderrPreview: '',
          evidenceContract: {
            phase: 'field',
            dataset_used: true,
            dataset_source: 'real',
            dataset_source_type: 'url',
            dataset_format: 'csv',
            dataset_mime_valid: false,
            dataset_parse_ok: false,
            n_rows: 120,
            lobo_folds: 4,
            runner_contract: 'PASS',
            truth_assessment: 'PASS',
          },
        },
      ],
    })

    expect(gates.evidenceSufficiency.status).toBe('FAIL')
    expect(gates.stageDecision).toBe('NEEDS_FIELD')
  })

  test('does not reuse cache for non-definitive or critical-fail outcomes', () => {
    expect(
      __testOnly.shouldReuseExperimentRunnersCachedOutput({
        gates: { stageDecision: 'REJECT_EARLY' },
        criticalVerdicts: { overall: 'FAIL' },
      } as any),
    ).toBe(false)
    expect(
      __testOnly.shouldReuseExperimentRunnersCachedOutput({
        gates: { stageDecision: 'DEFINITIVE_FAIL' },
        criticalVerdicts: { overall: 'INCONCLUSIVE' },
      } as any),
    ).toBe(false)
    expect(
      __testOnly.shouldReuseExperimentRunnersCachedOutput({
        gates: { stageDecision: 'NEEDS_FIELD' },
        criticalVerdicts: { overall: 'PASS' },
      } as any),
    ).toBe(false)
    expect(
      __testOnly.shouldReuseExperimentRunnersCachedOutput({
        gates: { stageDecision: 'PROVISIONAL_PASS' },
        criticalVerdicts: { overall: 'PASS' },
      } as any),
    ).toBe(false)
    expect(
      __testOnly.shouldReuseExperimentRunnersCachedOutput({
        gates: { stageDecision: 'DEFINITIVE_PASS' },
        criticalVerdicts: { overall: 'FAIL' },
      } as any),
    ).toBe(false)
    expect(
      __testOnly.shouldReuseExperimentRunnersCachedOutput({
        gates: { stageDecision: 'DEFINITIVE_PASS' },
        criticalVerdicts: { overall: 'PASS' },
      } as any),
    ).toBe(true)
  })

  test('reuses turn-scoped executed outputs to avoid degradation loops', () => {
    expect(
      __testOnly.shouldReuseTurnScopedExecutionOutput({
        executionResults: [{ id: 'R1', status: 'success' }],
        gates: { stageDecision: 'PROVISIONAL_PASS' },
      } as any),
    ).toBe(true)
    expect(
      __testOnly.shouldReuseTurnScopedExecutionOutput({
        executionResults: [{ id: 'R1', status: 'success' }],
        gates: { stageDecision: 'NEEDS_FIELD' },
      } as any),
    ).toBe(true)
    expect(
      __testOnly.shouldReuseTurnScopedExecutionOutput({
        executionResults: [{ id: 'R1', status: 'success' }],
        gates: { stageDecision: 'REJECT_EARLY' },
      } as any),
    ).toBe(false)
  })

  test('assistant summary requests AskUserQuestion when NEEDS_FIELD has no real dataset', () => {
    const output = {
      analysis: 'ok',
      retriesUsed: 0,
      model: 'gemini',
      planStatus: 'ready',
      runnersCount: 1,
      executionOrder: ['R1'],
      nextAction: 'next',
      hypothesisSnapshot: 'h',
      runnersDir: 'amawta-runners',
      materializedFiles: [],
      materializedDiffs: [],
      executionResults: [],
      installedDependencies: [],
      definitionPreviews: [],
      gates: {
        toy: {
          status: 'success',
          truthAssessment: 'PASS',
          passTests: 1,
          failTests: 0,
          logicalContradiction: false,
        },
        field: {
          shouldAdvance: true,
          reason: 'field',
        },
        runnerContract: {
          status: 'PASS',
          reason: 'ok',
        },
        evidenceSufficiency: {
          status: 'FAIL',
          datasetUsed: false,
          hasRealDataset: false,
          nRows: 0,
          loboFolds: 0,
        },
        stageDecision: 'NEEDS_FIELD',
        stageReason: 'missing real dataset',
        nextAction: 'ask user',
      },
      criticalVerdicts: { overall: 'INCONCLUSIVE', items: [] },
      plan: {
        experiment_runners: {
          meta: { plan_version: 'experiment-runners-v1', status: 'ready' },
          hypothesis_snapshot: 'h',
          assumptions: [],
          runners: [],
          execution_order: [],
          next_action: 'next',
        },
      },
    } as any

    const summary = __testOnly.renderResultForAssistant(output)
    expect(summary).toContain('AskUserQuestion')
    expect(summary).toContain('No usable real dataset for field')
  })

  test('discovers local dataset candidates matching hypothesis keywords', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'amawta-runners-ds-'))
    try {
      writeFileSync(
        join(sandbox, 'penguins_clean.csv'),
        'species,flipper_length_mm,body_mass_g\nAdelie,181,3750\n',
        'utf8',
      )
      writeFileSync(join(sandbox, 'notes.txt'), 'ignore me', 'utf8')

      const candidates = __testOnly.discoverLocalDatasetCandidates({
        cwd: sandbox,
        hypothesisQuery:
          'En Palmer Penguins, controlando por especie y sexo, mayor flipper_length_mm implica mayor body_mass_g.',
      })
      expect(candidates).toContain('penguins_clean.csv')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('discovers local dataset candidates recursively', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'amawta-runners-ds-rec-'))
    try {
      const nested = join(sandbox, 'datasets', 'palmer')
      mkdirSync(nested, { recursive: true })
      writeFileSync(
        join(nested, 'penguins_field.csv'),
        'species,sex,flipper_length_mm,body_mass_g\nAdelie,male,181,3750\n',
        'utf8',
      )

      const candidates = __testOnly.discoverLocalDatasetCandidates({
        cwd: sandbox,
        hypothesisQuery:
          'En Palmer Penguins, controlando por especie y sexo, mayor flipper_length_mm implica mayor body_mass_g.',
      })
      expect(candidates).toContain('datasets/palmer/penguins_field.csv')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('discovers local dataset candidates from header-observable matches even when filename is generic', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'amawta-runners-ds-header-'))
    try {
      writeFileSync(
        join(sandbox, 'resultados_tradeoff_local.csv'),
        [
          'ratio_costo_fisico,K_curvatura,u_accion_fisica,theta_perceptual',
          '0.2,0.10,0.88,0.19',
        ].join('\n'),
        'utf8',
      )

      const candidates = __testOnly.discoverLocalDatasetCandidates({
        cwd: sandbox,
        hypothesisQuery:
          'Bajo un funcional convexo con costos explicitos (alpha percepcion, beta fisico), el optimo reparte la correccion entre theta y u; pendiente esfuerzo-curvatura en el gauge.',
      })
      expect(candidates).toContain('resultados_tradeoff_local.csv')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('filters out unrelated local datasets when hypothesis keywords do not match', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'amawta-runners-ds-unrelated-'))
    try {
      writeFileSync(
        join(sandbox, 'penguins_clean.csv'),
        'species,flipper_length_mm,body_mass_g\nAdelie,181,3750\n',
        'utf8',
      )
      const candidates = __testOnly.discoverLocalDatasetCandidates({
        cwd: sandbox,
        hypothesisQuery:
          'Bajo un funcional convexo con costos explicitos, el optimo reparte correccion entre theta y u.',
      })
      expect(candidates).not.toContain('penguins_clean.csv')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('extracts direct and github-blob dataset URLs from web search hits', () => {
    const urls = __testOnly.extractDatasetUrlsFromSearchResults([
      {
        title: 'Palmer Penguins CSV',
        snippet: 'Dataset in csv format',
        link: 'https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv',
      },
      {
        title: 'CSV in github blob',
        snippet: 'Use this source',
        link: 'https://github.com/allisonhorst/palmerpenguins/blob/main/inst/extdata/penguins.csv',
      },
      {
        title: 'Generic page',
        snippet: 'https://example.org/docs/page.html',
        link: 'https://example.org/docs/page.html',
      },
    ])

    expect(urls).toContain(
      'https://raw.githubusercontent.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv',
    )
    expect(urls.some((value: string) => value.includes('page.html'))).toBe(false)
  })

  test('builds literature affinity queries from hypothesis and semantic profile', () => {
    const queries = __testOnly.buildLiteratureAffinityQueries({
      hypothesisQuery:
        'Under a convex functional with perceptual and physical costs, optimal control balances gauge curvature and effort.',
      semanticProfile: {
        tokens: ['convex', 'functional', 'gauge', 'curvature', 'effort'],
        minMatches: 2,
      },
    } as any)

    expect(queries.length).toBeGreaterThan(0)
    expect(queries.some((query: string) => query.includes('related work'))).toBe(
      true,
    )
    expect(queries.join(' ')).toContain('gauge')
  })

  test('extracts keyword hints from literature search snippets', () => {
    const hints = __testOnly.extractKeywordHintsFromSearchResults([
      {
        title: 'Gauge Curvature in Astrophysical Plasma',
        snippet:
          'Observational study on curvature and energetic effort under constrained control.',
        link: 'https://example.org/paper',
      },
      {
        title: 'Plasma Control Benchmark',
        snippet:
          'Benchmark dataset for magnetic curvature and control effort trajectories.',
        link: 'https://example.org/benchmark',
      },
    ] as any)

    expect(hints.length).toBeGreaterThan(0)
    expect(hints).toContain('curvature')
    expect(hints).toContain('plasma')
  })

  test('adds literature keyword hints to dataset web discovery queries', () => {
    const queries = __testOnly.buildDatasetWebDiscoveryQueries({
      hypothesisQuery:
        'Control effort and gauge curvature trade-off in constrained systems',
      keywordHints: ['astrophysics', 'plasma', 'spectral'],
    } as any)

    expect(queries.length).toBeGreaterThan(0)
    expect(
      queries.some((query: string) => query.includes('astrophysics')),
    ).toBe(true)
  })
})
