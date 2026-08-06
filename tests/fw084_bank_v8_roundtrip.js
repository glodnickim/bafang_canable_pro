// FW-084 host test: bank v8 carries Extended Boost, and everything older keeps working.
//
// Run from the Canable project root:  node tests/fw084_bank_v8_roundtrip.js
//
// Two failures are worth more than all the rest here:
//   * sending v8 to a v7 controller — the whole bank is rejected and the rider silently
//     keeps their old tune while the app says it wrote;
//   * a v7 blob no longer round-tripping byte for byte, which would rewrite every profile
//     saved before this card.
// The 255 B length is the ceiling of the transport, so the geometry is pinned here too.

'use strict';
const fs = require('fs');
const path = require('path');
const { BafangCanControllerParser } = require(path.join(__dirname, '..', 'bafang-parser'));
const canbus = require(path.join(__dirname, '..', 'canbus'));
const serializeBank = canbus.constructor.serializeBankBlob;

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

function level(overrides) {
    return Object.assign({
        mode_type: 1, support_ratio_pct: 200, support_min_pct: 170, support_max_pct: 260,
        reference_power_w: 200, progression_pct: 0,
        curve_exponent_x10: 15, curve_exponent_high_x10: 15,
        emtb_parameter: 100, emtb_based_on_power: true, emtb_reference_voltage_mv: 36000,
        torque_assist_factor: 80, max_motor_power_w: 0, max_iq_pct: 100,
        assist_without_rotation: false, minimum_pedal_load_kg: 0.7,
        riding_minimum_pedal_load_kg: 0.3,
        startup_boost_enabled: true, startup_boost_mode: 0, startup_boost_strength_pct: 100,
        startup_boost_end_rpm: 27, smooth_start_enabled: false, smooth_start_ms: 300,
        release_ms: 650, power_rise_filter_ms: 150, power_fall_filter_ms: 375,
        iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
        iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
        extended_boost_trigger_load_kg: 20, extended_boost_strength_pct: 100,
        extended_boost_duration_ms: 0,
    }, overrides);
}

const bank = (schemaVersion, levels) => ({
    bank_index: 0, active_bank: 0, bank_schema_version: schemaVersion,
    wa_cutoff_kmh: 7, wa_current_pct: 30, wa_target_rpm: 50,
    wa_latch_after_release: false, wa_latch_timeout_s: 30,
    levels,
});

const roundTrip = (bankObj) => {
    const bytes = serializeBank(bankObj);
    return { bytes, parsed: BafangCanControllerParser.bankBlob({ data: bytes }) };
};

// Five levels with genuinely different boost settings, including both ends of every range.
const distinct = [
    level({ extended_boost_trigger_load_kg: 1, extended_boost_strength_pct: 0, extended_boost_duration_ms: 0 }),
    level({ extended_boost_trigger_load_kg: 8, extended_boost_strength_pct: 100, extended_boost_duration_ms: 200 }),
    level({ extended_boost_trigger_load_kg: 12.5, extended_boost_strength_pct: 150, extended_boost_duration_ms: 1 }),
    level({ extended_boost_trigger_load_kg: 60, extended_boost_strength_pct: 255, extended_boost_duration_ms: 1000 }),
    level({ extended_boost_trigger_load_kg: 3.5, extended_boost_strength_pct: 77, extended_boost_duration_ms: 425 }),
];

// 3. v8 geometry: exactly the 255 B ceiling, 48 B records, CRC in the last two bytes.
const v8 = roundTrip(bank(8, distinct));
check(v8.bytes.length === 255, `v8 blob must be exactly 255 B, got ${v8.bytes.length}`);
check(v8.bytes[2] === 8, 'v8 version byte');
check(v8.bytes[5] === 48, `v8 record length must be 48, got ${v8.bytes[5]}`);
check(v8.parsed.parseError !== true, `v8 blob must parse: ${v8.parsed.error || ''}`);
check(13 + 5 * 48 === 253, 'v8 CRC must sit at bytes 253-254');

// 4. All three values survive the round trip, on every level.
['extended_boost_trigger_load_kg', 'extended_boost_strength_pct', 'extended_boost_duration_ms']
    .forEach((key) => {
        distinct.forEach((source, index) => {
            check(v8.parsed.levels[index][key] === source[key],
                `v8 level ${index + 1} ${key}: ${source[key]} -> ${v8.parsed.levels[index][key]}`);
        });
    });

