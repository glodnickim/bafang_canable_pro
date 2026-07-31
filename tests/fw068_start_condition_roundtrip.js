// FW-068/FW-069 host test: v6 blobs (bank + tuning) round-trip, and older versions still work.
//
// Run from the Canable project root:  node tests/fw068_start_condition_roundtrip.js
//
// Covers exactly the parts that fail silently if an offset is off by one:
//   * the per-level start condition (u8 on the wire) and the four Iq ramps (u16),
//   * the 10 ms quantisation of the rise window,
//   * the record STRIDE from byte 5 — a v5 record must still parse and get defaults
//     instead of dragging the whole bank down with it,
//   * the 255 B multiframe ceiling, which the blob must never cross,
//   * tuning version negotiation: v6 only to a controller that reported v6.

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

function level(overrides) {
    return Object.assign({
        mode_type: 1, support_ratio_pct: 200, support_min_pct: 170, support_max_pct: 260,
        reference_power_w: 200, progression_pct: 0,
        curve_exponent_x10: 15, curve_exponent_high_x10: 15,
        emtb_parameter: 100, emtb_based_on_power: true, emtb_reference_voltage_mv: 36000,
        torque_assist_factor: 80, max_motor_power_w: 0, max_iq_pct: 100,
        assist_without_rotation: false, without_rotation_threshold_mv: 18,
        startup_boost_enabled: true, startup_boost_mode: 0, startup_boost_strength_pct: 100,
        startup_boost_end_rpm: 27, smooth_start_enabled: false, smooth_start_ms: 300,
        release_ms: 650, power_rise_filter_ms: 150, power_fall_filter_ms: 375,
        start_load_reduction_mv: 0, start_rise_mv: 0, start_rise_window_ms: 400,
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

// --- v6 geometry ---------------------------------------------------------------
// 13 B header + 5 x 46 B + 2 B CRC. The ceiling is not cosmetic: the multiframe
// protocol carries the total length in ONE byte (CAN_Display.c rx_data_length),
// so a blob above 255 B cannot be transferred at all.
const distinct = [
    level({ start_load_reduction_mv: 10, start_rise_mv: 12, start_rise_window_ms: 400,
        iq_rise_slow_ms: 2000, iq_rise_fast_ms: 1500, iq_fall_slow_ms: 900, iq_fall_fast_ms: 120 }),
    level({ start_load_reduction_mv: 0, start_rise_mv: 0, start_rise_window_ms: 0,
        iq_rise_slow_ms: 20, iq_rise_fast_ms: 20, iq_fall_slow_ms: 20, iq_fall_fast_ms: 20 }),
    level({ start_load_reduction_mv: 100, start_rise_mv: 100, start_rise_window_ms: 2000,
        iq_rise_slow_ms: 5000, iq_rise_fast_ms: 5000, iq_fall_slow_ms: 5000, iq_fall_fast_ms: 5000 }),
    level({ start_load_reduction_mv: 33, start_rise_mv: 7, start_rise_window_ms: 250 }),
    level({ start_load_reduction_mv: 5, start_rise_mv: 90, start_rise_window_ms: 1230 }),
];
const v6 = roundTrip(bank(6, distinct));
check(v6.bytes.length === 245, `v6 blob must be 245 B, got ${v6.bytes.length}`);
check(v6.bytes[2] === 6, 'v6 version byte');
check(v6.bytes[5] === 46, `record length byte must be 46, got ${v6.bytes[5]}`);
check(v6.bytes.length <= 255, 'blob must stay under the 255 B multiframe ceiling');
check(v6.parsed.parseError !== true, `v6 blob must parse: ${v6.parsed.error || ''}`);

// --- every new field survives, on every level ----------------------------------
['start_load_reduction_mv', 'start_rise_mv',
    'iq_rise_slow_ms', 'iq_rise_fast_ms', 'iq_fall_slow_ms', 'iq_fall_fast_ms'].forEach((key) => {
    distinct.forEach((src, index) => {
        check(v6.parsed.levels[index][key] === src[key],
            `level ${index + 1} ${key}: ${src[key]} -> ${v6.parsed.levels[index][key]}`);
    });
});

// The window travels in 10 ms units, so it round-trips quantised DOWN, never up:
// a value that grew across the wire would mean the rise detector watches longer
// than the user asked for.
distinct.forEach((src, index) => {
    const expected = Math.floor(src.start_rise_window_ms / 10) * 10;
    check(v6.parsed.levels[index].start_rise_window_ms === expected,
        `level ${index + 1} rise window: ${src.start_rise_window_ms} -> ${v6.parsed.levels[index].start_rise_window_ms}, expected ${expected}`);
});

// --- the old fields must not have moved ----------------------------------------
['mode_type', 'support_ratio_pct', 'support_min_pct', 'support_max_pct', 'reference_power_w',
    'emtb_parameter', 'emtb_reference_voltage_mv', 'torque_assist_factor', 'max_motor_power_w',
    'max_iq_pct', 'without_rotation_threshold_mv', 'startup_boost_strength_pct',
    'startup_boost_end_rpm', 'smooth_start_ms', 'release_ms', 'power_rise_filter_ms',
    'power_fall_filter_ms'].forEach((key) => {
    check(v6.parsed.levels[0][key] === distinct[0][key],
        `field ${key} moved: ${distinct[0][key]} -> ${v6.parsed.levels[0][key]}`);
});

// --- v5 stays writable and readable --------------------------------------------
// A controller that reports v5 must still get a 35 B record; sending it v6 fields it
// cannot store would make it reject the whole bank.
const v5 = roundTrip(bank(5, distinct));
check(v5.bytes.length === 190, `v5 blob must stay 190 B, got ${v5.bytes.length}`);
check(v5.bytes[5] === 35, 'v5 record length byte must stay 35');
check(v5.parsed.parseError !== true, 'v5 blob must still parse');
// Reading a v5 blob with the new parser: the new fields are absent, so the level takes
// the firmware defaults rather than whatever follows the record in memory.
check(v5.parsed.levels[0].start_load_reduction_mv === 0, 'v5 read: reduction defaults to 0');
check(v5.parsed.levels[0].start_rise_mv === 0, 'v5 read: rise defaults to 0');
check(v5.parsed.levels[0].start_rise_window_ms === 400, 'v5 read: window defaults to 400');
check(v5.parsed.levels[0].iq_rise_slow_ms === 600, 'v5 read: rise slow defaults to 600');
check(v5.parsed.levels[0].iq_fall_fast_ms === 140, 'v5 read: fall fast defaults to 140');

// --- corrupted v6 blobs are still rejected -------------------------------------
const brokenCrc = v6.bytes.slice();
brokenCrc[40] ^= 0xFF;
check(BafangCanControllerParser.bankBlob({ data: brokenCrc }).parseError === true,
    'v6 bad CRC must be rejected');
const badVersion = v6.bytes.slice();
badVersion[2] = 9;
check(BafangCanControllerParser.bankBlob({ data: badVersion }).parseError === true,
    'unknown bank version must be rejected');
check(BafangCanControllerParser.bankBlob({ data: v6.bytes.slice(0, 200) }).parseError === true,
    'truncated v6 blob must be rejected');

// --- tuning blob: version negotiation ------------------------------------------
const tuning = {
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300, iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20, assist_run_deadband_mv: 5, assist_hold_ms: 1400,
    assist_min_iq_pct: 2, assist_torque_run_filter_ms: 300, assist_start_steps: 7,
};
const t6 = serializeTuning({ ...tuning, tuning_schema_version: 6 });
check(t6.length === 32, `tuning v6 must be 32 B, got ${t6.length}`);
check(t6[2] === 6, 'tuning v6 version byte');
const t6parsed = BafangCanControllerParser.tuningBlob({ data: t6 });
check(t6parsed.parseError !== true, `tuning v6 must parse: ${t6parsed.error || ''}`);
check(t6parsed.assist_start_steps === 7, `start steps: 7 -> ${t6parsed.assist_start_steps}`);
check(t6parsed.tuning_schema_version === 6, 'parser must report the tuning version back');

// A controller that reported v5 must NOT be sent v6: it rejects an unknown version byte
// outright, which would make the whole Dynamics write fail.
const t5 = serializeTuning({ ...tuning, tuning_schema_version: 5 });
check(t5.length === 24, `tuning v5 must stay 24 B, got ${t5.length}`);
check(t5[2] === 5, 'tuning must negotiate down to v5');
const t5parsed = BafangCanControllerParser.tuningBlob({ data: t5 });
check(t5parsed.parseError !== true, 'negotiated v5 tuning blob must parse');
check(t5parsed.assist_start_steps === 4, 'v5 read: start steps falls back to the default 4');
// No version reported at all (never read) must not be treated as v6 either.
const tNone = serializeTuning(tuning);
check(tNone[2] === 5, 'unknown tuning version must fall back to v5, not v6');

console.log(failures === 0
    ? 'FW-068/069 start condition + ramps round trip: PASS'
    : `FW-068/069 start condition + ramps round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
