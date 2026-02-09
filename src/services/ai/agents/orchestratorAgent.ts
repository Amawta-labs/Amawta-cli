import { queryAdkDialecticalOrchestrator } from '@services/ai/adkOrchestrator'

export type OrchestratorAgentInput = Parameters<
  typeof queryAdkDialecticalOrchestrator
>[0]

export async function runOrchestratorAgent(params: OrchestratorAgentInput) {
  return queryAdkDialecticalOrchestrator(params)
}
