// FW-129 host test: tuning blob v8 carries ASSIST TORQUE FULL SCALE and CRANK LENGTH.
// Run from the Canable project root: node tests/fw129_tuning_v8_roundtrip.js
//
// v8 spends two of the three u16 that v6 reserved (offsets 24 and 26) and changes nothing
// else: same 32 B, same CRC position, same frame count. The risks worth a test are therefore
// not about the two new numbers on their own but about the seams around them:
//
//   - a v8 blob must still be 32 B, or the 0x6023/0x6024 transfer changes shape;
//   - writing to a pre-v8 controller must leave those bytes ZERO, because that firmware
//     reserves them and a value there would only make the echo differ from what was sent;
//   - reading a pre-v8 blob must show the FIRMWARE DEFAULTS, never the reserved zeros -
//     "0 kg full scale" is a division by zero in the preview maths and "0 mm crank" makes
//     every rider-power figure zero;
//   - the whole point of the card is that these two are ride-feel settings, not sensor
//     calibration, so the UI must not present them as anything else.

'use strict';
const path = require('path');
const fs = require('fs');
const { BafangCanControllerParser } = require(path.join(__dirname, '..', 'bafang-parser'));
const canbus = require(path.join(__dirname, '..', 'canbus'));
const serializeTuning = canbus.constructor.serializeTuningBlob;

let failures = 0;
const check = (ok, label) => {
    if (!ok) { failures++; console.log(`  FAIL  ${label}`); }
    return ok;
};

const base = {
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300, iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20, assist_run_deadband_mv: 5, assist_hold_ms: 1400,
    assist_min_iq_pct: 2, assist_start_steps: 7, assist_torque_run_window_deg: 180,
};
const u16at = (d, o) => d[o] | (d[o + 1] << 8);
const parse = (d) => BafangCanControllerParser.tuningBlob({ data: d });

// --- geometry: the length is the transport contract and must not move ------

{
    const d = serializeTuning({ ...base, tuning_schema_version: 8 });
    check(d.length === 32, 'v8 is still exactly 32 B');
    check(d[2] === 8, 'v8 version byte');
    check(u16at(d, 28) === 0, 'the third reserved u16 stays reserved');
    // CRC is where it always was.
    let crc = 0xFFFF;
    for (let i = 0; i < 30; i++) {
        crc ^= d[i] << 8;
        for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
    }
    check(u16at(d, 30) === crc, 'CRC still covers bytes 0..29 and sits at 30..31');
}

// --- writing ---------------------------------------------------------------

{
    const d = serializeTuning({
        ...base, tuning_schema_version: 8,
        assist_torque_full_scale_centikg: 4000, crank_length_mm: 175,
    });
    check(u16at(d, 24) === 4000, 'v8 writes assist torque full scale at offset 24');
    check(u16at(d, 26) === 175, 'v8 writes crank length at offset 26');
}

// Out-of-range values are clamped, never wrapped: a wrapped full scale would be a
// wildly wrong assist curve, and the firmware would clamp it anyway - disagreeing
// with what the tool showed the rider.
{
    const low = serializeTuning({
        ...base, tuning_schema_version: 8,
        assist_torque_full_scale_centikg: 1, crank_length_mm: 10,
    });
    check(u16at(low, 24) === 2000, 'under-range full scale clamps to 20.0 kg');
    check(u16at(low, 26) === 150, 'under-range crank clamps to 150 mm');
    const high = serializeTuning({
        ...base, tuning_schema_version: 8,
        assist_torque_full_scale_centikg: 60000, crank_length_mm: 900,
    });
    check(u16at(high, 24) === 12000, 'over-range full scale clamps to 120.0 kg');
    check(u16at(high, 26) === 190, 'over-range crank clamps to 190 mm');
}

// Negotiating down: on a pre-v8 controller these bytes are RESERVED. Writing a value
// there would be read by that firmware as nothing at all, and would make the blob it
// echoes back differ from the one the tool sent.
{
    for (const version of [5, 6, 7]) {
        const d = serializeTuning({
            ...base, tuning_schema_version: version,
            assist_torque_full_scale_centikg: 4000, crank_length_mm: 175,
        });
        check(d[2] === version, `negotiates down to v${version}`);
        if (d.length > 26) {
            check(u16at(d, 24) === 0 && u16at(d, 26) === 0,
                `v${version} leaves the reserved bytes at zero`);
        }
    }
}

// --- reading ---------------------------------------------------------------

