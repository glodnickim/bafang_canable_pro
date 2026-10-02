// TASK-EVD-TQ-06-G1: 0x6029 ride diagnostics v8 (TQ-06 G53 map, 71 B) and v9 (77 B: + G53 PI #1
// battery-current limiter and hard trip). The frames are BUILT the way the firmware builds them
// (motor-controller-firmware src/CAN_Display.c, case 0x6029; protocol/RIDE_DIAGNOSTICS_6029.md)
// and checked against the values put in - never against the decoder's own output.
//
// Run from the Canable project root:  node tests/tq06_g1_ride_diag_v8_v9.js

'use strict';
const path = require('path');
const { BafangCanControllerParser } = require(path.join(__dirname, '..', 'bafang-parser'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const eq = (got, want, label) => check(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

function crc16(d, n) {
    let c = 0xFFFF;
    for (let i = 0; i < n; i++) { c ^= d[i] << 8; for (let b = 0; b < 8; b++) c = ((c & 0x8000) ? (c << 1) ^ 0x1021 : c << 1) & 0xFFFF; }
    return c;
}
function put16(d, o, v) { d[o] = v & 0xFF; d[o + 1] = (v >> 8) & 0xFF; }

function build(version) {
    const body = version >= 9 ? 75 : 69;
    const d = new Array(body + 2).fill(0);
    d[0] = 0x44; d[1] = 0x47; d[2] = version; d[3] = 2;
    d[5] = 0x01 | 0x02 | 0x80;          // permitted, forward, PWM on
    put16(d, 20, 2534);                 // 25.34 km/h
    put16(d, 26, 0xFF9C);               // final allowed Iq = -100
    put16(d, 41, 48210);                // pack voltage
    d[43] = 77;                         // cadence
    d[34] = 0x01 | (version >= 9 ? 0x02 : 0);
    d[44] = 0x02 | 0x80;                // battery limited, G53 normal permission
    d[45] = 0xFF;                       // PAS direction -1
    put16(d, 50, 3399);                 // M2AA
    d[52] = 5 | 0x10;                   // BYPASS, QUIET
    put16(d, 53, 2050);                 // 20.50 kg
    put16(d, 63, 237);
    if (version >= 9) {
        put16(d, 69, 2595);             // g1
        put16(d, 71, 1903);             // 19.03 A
        put16(d, 73, 2);                // two trips
    }
    put16(d, body, crc16(d, body));
    return d;
}

// v9
{
    const r = BafangCanControllerParser.rideDiagnostics({ data: build(9) });
    check(!r.parseError, `v9 decodes (${r.error})`);
    eq(r.version, 9, 'v9 version');
    eq(r.speed_x100, 2534, 'v9 speed');
    eq(r.final_iq_allowed, -100, 'v9 signed final Iq');
    eq(r.pack_voltage_mv, 48210, 'v9 pack voltage');
    eq(r.cadence_now, 77, 'v9 cadence');
    eq(r.battery_limiting, true, 'v9 byte 34 bit0');
    eq(r.battery_trip_latched, true, 'v9 byte 34 bit1 = hard trip latched');
    eq(r.battery_limited, true, 'v9 byte 44 bit1');
    eq(r.g53_normal_permission, true, 'v9 byte 44 bit7');
    eq(r.g53_pas_direction, -1, 'v9 PAS direction i8');
    eq(r.m2aa, 3399, 'v9 M2AA');
    eq(r.fis_mode, 5, 'v9 fis mode');
    eq(r.zero_policy_quiet, true, 'v9 zero policy');
    eq(r.pedal_load_kg, 20.5, 'v9 pedal load');
    eq(r.iq_request_before_limits, 237, 'v9 pre-limit Iq');
    eq(r.g1_q12, 2595, 'v9 g1 raw');
    eq(r.limiter_feedback_a, 19.03, 'v9 limiter feedback A');
    eq(r.hard_trip_count, 2, 'v9 trip count');
}
// v8: same map, the v9-only fields are null (not reported), never 0
{
    const r = BafangCanControllerParser.rideDiagnostics({ data: build(8) });
    check(!r.parseError, `v8 decodes (${r.error})`);
    eq(r.version, 8, 'v8 version');
    eq(r.m2aa, 3399, 'v8 M2AA');
    eq(r.g1_q12, null, 'v8 has no g1');
    eq(r.battery_trip_latched, null, 'v8 has no trip flag');
    eq(r.hard_trip_count, null, 'v8 has no trip count');
}
// rejections
{
    const bad = build(9); bad[71] ^= 0x01;
    check(BafangCanControllerParser.rideDiagnostics({ data: bad }).parseError, 'v9 CRC mismatch rejected');
    const v10 = build(9); v10[2] = 10;
    check(BafangCanControllerParser.rideDiagnostics({ data: v10 }).parseError, 'unknown version 10 rejected');
    const shortV9 = build(9).slice(0, 71);
    check(BafangCanControllerParser.rideDiagnostics({ data: shortV9 }).parseError, 'v9 truncated to the v8 length rejected');
}

if (failures) { console.log(`TQ-06-G1 ride diagnostics v8/v9: ${failures} FAILED`); process.exit(1); }
console.log('TQ-06-G1 ride diagnostics v8/v9: ALL CHECKS PASSED');