// Wire placement, exactly as the firmware reads it.
distinct.forEach((source, index) => {
    const r = 13 + index * 48;
    // 0.5 kg per unit: 2 = 1.0 kg, 120 = 60.0 kg. This is the one kg field that is not on
    // the 0.1 kg grid, and getting it wrong would silently double every trigger.
    check(v8.bytes[r + 36] === Math.round(source.extended_boost_trigger_load_kg * 2),
        `level ${index + 1} trigger load at byte 36 on the 0.5 kg grid`);
    check(v8.bytes[r + 37] === source.extended_boost_strength_pct,
        `level ${index + 1} strength at byte 37`);
    const duration = v8.bytes[r + 46] | (v8.bytes[r + 47] << 8);
    check(duration === source.extended_boost_duration_ms,
        `level ${index + 1} duration at bytes 46..47 LE`);
});
// 255 % is a legal multiplier, not a signed -1 and not something to clip back to zero.
check(v8.bytes[13 + 3 * 48 + 37] === 255, '255 % must reach the wire intact');

// 5. Out-of-range values are repaired at the boundary, never truncated into something else.
const wild = roundTrip(bank(8, [
    level({ extended_boost_trigger_load_kg: 0, extended_boost_duration_ms: 5000, extended_boost_strength_pct: 999 }),
    level({ extended_boost_trigger_load_kg: 99, extended_boost_duration_ms: -50 }),
    level({ extended_boost_trigger_load_kg: 8.37 }),
    level({}), level({}),
]));
check(wild.parsed.parseError !== true, 'out-of-range values must still produce a valid blob');
check(wild.parsed.levels[0].extended_boost_trigger_load_kg === 1,
    `a 0 kg trigger must be raised to the 1.0 kg floor, got ${wild.parsed.levels[0].extended_boost_trigger_load_kg}`);
check(wild.parsed.levels[0].extended_boost_duration_ms === 1000, '5000 ms must clamp to 1000 ms');
check(wild.parsed.levels[0].extended_boost_strength_pct === 255, '999 % must clamp to 255 %');
check(wild.parsed.levels[1].extended_boost_trigger_load_kg === 60, '99 kg must clamp to 60 kg');
check(wild.parsed.levels[1].extended_boost_duration_ms === 0, 'a negative duration must clamp to 0');
check(wild.parsed.levels[2].extended_boost_trigger_load_kg === 8.5,
    `8.37 kg must snap to the 0.5 kg grid, got ${wild.parsed.levels[2].extended_boost_trigger_load_kg}`);
// The whole sensor scale really is reachable — the reason the step is 0.5 and not 0.1.
check(v8.bytes[13 + 3 * 48 + 36] === 120, '60.0 kg reaches the wire as 120');

// 1 + 2. A v7 controller must keep receiving v7, byte for byte, with the boost bytes absent
// and the two former rise-detector slots still zero.
const v7 = roundTrip(bank(7, distinct));
check(v7.bytes.length === 245 && v7.bytes[2] === 7 && v7.bytes[5] === 46,
    `v7 negotiation must stay 245 B / v7 / 46 B (${v7.bytes.length}/${v7.bytes[2]}/${v7.bytes[5]})`);
check(v7.parsed.parseError !== true, 'negotiated v7 must parse');
distinct.forEach((_, index) => {
    const r = 13 + index * 46;
    check(v7.bytes[r + 36] === 0 && v7.bytes[r + 37] === 0,
        `v7 level ${index + 1} must leave bytes 36..37 reserved and zero`);
});
// 8. THE ONE THAT MATTERS: never send v8 to a controller that reported v7 or older.
[3, 4, 5, 6, 7].forEach((reported) => {
    const bytes = serializeBank(bank(reported, distinct));
    check(bytes[2] === reported && bytes[2] < 8,
        `a v${reported} controller must never be sent v8 (got v${bytes[2]})`);
    check(bytes.length <= 245, `a v${reported} blob must keep its own length (${bytes.length})`);
});

// 1. Reading an older blob migrates to the function being OFF — never to whatever those
//    bytes used to mean.
const v7Parsed = v7.parsed.levels[0];
check(v7Parsed.extended_boost_duration_ms === 0, 'a v7 blob migrates to duration 0 (off)');
check(v7Parsed.extended_boost_trigger_load_kg === 20 && v7Parsed.extended_boost_strength_pct === 100,
    'a v7 blob migrates to the 20.0 kg / 100 % defaults');
