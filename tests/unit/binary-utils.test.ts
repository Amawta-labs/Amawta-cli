import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const utils = require('../../scripts/binary-utils.cjs') as {
  getPlatformArch: (platform: string, arch: string) => string
  getBinaryFilename: (platform: string) => string
  getCachedBinaryPath: (opts: {
    version: string
    platform: string
    arch: string
    baseDir: string
  }) => string
  getGithubReleaseBinaryUrl: (opts: {
    version: string
    platform: string
    arch: string
    owner?: string
    repo?: string
    tag?: string
    baseUrl?: string
  }) => string
}

test('binary-utils: platform/arch and filenames', () => {
  expect(utils.getPlatformArch('darwin', 'arm64')).toBe('darwin-arm64')
  expect(utils.getPlatformArch('win32', 'x64')).toBe('win32-x64')
  expect(utils.getBinaryFilename('darwin')).toBe('amawta')
  expect(utils.getBinaryFilename('linux')).toBe('amawta')
  expect(utils.getBinaryFilename('win32')).toBe('amawta.exe')
})

test('binary-utils: cached binary path', () => {
  expect(
    utils.getCachedBinaryPath({
      version: '2.0.0',
      platform: 'darwin',
      arch: 'arm64',
      baseDir: '/tmp/amawta-bin',
    }),
  ).toBe('/tmp/amawta-bin/2.0.0/darwin-arm64/amawta')

  expect(
    utils.getCachedBinaryPath({
      version: '2.0.0',
      platform: 'win32',
      arch: 'x64',
      baseDir: '/tmp/amawta-bin',
    }),
  ).toBe('/tmp/amawta-bin/2.0.0/win32-x64/amawta.exe')
})

test('binary-utils: GitHub release URL', () => {
  expect(
    utils.getGithubReleaseBinaryUrl({
      version: '2.0.0',
      platform: 'darwin',
      arch: 'arm64',
      owner: 'shareAI-lab',
      repo: 'amawta',
      tag: 'v2.0.0',
    }),
  ).toBe(
    'https://github.com/shareAI-lab/amawta/releases/download/v2.0.0/amawta-darwin-arm64',
  )
})

test('binary-utils: base URL override', () => {
  const prev = process.env.AMAWTA_BINARY_BASE_URL
  process.env.AMAWTA_BINARY_BASE_URL = 'https://example.com/amawta'
  try {
    expect(
      utils.getGithubReleaseBinaryUrl({
        version: '2.0.0',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toBe('https://example.com/amawta/amawta-linux-x64')
  } finally {
    if (prev === undefined) delete process.env.AMAWTA_BINARY_BASE_URL
    else process.env.AMAWTA_BINARY_BASE_URL = prev
  }
})
