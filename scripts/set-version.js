#!/usr/bin/env node
/**
 * Set version across all project files.
 * Usage: npm run set-version -- 1.0.3
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const version = process.argv[2];

if (!version) {
  console.error('Usage: npm run set-version -- <version>');
  console.error('Example: npm run set-version -- 1.0.3');
  process.exit(1);
}

// Validate version format (semver-like)
if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
  console.error(`Invalid version format: ${version}`);
  console.error('Expected format: MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease');
  process.exit(1);
}

const rootDir = join(__dirname, '..');

// Convert to 4-part version for manifest (e.g., 1.0.3 -> 1.0.3.0)
const manifestVersion = version.includes('-') ? version.split('-')[0] + '.0' : version + '.0';

// Update package.json
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
packageJson.version = version;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
console.log(`✓ Updated package.json to version ${version}`);

// Update manifest.json
const manifestPath = join(rootDir, 'assets', 'manifest.json');
const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifestJson.Version = manifestVersion;
writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n', 'utf8');
console.log(`✓ Updated assets/manifest.json to version ${manifestVersion}`);

console.log(`\nVersion successfully set to ${version}`);
