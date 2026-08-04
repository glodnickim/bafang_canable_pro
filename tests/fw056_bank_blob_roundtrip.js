// FW-056 host test for the bank blob round-trip (EBICS documentation/FW-056, 8.2).
//
// Run from the Canable project root:  node tests/fw056_bank_blob_roundtrip.js
//
// Covers the part of the change that can silently corrupt a rider's profiles:
// record byte 9 now means gamma in Power Curve (mode 6) and progression in
// Power Progressive (mode 2), and blob version 4 must stay byte-identical to v3.
//
// canbus.js pulls in USB hardware bindings, so the serializer is loaded through
// its class rather than the exported singleton's module side effects.

'use strict';
const path = require('path');
const { BafangCanControllerParser } = require(path.join(__dirname, '..', 'bafang-parser'));
const canbus = require(path.join(__dirname, '..', 'canbus'));
const serialize = canbus.constructor.serializeBankBlob;

let failures = 0;
const check = (ok, label) => {
    if (!ok) { failures++; console.log(`  FAIL  ${label}`); }
    return ok;
};

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
    const bytes = serialize(bankObj);
    return { bytes, parsed: BafangCanControllerParser.bankBlob({ data: bytes }) };
};

// --- length and version ---
const curveLevels = [
    level({ mode_type: 6, curve_exponent_x10: 15, curve_exponent_high_x10: 20 }),
    level({ mode_type: 6, curve_exponent_x10: 3, curve_exponent_high_x10: 25 }),
    level({ mode_type: 6, curve_exponent_x10: 25, curve_exponent_high_x10: 3 }),
    level({ mode_type: 2, progression_pct: 40 }),
    level({ mode_type: 1, support_ratio_pct: 320 }),
];

// --- FW-073: every mode number must survive a round trip UNCHANGED -------------------
// A stored bank carries the NUMBER, not the name. FW-073 renamed ASSIST_MODE_EMTB_TSDZ to
// ASSIST_MODE_EMTB; had that rename taken the value with it, a bank saved as eMTB would come
// back as a different mode after the update, silently and with no error. Modes 1, 2 and 6
// were already covered above — 3, 4 and 5 were not, which is exactly where the risk sat.
[1, 2, 3, 4, 5, 6].forEach((modeType) => {
    const trip = roundTrip(bank(5, [
        level({ mode_type: modeType }), level({}), level({}), level({}), level({}),
    ]));
    check(!trip.parsed.parseError, `mode ${modeType}: blob failed to parse`);
    check(trip.bytes[13] === modeType,
        `mode ${modeType} must be written as ${modeType} in record byte 0, got ${trip.bytes[13]}`);
    check(trip.parsed.levels[0].mode_type === modeType,
        `mode ${modeType} must read back as ${modeType}, got ${trip.parsed.levels[0].mode_type}`);
});
// eMTB in particular, spelled out: this is the value FW-073 could have moved.
const emtb = roundTrip(bank(5, [level({ mode_type: 3, emtb_parameter: 140 }),
    level({}), level({}), level({}), level({})]));
check(emtb.parsed.levels[0].mode_type === 3, 'eMTB must stay wire value 3');
check(emtb.parsed.levels[0].emtb_parameter === 140, 'eMTB parameter must survive with it');
const v4 = roundTrip(bank(4, curveLevels));
check(v4.bytes.length === 189, `v4 blob must stay 189 B, got ${v4.bytes.length}`);
check(v4.bytes[2] === 4, `v4 blob must carry version 4, got ${v4.bytes[2]}`);
check(v4.bytes[5] === 35, `record length must stay 35 B, got ${v4.bytes[5]}`);
check(!v4.parsed.parseError, `v4 blob failed to parse: ${v4.parsed.error}`);
check(v4.parsed.bank_schema_version === 4, 'parsed schema version must be 4');
check(v4.parsed.cadence_comp_enabled === false,
    'cadence compensation must read back off on a v4 controller');

// --- FW-057: v5 adds one header byte and stays inside the 192 B buffers ---
const v5on = roundTrip(Object.assign(bank(5, curveLevels), { cadence_comp_enabled: true }));
check(v5on.bytes.length === 190, `v5 blob must be 190 B, got ${v5on.bytes.length}`);
check(v5on.bytes.length <= 192, 'v5 blob must still fit bank_store[2][192] and BankBlob[192]');
check(Math.ceil(v5on.bytes.length / 8) <= 24,
    `v5 blob must still fit 24 multiframe frames, needs ${Math.ceil(v5on.bytes.length / 8)}`);
check(v5on.bytes[2] === 5, `v5 blob must carry version 5, got ${v5on.bytes[2]}`);
check(v5on.bytes[12] === 1, `header byte 12 must be the cadence comp flag, got ${v5on.bytes[12]}`);
check(!v5on.parsed.parseError, `v5 blob failed to parse: ${v5on.parsed.error}`);
check(v5on.parsed.cadence_comp_enabled === true, 'cadence compensation must survive the round trip');
check(v5on.parsed.levels[0].curve_exponent_x10 === 15 && v5on.parsed.levels[0].curve_exponent_high_x10 === 20,
    'level records must still parse correctly at the shifted v5 offset');
