#!/usr/bin/env node

const { execSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

/**
 * Publish a development build to npm.
 * Uses the `dev` tag and auto-increments the `-dev.N` suffix.
 * Keeps scope focused on npm publishing (no git operations).
 */
async function publishDev() {
  try {
    console.log('🚀 Starting dev version publish process...\n');

    // 1) Read current package metadata
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const packageName = packageJson.name;
    const baseVersion = packageJson.version;
    const npmPackagePath = packageName.startsWith('@')
      ? packageName.replace('/', '%2F')
      : packageName;

    console.log(`📦 Current base version: ${baseVersion}`);

    // 2) Compute next development version
    let devVersion;
    try {
      // Read latest version currently published under the dev tag
      const npmResult = execSync(`npm view ${packageName}@dev version`, { encoding: 'utf8' }).trim();
      const currentDevVersion = npmResult;
      
      if (currentDevVersion.startsWith(baseVersion + '-dev.')) {
        const devNumber = parseInt(currentDevVersion.split('-dev.')[1]) + 1;
        devVersion = `${baseVersion}-dev.${devNumber}`;
      } else {
        devVersion = `${baseVersion}-dev.1`;
      }
    } catch {
      // If no existing dev version is found, start from 1
      devVersion = `${baseVersion}-dev.1`;
    }

    console.log(`📦 Publishing version: ${devVersion} with tag 'dev'`);

    // 3) Temporarily update package.json with the dev version
    const originalPackageJson = { ...packageJson };
    packageJson.version = devVersion;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    // 4) Build the project
    console.log('🔨 Building project...');
    execSync('npm run build', { stdio: 'inherit' });

    // 5) Run pre-publish checks
    console.log('🔍 Running pre-publish checks...');
    execSync('bun run scripts/prepublish-check.js', { stdio: 'inherit' });

    // 6) Publish to npm with the dev tag
    console.log('📤 Publishing to npm...');
    execSync(`npm publish --tag dev --access public`, { stdio: 'inherit' });

    // 7) Restore original package.json
    writeFileSync(packagePath, JSON.stringify(originalPackageJson, null, 2));

    console.log('\n✅ Dev version published successfully!');
    console.log(`📦 Version: ${devVersion}`);
    console.log(`🔗 Install with: npm install -g ${packageName}@dev`);
    console.log(`🔗 Or: npm install -g ${packageName}@${devVersion}`);
    console.log(`📊 View on npm: https://www.npmjs.com/package/${npmPackagePath}/v/${devVersion}`);

  } catch (error) {
    console.error('❌ Dev publish failed:', error.message);
    
    // Best-effort package.json restore on failure
    try {
      const packagePath = path.join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (packageJson.version.includes('-dev.')) {
        // Restore base version
        const baseVersion = packageJson.version.split('-dev.')[0];
        packageJson.version = baseVersion;
        writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
        console.log('🔄 Restored package.json version');
      }
    } catch {}
    
    process.exit(1);
  }
}

publishDev();
