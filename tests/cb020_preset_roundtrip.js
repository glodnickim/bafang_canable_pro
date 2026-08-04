// CB-020 host test: the preset file must carry the ride tuning and NOTHING bike-specific,
// and importing must clamp rather than trust what it is handed.
//
// Run from the Canable project root:  node tests/cb020_preset_roundtrip.js
//
// The dangerous failure here is not a crash. It is a preset that quietly carries one bike's
// torque calibration or battery settings into another bike, or a hand-edited file that puts
// an out-of-range value into the editor and from there into the controller.

'use strict';
let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

const PRESET_FORMAT = 'evistdrive-preset';
const PRESET_VERSION = 1;
const BANK_RUNTIME_KEYS = ['active_bank'];
const kgWithOneDecimal = (value) => Math.round(value * 10) / 10;

// Mirrors presets.js buildPreset(): it exports exactly lastBanks + lastTuning, minus runtime.
function buildPreset(state, name) {
    const banks = [0, 1].map((index) => {
        const bank = state.lastBanks?.[index];
        if (!bank) return null;
        const copy = JSON.parse(JSON.stringify(bank));
        BANK_RUNTIME_KEYS.forEach((key) => { delete copy[key]; });
        return copy;
    });
    return {
        format: PRESET_FORMAT, version: PRESET_VERSION, created: new Date().toISOString(),
        name: name || '', note: '',
        source: { controller_sw_version: null, bank_schema_version: 7 },
        banks,
        tuning: state.lastTuning ? JSON.parse(JSON.stringify(state.lastTuning)) : null,
    };
}

// Mirrors presets.js clampInto().
function clampInto(target, source, descriptors, label, adjusted) {
    descriptors.filter(Boolean).forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(source, field.key)) return;
        let value = source[field.key];
        if (field.type === 'checkbox') { target[field.key] = !!value; return; }
        if (!Number.isFinite(value)) return;
        if (Number.isFinite(field.min) && value < field.min) {
            adjusted.push(`${label} · ${field.label}: ${value} → ${field.min}`); value = field.min;
        } else if (Number.isFinite(field.max) && value > field.max) {
            adjusted.push(`${label} · ${field.label}: ${value} → ${field.max}`); value = field.max;
        }
        target[field.key] = value;
    });
}

const level = (over) => Object.assign({
    mode_type: 1, support_ratio_pct: 200, max_iq_pct: 100,
    minimum_pedal_load_kg: 0.7, riding_minimum_pedal_load_kg: 0.7,
    iq_rise_slow_ms: 600, iq_fall_slow_ms: 1000, release_ms: 650,
    assist_without_rotation: false,
}, over);

const bank = (index, over) => Object.assign({
    bank_index: index, active_bank: 0, bank_schema_version: 7,
    wa_cutoff_kmh: 7, wa_target_rpm: 50,
    levels: [level({}), level({}), level({}), level({}), level({})],
}, over);

// --- what the file carries -----------------------------------------------------------
const state = {
    lastBanks: { 0: bank(0), 1: bank(1, { wa_cutoff_kmh: 6 }) },
    lastTuning: { assist_start_steps: 4, assist_run_deadband_mv: 5, assist_hold_ms: 1400 },
    // Present in the app, and deliberately NOT part of a preset — these belong to one bike.
    lastTorque: { span_native: 1620, calibration_source: 1 },
    lastSystem: { soc_full_pack_10mv: 4587 },
};
const preset = buildPreset(state, 'mountains');
const serialised = JSON.stringify(preset);

check(preset.format === PRESET_FORMAT && preset.version === PRESET_VERSION, 'format and version stamped');
check(preset.banks[0].levels.length === 5 && preset.banks[1].levels.length === 5, 'both banks exported in full');
check(preset.tuning.assist_start_steps === 4, 'global tuning exported');
check(preset.banks[1].wa_cutoff_kmh === 6, 'per-bank walk setting travels with its bank');

// The whole point of the format: a preset must be safe to hand to a stranger.
check(!('active_bank' in preset.banks[0]), 'active bank is runtime state and must not travel');
['span_native', 'calibration_source', 'soc_full_pack_10mv', 'torque', 'wheel', 'serial']
    .forEach((needle) => {
        check(!serialised.includes(needle),
            `bike-specific data must never reach the file (found "${needle}")`);
    });

// --- import clamps, and says so -------------------------------------------------------
const descriptors = [
    { key: 'max_iq_pct', label: 'Maximum motor current', min: 0, max: 100 },
    { key: 'iq_rise_slow_ms', label: 'Acceleration — low speed/cadence', min: 20, max: 5000 },
    { key: 'riding_minimum_pedal_load_kg', label: 'Minimum pedal load while riding', min: 0, max: 22.5 },
    { key: 'assist_without_rotation', label: 'Assist without crank rotation', type: 'checkbox' },
];
const hostile = {
    max_iq_pct: 250,            // over the ceiling
    iq_rise_slow_ms: 5,         // under the floor
    riding_minimum_pedal_load_kg: 0.4, // legal, must pass through untouched
    assist_without_rotation: 'yes', // truthy non-boolean
};
const target = level({});
const adjusted = [];
clampInto(target, hostile, descriptors, 'Bank 1 / ECO', adjusted);

check(target.max_iq_pct === 100, `over-range clamped to max, got ${target.max_iq_pct}`);
check(target.iq_rise_slow_ms === 20, `under-range clamped to min, got ${target.iq_rise_slow_ms}`);
check(target.riding_minimum_pedal_load_kg === 0.4, 'a legal kg value must pass through unchanged');
check(target.assist_without_rotation === true, 'checkbox coerced to a real boolean');
check(adjusted.length === 2, `both clamps must be reported, got ${adjusted.length}`);
check(adjusted.join(' ').includes('250') && adjusted.join(' ').includes('100'),
    'the report must name the original and the corrected value');

check(kgWithOneDecimal(0.74) === 0.7, 'canonical preset minimum rounds to one decimal');
check(kgWithOneDecimal(0.26) === 0.3, 'canonical preset riding minimum rounds to one decimal');

// A field the preset does not mention must be left alone, not zeroed.
const untouched = level({ release_ms: 900 });
clampInto(untouched, { max_iq_pct: 50 }, descriptors, 'x', []);
check(untouched.release_ms === 900, 'fields absent from the preset must keep their value');

// --- validation rejects what it should ------------------------------------------------
function validate(parsed) {
    if (!parsed || typeof parsed !== 'object') return { error: 'not an object' };
    if (parsed.format !== PRESET_FORMAT) return { error: 'wrong format' };
    if (!Number.isFinite(parsed.version) || parsed.version > PRESET_VERSION) return { error: 'too new' };
    const banks = Array.isArray(parsed.banks) ? parsed.banks : [];
    const hasBank = banks.some((b) => Array.isArray(b?.levels) && b.levels.length);
    if (!hasBank && !parsed.tuning) return { error: 'empty' };
    return { preset: parsed };
}
check(!!validate(preset).preset, 'a valid preset validates');
check(!!validate({ format: 'canable_backup', version: 1 }).error,
    'a whole-device backup must be refused, not half-imported');
check(!!validate({ format: PRESET_FORMAT, version: 99 }).error, 'a newer format must be refused');
check(!!validate({ format: PRESET_FORMAT, version: 1, banks: [], tuning: null }).error,
    'an empty preset must be refused');

console.log(failures === 0 ? 'CB-020 preset round trip: PASS'
    : `CB-020 preset round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
