// CB-021: give every packaged build its own number.
//
// The firmware has had a build counter for a long time; the app did not, so "the exe from
// this morning" and "the exe from ten minutes ago" were indistinguishable on disk and
// invisible in the interface. That is how a fresh firmware ends up paired with a stale UI
// that knows nothing about the new fields.
//
// Runs automatically before `npm run build` / `build:win` (npm's prebuild hook), bumps the
// patch number in package.json and writes ui/version.json, which the app reads at runtime.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const parts = String(pkg.version || '0.0.0').split('.').map((value) => parseInt(value, 10) || 0);
while (parts.length < 3) parts.push(0);
parts[2] += 1;
const version = parts.join('.');

pkg.version = version;
// Two spaces and a trailing newline: npm's own formatting, so the bump is a one-line diff.
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

// Written into ui/ because pkg bundles that directory as an asset — reading package.json
// from inside the packaged binary is not something to rely on.
fs.writeFileSync(
    path.join(root, 'ui', 'version.json'),
    `${JSON.stringify({ version, built: new Date().toISOString() }, null, 2)}\n`,
);

console.log(`Canable build version: ${version}`);
