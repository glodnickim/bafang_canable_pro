// evistdrive/level-curve.js — the first card where the chart IS the editor.
//
// Every other card on the Profiles tab edits ONE assist level: the one picked in the toolbar.
// This one shows a single setting across all five levels of the selected bank at once, which
// is the shape riders actually think in ("ECO is too weak, BOOST is too much") and the shape
// a line chart is for. Drag a point, and that level's value changes.
//
// Deliberately NOT a new source of truth:
//   * the ranges, the unit, the label and the display<->stored conversion all come from the
//     SAME field descriptor the number box is built from (profiles.js sharedFieldList), so the
//     chart cannot allow a value the box refuses, or round one differently;
//   * the edit is written into the level object the rest of the tab already works on;
//   * the value read from the controller comes from state.lastBanksAsRead, which CB-012
//     already keeps untouched — so "Controller: 60 · Edited: 72" needs no new state at all.
//
// NOTHING HERE SENDS CAN TRAFFIC. Dragging changes what is on the screen. The bike keeps its
// settings until "Save…" in the top bar is used, exactly as before.
import { el, LEVEL_NAMES, LEVEL_COLORS, tabIsVisible, bankSchemaVersion } from './common.js';
import { createEditableParameterChart } from './editable-chart.js';
import { decimalsForStep } from './parameter-grid.js';

/*
 * Which settings may be shaped this way: every per-level NUMBER the editor below owns, in the
 * order the field grid presents them.
 *
 * Two kinds are absent, and neither is an oversight:
 *   * the checkboxes (Startup boost on/off, Smooth start on/off, Assist without rotation) —
 *     there is nothing to drag on a line that only has two heights;
 *   * the mode-specific fields (support ratio, eMTB parameter, the curve gammas) — they only
 *     exist for the mode a level happens to be in, and the five levels of a bank are not
 *     guaranteed to share one, so a line across them could be comparing different things.
 *     Those are draggable on their own chart instead: "Selected engine preview".
 *
 * `max_motor_power_w` IS here even though 0 means "no extra limit" rather than "no power" —
 * the readout under the chart says "off" for a level sitting at zero, so the one value that
 * does not mean what its height suggests is spelled out rather than left to be guessed.
 */
const CURVE_KEYS = [
    'max_iq_pct',
    'max_motor_power_w',
    'minimum_pedal_load_kg',
    'riding_minimum_pedal_load_kg',
    'startup_boost_strength_pct',
    'startup_boost_end_rpm',
    'smooth_start_ms',
    'iq_rise_slow_ms',
    'iq_rise_fast_ms',
    'iq_fall_slow_ms',
    'iq_fall_fast_ms',
    'release_ms',
    'power_rise_filter_ms',
    'power_fall_filter_ms',
    // FW-084. Offered like any other per-level number; the chart goes read-only when the
    // controller reports a bank schema older than v8, exactly as the field grid does.
    'extended_boost_trigger_load_kg',
    'extended_boost_strength_pct',
    'extended_boost_duration_ms',
];

const DEFAULT_KEY = 'max_iq_pct';

let chart = null;
let selectedKey = DEFAULT_KEY;
let context = null; // the latest render context, so pointer callbacks are never stale

// A descriptor's fromNative may hand back a formatted string (the kg fields do, to pin them to
// one decimal). The chart works in numbers.
const toDisplay = (descriptor, native) => {
    const raw = descriptor.fromNative ? descriptor.fromNative(native) : native;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number(descriptor.min) || 0;
};
const toStored = (descriptor, display) =>
    (descriptor.toNative ? descriptor.toNative(display) : display);

function descriptorFor(descriptors, key) {
    return descriptors.find((field) => field.key === key) || null;
}

function populateParamSelect(descriptors) {
    const select = el('ebicsLevelCurveParam');
    if (!select) return;
    const wanted = CURVE_KEYS
        .map((key) => descriptorFor(descriptors, key))
        .filter(Boolean);
    if (select.options.length === wanted.length) return;
    const previous = select.value;
    select.innerHTML = '';
    wanted.forEach((field) => {
        const unit = field.unit ? ` (${field.unit})` : '';
        // The ramp labels carry their firmware breakpoints in brackets, which is right in the
        // field grid and far too long for a dropdown — keep everything before the bracket.
        const label = String(field.label).split(' — ')[0].split(' (')[0];
        select.add(new Option(`${label}${unit}`, field.key));
    });
    if (wanted.some((field) => field.key === previous)) select.value = previous;
    else select.value = CURVE_KEYS.includes(selectedKey) ? selectedKey : wanted[0]?.key;
    selectedKey = select.value;
}

/*
 * The per-level readout under the chart: what the controller holds against what is on screen.
 *
 * This is the "Controller: 60 / Edited: 72" view, and it is also why the chart does not need
 * to invent a dirty-state store — both numbers already exist, one in state.lastBanks and one
 * in state.lastBanksAsRead.
 */