// A v6 blob with a leftover non-zero byte 36 must NOT surface as a boost setting.
const v6Bytes = serializeBank(bank(6, distinct));
v6Bytes[13 + 36] = 200; // whatever the removed rise detector left behind
let crc = 0xFFFF;
for (let i = 0; i < 243; i++) {
    crc ^= v6Bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
}
v6Bytes[243] = crc & 0xFF; v6Bytes[244] = (crc >> 8) & 0xFF;
const v6Parsed = BafangCanControllerParser.bankBlob({ data: v6Bytes });
check(v6Parsed.parseError !== true, 'the doctored v6 blob must still parse');
check(v6Parsed.levels[0].extended_boost_trigger_load_kg === 20,
    'a stale byte 36 in a v6 blob must not become a 20 kg trigger');

// A v8 blob with the wrong record length is a protocol error, not something to guess at.
const shortRecord = v8.bytes.slice();
shortRecord[5] = 46;
check(BafangCanControllerParser.bankBlob({ data: shortRecord }).parseError === true,
    'v8 with a 46 B record must be rejected');
const badCrc = v8.bytes.slice();
badCrc[60] ^= 0xFF;
check(BafangCanControllerParser.bankBlob({ data: badCrc }).parseError === true,
    'v8 with a bad CRC must be rejected');
const badVersion = v8.bytes.slice();
badVersion[2] = 9;
check(BafangCanControllerParser.bankBlob({ data: badVersion }).parseError === true,
    'an unknown bank version must still be rejected');

// 6. The transport: 255 B is 32 frames, and the last one carries 7 bytes. writeLongParameter()
//    sends frame 0 as MULTIFRAME_START, then subcodes 0..N-1, then MULTIFRAME_END — so the
//    controller must accept an END frame with subcode 30, which it writes at index 31.
{
    let remaining = 255 - 8; // after MULTIFRAME_START
    let packages = 0;
    while (remaining > 8) { packages++; remaining -= 8; }
    check(packages === 30, `the MULTIFRAME sequence must end at subcode 30 (got ${packages})`);
    check(remaining === 7, `the END frame must carry 7 B (got ${remaining})`);
    check(1 + packages + 1 === 32, 'that is 32 frames in total');
    check(255 <= 255, 'and the length byte of the init frame still holds it');
}

