# Amawta CLI

Amawta CLI is a terminal-first multi-agent coding assistant built for the Gemini 3 Hackathon.

It runs an orchestrator agent plus specialized subagents (Dialectical, Baconian, Literature Discovery, Normalization, Falsification, and Experiment Runners) to execute an end-to-end reasoning and testing workflow.

## Repository

- GitHub: https://github.com/Amawta-labs/Amawta-cli
- Package: https://www.npmjs.com/package/amawta-cli
- License: Apache-2.0

## What It Does

- Orchestrates a multi-agent workflow from claim to tests
- Uses structured outputs for contract-based agent handoffs
- Generates and executes runner scripts (`amawta-runners/*.py`)
- Produces gates and evidence contracts (`toy`, `field`, `lobo`, `bic`, etc.)
- Supports interactive decisions when missing field data is detected

## Model Setup

This build is configured for Gemini 3 models only:

- `gemini-3-flash-preview`
- `gemini-3-pro-preview`

For demo/judging usage, the project can auto-load a local demo key file:

- `.amawta-demo-key` in repository root

If present, the CLI can bootstrap default model pointers (`main`, `task`, `quick`, `compact`) without manual onboarding.

## Quick Start

```bash
# from repository root
node cli.js
```

Recommended: run inside a project/workspace directory instead of `$HOME`.

## Common Commands

- `/help` - show command list
- `/model` - inspect/adjust model profiles and pointers
- `/mcp` - inspect MCP integrations
- `/init` - initialize project instruction file
- `/agents` - inspect/manage agent definitions

## Local Development

```bash
# install dependencies
bun install

# build runtime
bun run scripts/build.mjs

# run CLI
node cli.js
```

## Project Structure

- `src/app/` - CLI flow and orchestration
- `src/services/ai/` - agent prompts, schemas, execution
- `src/tools/ai/` - AI tools (falsification, runners, etc.)
- `amawta-runners/` - generated/maintained Python runners
- `docs/` - documentation

## Notes for Evaluation

- The orchestrator decides next actions from structured subagent outputs.
- Runner generation and execution are contract-driven.
- If no real dataset is resolved, the system can continue in provisional synthetic mode.

## Contributing

See `CONTRIBUTING.md`.
