// CB-018: the app's offline placeholders must agree with what a controller actually leaves
// the factory with.
//
// They did not, and it mattered: the Limits card showed "Legal speed-limit flag: Enabled"
// before anything had been read, while the firmware default is 0 — off. That was taken for
// the bike's own setting, and the rider expected a speed limit the bike was never applying.
//
// This reads the defaults straight out of the firmware sources, so the check cannot rot:
// change config.h and this test fails until the app is updated to match.
const fs = require('fs');
const path = require('path');

const FIRMWARE = process.env.EVD_FIRMWARE_DIR
    || path.join(__dirname, '..', '..', 'EBICS', 'BAFANG_GD32F303RCT6');

function readIfPresent(file) {
    try { return fs.readFileSync(path.join(FIRMWARE, file), 'utf8'); } catch { return null; }
}

const config = readIfPresent(path.join('inc', 'config.h'));
if (config === null) {
    // The firmware tree is not always checked out beside this repo; skipping is honest,
    // failing would be noise.
    console.log(`CB-018 placeholder defaults: SKIPPED (no firmware sources at ${FIRMWARE})`);
    process.exit(0);
}

function define(name) {
    const match = config.match(new RegExp(`^\\s*#define\\s+${name}\\s+(0x[0-9A-Fa-f]+|\\d+)`, 'm'));
    if (!match) throw new Error(`#define ${name} not found in inc/config.h`);
    return match[1].startsWith('0x') ? parseInt(match[1], 16) : parseInt(match[1], 10);
}

const LEGALFLAG = define('LEGALFLAG');
const LIMP_DISABLED = define('LIMP_DISABLED');

// previewP1() is a plain object literal, so reading the values out of the source keeps this
// test free of the browser imports that file carries.
const appSource = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'legacy-params.js'), 'utf8');
const preview = appSource.slice(appSource.indexOf('function previewP1()'), appSource.indexOf('function previewP2()'));

function placeholder(key) {
    const match = preview.match(new RegExp(`${key}:\\s*([A-Za-z0-9_]+)`));
    if (!match) throw new Error(`previewP1() has no ${key}`);
    const raw = match[1];
    if (raw === 'LIMP_DISABLED') return LIMP_DISABLED;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return Number(raw);
}

const checks = [
    ['coaster_brake (legal speed-limit flag)', placeholder('coaster_brake'), LEGALFLAG !== 0],
    ['limp_mode_soc_limit', placeholder('limp_mode_soc_limit'), LIMP_DISABLED],
    ['limp_mode_soc_limit_stage2', placeholder('limp_mode_soc_limit_stage2'), LIMP_DISABLED],
];

let failures = 0;
for (const [label, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: app shows ${actual}, firmware default is ${expected}`);
}

if (failures) {
    console.log('\nCB-018 placeholder defaults: FAIL');
    console.log('The app would show a value the bike does not have, in a field that looks read.');
    process.exit(1);
}
console.log('CB-018 placeholder defaults: PASS (app placeholders match firmware defaults)');
