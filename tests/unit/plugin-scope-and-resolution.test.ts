import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCwd } from '@utils/state'
import {
  addMarketplace,
  disableSkillPlugin,
  enableSkillPlugin,
  installSkillPlugin,
  listInstalledSkillPlugins,
} from '@services/skillMarketplace'

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(updates)) {
    previous[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function writeMarketplaceRepo(repoDir: string, marketplaceName: string): void {
  mkdirSync(join(repoDir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(repoDir, 'skills', 'pdf'), { recursive: true })
  mkdirSync(join(repoDir, 'skills', 'xlsx'), { recursive: true })

  writeFileSync(
    join(repoDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: marketplaceName,
        owner: { name: 'Test', email: 'test@example.com' },
        metadata: { description: 'Test marketplace', version: '1.0.0' },
        plugins: [
          {
            name: 'document-skills',
            description: 'Doc skills pack',
            source: './',
            strict: false,
            skills: ['./skills/xlsx', './skills/pdf'],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )

  for (const skillName of ['pdf', 'xlsx']) {
    writeFileSync(
      join(repoDir, 'skills', skillName, 'SKILL.md'),
      [
        '---',
        `name: ${skillName}`,
        `description: ${skillName} skill`,
        'allowed-tools: Read',
        '---',
        '',
        `# ${skillName}`,
      ].join('\n'),
      'utf8',
    )
  }
}

describe('plugin scopes + resolution', () => {
  const runnerCwd = process.cwd()

  let projectDir: string
  let homeDir: string
  let repoA: string
  let repoB: string

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'amawta-skill-plugin-proj-'))
    homeDir = mkdtempSync(join(tmpdir(), 'amawta-skill-plugin-home-'))
    await setCwd(projectDir)

    repoA = join(projectDir, 'skills-repo-a')
    repoB = join(projectDir, 'skills-repo-b')
  })

  afterEach(async () => {
    await setCwd(runnerCwd)
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('install resolves bare plugin name when unique', async () => {
    await withEnv({ AMAWTA_CONFIG_DIR: join(homeDir, '.amawta') }, async () => {
      writeMarketplaceRepo(repoA, 'mkt-a')
      await addMarketplace(repoA)

      const install = installSkillPlugin('document-skills', { scope: 'user' })
      expect(install.pluginSpec).toBe('document-skills@mkt-a')
      expect(install.installedSkills.sort()).toEqual(['pdf', 'xlsx'])
      expect(existsSync(join(homeDir, '.amawta', 'skills', 'pdf'))).toBe(true)
      expect(existsSync(join(homeDir, '.amawta', 'skills', 'xlsx'))).toBe(true)
    })
  })

  test('install rejects bare plugin name when ambiguous across marketplaces', async () => {
    await withEnv({ AMAWTA_CONFIG_DIR: join(homeDir, '.amawta') }, async () => {
      writeMarketplaceRepo(repoA, 'mkt-a')
      writeMarketplaceRepo(repoB, 'mkt-b')
      await addMarketplace(repoA)
      await addMarketplace(repoB)

      expect(() =>
        installSkillPlugin('document-skills', { scope: 'user' }),
      ).toThrow(/multiple marketplaces/i)
    })
  })

  test('project scope installs into project ./.amawta/skills and records projectPath', async () => {
    await withEnv({ AMAWTA_CONFIG_DIR: join(homeDir, '.amawta') }, async () => {
      writeMarketplaceRepo(repoA, 'mkt-a')
      await addMarketplace(repoA)

      const install = installSkillPlugin('document-skills@mkt-a', {
        scope: 'project',
      })
      expect(install.installedSkills.sort()).toEqual(['pdf', 'xlsx'])
      expect(existsSync(join(projectDir, '.amawta', 'skills', 'pdf'))).toBe(true)
      expect(existsSync(join(projectDir, '.amawta', 'skills', 'xlsx'))).toBe(true)

      const state = listInstalledSkillPlugins()
      const record = state['document-skills@mkt-a'] as any
      expect(record.scope).toBe('project')
      expect(record.projectPath).toBe(projectDir)
    })
  })

  test('disable/enable moves installed skills in-place (user scope)', async () => {
    await withEnv({ AMAWTA_CONFIG_DIR: join(homeDir, '.amawta') }, async () => {
      writeMarketplaceRepo(repoA, 'mkt-a')
      await addMarketplace(repoA)
      installSkillPlugin('document-skills@mkt-a', { scope: 'user' })

      disableSkillPlugin('document-skills@mkt-a', { scope: 'user' })
      expect(existsSync(join(homeDir, '.amawta', 'skills', 'pdf'))).toBe(false)
      expect(
        existsSync(
          join(
            homeDir,
            '.amawta',
            'skills.disabled',
            'document-skills',
            'mkt-a',
            'pdf',
          ),
        ),
      ).toBe(true)

      enableSkillPlugin('document-skills@mkt-a', { scope: 'user' })
      expect(existsSync(join(homeDir, '.amawta', 'skills', 'pdf'))).toBe(true)
    })
  })
})
