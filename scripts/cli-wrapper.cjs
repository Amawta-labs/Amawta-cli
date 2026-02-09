#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function findPackageRoot(startDir) {
  let dir = startDir
  for (let i = 0; i < 25; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

function readPackageJson(packageRoot) {
  try {
    const p = path.join(packageRoot, 'package.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function hasFlag(flag) {
  return process.argv.includes(flag)
}

function printHelpLite() {
  process.stdout.write(
    `Amawta CLI (command: amawta)\n\n` +
      `Usage: amawta [options] [command] [prompt]\n\n` +
      `Common options:\n` +
      `  -h, --help           Show full help\n` +
      `  -v, --version        Show version\n` +
      `  -p, --print          Print response and exit (non-interactive)\n` +
      `  -c, --cwd <cwd>      Set working directory\n`,
  )
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, AMAWTA_PACKAGED: process.env.AMAWTA_PACKAGED || '1' },
  })
  if (result.error) {
    throw result.error
  }
  process.exit(typeof result.status === 'number' ? result.status : 1)
}

function shouldPreferNodeDist(packageRoot) {
  if (process.env.AMAWTA_PREFER_DIST === '1') return true
  if (process.env.AMAWTA_PREFER_DIST === '0') return false

  return fs.existsSync(path.join(packageRoot, '.git'))
}

function getLatestMtimeMs(targetPath, depth = 0) {
  if (depth > 6) return 0
  let stat
  try {
    stat = fs.statSync(targetPath)
  } catch {
    return 0
  }

  if (!stat.isDirectory()) {
    return stat.mtimeMs || 0
  }

  const base = path.basename(targetPath)
  if (
    base === 'dist' ||
    base === '.git' ||
    base === 'node_modules' ||
    base === '.turbo'
  ) {
    return 0
  }

  let latest = stat.mtimeMs || 0
  let entries = []
  try {
    entries = fs.readdirSync(targetPath)
  } catch {
    return latest
  }

  for (const entry of entries) {
    const full = path.join(targetPath, entry)
    const next = getLatestMtimeMs(full, depth + 1)
    if (next > latest) latest = next
  }
  return latest
}

function isDistStale(packageRoot, distEntry) {
  let distMtime = 0
  try {
    distMtime = fs.statSync(distEntry).mtimeMs || 0
  } catch {
    return false
  }
  if (!distMtime) return false

  const srcDir = path.join(packageRoot, 'src')
  const latestSrc = getLatestMtimeMs(srcDir)
  return latestSrc > distMtime
}

function maybePrepareDist(packageRoot, distEntry) {
  if (process.env.AMAWTA_AUTO_REBUILD_DIST === '0') return
  if (!fs.existsSync(path.join(packageRoot, '.git'))) return
  if (!fs.existsSync(path.join(packageRoot, 'src'))) return
  const distExists = fs.existsSync(distEntry)
  if (distExists && !isDistStale(packageRoot, distEntry)) return

  process.stdout.write(
    distExists
      ? 'ℹ️  Source is newer than dist. Rebuilding runtime...\n'
      : 'ℹ️  Dist runtime is missing. Building runtime...\n',
  )
  const rebuilt = spawnSync('bun', ['run', 'build:npm'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (rebuilt.error || rebuilt.status !== 0) {
    process.stderr.write(
      distExists
        ? '⚠️  Rebuild failed; continuing with existing dist runtime.\n'
        : '⚠️  Build failed and dist runtime is still missing.\n',
    )
  }
}

function runSourceFallback(packageRoot, args) {
  if (process.env.AMAWTA_SOURCE_FALLBACK === '0') return false
  if (!fs.existsSync(path.join(packageRoot, '.git'))) return false

  const sourceEntry = path.join(packageRoot, 'src', 'entrypoints', 'cli.tsx')
  if (!fs.existsSync(sourceEntry)) return false

  const fallback = spawnSync('bun', ['run', sourceEntry, ...args], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, AMAWTA_PACKAGED: process.env.AMAWTA_PACKAGED || '1' },
  })
  if (fallback.error) return false

  process.exit(typeof fallback.status === 'number' ? fallback.status : 1)
}

function main() {
  const packageRoot = findPackageRoot(__dirname)
  const pkg = readPackageJson(packageRoot)
  const version = pkg?.version || ''
  const distEntry = path.join(packageRoot, 'dist', 'index.js')
  const { getCachedBinaryPath } = require(path.join(
    packageRoot,
    'scripts',
    'binary-utils.cjs',
  ))

  if (hasFlag('--help-lite')) {
    printHelpLite()
    process.exit(0)
  }

  if (hasFlag('--version') || hasFlag('-v')) {
    process.stdout.write(`${version}\n`)
    process.exit(0)
  }

  // In a source checkout, prefer local dist to avoid stale cached binaries.
  if (shouldPreferNodeDist(packageRoot)) {
    maybePrepareDist(packageRoot, distEntry)
    if (fs.existsSync(distEntry)) {
      run(process.execPath, [distEntry, ...process.argv.slice(2)])
    }
    if (runSourceFallback(packageRoot, process.argv.slice(2))) return
  }

  // 1) Prefer native binary (Windows OOTB, no Bun required)
  if (version) {
    const binPath = getCachedBinaryPath({ version })
    if (fs.existsSync(binPath)) {
      run(binPath, process.argv.slice(2))
    }
  }

  // 2) Fallback: Node.js runtime (npm install should work without Bun)
  if (fs.existsSync(distEntry)) {
    run(process.execPath, [distEntry, ...process.argv.slice(2)])
  }

  // 3) Final fallback: explain what to do
  process.stderr.write(
    [
      '❌ Amawta CLI is not runnable on this system.',
      '',
      'Tried:',
      '- Native binary (postinstall download)',
      '- Node.js runtime fallback',
      '',
      'Fix:',
      '- In a source checkout: run `bun run build:npm` and retry `node cli.js`',
      '- Reinstall (ensure network access), or set AMAWTA_BINARY_BASE_URL to a mirror',
      '- Or download a standalone binary from GitHub Releases',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

main()