check(v5on.parsed.wa_target_rpm === 50 && v5on.parsed.wa_cutoff_kmh === 7,
    'Walk Assist header fields must be unchanged in v5');

const v5off = roundTrip(Object.assign(bank(5, curveLevels), { cadence_comp_enabled: false }));
check(v5off.bytes[12] === 0, 'cadence comp off must write 0');
check(v5off.parsed.cadence_comp_enabled === false, 'cadence comp off must read back off');

// A v4 controller must never be handed the longer blob, even if the flag is set.
const v4flagged = roundTrip(Object.assign(bank(4, curveLevels), { cadence_comp_enabled: true }));
check(v4flagged.bytes.length === 189 && v4flagged.bytes[2] === 4,
    'a v4 controller must still receive a 189 B v4 blob');

// --- the shape byte carries the right meaning per mode ---
curveLevels.forEach((source, index) => {
    const parsed = v4.parsed.levels[index];
    const record = 12 + index * 35;
    const wireByte = v4.bytes[record + 9];
    if (source.mode_type === 6) {
        check(wireByte === source.curve_exponent_x10,
            `level ${index}: byte 9 must be lower gamma ${source.curve_exponent_x10}, got ${wireByte}`);
        check(parsed.curve_exponent_x10 === source.curve_exponent_x10,
            `level ${index}: lower gamma did not survive the round trip`);
        check(v4.bytes[record + 1] === source.curve_exponent_high_x10,
            `level ${index}: byte 1 must be upper gamma ${source.curve_exponent_high_x10}, got ${v4.bytes[record + 1]}`);
        check(v4.bytes[record + 2] === 0,
            `level ${index}: byte 2 must stay reserved, got ${v4.bytes[record + 2]}`);
        check(parsed.curve_exponent_high_x10 === source.curve_exponent_high_x10,
            `level ${index}: upper gamma did not survive the round trip`);
        check(parsed.progression_pct === 0,
            `level ${index}: progression must read back as 0 in Power Curve`);
        check(parsed.support_ratio_pct === 0,
            `level ${index}: support_ratio must read back as 0 in Power Curve`);
    } else {
        check(wireByte === source.progression_pct,
            `level ${index}: byte 9 must be progression ${source.progression_pct}, got ${wireByte}`);
        check(parsed.progression_pct === source.progression_pct,
            `level ${index}: progression did not survive the round trip`);
        check(parsed.support_ratio_pct === source.support_ratio_pct,
            `level ${index}: support_ratio did not survive the round trip`);
        check(parsed.curve_exponent_x10 === 15 && parsed.curve_exponent_high_x10 === 15,
            `level ${index}: non-curve level must report the default gammas`);
    }
});

// --- old controllers never receive v4 ---
const v3 = roundTrip(bank(3, [level({ mode_type: 2, progression_pct: 55 }), level({}), level({}), level({}), level({})]));
check(v3.bytes[2] === 3, 'a controller that reported v3 must be written back as v3');
check(v3.bytes.length === 189, 'v3 blob length unchanged');
check(v3.parsed.levels[0].progression_pct === 55, 'v3 progression round trip');
const noVersion = roundTrip(bank(undefined, [level({}), level({}), level({}), level({}), level({})]));
check(noVersion.bytes[2] === 3, 'unknown schema version must fall back to v3, not v4');

// --- everything else must still round trip untouched ---
const reference = level({ mode_type: 2, progression_pct: 40, max_motor_power_w: 750, max_iq_pct: 85, release_ms: 700 });
const other = roundTrip(bank(4, [reference, level({}), level({}), level({}), level({})]));
['mode_type', 'support_ratio_pct', 'support_min_pct', 'support_max_pct', 'reference_power_w',
    'emtb_parameter', 'emtb_reference_voltage_mv', 'torque_assist_factor', 'max_motor_power_w',
    'max_iq_pct', 'minimum_pedal_load_kg', 'startup_boost_strength_pct',
    'startup_boost_end_rpm', 'smooth_start_ms', 'release_ms', 'power_rise_filter_ms',
    'power_fall_filter_ms'].forEach((key) => {
    check(other.parsed.levels[0][key] === reference[key],
        `field ${key} changed across the round trip: ${reference[key]} -> ${other.parsed.levels[0][key]}`);
});

// --- corrupted blobs are still rejected ---
const broken = v4.bytes.slice();
broken[20] ^= 0xFF;
check(BafangCanControllerParser.bankBlob({ data: broken }).parseError === true, 'bad CRC must be rejected');
const badVersion = v4.bytes.slice();
badVersion[2] = 9;
check(BafangCanControllerParser.bankBlob({ data: badVersion }).parseError === true, 'unknown version must be rejected');
check(BafangCanControllerParser.bankBlob({ data: v4.bytes.slice(0, 100) }).parseError === true, 'short blob must be rejected');

console.log(failures === 0 ? 'FW-056 bank blob round trip: PASS' : `FW-056 bank blob round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
