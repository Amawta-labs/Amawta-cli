#!/usr/bin/env node

const { execSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * Publish a production release to npm.
 * Uses the `latest` tag and supports semantic version bumps.
 * Keeps scope focused on npm publishing (no git operations).
 */
async function publishRelease() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise(resolve => rl.question(query, resolve));

  try {
    console.log('🚀 Starting production release process...\n');

    // 1) Read current version
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const packageName = packageJson.name;
    const currentVersion = packageJson.version;
    const npmPackagePath = packageName.startsWith('@')
      ? packageName.replace('/', '%2F')
      : packageName;

    console.log(`📦 Current version: ${currentVersion}`);

    // 2) Choose version bump type
    console.log('\n🔢 Version bump options:');
    const versionParts = currentVersion.split('.');
    const major = parseInt(versionParts[0]);
    const minor = parseInt(versionParts[1]);
    const patch = parseInt(versionParts[2]);

    console.log(`  1. patch  → ${major}.${minor}.${patch + 1} (bug fixes)`);
    console.log(`  2. minor  → ${major}.${minor + 1}.0 (new features)`);
    console.log(`  3. major  → ${major + 1}.0.0 (breaking changes)`);
    console.log(`  4. custom → enter custom version`);

    const choice = await question('\nSelect version bump (1-4): ');
    
    let newVersion;
    switch (choice) {
      case '1':
        newVersion = `${major}.${minor}.${patch + 1}`;
        break;
      case '2':
        newVersion = `${major}.${minor + 1}.0`;
        break;
      case '3':
        newVersion = `${major + 1}.0.0`;
        break;
      case '4':
        newVersion = await question('Enter custom version: ');
        break;
      default:
        console.log('❌ Invalid choice');
        process.exit(1);
    }

    // 3) Ensure target version does not already exist
    try {
      execSync(`npm view ${packageName}@${newVersion} version`, { stdio: 'ignore' });
      console.log(`❌ Version ${newVersion} already exists on npm`);
      process.exit(1);
    } catch {
      // Version not found on npm; safe to continue
    }

    // 4) Confirm release details
    console.log(`\n📋 Release Summary:`);
    console.log(`   Current: ${currentVersion}`);
    console.log(`   New:     ${newVersion}`);
    console.log(`   Tag:     latest`);

    const confirm = await question('\n🤔 Proceed with release? (y/N): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('❌ Cancelled');
      process.exit(0);
    }

    // 5) Update package.json version
    console.log('📝 Updating version...');
    const originalPackageJson = { ...packageJson };
    packageJson.version = newVersion;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    // 6) Run tests
    console.log('🧪 Running tests...');
    try {
      execSync('npm run typecheck', { stdio: 'inherit' });
      execSync('npm test', { stdio: 'inherit' });
    } catch (error) {
      console.log('❌ Tests failed, rolling back version...');
      writeFileSync(packagePath, JSON.stringify(originalPackageJson, null, 2));
      process.exit(1);
    }

    // 7) Build project
    console.log('🔨 Building project...');
    execSync('npm run build', { stdio: 'inherit' });

    // 8) Run pre-publish checks
    console.log('🔍 Running pre-publish checks...');
    execSync('bun run scripts/prepublish-check.js', { stdio: 'inherit' });

    // 9) Publish to npm
    console.log('📤 Publishing to npm...');
    execSync('npm publish --access public', { stdio: 'inherit' });

    console.log('\n🎉 Production release published successfully!');
    console.log(`📦 Version: ${newVersion}`);
    console.log(`🔗 Install with: npm install -g ${packageName}`);
    console.log(`🔗 Or: npm install -g ${packageName}@${newVersion}`);
    console.log(`📊 View on npm: https://www.npmjs.com/package/${npmPackagePath}`);
    
    console.log('\n💡 Next steps:');
    console.log('   - Commit the version change to git');
    console.log('   - Create a git tag for this release');
    console.log('   - Push changes to the repository');

  } catch (error) {
    console.error('❌ Production release failed:', error.message);
    
    // Best-effort recovery notice for package.json
    try {
      const packagePath = path.join(process.cwd(), 'package.json');
      const originalContent = readFileSync(packagePath, 'utf8');
      // Intentionally simplified fallback for manual recovery
      console.log('🔄 Please manually restore package.json if needed');
    } catch {}
    
    process.exit(1);
  } finally {
    rl.close();
  }
}

publishRelease();
