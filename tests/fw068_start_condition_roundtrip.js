// FW-068/069/077 host test: bank v7 uses two kg thresholds and negotiates down.
// Run from the Canable project root: node tests/fw068_start_condition_roundtrip.js

'use strict';
const path = require('path');
const { BafangCanControllerParser } = require(path.join(__dirname, '..', 'bafang-parser'));
const canbus = require(path.join(__dirname, '..', 'canbus'));
const serializeBank = canbus.constructor.serializeBankBlob;
const serializeTuning = canbus.constructor.serializeTuningBlob;

let failures = 0;
const check = (ok, label) => {
    if (!ok) { failures++; console.log(`  FAIL  ${label}`); }
    return ok;
};
const close = (actual, expected, tolerance, label) =>
    check(Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`);

function level(overrides) {
    return Object.assign({
        mode_type: 1, support_ratio_pct: 200, support_min_pct: 170, support_max_pct: 260,
        reference_power_w: 200, progression_pct: 0,
        curve_exponent_x10: 15, curve_exponent_high_x10: 15,
        emtb_parameter: 100, emtb_based_on_power: true, emtb_reference_voltage_mv: 36000,
        torque_assist_factor: 80, max_motor_power_w: 0, max_iq_pct: 100,
        assist_without_rotation: false, minimum_pedal_load_kg: 0.7,
        riding_minimum_pedal_load_kg: 0.7,
        startup_boost_enabled: true, startup_boost_mode: 0, startup_boost_strength_pct: 100,
        startup_boost_end_rpm: 27, smooth_start_enabled: false, smooth_start_ms: 300,
        release_ms: 650, power_rise_filter_ms: 150, power_fall_filter_ms: 375,
        iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
        iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    }, overrides);
}

function bank(schemaVersion, levels) {
    return {
        bank_index: 0, active_bank: 0, bank_schema_version: schemaVersion,
        wa_cutoff_kmh: 7, wa_current_pct: 30, wa_target_rpm: 50,
        wa_latch_after_release: false, wa_latch_timeout_s: 30,
        levels,
    };
}

const roundTrip = (bankObj) => {
    const bytes = serializeBank(bankObj);
    return { bytes, parsed: BafangCanControllerParser.bankBlob({ data: bytes }) };
};

const distinct = [
    level({ minimum_pedal_load_kg: 0.7, riding_minimum_pedal_load_kg: 0.3,
        iq_rise_slow_ms: 2000, iq_rise_fast_ms: 1500, iq_fall_slow_ms: 900, iq_fall_fast_ms: 120 }),
    level({ minimum_pedal_load_kg: 1.2, riding_minimum_pedal_load_kg: 1.2,
        iq_rise_slow_ms: 20, iq_rise_fast_ms: 20, iq_fall_slow_ms: 20, iq_fall_fast_ms: 20 }),
    level({ minimum_pedal_load_kg: 22.5, riding_minimum_pedal_load_kg: 0,
        iq_rise_slow_ms: 5000, iq_rise_fast_ms: 5000, iq_fall_slow_ms: 5000, iq_fall_fast_ms: 5000 }),
    level({ minimum_pedal_load_kg: 2.4, riding_minimum_pedal_load_kg: 1.1 }),
    level({ minimum_pedal_load_kg: 3.3, riding_minimum_pedal_load_kg: 0.8 }),
];

// v7 keeps the v6 geometry; bytes 19/35 are kg and 36/37 are reserved zero.
const v7 = roundTrip(bank(7, distinct));
check(v7.bytes.length === 245, `v7 blob must be 245 B, got ${v7.bytes.length}`);
check(v7.bytes[2] === 7, 'v7 version byte');
check(v7.bytes[5] === 46, `record length must be 46, got ${v7.bytes[5]}`);
check(v7.parsed.parseError !== true, `v7 blob must parse: ${v7.parsed.error || ''}`);

['minimum_pedal_load_kg', 'riding_minimum_pedal_load_kg',
    'iq_rise_slow_ms', 'iq_rise_fast_ms', 'iq_fall_slow_ms', 'iq_fall_fast_ms'].forEach((key) => {
    distinct.forEach((source, index) => {
        check(v7.parsed.levels[index][key] === source[key],
            `v7 level ${index + 1} ${key}: ${source[key]} -> ${v7.parsed.levels[index][key]}`);
    });
});

distinct.forEach((source, index) => {
    check(v7.bytes[13 + index * 46 + 36] === 0 &&
        v7.bytes[13 + index * 46 + 37] === 0,
    `level ${index + 1} removed rise-detector slots must be zero`);
    check(!Object.prototype.hasOwnProperty.call(v7.parsed.levels[index], 'start_rise_kg') &&
        !Object.prototype.hasOwnProperty.call(v7.parsed.levels[index], 'start_rise_window_ms'),
    `level ${index + 1} parser must not expose removed rise-detector fields`);
});

// Values with extra decimals are normalized at the serialization boundary and
// never come back to the editor with a second decimal place.
const fractional = roundTrip(bank(7, [
    level({ minimum_pedal_load_kg: 0.74,
        riding_minimum_pedal_load_kg: 0.26 }),
    level({}), level({}), level({}), level({}),
]));
check(fractional.parsed.levels[0].minimum_pedal_load_kg === 0.7,
    '0.74 kg minimum must round to 0.7 kg');
check(fractional.parsed.levels[0].riding_minimum_pedal_load_kg === 0.3,
    '0.26 kg riding minimum must round to 0.3 kg');
check(fractional.bytes[13 + 19] === 70 && fractional.bytes[13 + 20] === 0,
    'u16 minimum wire value must be a multiple of 10 centikg');

// A v6 controller must receive the old mV representation, never version 7.
const v6 = roundTrip(bank(6, distinct));
check(v6.bytes[2] === 6 && v6.bytes.length === 245, 'v6 negotiation must retain v6/245 B');
check(v6.parsed.parseError !== true, 'negotiated v6 must parse');
distinct.forEach((source, index) => {
    const parsed = v6.parsed.levels[index];
    const minimumMv = Math.min(300, Math.round(source.minimum_pedal_load_kg * 27));
    const requestedRidingMv = Math.min(minimumMv,
        Math.round(source.riding_minimum_pedal_load_kg * 27));
    const reductionMv = Math.min(100, Math.max(0, minimumMv - requestedRidingMv));
    const expectedRidingKg = (minimumMv - reductionMv) / 27;
    close(parsed.minimum_pedal_load_kg, minimumMv / 27, 1 / 27,
        `v6 level ${index + 1} minimum kg`);
    close(parsed.riding_minimum_pedal_load_kg, expectedRidingKg,
        1 / 27, `v6 level ${index + 1} riding kg`);
    ['minimum_pedal_load_kg', 'riding_minimum_pedal_load_kg']
        .forEach((key) => check(Number.isInteger(parsed[key] * 10),
            `v6 level ${index + 1} ${key} must have one-decimal precision`));
});

// v5 has no rolling tail. The parser exposes one direct kg model anyway.
const v5 = roundTrip(bank(5, distinct));
check(v5.bytes.length === 190 && v5.bytes[5] === 35, 'v5 geometry must remain 190/35 B');
check(v5.parsed.parseError !== true, 'v5 blob must parse');
close(v5.parsed.levels[0].riding_minimum_pedal_load_kg,
    v5.parsed.levels[0].minimum_pedal_load_kg, 0, 'v5 rolling threshold defaults to minimum');

const brokenCrc = v7.bytes.slice();
brokenCrc[40] ^= 0xFF;
check(BafangCanControllerParser.bankBlob({ data: brokenCrc }).parseError === true,
    'v7 bad CRC must be rejected');
const badVersion = v7.bytes.slice();
badVersion[2] = 9;
check(BafangCanControllerParser.bankBlob({ data: badVersion }).parseError === true,
    'unknown bank version must be rejected');

// Tuning negotiation is unchanged by FW-077.
const tuning = {
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300, iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20, assist_run_deadband_mv: 5, assist_hold_ms: 1400,
    assist_min_iq_pct: 2, assist_torque_run_filter_ms: 300, assist_start_steps: 7,
};
const t6 = serializeTuning({ ...tuning, tuning_schema_version: 6 });
check(t6.length === 32 && t6[2] === 6, 'tuning v6 geometry/version');
const t6parsed = BafangCanControllerParser.tuningBlob({ data: t6 });
check(t6parsed.assist_start_steps === 7, 'tuning start steps round trip');
const t5 = serializeTuning({ ...tuning, tuning_schema_version: 5 });
check(t5.length === 24 && t5[2] === 5, 'tuning must negotiate down to v5');

console.log(failures === 0
    ? 'FW-068/069/077 two-threshold start condition + ramps round trip: PASS'
    : `FW-068/069/077 round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
