// evistdrive/parameter-grid.js — CB-025: the arithmetic behind a draggable parameter point.
//
// Pure functions, no DOM, no Plotly, no app state, no imports — the same rule motor-limits.js
// follows, and for the same reason: this is the part that can be quietly wrong. A snap that
// lands half a step off, a pixel transform that is upside down, or a clamp that lets a drag
// leave the allowed range are all invisible in a screenshot and obvious in a test.
//
// Two jobs live here:
//
//   1. VALUES — putting a dragged number back on the parameter's own grid. The grid is
//      measured from `min`, not from zero: a field allowed 20..5000 in steps of 10 has its
//      values at 20, 30, 40 — never at 0, 10, 20.
//
//   2. GEOMETRY — turning a pointer position into a value and back. The chart owns both axis
//      ranges (they are pinned, so nothing the plotting library does can move them) and knows
//      the rectangle the plot area occupies, which is all this needs.
//
// Nothing here reads or writes a parameter. The caller decides what to do with the number.

/** Decimal places implied by a step: 0.5 -> 1, 0.25 -> 2, 1 -> 0, 50 -> 0. */
export function decimalsForStep(step) {
    if (!Number.isFinite(step) || step <= 0) return 0;
    const text = String(step);
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Put a raw value on the parameter's grid.
 *
 * Clamp -> snap to the grid measured from `min` -> clamp again (a `max` that does not sit on
 * the grid must still be reachable, exactly as the number box allows) -> round to the step's
 * own precision, so a 0.1 grid cannot accumulate binary float dust and an integer parameter
 * always comes back an integer.
 *
 * A non-numeric input falls back to `min` rather than producing NaN, because NaN on a chart
 * axis takes the whole plot down.
 */
export function snapToStep(raw, limits = {}) {
    const { min = 0, max = 100, step = 1 } = limits;
    const decimals = Number.isFinite(limits.decimals) ? limits.decimals : decimalsForStep(step);
    const value = Number(raw);
    if (!Number.isFinite(value)) return min;
    const bounded = Math.min(max, Math.max(min, value));
    const grid = Number.isFinite(step) && step > 0
        ? min + Math.round((bounded - min) / step) * step
        : bounded;
    const factor = 10 ** decimals;
    return Math.round(Math.min(max, Math.max(min, grid)) * factor) / factor;
}

/**
 * Pick the storable value whose curve passes closest to where the pointer is.
 *
 * Some settings shape a curve through arithmetic that cannot be turned round: the Power Curve
 * gammas are a lookup table, the eMTB parameter sits in a clamped denominator, and every
 * "requested power" curve is clipped by a ceiling. Deriving an inverse for each would mean a
 * second implementation of the maths that could disagree with the one actually drawn.
 *
 * So there is no inverse. `evaluate(candidate)` is the SAME forward function the chart draws
 * with, and this walks the parameter's own grid — every value the controller can store, and no
 * others — and keeps the closest. That also makes the result exact by construction rather than
 * exact-then-rounded.
 *
 * Ties go to the candidate nearest `current`, which matters in the flat parts of a clipped
 * curve: there, many values produce the same height, and without this the value would jump
 * about while the picture stayed still.
 */
export function solveOnGrid(options = {}) {
    const { min = 0, max = 100, step = 1, current, target, evaluate } = options;
    if (typeof evaluate !== 'function') return current ?? min;
    const stride = Number.isFinite(step) && step > 0 ? step : 1;
    // A guard, not a real limit: every field in this app has well under 200 storable values.
    const count = Math.min(4096, Math.floor((max - min) / stride) + 1);
    const decimals = decimalsForStep(stride);
    const factor = 10 ** decimals;
    let best = current ?? min;
    let bestError = Infinity;
    let bestDistance = Infinity;
    for (let index = 0; index < count; index++) {
        const candidate = Math.round((min + index * stride) * factor) / factor;
        const error = Math.abs(evaluate(candidate) - target);
        if (!Number.isFinite(error)) continue;
        const distance = Number.isFinite(current) ? Math.abs(candidate - current) : 0;
        if (error < bestError - 1e-9 || (error < bestError + 1e-9 && distance < bestDistance)) {
            best = candidate;
            bestError = error;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * The value axis, with a little air above and below the allowed range so a point sitting on
 * its own ceiling is still drawn as a circle and not as a half-circle on the frame.
 */
export function paddedRange(min, max, padFraction = 0.07) {
    const span = Math.max(1e-9, max - min);
    const pad = span * padFraction;
    return [min - pad, max + pad];
}

/** The category axis for `count` evenly spaced points at 0, 1, 2, … */
export function categoryRange(count) {
    return [-0.5, Math.max(0.5, count - 0.5)];
}

/*
 * A range is USABLE when it spans something, in either direction.
 *
 * Reversed ranges are real and in use: the low-SoC limp chart runs 100 % on the left down to
 * 0 % on the right, because that is the direction a ride goes. Rejecting a negative span as
 * degenerate — which an earlier version did — silently pinned every handle on that chart to
 * the left edge of the plot, so a press near the drawn handle grabbed nothing at all. Only a
 * zero or non-finite span is actually degenerate.
 */
const usableSpan = (low, high) => {
    const span = high - low;
    return Number.isFinite(span) && span !== 0 ? span : null;
};

/**
 * Value -> pixel down the screen. `area` is { top, height } of the plot rectangle, in pixels
 * from the top of the graph element. Inverted on purpose: pixels grow downward, values do not.
 */
export function valueToPixel(value, [low, high], area) {
    const span = usableSpan(low, high);
    if (span === null || !(area?.height > 0)) return area?.top ?? 0;
    return area.top + (1 - (value - low) / span) * area.height;
}

/** Pixel down the screen -> value. The exact inverse of valueToPixel. */
export function pixelToValue(pixel, [low, high], area) {
    const span = usableSpan(low, high);
    if (span === null || !(area?.height > 0)) return low;
    return high - ((pixel - area.top) / area.height) * span;
}

/** Point index -> pixel across the screen. `area` is { left, width }. */
export function indexToPixel(index, [low, high], area) {
    const span = usableSpan(low, high);
    if (span === null || !(area?.width > 0)) return area?.left ?? 0;
    return area.left + ((index - low) / span) * area.width;
}

/**
 * Which point a press at `pixel` grabs, or -1 for none.
 *
 * Horizontal distance only. A point is grabbed by its COLUMN rather than by the marker itself,
 * because a marker is a poor target for a fingertip and the caller keeps the grab offset — so
 * pressing well below a point drags it from where it is instead of teleporting it to the
 * finger. Ties go to the lower index, which only matters when two points overlap exactly.
 */
export function nearestIndex(pixel, count, range, area, radiusPx = 34) {
    let best = -1;
    let bestDistance = radiusPx;
    for (let index = 0; index < count; index++) {
        const distance = Math.abs(pixel - indexToPixel(index, range, area));
        if (distance < bestDistance || (distance === bestDistance && best === -1)) {
            bestDistance = distance;
            best = index;
        }
    }
    return best;
}