function renderStatus(descriptor, values, baseline, needsSchema = 0) {
    const host = el('ebicsLevelCurveStatus');
    if (!host) return;
    const unit = descriptor.unit ? ` ${descriptor.unit}` : '';
    const decimals = decimalsForStep(descriptor.step ?? 1);
    // CB-024: for an off-able field 0 does NOT mean "none of it", it means the limit is not
    // applied at all. Printing a bare "0 W" would read as "no motor".
    const offAt = descriptor.type === 'toggleValue' || descriptor.key === 'extended_boost_duration_ms'
        ? 0 : null;
    const format = (value) => (value === offAt
        ? 'off'
        : `${Number(value).toFixed(decimals)}${unit}`);

    host.innerHTML = '';
    let changed = 0;
    LEVEL_NAMES.forEach((name, index) => {
        const chip = document.createElement('span');
        chip.className = 'evd-level-chip';
        chip.style.borderColor = LEVEL_COLORS[index] || '#94a3b8';
        if (index === context?.levelIndex) chip.classList.add('is-selected');

        const title = document.createElement('strong');
        title.textContent = name;
        chip.appendChild(title);

        const modified = baseline
            && Number.isFinite(baseline[index])
            && Math.abs(baseline[index] - values[index]) > 10 ** -(decimals + 3);
        const readout = document.createElement('span');
        if (modified) {
            changed++;
            chip.classList.add('is-modified');
            readout.textContent = `${format(baseline[index])} → ${format(values[index])}`;
        } else {
            readout.textContent = format(values[index]);
        }
        chip.appendChild(readout);
        host.appendChild(chip);
    });

    const summary = document.createElement('span');
    summary.className = 'evd-level-summary';
    if (needsSchema) {
        summary.textContent = `⚠ This controller's firmware cannot store this setting `
            + `(needs bank schema v${needsSchema}) — shown read-only.`;
        summary.classList.add('is-dirty');
        host.appendChild(summary);
        return;
    }
    if (!baseline) {
        summary.textContent = 'Not read from the controller — nothing to compare against yet.';
    } else if (changed === 0) {
        summary.textContent = 'Same as the controller.';
    } else {
        summary.textContent = `${changed} of ${LEVEL_NAMES.length} levels changed — not written to the bike yet.`;
        summary.classList.add('is-dirty');
    }
    host.appendChild(summary);
}

/**
 * renderLevelCurve(ctx)
 *
 * ctx = {
 *   bankIndex, levelIndex,      // what the toolbar has selected
 *   levels,                     // the bank's five level objects the editor writes into
 *   baselineLevels,             // the same five as read from the controller, or null
 *   descriptors,                // profiles.js sharedFieldList()
 *   onEdit(levelIndex, key, storedValue, { committed }),
 * }
 *
 * Safe to call as often as the tab re-renders: the chart is a singleton and updates in place.
 */
export function renderLevelCurve(ctx) {
    context = ctx;
    const host = el('ebicsLevelCurveChart');
    if (!host || !ctx?.levels?.length) return;
    // Plotly cannot size into a hidden container — it draws blank and never recovers.
    if (!tabIsVisible('tab-ebics-profiles')) return;

    populateParamSelect(ctx.descriptors);
    const descriptor = descriptorFor(ctx.descriptors, selectedKey);
    if (!descriptor) return;

    const step = descriptor.step ?? 1;
    const values = LEVEL_NAMES.map((_, index) =>
        toDisplay(descriptor, ctx.levels[index]?.[descriptor.key]));
    const baseline = ctx.baselineLevels
        ? LEVEL_NAMES.map((_, index) =>
            toDisplay(descriptor, ctx.baselineLevels[index]?.[descriptor.key]))
        : null;

    // A setting the connected controller cannot store must not be draggable: typing a value
    // the serializer then drops on write is worse than being told the firmware is too old,
    // because the rider would ride expecting it. "Nothing read yet" stays editable — offline
    // there is no controller to disagree with and nothing can be written anyway.
    const schema = bankSchemaVersion();
    const tooOld = !!descriptor.minBankSchema && schema > 0 && schema < descriptor.minBankSchema;

    const settings = {
        labels: LEVEL_NAMES.slice(),
        colors: LEVEL_COLORS.slice(),
        values,
        baseline,
        disabled: tooOld,
        min: Number(descriptor.min) || 0,
        max: Number(descriptor.max),
        step,
        decimals: decimalsForStep(step),
        unit: descriptor.unit || '',
        xTitle: 'Assist level',
        yTitle: `${String(descriptor.label).split(' — ')[0]}${descriptor.unit ? ` (${descriptor.unit})` : ''}`,
        valueLabel: 'On screen (drag me)',
        baselineLabel: 'In the controller',
        activeIndex: ctx.levelIndex,
        onChange: handleChange,
    };

    if (!chart) {
        chart = createEditableParameterChart({ element: host, ...settings });
    } else {
        chart.update(settings);
    }
    renderStatus(descriptor, values, baseline, tooOld ? descriptor.minBankSchema : 0);
}

// One point moved. Everything below happens in the browser; see the file header.
function handleChange(index, displayValue, { committed }) {
    if (!context) return;
    const descriptor = descriptorFor(context.descriptors, selectedKey);
    const level = context.levels[index];
    if (!descriptor || !level) return;

    const stored = toStored(descriptor, displayValue);
    level[descriptor.key] = stored;

    // The readout is plain DOM and cheap, so it tracks the drag frame by frame. The heavy
    // work — the other preview charts — waits for the pointer to be released.
    const values = LEVEL_NAMES.map((_, i) => toDisplay(descriptor, context.levels[i]?.[descriptor.key]));
    const baseline = context.baselineLevels
        ? LEVEL_NAMES.map((_, i) => toDisplay(descriptor, context.baselineLevels[i]?.[descriptor.key]))
        : null;
    renderStatus(descriptor, values, baseline);

    context.onEdit?.(index, descriptor.key, stored, { committed });
}

export function bindLevelCurveControls(onParamChange) {
    el('ebicsLevelCurveParam')?.addEventListener('change', (event) => {
        selectedKey = event.target.value;
        onParamChange?.();
    });
}

// Which setting the card is currently showing — profiles.js needs it to decide whether a
// number box that just changed is one of the points on screen.
export const currentCurveKey = () => selectedKey;
