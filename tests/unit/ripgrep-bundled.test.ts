import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rgPath } from '@vscode/ripgrep'
import { getRipgrepPath, resetRipgrepPathCacheForTests } from '@utils/system/ripgrep'

const ORIGINAL_ENV = { ...process.env }

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function setEnv(next: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetRipgrepPathCacheForTests()
}

beforeEach(() => {
  restoreEnv()
  resetRipgrepPathCacheForTests()
})

afterEach(() => {
  restoreEnv()
  resetRipgrepPathCacheForTests()
})

test('uses AMAWTA_RIPGREP_PATH when set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amawta-rg-path-'))
  try {
    const fakeRg = join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg')
    writeFileSync(fakeRg, '#!/bin/sh\necho rg\n')

    setEnv({ AMAWTA_RIPGREP_PATH: fakeRg })
    expect(getRipgrepPath()).toBe(fakeRg)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to @vscode/ripgrep when forced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amawta-rg-vendor-'))
  try {
    setEnv({
      USE_BUILTIN_RIPGREP: '1',
      AMAWTA_RIPGREP_PATH: undefined,
    })

    expect(getRipgrepPath()).toBe(rgPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('throws a helpful error when AMAWTA_RIPGREP_PATH points to a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amawta-rg-missing-'))
  try {
    setEnv({
      AMAWTA_RIPGREP_PATH: join(dir, 'does-not-exist-rg'),
    })

    expect(() => getRipgrepPath()).toThrow(
      /AMAWTA_RIPGREP_PATH points to a missing file/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