{
    let ok = true;
    for (const centikg of [2000, 4000, 6000, 9500, 12000]) {
        const d = serializeTuning({
            ...base, tuning_schema_version: 8, assist_torque_full_scale_centikg: centikg,
            crank_length_mm: 165,
        });
        ok = ok && parse(d).assist_torque_full_scale_centikg === centikg;
    }
    check(ok, 'v8 round-trips every full-scale setting unchanged');

    ok = true;
    for (const mm of [150, 165, 170, 175, 190]) {
        const d = serializeTuning({
            ...base, tuning_schema_version: 8, crank_length_mm: mm,
            assist_torque_full_scale_centikg: 6000,
        });
        ok = ok && parse(d).crank_length_mm === mm;
    }
    check(ok, 'v8 round-trips every crank length unchanged');
}

// A pre-v8 blob has reserved ZEROS there. Reading them literally would mean "0 kg full
// scale" (a division by zero in the preview) and "0 mm crank" (all rider power zero).
// The firmware defaults are what that controller actually behaves as, so that is what
// has to be shown.
{
    for (const version of [6, 7]) {
        const d = serializeTuning({ ...base, tuning_schema_version: version });
        const parsed = parse(d);
        check(parsed.assist_torque_full_scale_centikg === 6000,
            `v${version} blob reads back the 60.0 kg default, not 0`);
        check(parsed.crank_length_mm === 165,
            `v${version} blob reads back the 165 mm default, not 0`);
    }
}

// A malformed v8 blob that somehow carries zeros must be defended against too - the
// same rule, one layer out, because a zero here is never a legitimate setting.
{
    const d = serializeTuning({ ...base, tuning_schema_version: 8 });
    d[24] = 0; d[25] = 0; d[26] = 0; d[27] = 0;
    let crc = 0xFFFF;
    for (let i = 0; i < 30; i++) {
        crc ^= d[i] << 8;
        for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
    }
    d[30] = crc & 0xFF; d[31] = (crc >> 8) & 0xFF;
    const parsed = parse(d);
    check(parsed.assist_torque_full_scale_centikg === 6000, 'zeroed v8 full scale falls back to the default');
    check(parsed.crank_length_mm === 165, 'zeroed v8 crank length falls back to the default');
}

// --- UI agrees with the wire ----------------------------------------------

{
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'dynamics.js'), 'utf8');

    const fullScale = src.slice(src.indexOf("key: 'assist_torque_full_scale_centikg'"));
    const fsRow = fullScale.slice(0, fullScale.indexOf("{ key: 'crank_length_mm'"));
    check(/min:\s*20\b/.test(fsRow) && /max:\s*120\b/.test(fsRow),
        'UI full-scale field is 20..120 kg, matching the firmware clamp');
    check(/unit:\s*'kg'/.test(fsRow), 'UI full-scale field is labelled in kg');
    check(/minTuningSchema:\s*8/.test(fsRow), 'UI full-scale field is gated on tuning schema v8');
    // The card's central point: this is ride feel, not calibration. If the help text ever
    // stops saying so, the rider will reach for it to fix a reading instead of a feel.
    check(/does NOT recalibrate|not recalibrate|does not change the measured kg/i.test(fsRow),
        'UI full-scale help says it does NOT recalibrate the sensor');

    const crank = src.slice(src.indexOf("key: 'crank_length_mm'"));
    const crankRow = crank.slice(0, crank.indexOf("{ key: 'assist_torque_run_window_deg'"));
    check(/min:\s*150\b/.test(crankRow) && /max:\s*190\b/.test(crankRow),
        'UI crank field is 150..190 mm, matching the firmware clamp');
    check(/unit:\s*'mm'/.test(crankRow), 'UI crank field is labelled in mm');
    check(/minTuningSchema:\s*8/.test(crankRow), 'UI crank field is gated on tuning schema v8');

    check(/assist_torque_full_scale_centikg:\s*6000/.test(src), 'UI default full scale is 60.0 kg');
    check(/crank_length_mm:\s*165/.test(src), 'UI default crank length is 165 mm');
}

// The preview charts have to use the SAME two settings, or they draw a bike that does
// not exist. Before this card the preview assumed a fixed 60 kg while the firmware
// normalized by the sensor calibration span - they disagreed by construction.
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'profiles.js'), 'utf8');
    check(/previewAssistTorqueFullScaleKg\(\)/.test(src),
        'preview normalizes the eMTB/Torque axis by the configured full scale');
    check(!/loadKg \* 160 \/ 60\b/.test(src),
        'preview no longer hard-codes a 60 kg torque axis');
    check(/previewCrankLengthMm\(\)/.test(src),
        'preview computes rider power with the configured crank length');
}

console.log(failures === 0
    ? 'FW-129 tuning blob v8 (assist torque full scale + crank length) round trip: PASS'
    : `FW-129 tuning v8 round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
