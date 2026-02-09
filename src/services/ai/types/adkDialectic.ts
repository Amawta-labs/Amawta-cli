export interface DialecticResult {
  summary: string
  hypothesis: string
  antithesis: string
  synthesis: string
  confidence?: 'low' | 'medium' | 'high'
}

export interface BaconianResult {
  summary: string
  idols: {
    tribe: string
    cave: string
    market: string
    theater: string
  }
  clearing: {
    tribe: string
    cave: string
    market: string
    theater: string
  }
  truth_tables: {
    presence: string
    absence: string
    degrees: string
  }
  forma_veritas: string
  confidence?: 'low' | 'medium' | 'high'
}

export interface LiteratureDiscoveryResult {
  summary: string
  novelty_assessment:
    | 'likely_novel'
    | 'partial_overlap'
    | 'well_established'
    | 'insufficient_evidence'
  confidence?: 'low' | 'medium' | 'high'
  search_queries: string[]
  findings: Array<{
    title: string
    url: string
    evidence_type:
      | 'paper'
      | 'preprint'
      | 'survey'
      | 'technical_report'
      | 'repository'
      | 'other'
    relation_to_claim: string
  }>
  overlap_signals: string[]
  novelty_signals: string[]
  gaps: string[]
  recommended_next_steps: string[]
}

export interface HypothesisNormalizationResult {
  meta: {
    normalization_version: 'normalization-v1'
    mode: 'strict' | 'autocorrect'
  }
  hypothesis_normalization: {
    claim: string
    domain: string
    entities: string[]
    relation: string
    observables: string[]
    expected_direction: string
    conditions: string
    time_scope: string
    notes: string
    missing_fields: string[]
    clarification_required: boolean
    clarification_questions: string[]
    clarification_plan?: {
      required_fields?: string[]
      questions?: string[]
      proxy_observables?: string[]
      proxy_time_scope?: string
      proxy_conditions?: string
      weakened_claim?: string
      experiment_design_min?: string
    }
  }
}

export interface FalsificationPlanResult {
  falsification_plan: {
    meta: {
      plan_version: 'falsification-plan-v1'
      status: 'ready' | 'skipped'
      reason?: string
    }
    normalized_claim: {
      claim: string
      domain: string
      entities: string[] | string
      relation: string
      observables: string[] | string
      expected_direction: string
      conditions: string[] | string
      time_scope: string
    }
    tests: Array<{
      id: string
      goal: string
      method: string
      minimal_data: string
      procedure: string
      what_would_falsify: string
      confounds: string
      falsifier_kind?:
        | 'mechanism'
        | 'confound'
        | 'boundary'
        | 'invariance'
        | 'intervention'
        | 'measurement'
        | 'alternative'
        | 'robustness'
        | 'counterexample'
      phase?: 'toy' | 'field' | 'both'
      priority?: number
    }>
    test_matrix: {
      axes: Array<{
        axis: string
        rationale: string
        parameters: string[] | Record<string, unknown> | string
      }>
      variants: Array<{
        id: string
        axis_values: Record<string, unknown>
        applies_to_tests: string[]
        rationale: string
      }>
    }
    data_requests: string[]
  }
  invariants_match: {
    meta: {
      match_version: 'invariants-match-v1'
      status: 'ready' | 'skipped'
      reason: string
      catalog_sha256?: string
    }
    matches: Array<{
      invariant_name: string
      gate_id: string
      match_strength: 'strong' | 'moderate' | 'weak'
      why: string
      evidence_profile: {
        needs_gauge: boolean
        needs_nulls: boolean
        needs_bootstrap: boolean
        needs_intervention: boolean
      }
      dataset_hints: string[]
      runner_implications: string[]
    }>
    overall: {
      match_strength: 'none' | 'weak' | 'moderate' | 'strong'
      notes: string
      next_action: string
    }
  }
}

export interface ExperimentRunnersResult {
  experiment_runners: {
    meta: {
      plan_version: 'experiment-runners-v1'
      status: 'ready' | 'skipped'
      reason?: string
    }
    hypothesis_snapshot: string
    assumptions: string[]
    runners: Array<{
      id: string
      goal: string
      test_ids: string[]
      phase: 'toy' | 'field' | 'both'
      language: 'python' | 'bash' | 'pseudo'
      filename: string
      run_command: string
      required_inputs: string[]
      expected_signal: string
      failure_signal: string
      code: string
    }>
    execution_order: string[]
    next_action: string
  }
}

export type OrchestratorRoute = 'dialectic' | 'default'

export interface AdkOrchestratorResult {
  handled: boolean
  route: OrchestratorRoute
  text: string
  dialectic?: DialecticResult
  baconian?: BaconianResult
  retriesUsed: number
}
