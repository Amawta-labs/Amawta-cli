import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { configureSessionPlugins } from '@services/pluginRuntime'
import { getSystemPrompt } from '@constants/prompts'
import { __resetAmawtaHooksCacheForTests } from '@utils/session/sessionHooks'
import { __resetSessionPluginsForTests } from '@utils/session/sessionPlugins'
import { setCwd } from '@utils/state'
import { setAmawtaAgentSessionId } from '@utils/protocol/agentSessionId'

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

describe('Plugin hooks: SessionStart injects additionalContext into system prompt', () => {
  const runnerCwd = process.cwd()
  const originalEnvValue = process.env.AMAWTA_TEST_ENV

  let projectDir: string
  let pluginDir: string

  beforeEach(async () => {
    __resetAmawtaHooksCacheForTests()
    __resetSessionPluginsForTests()
    setAmawtaAgentSessionId('11111111-1111-1111-1111-111111111111')

    projectDir = mkdtempSync(join(tmpdir(), 'amawta-plugin-sessionstart-'))
    await setCwd(projectDir)

    pluginDir = join(projectDir, 'explanatory-output-style')
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        { name: 'explanatory-output-style', version: '1.0.0' },
        null,
        2,
      ) + '\n',
      'utf8',
    )

    const handlerPath = join(pluginDir, 'session-start.js')
    writeFileSync(
      handlerPath,
      `
import { appendFileSync } from 'fs';
const envFile = process.env.CLAUDE_ENV_FILE;
if (envFile) appendFileSync(envFile, 'export AMAWTA_TEST_ENV=hello\\n', 'utf8');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'SESSION_START_CONTEXT' } }));
`,
      'utf8',
    )

    writeJson(join(pluginDir, 'hooks', 'hooks.json'), {
      description: 'session start demo',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun \"${CLAUDE_PLUGIN_ROOT}/session-start.js\"',
              },
            ],
          },
        ],
      },
    })

    await configureSessionPlugins({ pluginDirs: [pluginDir] })
  })

  afterEach(async () => {
    if (originalEnvValue === undefined) delete process.env.AMAWTA_TEST_ENV
    else process.env.AMAWTA_TEST_ENV = originalEnvValue
    __resetAmawtaHooksCacheForTests()
    __resetSessionPluginsForTests()
    await setCwd(runnerCwd)
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('appends hook additionalContext and applies env file exports', async () => {
    const promptParts = await getSystemPrompt()
    const combined = promptParts.join('\n')
    expect(combined).toContain('SESSION_START_CONTEXT')
    expect(process.env.AMAWTA_TEST_ENV).toBe('hello')
  })
})
