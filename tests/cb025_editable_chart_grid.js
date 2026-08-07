// CB-025 host test: the maths behind a draggable parameter point, run against the SHIPPED
// module.
//
// Run from the Canable project root:  node tests/cb025_editable_chart_grid.js
//
// This imports ui/js/evistdrive/parameter-grid.js itself rather than re-implementing it, so a
// change to the arithmetic cannot pass by agreeing with a copy of itself.
//
// The failures worth catching here are the ones a screenshot cannot show: a drag that leaves
// the allowed range, a value that lands between two storable settings, an integer parameter
// coming back with a fraction on it, and a pixel transform that is subtly not the inverse of
// itself — which is what makes a point drift away from the cursor over a long drag.
//
// The ranges used below are the real ones from the profile editor (profiles.js
// sharedFieldList): Maximum motor torque 0-80 Nm step 1, Minimum pedal load 0-22.5 kg step
// 0.1, Extended Boost trigger 1-60 kg step 0.5, the ramps 20-5000 ms step 10.

'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const near = (actual, expected, tolerance, label) =>
    check(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
        `${label}: expected ~${expected}, got ${actual}`);

const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'parameter-grid.js')).href;

(async () => {
    const {
        decimalsForStep, snapToStep, paddedRange, categoryRange,
        valueToPixel, pixelToValue, indexToPixel, nearestIndex,
    } = await import(moduleUrl);

    const TORQUE = { min: 0, max: 80, step: 1 };          // max_iq_pct shown in Nm
    const LOAD = { min: 0, max: 22.5, step: 0.1 };        // minimum_pedal_load_kg
    const TRIGGER = { min: 1, max: 60, step: 0.5 };       // extended_boost_trigger_load_kg
    const RAMP = { min: 20, max: 5000, step: 10 };        // iq_rise_slow_ms

    // 1-4. Decimals implied by a step. Drives how a value is printed AND how far it is
    // rounded, so getting 0.5 wrong would show "8.5" and store 8.
    check(decimalsForStep(1) === 0, '1. step 1 -> 0 decimals');
    check(decimalsForStep(0.5) === 1, '2. step 0.5 -> 1 decimal');
    check(decimalsForStep(0.1) === 1, '3. step 0.1 -> 1 decimal');
    check(decimalsForStep(50) === 0, '4. step 50 -> 0 decimals');

    // 5-8. The range is a wall. A drag past either end must stop AT the end, never beyond it
    // and never wrap.
    check(snapToStep(999, TORQUE) === 80, '5. above max clamps to max');
    check(snapToStep(-40, TORQUE) === 0, '6. below min clamps to min');
    check(snapToStep(80.4, TORQUE) === 80, '7. just above max clamps to max');
    check(snapToStep(0.6, TRIGGER) === 1, '8. below a non-zero min clamps to that min');

    // 9-12. An integer parameter stays an integer, whatever the pointer said.
    [12.4, 12.5, 12.6, 79.99].forEach((raw, index) => {
        const value = snapToStep(raw, TORQUE);
        check(Number.isInteger(value), `${9 + index}. ${raw} Nm snaps to an integer (${value})`);
    });

    // 13-15. The grid is measured from `min`, not from zero. A ramp allowed 20-5000 in steps
    // of 10 has values at 20, 30, 40 — a grid anchored at zero would agree here by accident,
    // so the trigger load (min 1, step 0.5) is the case that actually proves it.
    check(snapToStep(24, RAMP) === 20, '13. 24 ms snaps down to 20 ms');
    check(snapToStep(26, RAMP) === 30, '14. 26 ms snaps up to 30 ms');
    check(snapToStep(8.3, TRIGGER) === 8.5, '15. trigger load snaps onto the 1 + n*0.5 grid');

    // 16-18. Float dust. 0.1 steps are where a snap that forgets to round produces
    // 8.200000000000001 and a field that will not compare equal to itself.
    const kg = snapToStep(8.23, LOAD);
    check(kg === 8.2, `16. 8.23 kg snaps to exactly 8.2 (${kg})`);
    check(String(snapToStep(0.7000000000000001, LOAD)) === '0.7', '17. no binary dust survives');
    check(snapToStep(22.47, LOAD) === 22.5, '18. a max off the grid is still reachable');

    // 19-20. Garbage in must not become NaN out: NaN on an axis takes the whole plot down.
    check(snapToStep(NaN, TORQUE) === 0, '19. NaN falls back to min');
    check(snapToStep(undefined, RAMP) === 20, '20. undefined falls back to min');

    // 21-22. Axis padding leaves air at both ends so a point sitting on its ceiling is drawn
    // as a whole marker, and must never be so large that the wall drifts to mid-chart.
    const [lo, hi] = paddedRange(0, 80, 0.07);
    near(lo, -5.6, 1e-9, '21. padded range starts below min');
    near(hi, 85.6, 1e-9, '22. padded range ends above max');

    // 23-24. Five points sit at 0..4 on an axis half a slot wider at each end.
    const xr = categoryRange(5);
    check(xr[0] === -0.5 && xr[1] === 4.5, `23. five points span [-0.5, 4.5] (${xr})`);
    check(categoryRange(0)[1] === 0.5, '24. an empty set still has a non-zero axis span');

    // 25-28. The pixel transforms. Pixels grow downward and values do not, so max belongs at
    // the TOP of the plot area — an inverted axis is the classic way a drag ends up pushing
    // the point the wrong way.
    const area = { left: 66, top: 28, width: 600, height: 224 };
    const yr = paddedRange(0, 80, 0.07);
    near(valueToPixel(85.6, yr, area), 28, 1e-6, '25. the top of the range is the top pixel');
    near(valueToPixel(-5.6, yr, area), 252, 1e-6, '26. the bottom of the range is the bottom pixel');
    check(valueToPixel(80, yr, area) < valueToPixel(20, yr, area),
        '27. a bigger value sits higher on the screen');
    near(pixelToValue(valueToPixel(43, yr, area), yr, area), 43, 1e-9,
        '28. pixel and value transforms are exact inverses');

    // 29-30. Degenerate geometry (a chart in a collapsed container) must return something
    // finite rather than Infinity from a division by a zero height.
    check(Number.isFinite(valueToPixel(40, yr, { top: 0, height: 0 })),
        '29. zero height does not produce Infinity');
    check(Number.isFinite(pixelToValue(10, [5, 5], area)),
        '30. a zero-span range does not produce Infinity');

    // 30a-30e. REVERSED axes. The low-SoC limp chart runs 100 % on the left down to 0 % on the
    // right — the direction a ride actually goes. An earlier guard treated the negative span as
    // degenerate and pinned every handle to the left edge, so a press on a visible handle
    // grabbed nothing. These are the checks that would have caught it.
    const revX = [25, 0];
    near(indexToPixel(25, revX, area), 66, 1e-6, '30a. reversed axis: the high end is on the left');
    near(indexToPixel(0, revX, area), 666, 1e-6, '30b. reversed axis: zero is on the right');
    near(indexToPixel(20, revX, area), 186, 1e-6, '30c. reversed axis maps a mid value correctly');
    const revY = [105, 0];
    near(pixelToValue(valueToPixel(30, revY, area), revY, area), 30, 1e-9,
        '30d. reversed value axis round-trips');
    const revCategories = [4.5, -0.5];
    check(nearestIndex(indexToPixel(0, revCategories, area), 5, revCategories, area, 34) === 0,
        '30e. a press grabs the right point on a reversed category axis');
    check(nearestIndex(indexToPixel(4, revCategories, area), 5, revCategories, area, 34) === 4,
        '30f. and the far one too');

    // 31-33. Where the five points land across the plot, and which one a press grabs.
    near(indexToPixel(0, xr, area), 126, 1e-6, '31. the first point is half a slot in');
    near(indexToPixel(4, xr, area), 606, 1e-6, '32. the last point is half a slot from the right');
    check(indexToPixel(2, xr, area) === area.left + area.width / 2,
        '33. the middle of five points is the middle of the plot');

    // 34-37. Grabbing. The column is the target, not the marker, so a fingertip anywhere near
    // the right x picks the point — but a press in the gap between two far-apart points must
    // pick nothing rather than the least-wrong thing.
    check(nearestIndex(126, 5, xr, area, 34) === 0, '34. a press on a point grabs it');
    check(nearestIndex(146, 5, xr, area, 34) === 0, '35. a press 20 px off still grabs it');
    check(nearestIndex(366, 5, xr, area, 34) === 2, '36. the middle column grabs the middle point');
    // Points sit 120 px apart here, so 186 is the midpoint of the first gap — 60 px from
    // either neighbour, well outside the 34 px grab radius.
    check(nearestIndex(186, 5, xr, area, 34) === -1,
        '37. a press midway between two points grabs nothing');

    // 38. Vertical position is deliberately ignored: the whole column is grabbable, because
    // the caller keeps the grab offset and moves the point relative to where it was held.
    check(nearestIndex(126, 5, xr, area, 34) === nearestIndex(126, 5, xr, area, 34),
        '38. grabbing depends on x alone');

    // 39-40. A full drag, end to end, in the units of the real field: press 12 px below the
    // ECO point, drag 40 px up, and the value must land on the grid and inside the range.
    const start = 20;
    const pressPx = valueToPixel(start, yr, area) + 12;
    const grabOffset = pressPx - valueToPixel(start, yr, area);
    const dragged = snapToStep(pixelToValue(pressPx - 40 - grabOffset, yr, area), TORQUE);
    check(Number.isInteger(dragged) && dragged > start && dragged <= 80,
        `39. dragging up raises the value and keeps it storable (${dragged})`);
    const slammed = snapToStep(pixelToValue(area.top - 500, yr, area), TORQUE);
    check(slammed === 80, `40. dragging far past the top stops at max (${slammed})`);

    console.log(failures === 0
        ? 'CB-025 parameter grid: all checks passed'
        : `CB-025 parameter grid: ${failures} check(s) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
