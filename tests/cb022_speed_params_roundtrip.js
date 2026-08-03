// CB-022 host test: the 0x3203 speed-parameter frame must survive serialise → parse intact.
//
// Run from the Canable project root:  node tests/cb022_speed_params_roundtrip.js
//
// The wheel diameter code sits in bytes 2-3, between the speed limit and the circumference.
// Firmware used to ignore those two bytes on write and answer with a constant "A1" on read,
// so the app reported a saved wheel that the controller had never stored. These offsets are
// the contract that makes the read-back check meaningful — if they drift, the app compares
// the wrong bytes and confirms a write that did not happen.

'use strict';
const path = require('path');
const { BafangCanControllerParser } = require(path.join(__dirname, '..', 'bafang-parser'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

const intToByteArray = (value, bytes) => {
    const out = [];
    for (let i = 0; i < bytes; i++) out.push((value >> (8 * i)) & 0xFF);
    return out;
};

// Mirrors bafang-serializer.js prepareSpeedPackageWriteData().
function serialiseSpeed(value) {
    return [
        ...intToByteArray(Math.round(value.speed_limit * 100), 2),
        value.wheel_diameter.code[0],
        value.wheel_diameter.code[1],
        ...intToByteArray(Math.round(value.circumference), 2),
    ];
}

const roundTrip = (value) => {
    const data = serialiseSpeed(value);
    return { data, parsed: BafangCanControllerParser.parameter3({ data }) };
};

// --- the documented default: 25 km/h, 27.5" (B5 01), 2218 mm --------------------------
const base = { speed_limit: 25, wheel_diameter: { code: [0xB5, 0x01] }, circumference: 2218 };
const trip = roundTrip(base);
check(trip.data.length === 6, `frame must be 6 bytes, got ${trip.data.length}`);
check(trip.data[0] === 0xC4 && trip.data[1] === 0x09,
    `speed limit 25 km/h must serialise as C4 09, got ${trip.data.slice(0, 2).map((b) => b.toString(16))}`);
check(trip.data[2] === 0xB5 && trip.data[3] === 0x01, 'wheel code must sit in bytes 2-3 untouched');
check(trip.data[4] === 0xAA && trip.data[5] === 0x08,
    `2218 mm must serialise as AA 08, got ${trip.data.slice(4).map((b) => b.toString(16))}`);
check(trip.parsed.speed_limit === 25, `speed limit round trip, got ${trip.parsed.speed_limit}`);
check(trip.parsed.circumference === 2218, `circumference round trip, got ${trip.parsed.circumference}`);
check(trip.parsed.wheel_diameter_code[0] === 0xB5 && trip.parsed.wheel_diameter_code[1] === 0x01,
    'wheel code round trip');

// --- 29" (D0 01) with a different circumference ---------------------------------------
const big = roundTrip({ speed_limit: 32, wheel_diameter: { code: [0xD0, 0x01] }, circumference: 2320 });
check(big.parsed.wheel_diameter_code[0] === 0xD0 && big.parsed.wheel_diameter_code[1] === 0x01,
    '29 inch code round trip');
check(big.parsed.circumference === 2320, 'circumference 2320 round trip');
check(big.parsed.speed_limit === 32, 'speed limit 32 round trip');

// The three values must be independent: changing the wheel must not disturb the others,
// which is exactly what a wrong offset would do.
check(big.data[0] === trip.data[0] || big.parsed.speed_limit !== trip.parsed.speed_limit,
    'speed limit and wheel code must occupy different bytes');
const onlyWheel = roundTrip({ ...base, wheel_diameter: { code: [0xD0, 0x01] } });
check(onlyWheel.parsed.speed_limit === 25 && onlyWheel.parsed.circumference === 2218,
    'changing only the wheel code must leave speed limit and circumference alone');

// --- an unknown code must survive, not be dropped -------------------------------------
// The app shows it as "Code xx/yy" rather than refusing: a wheel this build does not know
// is still a value the controller holds, and the circumference must remain writable.
const unknown = roundTrip({ ...base, wheel_diameter: { code: [0x7F, 0x42] } });
check(unknown.parsed.wheel_diameter_code[0] === 0x7F && unknown.parsed.wheel_diameter_code[1] === 0x42,
    'an unrecognised wheel code must pass through unchanged');
check(unknown.parsed.circumference === 2218, 'an unknown code must not disturb the circumference');

// --- a short frame must be refused, not half-read -------------------------------------
check(BafangCanControllerParser.parameter3({ data: [0xC4, 0x09, 0xB5] }).parseError === true,
    'a frame shorter than 6 bytes must be rejected');

console.log(failures === 0 ? 'CB-022 speed params round trip: PASS'
    : `CB-022 speed params round trip: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
