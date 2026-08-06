// FW-085 host test: the RUN smoothing window is CRANK DEGREES from tuning blob v7 on.
// Run from the Canable project root: node tests/fw085_tuning_window_roundtrip.js
//
// Offset 20 keeps its position but changes UNIT between v6 (milliseconds) and
// v7 (crank degrees). That is the whole risk of this card: the same two bytes mean
// two different things depending on one version byte, so both directions need
// covering — writing to an old controller and reading a blob written by one.

'use strict';
const path = require('path');
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
    assist_min_iq_pct: 2, assist_start_steps: 7,
};
const u16at = (d, o) => d[o] | (d[o + 1] << 8);
const parse = (d) => BafangCanControllerParser.tuningBlob({ data: d });

// --- writing ---------------------------------------------------------------

// v7 geometry is v6's; only the version byte and the meaning of offset 20 differ.
{
    const d = serializeTuning({ ...base, tuning_schema_version: 7, assist_torque_run_window_deg: 180 });
    check(d.length === 32 && d[2] === 7, 'v7 geometry: 32 B, version byte 7');
    check(u16at(d, 20) === 180, 'v7 writes the window in degrees at offset 20');
}

// Out-of-range degrees are clamped, never wrapped.
{
    const d = serializeTuning({ ...base, tuning_schema_version: 7, assist_torque_run_window_deg: 5000 });
    check(u16at(d, 20) === 360, 'v7 clamps an over-range window to 360');
}

// The setting has nowhere to go on a pre-FW-085 controller. It must send that
// firmware's own millisecond default, NOT the degree number — 180 written to a v6
// controller would be silently taken as 180 ms.
{
    const d = serializeTuning({ ...base, tuning_schema_version: 6, assist_torque_run_window_deg: 180 });
    check(d.length === 32 && d[2] === 6, 'negotiates down to v6 geometry');
    check(u16at(d, 20) === 300, 'v6 fallback writes the firmware ms default, not the degree value');
}
{
    const d = serializeTuning({ ...base, tuning_schema_version: 5, assist_torque_run_window_deg: 180 });
    check(d.length === 24 && d[2] === 5, 'still negotiates down to v5');
}

// --- reading ---------------------------------------------------------------

// v7 values are taken literally across the whole range.
{
    let ok = true;
    for (const deg of [0, 15, 90, 180, 270, 360]) {
        const d = serializeTuning({ ...base, tuning_schema_version: 7, assist_torque_run_window_deg: deg });
        ok = ok && parse(d).assist_torque_run_window_deg === deg;
    }
    check(ok, 'v7 round-trips every window setting unchanged');
}

// A v6 blob carries milliseconds. Reading it literally would show 700 ms as 700°
// (clamped to 360) and silently double the smoothing the rider had configured.
// There is no honest conversion, so everything except "off" falls back to default.
{
    const withMs = (ms) => {
        const d = serializeTuning({ ...base, tuning_schema_version: 6, assist_torque_run_window_deg: 0 });
        d[20] = ms & 0xFF; d[21] = (ms >> 8) & 0xFF;
        // CRC must be recomputed after poking the body.
        let crc = 0xFFFF;
        for (let i = 0; i < 30; i++) {
            crc ^= d[i] << 8;
            for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
        }
        d[30] = crc & 0xFF; d[31] = (crc >> 8) & 0xFF;
        return parse(d).assist_torque_run_window_deg;
    };
    check(withMs(0) === 0, 'v6 disabled stays disabled');
    check(withMs(300) === 180, 'v6 300 ms shows as the default window');
    check(withMs(700) === 180, 'v6 700 ms shows as the default window');
    check(withMs(700) !== 360, 'v6 700 ms is NOT read as 700 deg clamped to 360');
    check(withMs(1000) === 180, 'v6 max ms shows as the default window');
}

// The UI field must agree with the wire: degrees, 0..360, stepping in whole
// quadrature steps (15 deg = 4 steps).
{
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'dynamics.js'), 'utf8');
    const field = src.slice(src.indexOf("key: 'assist_torque_run_window_deg'"));
    const row = field.slice(0, field.indexOf('},'));
    check(/min:\s*0/.test(row) && /max:\s*360/.test(row) && /step:\s*15/.test(row),
        'UI field is 0..360 in 15 deg steps');
    check(/unit:\s*'°'/.test(row), 'UI field is labelled in degrees');
    check(/assist_torque_run_window_deg:\s*180/.test(src), 'UI default is 180 deg');
}

console.log(failures === 0
    ? 'FW-085 RUN smoothing window (crank degrees) round trip: PASS'
    : `FW-085 round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
