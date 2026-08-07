// CB-024 host test: the motor-ceiling maths, run against the SHIPPED module.
//
// Run from the Canable project root:  node tests/cb024_motor_limits.js
//
// This imports ui/js/evistdrive/motor-limits.js itself rather than re-implementing it, so a
// change to the arithmetic cannot pass by agreeing with a copy of itself. The module is an
// ES module for the browser; Node reaches it through a dynamic import.
//
// The failures worth catching here are the quiet ones: a division by zero at 0 rpm producing
// Infinity on a chart axis, a percentage outside 0-100 sailing through into a torque figure,
// and the wire format changing because a display unit leaked into the profile object.

'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const near = (actual, expected, tolerance, label) =>
    check(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${label}: expected ~${expected}, got ${actual}`);

const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'motor-limits.js')).href;

(async () => {
    const {
        M820_MAX_TORQUE_NM, PREVIEW_EFFICIENCY, MAX_PREVIEW_CADENCE_RPM,
        iqPercentToTorqueNm, torqueNmToIqPercent,
        calculateMotorLimitPoint, buildMotorLimitSeries,
    } = await import(moduleUrl);

    check(M820_MAX_TORQUE_NM === 80, `M820 reference torque is 80 Nm (${M820_MAX_TORQUE_NM})`);
    check(PREVIEW_EFFICIENCY === 0.8, `preview efficiency is 0.80 (${PREVIEW_EFFICIENCY})`);
    check(MAX_PREVIEW_CADENCE_RPM === 120, 'preview cadence axis ends at 120 rpm');

    // 1-3. The percent -> Nm map the rider reads off the slider.
    check(iqPercentToTorqueNm(0) === 0, '1. 0% is 0 Nm');
    check(iqPercentToTorqueNm(50) === 40, '2. 50% is 40 Nm');
    check(iqPercentToTorqueNm(100) === 80, '3. 100% is 80 Nm');
    check(iqPercentToTorqueNm(25) === 20, '25% is 20 Nm');
    check(iqPercentToTorqueNm(75) === 60, '75% is 60 Nm');

    // 4. ...and back, because what the slider writes must be storable as whole percent.
    check(torqueNmToIqPercent(60) === 75, '4. 60 Nm is 75%');
    check(torqueNmToIqPercent(0) === 0, '0 Nm is 0%');
    check(torqueNmToIqPercent(80) === 100, '80 Nm is 100%');
    // Round-trip through the wire unit: every whole percent survives.
    for (let pct = 0; pct <= 100; pct++) {
        const back = torqueNmToIqPercent(iqPercentToTorqueNm(pct));
        check(back === pct, `round trip ${pct}% -> ${iqPercentToTorqueNm(pct)} Nm -> ${back}%`);
    }

    // 5. No power ceiling means the torque ceiling is the whole story.
    {
        const point = calculateMotorLimitPoint({
            cadenceRpm: 90, maxIqPct: 100, maxMotorPowerW: 0,
        });
        check(point.availableTorqueNm === 80, '5. 0 W does not limit torque');
        check(point.powerTorqueLimitNm === null, '5. and reports no power-derived limit');
        check(point.activeLimiter === 'none', '5. nothing is limiting at 100% with no ceiling');
    }

    // 6. THE ZERO-RPM CASE: no division by zero, no Infinity, no NaN reaching a chart.
    {
        const point = calculateMotorLimitPoint({
            cadenceRpm: 0, maxIqPct: 75, maxMotorPowerW: 600,
        });
        check(point.availableTorqueNm === 60, '6. full torque ceiling is available at 0 rpm');
        check(point.mechanicalPowerW === 0, '6. mechanical power is 0 W at 0 rpm');
        check(point.electricalPowerW === 0, '6. electrical power is 0 W at 0 rpm');
        check(point.powerTorqueLimitNm === null, '6. the power ceiling is not a torque here');
        [point.availableTorqueNm, point.mechanicalPowerW, point.electricalPowerW]
            .forEach((value, index) => check(Number.isFinite(value),
                `6. value ${index} is finite, not NaN/Infinity (${value})`));
    }

    // 7. The worked example: 600 W at 80% efficiency and 60 rpm.
    //    480 W mechanical / (60 rpm -> 6.283 rad/s) = 76.4 Nm.
    {
        const point = calculateMotorLimitPoint({
            cadenceRpm: 60, maxIqPct: 100, maxMotorPowerW: 600,
        });
        near(point.powerTorqueLimitNm, 76.4, 0.1, '7. power-derived torque limit at 60 rpm');
        check(point.availableTorqueNm === Math.min(80, point.powerTorqueLimitNm),
            '7. the lower of the two ceilings wins');
        check(point.activeLimiter === 'power', '7. and it is the power one here');
    }

    // 8. The power curve rises while torque-limited, then sits flat on the ceiling.
    {
        const series = buildMotorLimitSeries({ maxIqPct: 100, maxMotorPowerW: 600 });
        const maxPower = Math.max(...series.electricalPowerW);
        near(maxPower, 600, 0.001, '8. power never exceeds the ceiling');
        check(series.electricalPowerW[0] === 0, '8. and starts from 0 W at 0 rpm');
        const top = series.points[series.points.length - 1];
        near(top.electricalPowerW, 600, 0.001, '8. still on the ceiling at 120 rpm (plateau)');
        // Monotonic: a limit envelope must never dip as cadence rises.
        let monotonic = true;
        for (let i = 1; i < series.electricalPowerW.length; i++) {
            if (series.electricalPowerW[i] < series.electricalPowerW[i - 1] - 1e-9) monotonic = false;
        }
        check(monotonic, '8. no invented dip at high cadence');
        check(series.crossoverRpm !== null && series.crossoverRpm > 0,
            `8. the crossover cadence is reported (${series.crossoverRpm})`);
        // Below the crossover the torque ceiling rules; above it the power one does.
        const below = series.points.find((p) => p.cadenceRpm < series.crossoverRpm && p.cadenceRpm > 0);
        const above = series.points.find((p) => p.cadenceRpm > series.crossoverRpm);
        check(below.activeLimiter !== 'power', '8. torque-limited below the crossover');
        check(above.activeLimiter === 'power', '8. power-limited above it');
    }
    {
        // With no ceiling the power line keeps climbing and never plateaus.
        const series = buildMotorLimitSeries({ maxIqPct: 100, maxMotorPowerW: 0 });
        check(series.crossoverRpm === null, '8. no crossover without a power ceiling');
        const last = series.electricalPowerW[series.electricalPowerW.length - 1];
        check(last > 900, `8. unlimited power keeps rising with cadence (${Math.round(last)} W)`);
    }

    // 9. Rubbish in, safe values out. Every one of these has a plausible source: an empty
    //    input box, an unread profile, a hand-edited preset.
    {
        check(iqPercentToTorqueNm(-40) === 0, '9. negative percent clamps to 0 Nm');
        check(iqPercentToTorqueNm(250) === 80, '9. over-range percent clamps to full torque');
        check(iqPercentToTorqueNm(NaN) === 0, '9. NaN percent is 0 Nm');
        check(iqPercentToTorqueNm(undefined) === 0, '9. missing percent is 0 Nm');
        check(torqueNmToIqPercent(-10) === 0, '9. negative torque is 0%');
        check(torqueNmToIqPercent(500) === 100, '9. over-range torque is 100%');
        // Garbage must fail SAFE. Infinity is not "as much as possible" — it is a broken
        // input, and a broken input that turned into full motor torque would be the worst
        // possible reading of it.
        check(torqueNmToIqPercent(Infinity) === 0, '9. Infinity torque falls back to 0%, not full power');
        check(torqueNmToIqPercent(NaN) === 0, '9. NaN torque falls back to 0%');

        const empty = calculateMotorLimitPoint();
        check(empty.availableTorqueNm === 0 && empty.electricalPowerW === 0,
            '9. no options at all yields zeros, not a crash');
        const nasty = calculateMotorLimitPoint({
            cadenceRpm: -30, maxIqPct: 900, maxMotorPowerW: -500,
        });
        check(nasty.cadenceRpm === 0, '9. negative cadence clamps to 0');
        check(nasty.availableTorqueNm === 80, '9. over-range percent still clamps to 80 Nm');
        check(nasty.electricalPowerW === 0, '9. negative power ceiling never goes negative');
        const zeroEta = calculateMotorLimitPoint({
            cadenceRpm: 60, maxIqPct: 50, maxMotorPowerW: 400, efficiency: 0,
        });
        [zeroEta.availableTorqueNm, zeroEta.electricalPowerW].forEach((value) =>
            check(Number.isFinite(value), `9. a zero efficiency cannot divide to Infinity (${value})`));
        const series = buildMotorLimitSeries({ maxIqPct: NaN, maxMotorPowerW: NaN, stepRpm: 0 });
        check(series.points.length > 1 && series.points.every((p) =>
            Number.isFinite(p.availableTorqueNm) && Number.isFinite(p.electricalPowerW)),
        '9. a series built from nonsense still contains only finite numbers');
    }

    // 10. THE ONE THAT MATTERS FOR THE BIKE: this is presentation only. The profile object
    //     and the wire format keep exactly the two integer fields they always had.
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'motor-limits.js'), 'utf8');
        check(!/import\s/.test(source) && !/require\(/.test(source),
            '10. the calc module stays dependency-free');
        check(!/torque_nm|torqueNm\s*:/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')) ||
            !/max_torque/.test(source),
            '10. no Nm field is invented for the profile');

        const canbus = fs.readFileSync(path.join(__dirname, '..', 'canbus.js'), 'utf8');
        check(/u16\(r \+ 15, lv\.max_motor_power_w\); d\[r \+ 17\] = lv\.max_iq_pct & 0xFF;/.test(canbus),
            '10. the bank serializer still writes exactly max_motor_power_w and max_iq_pct');
        check(!/torqueNm/.test(canbus), '10. no Nm value reaches the serializer');

        const parser = fs.readFileSync(path.join(__dirname, '..', 'bafang-parser.js'), 'utf8');
        check(/max_motor_power_w: u16\(r \+ 15\), max_iq_pct: d\[r \+ 17\]/.test(parser),
            '10. the parser still reads both fields from their own offsets');

        const profiles = fs.readFileSync(
            path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'profiles.js'), 'utf8');
        check(/key: 'max_iq_pct'/.test(profiles) && /toNative: \(nm\) => torqueNmToIqPercent\(nm\)/.test(profiles),
            '10. the torque slider converts back to max_iq_pct before storing');
        // "0 disables" is still true and still said for eMTB sensitivity and Extended Boost
        // duration. What must never come back is saying it about the POWER ceiling, where 0
        // means "no extra limit" and reads as "no motor".
        const powerField = profiles.slice(
            profiles.indexOf("key: 'max_motor_power_w'"),
            profiles.indexOf("key: 'max_iq_pct'"));
        check(!/disable/i.test(powerField),
            '10. the power ceiling never claims that 0 disables anything');
        check(/No extra power limit/.test(powerField),
            '10. it says what 0 actually means instead');
        check(/type: 'toggleValue'/.test(profiles),
            '10. the power ceiling is an explicit on/off switch');
    }

    // The preset importer clamps in DISPLAY units. Before CB-024 it compared a native value
    // against display bounds, which turned 36000 mV into 84 and a 1.5 gamma into 2.5.
    {
        const presets = fs.readFileSync(
            path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'presets.js'), 'utf8');
        check(/const nativeMin = Number\.isFinite\(field\.min\) \? Number\(toNative\(field\.min\)\)/.test(presets),
            'importer: the display bounds are translated into the stored unit before comparing');

        // Model of the fixed clampInto, checked against the descriptors that actually differ.
        const clampOne = (field, value) => {
            const toNative = field.toNative || ((s) => s);
            const nativeMin = Number.isFinite(field.min) ? Number(toNative(field.min)) : -Infinity;
            const nativeMax = Number.isFinite(field.max) ? Number(toNative(field.max)) : Infinity;
            if (value < nativeMin) return nativeMin;
            if (value > nativeMax) return nativeMax;
            return value;
        };
        const volts = { min: 12, max: 84, fromNative: (v) => Math.round(v / 1000), toNative: (v) => Math.round(v * 1000) };
        check(clampOne(volts, 36000) === 36000, 'importer: 36000 mV survives (was clamped to 84)');
        check(clampOne(volts, 90000) === 84000, 'importer: a genuinely too-high voltage clamps to 84 V');
        const gamma = { min: 0.3, max: 2.5, fromNative: (v) => v / 10, toNative: (v) => Math.round(v * 10) };
        check(clampOne(gamma, 15) === 15, 'importer: a 1.5 gamma survives (was clamped to 2.5)');
        const torque = { min: 0, max: 80, fromNative: iqPercentToTorqueNm, toNative: torqueNmToIqPercent };
        check(clampOne(torque, 100) === 100, 'importer: 100% survives the Nm-displayed field');
        check(clampOne(torque, 250) === 100, 'importer: an impossible 250% clamps to 100%');
        const plain = { min: 0, max: 1000 };
        check(clampOne(plain, 5000) === 1000, 'importer: fields without a conversion are unchanged');
    }

    console.log(failures === 0
        ? 'CB-024 motor limit maths: PASS'
        : `CB-024 motor limit maths: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.error('CB-024 test crashed:', error);
    process.exit(1);
});