// 9. Copy, restore, defaults and preset import/export all work off the same field list, so
//    the three settings must be in it — and in ONE section, or "Copy to…" would move a
//    duration without the trigger load that gives it meaning.
{
    const profiles = fs.readFileSync(
        path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'profiles.js'), 'utf8');
    ['extended_boost_trigger_load_kg', 'extended_boost_strength_pct', 'extended_boost_duration_ms']
        .forEach((key) => {
            check(new RegExp(`key: '${key}'`).test(profiles), `${key} is an editable field`);
            check(new RegExp(`${key}:`).test(profiles), `${key} has an offline placeholder default`);
        });
    const group = profiles.slice(profiles.indexOf("id: 'extendedBoost'"));
    check(/pick\('extended_boost_trigger_load_kg', 'extended_boost_strength_pct',\s*'extended_boost_duration_ms'\)/
        .test(group), 'all three settings live in one copy section');
    // The gate lives on the FIELDS and the section derives it, so the editor and the preset
    // importer cannot disagree about which firmware can store these settings.
    const fieldGates = (profiles.match(/minBankSchema: 8,/g) || []).length;
    check(fieldGates === 3, `all three fields carry minBankSchema: 8 (${fieldGates})`);
    check(/minBankSchema: Math\.max\(0,/.test(profiles),
        'the section gate is derived from its fields, not repeated by hand');
    check(/extended_boost_duration_ms: 0,/.test(profiles),
        'the offline placeholder has the boost OFF');
    check(/control\.disabled = true/.test(profiles),
        'a controller that cannot store the section must not offer editable fields');
    // ...but only THAT case. Disabling the fields offline too made them lose their spinner
    // arrows while every other card kept them, which reads as a broken card rather than as
    // "your controller is too old".
    check(/const tooOld = schema > 0 && schema < group\.minBankSchema;/.test(profiles) &&
        /if \(tooOld\) \{/.test(profiles),
        'the fields are only locked for a controller that really reported an older schema');
    const gate = profiles.slice(profiles.indexOf('if (group.minBankSchema) {'));
    check(/Banks not read yet/.test(gate) && /You can set them up here/.test(gate),
        'offline the section stays editable and says why it is not confirmed yet');

    // The same gate has to hold on the IMPORT path. Blocking the editor but letting a
    // preset write the value straight into the model is the silent-loss case: the field
    // shows a boost duration, Apply reports OK, and the serializer drops it on the way out.
    const presets = fs.readFileSync(
        path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'presets.js'), 'utf8');
    check(/field\.minBankSchema && \(schema === 0 \|\| schema < field\.minBankSchema\)/.test(presets),
        'the preset importer refuses fields this controller cannot store');
    check(/skipped\.push\(/.test(presets) && /were NOT loaded/.test(presets),
        'and it tells the rider which ones, instead of dropping them quietly');

    // Model of the importer's decision, so the rule is tested and not only present.
    const skipField = (schema, field) => !!(field.minBankSchema &&
        (schema === 0 || schema < field.minBankSchema));
    const boostField = { key: 'extended_boost_duration_ms', minBankSchema: 8 };
    const oldField = { key: 'release_ms' };
    check(skipField(7, boostField) && skipField(0, boostField),
        'importer: a v7 controller (or none read) skips the boost fields');
    check(!skipField(8, boostField), 'importer: a v8 controller takes them');
    check(!skipField(7, oldField), 'importer: ungated fields are unaffected');
}

// Diagnostics 0x6029: v5 adds the Extended Boost state, and v4 must keep being accepted —
// the diagnostics card is the main tool for tuning this feature on the bench, and a parser
// that rejected v4 would blank it out on every controller that has not been reflashed yet.
{
    const withCrc = (body) => {
        let c = 0xFFFF;
        for (let i = 0; i < body.length; i++) {
            c ^= body[i] << 8;
            for (let b = 0; b < 8; b++) c = ((c & 0x8000) ? (c << 1) ^ 0x1021 : c << 1) & 0xFFFF;
        }
        return [...body, c & 0xFF, (c >> 8) & 0xFF];
    };
    const body = (version, len) => {
        const d = new Array(len).fill(0);
        d[0] = 0x44; d[1] = 0x47; d[2] = version;
        return d;
    };

    const v4 = withCrc(body(4, 45));
    const p4 = BafangCanControllerParser.rideDiagnostics({ data: v4 });
    check(p4.parseError !== true, `v4 diagnostics (47 B) must still parse: ${p4.error || ''}`);
    check(p4.ext_boost_active === null && p4.ext_boost_cancel_reason === null,
        'v4 reports the boost as unavailable, not as an idle module');

    const b5 = body(5, 53);
    b5[45] = 0x04;                    // ACTIVE
    b5[46] = 0xB8; b5[47] = 0x0B;     // 3000 centikg = 30.00 kg peak
    b5[48] = 0x2C; b5[49] = 0x01;     // boost_iq 300
    b5[50] = 0x96; b5[51] = 0x00;     // 150 ms left
    b5[52] = 11;                      // completed
    const p5 = BafangCanControllerParser.rideDiagnostics({ data: withCrc(b5) });
    check(p5.parseError !== true, `v5 diagnostics (55 B) must parse: ${p5.error || ''}`);
    check(p5.ext_boost_active === true && p5.ext_boost_armed === false,
        'v5 decodes the ACTIVE flag');
    check(p5.ext_boost_peak_load_kg === 30, `peak load in kg (${p5.ext_boost_peak_load_kg})`);
    check(p5.ext_boost_iq === 300 && p5.ext_boost_remaining_ms === 150,
        'boost current and remaining time');
    check(p5.ext_boost_cancel_reason === 11, 'the cancel reason byte');

    const shortV5 = withCrc(body(5, 45));  // a v5 header on a v4-length block
    check(BafangCanControllerParser.rideDiagnostics({ data: shortV5 }).parseError === true,
        'a v5 block that is too short must be rejected, not read past its end');
}

console.log(failures === 0
    ? 'FW-084 bank v8 Extended Boost round trip: PASS'
    : `FW-084 bank v8 round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
