// evistdrive/engine-preview-ui.js — per-group preview charts inside
// "Shared safety and ride settings" (Profiles tab). Each of the six field groups
// (limits / start / launch / ramps / smoothing / extended boost) gets its own small, focused chart
// built directly from that group's own fields — not one generic ride simulation
// copy-pasted five times. Curves are illustrative (relative 0–100%), not a physical
// model of the motor.
/* global Plotly */
import { state } from '../shared.js';
import {
    el, isNumber, plotLayout, tabIsVisible,
    RAMP_SPEED_LO_KMH, RAMP_SPEED_HI_KMH, RAMP_CADENCE_LO_RPM, RAMP_CADENCE_HI_RPM,
    RAMP_SLOW_WHEN, RAMP_FAST_WHEN,
} from './common.js';
import { calculateBoostFade, applyPowerFilters } from './engine-preview.js';
import {
    M820_MAX_TORQUE_NM, PREVIEW_EFFICIENCY, MAX_PREVIEW_CADENCE_RPM,
    iqPercentToTorqueNm, buildMotorLimitSeries,
} from './motor-limits.js';

const CHART_HEIGHT = 260;

// One colour system across all five charts, assigned by the JOB a line does rather
// than per chart. Before this, blue meant "requested" on one chart and "delivered"
// on the next, and green meant "delivered" here but "assist starts" there — the same
// hue carried three meanings, which is what actually made the set hard to read.
//
// The old hues also failed a colourblind check outright on the surface these render
// on (#f8fafc): orange↔green ΔE 4.8 under protanopia, orange↔red 14.9 even with
// full colour vision, both under the ΔE 15 floor.
//
// RULE that the palette depends on: LIMIT and SERIES_2 must never appear on the same
// chart — red↔orange measures ΔE 10.8 normal-vision, below the floor. They don't:
// LIMIT is used by the ceiling/threshold charts, SERIES_2 by the ramp/smoothing ones.
// Every pair that DOES share a chart passes all-pairs CVD and normal-vision checks.
const C = {
    REFERENCE: '#898781', // "what you'd get without this setting" — recessive, always dashed
    SERIES_1: '#2a78d6',  // what the motor actually delivers — the line that matters
    SERIES_2: '#eb6834',  // a genuine second variant or second phase of the delivered line
    LIMIT: '#d03b3b',     // a wall: ceiling or threshold. Never used for anything else
    EVENT_LINE: '#cbd5e1', // vertical "this moment" marker
    EVENT_TEXT: '#64748b', // its label, and every other muted caption
};

function baseLayout(xTitle, yTitle) {
    const layout = plotLayout(xTitle, yTitle);
    layout.height = CHART_HEIGHT;
    layout.margin = { l: 54, r: 20, t: 30, b: 44 };
    layout.hovermode = 'closest';
    return layout;
}

function draw(containerId, traces, layout) {
    if (typeof Plotly === 'undefined') return;
    const container = el(containerId);
    if (!container) return;
    Plotly.react(container, traces, layout, { responsive: true, displaylogo: false });
}

// ── Motor ceilings: torque and power against cadence ───────────────────────
//
// CB-024. Firmware applies BOTH ceilings (assist_modes.c finish_power_request and
// assist_modes_profile_iq_ceiling): motor power is clipped to max_motor_power_w and the
// current is separately clipped to max_iq_pct of the controller's phase limit. Whichever is
// reached first is the one the rider feels — and WHICH ONE that is depends on cadence, which
// is precisely what the old chart could not show.
//
// The old version plotted both ceilings against "how hard you push", in W and %. That axis
// was invented: effort does not map to either ceiling, the two panels shared no physical
// relationship, and the % panel told a rider nothing they could feel. Cadence is the real
// independent variable here, because P = M x omega is what makes the two ceilings trade
// places, and both panels can now be read in units a rider knows: Nm and W.
//
// Everything drawn is an ENVELOPE — the ceiling the settings impose — not a motor curve.
// No dyno data and no manufacturer map exist for the M820, so nothing here invents a torque
// characteristic: no low-cadence bump, no high-cadence roll-off. See motor-limits.js.
function renderLimitsChart(level) {
    const iqPct = level.max_iq_pct ?? 100;
    const powerW = level.max_motor_power_w ?? 0;
    const series = buildMotorLimitSeries({ maxIqPct: iqPct, maxMotorPowerW: powerW });
    const torqueCeilingNm = iqPercentToTorqueNm(iqPct);

    const traces = [
        {
            x: series.cadenceRpm, y: series.currentTorqueLimitNm,
            name: 'Torque ceiling (this level)', legendgroup: 'ceiling',
            type: 'scatter', mode: 'lines', xaxis: 'x', yaxis: 'y',
            line: { color: C.REFERENCE, dash: 'dash', width: 2 },
        },
        {
            x: series.cadenceRpm, y: series.availableTorqueNm,
            name: 'What the motor can actually give', legendgroup: 'delivered',
            type: 'scatter', mode: 'lines', xaxis: 'x', yaxis: 'y',
            line: { color: C.SERIES_1, width: 3 },
        },
        {
            x: series.cadenceRpm, y: series.electricalPowerW,
            name: 'What the motor can actually give', legendgroup: 'delivered',
            showlegend: false, type: 'scatter', mode: 'lines', xaxis: 'x2', yaxis: 'y2',
            line: { color: C.SERIES_1, width: 3 },
        },
    ];

    const layout = plotLayout('Crank cadence (rpm)', '');
    layout.height = CHART_HEIGHT + 40;
    layout.margin = { l: 60, r: 16, t: 62, b: 64 };
    layout.hovermode = 'closest';
    const axisBase = layout.xaxis;
    const cadenceAxis = {
        ...axisBase, title: 'Crank cadence (rpm)', range: [0, MAX_PREVIEW_CADENCE_RPM],
    };
    layout.xaxis = { ...cadenceAxis, domain: [0, 0.46], anchor: 'y' };
    layout.xaxis2 = { ...cadenceAxis, domain: [0.58, 1], anchor: 'y2' };
    layout.yaxis = {
        ...layout.yaxis, title: 'Estimated torque (Nm)',
        range: [0, M820_MAX_TORQUE_NM * 1.1], anchor: 'x',
    };
    const powerTop = Math.max(100, ...series.electricalPowerW) * 1.15;
    layout.yaxis2 = {
        ...layout.yaxis, title: 'Estimated electrical power (W)',
        range: [0, powerTop], anchor: 'x2',
    };
    layout.shapes = [];
    layout.annotations = [];

    // The torque ceiling as a wall on the left panel, and the power ceiling as one on the
    // right. LIMIT red is the palette's wall colour and SERIES_2 is absent from this chart,
    // so the red/orange rule in the palette comment still holds.
    if (iqPct < 100) {
        layout.shapes.push({
            type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 0.46,
            y0: torqueCeilingNm, y1: torqueCeilingNm,
            line: { color: C.LIMIT, width: 2, dash: 'dot' },
        });
    }
    layout.annotations.push({
        xref: 'paper', x: 0.46, xanchor: 'right', yref: 'y', y: torqueCeilingNm,
        yanchor: 'bottom',
        text: iqPct > 0
            ? `About ${Math.round(torqueCeilingNm)} Nm — ${iqPct}% of phase current`
            : 'Assist off at this level (0%)',
        showarrow: false, font: { color: iqPct < 100 ? C.LIMIT : C.EVENT_TEXT, size: 10 },
    });

    if (powerW > 0) {
        layout.shapes.push({
            type: 'line', xref: 'paper', yref: 'y2', x0: 0.58, x1: 1, y0: powerW, y1: powerW,
            line: { color: C.LIMIT, width: 2, dash: 'dot' },
        });
    }
    layout.annotations.push({
        xref: 'paper', x: 1, xanchor: 'right', yref: 'y2', y: powerW > 0 ? powerW : powerTop,
        yanchor: 'bottom',
        text: powerW > 0 ? `Power ceiling — ${powerW} W` : 'No extra power limit',
        showarrow: false, font: { color: powerW > 0 ? C.LIMIT : C.EVENT_TEXT, size: 10 },
    });

    // The one number on this chart a rider can act on: above this cadence the power setting
    // is what they feel, below it the torque setting is. Reading that off a plotted curve by
    // eye is exactly the job a UI should do for them.
    if (series.crossoverRpm !== null) {
        [['x', 'y'], ['x2', 'y2']].forEach(([xref]) => {
            layout.shapes.push({
                type: 'line', xref, yref: 'paper',
                x0: series.crossoverRpm, x1: series.crossoverRpm, y0: 0, y1: 1,
                line: { color: C.EVENT_LINE, width: 1, dash: 'dot' },
            });
        });
        layout.annotations.push({
            xref: 'x', x: series.crossoverRpm,
            xanchor: series.crossoverRpm > MAX_PREVIEW_CADENCE_RPM * 0.6 ? 'right' : 'left',
            yref: 'paper', y: 0.02, yanchor: 'bottom',
            text: `power limit takes over here (~${Math.round(series.crossoverRpm)} rpm)`,
            showarrow: false, font: { color: C.EVENT_TEXT, size: 10 },
        });
    }

    layout.annotations.push({
        xref: 'paper', x: 0.5, xanchor: 'center', yref: 'paper', y: 1.20, yanchor: 'bottom',
        text: powerW > 0
            ? (series.crossoverRpm === null
                ? `The torque setting is what you feel across the whole cadence range`
                : `Torque setting rules below ~${Math.round(series.crossoverRpm)} rpm, the power setting above it`)
            : 'Only the torque setting limits this level',
        showarrow: false, font: { color: C.SERIES_1, size: 11 },
    });
    layout.annotations.push({
        xref: 'paper', x: 0, xanchor: 'left', yref: 'paper', y: -0.20, yanchor: 'top',
        text: `Estimated limit envelope for a Bafang M820 (${M820_MAX_TORQUE_NM} Nm at full `
            + `phase current, ${Math.round(PREVIEW_EFFICIENCY * 100)}% assumed efficiency) — `
            + 'not a dyno measurement of your motor.',
        showarrow: false, font: { color: C.EVENT_TEXT, size: 10 },
    });

    draw('ebicsEnginePreviewLimitsChart', traces, layout);
}
// ── Start condition ─────────────────────────────────────────────────────────
function renderStartChart(level) {
    const thresholdKg = level.minimum_pedal_load_kg ?? 0.7;
    const ridingThresholdKg = level.riding_minimum_pedal_load_kg ?? thresholdKg;
    const withoutRotation = !!level.assist_without_rotation;

    const peakKg = Math.max(thresholdKg * 1.6, thresholdKg + 0.8, 1);
    const rampMs = 1200;
    const steps = 40;
    const time = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * 2000);
    const load = time.map((t) => Math.min(peakKg, (t / rampMs) * peakKg));

    const startIndex = load.findIndex((v) => v >= thresholdKg);
    const startTime = startIndex >= 0 ? time[startIndex] : null;

    // Both thresholds are the same kind of thing — a load you must clear — so they share
    // the LIMIT colour and are told apart by dash pattern plus the kg value in the legend,
    // rather than by inventing a second hue for the same concept.
    const traces = [
        { x: time, y: load, name: 'Pedal load', type: 'scatter', mode: 'lines', line: { width: 3, color: C.SERIES_1 } },
        { x: [0, 2000], y: [thresholdKg, thresholdKg], name: `Minimum pedal load — ${thresholdKg.toFixed(1)} kg`,
            type: 'scatter', mode: 'lines', line: { width: 2, color: C.LIMIT, dash: 'dash' } },
    ];

    if (Math.abs(ridingThresholdKg - thresholdKg) > 0.001) {
        traces.push({
            x: [0, 2000], y: [ridingThresholdKg, ridingThresholdKg], name: `Minimum while riding — ${ridingThresholdKg.toFixed(1)} kg`,
            type: 'scatter', mode: 'lines', line: { width: 2, color: C.LIMIT, dash: 'dot' },
        });
    }

    const layout = baseLayout('Time (ms)', 'Pedal load (kg)');
    layout.yaxis.range = [0, peakKg * 1.15];
    layout.shapes = [];
    layout.annotations = [];

    if (startTime !== null) {
        // "Assist starts" is a moment in time, drawn the same way every other moment
        // marker in this file is. It used to be green, which sat ΔE 4.1 from the red
        // threshold under deuteranopia — the two most meaningful marks on the chart
        // were the pair a colourblind reader could least tell apart.
        layout.shapes.push({ type: 'line', x0: startTime, x1: startTime, y0: 0, y1: 1, yref: 'paper', line: { color: C.EVENT_LINE, width: 2, dash: 'dot' } });
        layout.annotations.push({ x: startTime, y: thresholdKg, text: 'Assist starts', showarrow: true, arrowhead: 2, ax: 30, ay: -30, font: { color: C.EVENT_TEXT } });
    }

    layout.annotations.push({
        x: 1000, y: peakKg * 1.15 * 0.02, yanchor: 'bottom',
        text: withoutRotation ? 'Can start from a dead stop (no crank rotation needed)' : 'Needs crank rotation AND pedal load together',
        showarrow: false, font: { color: C.EVENT_TEXT, size: 11 },
    });

    draw('ebicsEnginePreviewStartChart', traces, layout);
}

// ── Launch feel — boost and smooth start ────────────────────────────────────
function renderLaunchChart(level, tuning) {
    const boostOn = !!level.startup_boost_enabled;
    const strengthPct = level.startup_boost_strength_pct || 0;
    const endRpm = level.startup_boost_end_rpm || 90;
    const smoothOn = !!level.smooth_start_enabled;
    const smoothMs = level.smooth_start_ms || 0;
    const cadenceStep = tuning?.startup_boost_cadence_step ?? 20;

    const durationMs = 2000;
    const assumedEndRpm = 120; // reference cadence spin-up used only to draw the shape
    const steps = 60;
    const time = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * durationMs);

    const value = time.map((t) => {
        const cadence = (t / durationMs) * assumedEndRpm;
        const smoothFactor = smoothOn && smoothMs > 0 ? Math.min(1, t / smoothMs) : 1;
        let boostPct = 0;
        if (boostOn && cadence <= endRpm) {
            boostPct = strengthPct * calculateBoostFade(0, cadence, { startup_boost_end_rpm: endRpm, startup_boost_cadence_step: cadenceStep });
        }
        return smoothFactor * (100 + boostPct);
    });

    const traces = [
        { x: [0, durationMs], y: [100, 100], name: 'Target level (no boost)', type: 'scatter', mode: 'lines', line: { width: 2, color: C.REFERENCE, dash: 'dash' } },
        { x: time, y: value, name: 'With boost / smooth start', type: 'scatter', mode: 'lines', line: { width: 3, color: C.SERIES_1 } },
    ];

    const layout = baseLayout('Time since start (ms)', 'Requested power (%)');
    const peak = Math.max(...value, 100);
    layout.yaxis.range = [0, peak * 1.15];
    layout.annotations = [];
    if (!boostOn) layout.annotations.push({ x: durationMs * 0.6, y: peak * 1.08, text: 'Startup boost is off', showarrow: false, font: { color: C.EVENT_TEXT, size: 11 } });
    if (!smoothOn) layout.annotations.push({ x: durationMs * 0.15, y: peak * 0.15, text: 'Smooth start is off (instant step)', showarrow: false, font: { color: C.EVENT_TEXT, size: 11 } });

    draw('ebicsEnginePreviewLaunchChart', traces, layout);
}

// ── Current ramps — acceleration and deceleration ───────────────────────────
//
// "Low" and "high" are not vague: they are fixed firmware breakpoints (config.h
// IQ_RAMP_SPEED_LO/HI and IQ_RAMP_CAD_LO/HI), and the two labels meant nothing on their own
// — a rider could not tell at what speed the value they were editing even applied.
//
// Firmware maps speed and cadence to a ramp time SEPARATELY and then takes the SHORTER of
// the two (assist_dynamics.c: up_ticks = min(up_c, up_s)). So whichever of the two is
// already "high" wins: 60 rpm on the spot is as fast as 25 km/h. Both are clamped, so below
// the low breakpoint you get exactly the slow value and above the high one exactly the fast
// value; in between it is a straight blend.

function renderRampsChart(level) {
    const riseSlow = level.iq_rise_slow_ms ?? 600;
    const riseFast = level.iq_rise_fast_ms ?? 300;
    const fallSlow = level.iq_fall_slow_ms ?? 1000;
    const fallFast = level.iq_fall_fast_ms ?? 140;
    const holdMs = 300;

    const trapezoid = (riseMs, fallMs) => {
        const t1 = riseMs;
        const t2 = riseMs + holdMs;
        const t3 = t2 + fallMs;
        return { x: [0, t1, t2, t3], y: [0, 100, 100, 0] };
    };

    const low = trapezoid(riseSlow, fallSlow);
    const high = trapezoid(riseFast, fallFast);
    const chartEnd = Math.max(low.x[3], high.x[3]) * 1.1;

    const traces = [
        { ...low, name: `Slow — ${RAMP_SLOW_WHEN} — rise ${riseSlow} ms / fall ${fallSlow} ms`, type: 'scatter', mode: 'lines', line: { width: 3, color: C.SERIES_1 } },
        { ...high, name: `Fast — ${RAMP_FAST_WHEN} — rise ${riseFast} ms / fall ${fallFast} ms`, type: 'scatter', mode: 'lines', line: { width: 3, color: C.SERIES_2 } },
    ];

    const layout = baseLayout('Time — pedal push then release (ms)', 'Motor current (%)');
    layout.xaxis.range = [0, chartEnd];
    layout.yaxis.range = [-5, 110];
    layout.margin.b = 62;
    layout.annotations = [{
        xref: 'paper', x: 0, xanchor: 'left', yref: 'paper', y: -0.30, yanchor: 'top',
        text: `Between those points the two curves blend. Speed and cadence are judged separately `
            + `and the FASTER result wins — ${RAMP_CADENCE_HI_RPM} rpm on the spot ramps like `
            + `${RAMP_SPEED_HI_KMH.toFixed(0)} km/h. Pulling away from a standstill always uses the slow curve.`,
        showarrow: false, font: { color: C.EVENT_TEXT, size: 10 },
    }];

    draw('ebicsEnginePreviewRampsChart', traces, layout);
}

// ── Power smoothing and release ─────────────────────────────────────────────
// Three fields live in this group and they act at three DIFFERENT moments, so the
// chart tells one pedal story in three labelled acts instead of a single square
// pulse with a coloured box beside it (the old version, which tied nothing on the
// picture to the release value and never drew the fade at all):
//
//   you push harder   -> power rise filter   (curved — a lag, not a deadline)
//   you ease off      -> power fall filter   (curved)
//   you stop pedalling-> release             (a STRAIGHT line to zero, per FW-040/072)
//
// Filters curve and release is straight for a real reason: the filters are
// first-order lags, the release is a fixed-time linear fade. Keeping that visual
// difference is the point — it is what tells the two mechanisms apart.
function renderSmoothingChart(level) {
    const riseFilterMs = level.power_rise_filter_ms || 0;
    const fallFilterMs = level.power_fall_filter_ms || 0;
    const releaseMs = level.release_ms || 0;
    const fallSlowMs = level.iq_fall_slow_ms ?? 1000;

    const CRUISE = 45;  // % power holding a steady pace
    const PUSH = 100;   // % power under a hard push
    const T_PUSH = 400;
    const T_EASE = 1600;
    const T_STOP = 2800;
    const dtMs = 10;

    // Simulate steady -> push -> ease off, exactly as firmware filters it.
    const time = [];
    const smoothed = [];
    let prev = CRUISE;
    for (let t = 0; t <= T_STOP; t += dtMs) {
        const target = t < T_PUSH ? CRUISE : (t < T_EASE ? PUSH : CRUISE);
        const value = applyPowerFilters(
            target / 100, prev / 100,
            { power_rise_filter_ms: riseFilterMs, power_fall_filter_ms: fallFilterMs },
            target > prev, dtMs,
        ) * 100;
        time.push(t);
        smoothed.push(value);
        prev = value;
    }

    // release_ms = 0 hands the fade to this level's deceleration ramp, which is defined
    // as the time for a FULL 100% -> 0 sweep, so from a partial level it takes
    // proportionally less. Showing that number beats "firmware decides timing".
    const levelAtStop = prev;
    const autoFadeMs = Math.max(1, Math.round(fallSlowMs * (levelAtStop / 100)));
    const fadeMs = releaseMs > 0 ? releaseMs : autoFadeMs;
    const totalMs = T_STOP + fadeMs + 400;

    const releaseTime = [];
    const releaseValue = [];
    for (let t = T_STOP; t <= T_STOP + fadeMs; t += dtMs) {
        releaseTime.push(t);
        releaseValue.push(levelAtStop * (1 - (t - T_STOP) / fadeMs));
    }
    releaseTime.push(T_STOP + fadeMs, totalMs);
    releaseValue.push(0, 0);

    const traces = [
        {
            x: [0, T_PUSH, T_PUSH, T_EASE, T_EASE, T_STOP, T_STOP, totalMs],
            y: [CRUISE, CRUISE, PUSH, PUSH, CRUISE, CRUISE, 0, 0],
            name: 'What you ask for', type: 'scatter', mode: 'lines',
            line: { width: 2, color: C.REFERENCE, dash: 'dash', shape: 'linear' },
        },
        {
            x: time, y: smoothed, name: 'Delivered — smoothed by the filters',
            type: 'scatter', mode: 'lines', line: { width: 3, color: C.SERIES_1 },
        },
        {
            x: releaseTime, y: releaseValue, name: 'Delivered — release fade',
            type: 'scatter', mode: 'lines', line: { width: 3, color: C.SERIES_2 },
        },
    ];

    const layout = baseLayout('One pedal story — time (ms)', 'Power (%)');
    layout.margin.t = 46; // top band labels sit inside the plot, under the legend
    layout.yaxis.range = [-6, 118];
    layout.xaxis.range = [0, totalMs];
    layout.shapes = [];
    layout.annotations = [];

    const marker = (x, text) => {
        layout.shapes.push({
            type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1,
            line: { color: C.EVENT_LINE, width: 1, dash: 'dot' },
        });
        layout.annotations.push({
            x, y: 2, yanchor: 'bottom', text, showarrow: false,
            font: { color: C.EVENT_TEXT, size: 10 },
        });
    };
    marker(T_PUSH, 'you push harder');
    marker(T_EASE, 'you ease off');
    marker(T_STOP, 'you stop pedalling');

    // A filter can be set far longer than the story it is drawn over (up to 5000 ms),
    // so clamp the band to the chart rather than letting it run off the axis and
    // smear over the next act.
    const band = (x0, widthMs, color, fill, text) => {
        const x1 = Math.min(totalMs, x0 + widthMs);
        if (widthMs > 0) {
            layout.shapes.push({
                type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1,
                fillcolor: fill, line: { width: 0 },
            });
        }
        layout.annotations.push({
            x: (x0 + x1) / 2, y: 112, text, showarrow: false, font: { color, size: 10 },
        });
    };

    // Each band is tinted with the colour of the CURVE it acts on, not a hue of its own:
    // both filters shape the blue line, the release shapes the orange one. That is also
    // what keeps red off this chart entirely — nothing here is a wall, and red is
    // reserved for walls.
    band(T_PUSH, riseFilterMs, C.SERIES_1, 'rgba(42, 120, 214, 0.07)',
        riseFilterMs > 0 ? `Rise filter — ${riseFilterMs} ms` : 'Rise filter: off');
    band(T_EASE, fallFilterMs, C.SERIES_1, 'rgba(42, 120, 214, 0.07)',
        fallFilterMs > 0 ? `Fall filter — ${fallFilterMs} ms` : 'Fall filter: off');
    band(T_STOP, fadeMs, C.SERIES_2, 'rgba(235, 104, 52, 0.10)',
        releaseMs > 0
            ? `Release — ${releaseMs} ms to zero`
            : `Release: AUTO — ≈${autoFadeMs} ms here`);

    layout.annotations.push({
        x: totalMs, y: -4, xanchor: 'right', yanchor: 'bottom',
        text: 'Filters bend the curve (a lag). Release is a straight line to zero.',
        showarrow: false, font: { color: C.EVENT_TEXT, size: 10 },
    });

    draw('ebicsEnginePreviewSmoothingChart', traces, layout);
}

// ── Obstacle assist — Extended Boost ────────────────────────────────────────
// FW-084. Two things decide what this feature does and they are in different units, so
// this follows the same two-panel form as the ceiling chart rather than inventing a twin
// scale: HOW HARD you pushed sets the height of the boost, and the two time fields set how
// long it lasts. One chart with kg on one axis and ms on the other would let the reader
// read crossings that do not exist.
//
// Left panel is also where the level's current ceiling becomes visible. That matters more
// here than anywhere else: the boost REPLACES the mode's own result, so the ceiling is
// re-applied to it afterwards (assist_modes_profile_iq_ceiling); a rider who has set
// Maximum motor current to 20% must be able to see that a 255% boost still stops there.
function renderExtendedBoostChart(level) {
    const triggerKg = level.extended_boost_trigger_load_kg ?? 8;
    const strengthPct = level.extended_boost_strength_pct ?? 100;
    const durationMs = level.extended_boost_duration_ms ?? 0;
    const releaseMs = level.release_ms || 0;
    const fallSlowMs = level.iq_fall_slow_ms ?? 1000;
    const iqPct = level.max_iq_pct ?? 100;

    // The firmware's own map, in the same units the card states it in: the part of the
    // pedal load ABOVE the trigger, spread over the rest of the 60 kg sensor scale.
    const FULL_SCALE_KG = 60;
    const rawBoostPct = (loadKg) => {
        const peak = Math.min(loadKg, FULL_SCALE_KG);
        // A trigger at the very top of the scale can never be exceeded — same early exit
        // the firmware takes, which is also what keeps the span out of a division by zero.
        if (peak <= triggerKg) return 0;
        const base = ((peak - triggerKg) / (FULL_SCALE_KG - triggerKg)) * 100;
        return Math.min((base * strengthPct) / 100, 100);
    };
    const deliveredPct = (loadKg) => Math.min(rawBoostPct(loadKg), iqPct);

    // The trigger can be set anywhere on the sensor's 60 kg scale, so the axis follows it
    // instead of being fixed: a 40 kg trigger on a 40 kg axis would sit on the frame edge
    // with the whole useful part of the curve off-chart.
    const PUSH_AXIS_MAX_KG = Math.min(FULL_SCALE_KG,
        Math.max(40, Math.ceil((triggerKg + 15) / 10) * 10));
    const loads = Array.from({ length: 81 }, (_, i) => (i * PUSH_AXIS_MAX_KG) / 80);
    // A push the rider would recognize as "a real shove over a rock", used to fix the
    // height of the right panel. Named in the caption so the height is never mistaken for
    // a constant of the feature.
    const examplePushKg = Math.min(PUSH_AXIS_MAX_KG, triggerKg + 12);
    const examplePct = deliveredPct(examplePushKg);

    // release_ms = 0 hands the fade to the deceleration ramp, which is defined over a full
    // 100% sweep — the same convention the smoothing chart explains.
    const autoFadeMs = Math.max(1, Math.round(fallSlowMs * (examplePct / 100)));
    const fadeMs = releaseMs > 0 ? releaseMs : autoFadeMs;
    const totalMs = Math.max(600, durationMs + fadeMs + 250);

    const boostOn = durationMs > 0 && strengthPct > 0;
    const timeX = [0, durationMs, durationMs + fadeMs, totalMs];
    const timeY = [examplePct, examplePct, 0, 0];
    // Without the feature the current starts falling the moment the cranks stop. That is
    // the comparison the whole group exists to make.
    const withoutX = [0, fadeMs, totalMs];
    const withoutY = [examplePct, 0, 0];

    const traces = [
        {
            x: loads, y: loads.map(rawBoostPct), name: 'Before the level ceiling',
            legendgroup: 'raw', type: 'scatter', mode: 'lines', xaxis: 'x', yaxis: 'y',
            line: { color: C.REFERENCE, dash: 'dash', width: 2 },
        },
        {
            x: loads, y: loads.map(deliveredPct), name: 'What the motor actually gets',
            legendgroup: 'delivered', type: 'scatter', mode: 'lines', xaxis: 'x', yaxis: 'y',
            line: { color: C.SERIES_1, width: 3 },
        },
        {
            x: withoutX, y: withoutY, name: 'Before the level ceiling', legendgroup: 'raw',
            showlegend: false, type: 'scatter', mode: 'lines', xaxis: 'x2', yaxis: 'y2',
            line: { color: C.REFERENCE, dash: 'dash', width: 2 },
        },
        {
            x: boostOn ? timeX : withoutX, y: boostOn ? timeY : withoutY,
            name: 'What the motor actually gets', legendgroup: 'delivered',
            showlegend: false, type: 'scatter', mode: 'lines', xaxis: 'x2', yaxis: 'y2',
            line: { color: C.SERIES_1, width: 3 },
        },
    ];

    const layout = plotLayout('Peak pedal load of the push (kg)', '');
    layout.height = CHART_HEIGHT + 40;
    layout.margin = { l: 60, r: 16, t: 62, b: 64 };
    layout.hovermode = 'closest';
    const axisBase = layout.xaxis;
    layout.xaxis = {
        ...axisBase, title: 'Peak pedal load of the push (kg)',
        range: [0, PUSH_AXIS_MAX_KG], domain: [0, 0.46], anchor: 'y',
    };
    layout.xaxis2 = {
        ...axisBase, title: 'After the cranks stop (ms)',
        range: [0, totalMs], domain: [0.58, 1], anchor: 'y2',
    };
    layout.yaxis = { ...layout.yaxis, title: 'Motor current (%)', range: [0, 114], anchor: 'x' };
    layout.yaxis2 = { ...layout.yaxis, title: 'Motor current (%)', range: [0, 114], anchor: 'x2' };
    layout.shapes = [];
    layout.annotations = [];

    // Left panel: the trigger is a threshold and the level ceiling is a wall — both are
    // LIMIT red, and SERIES_2 is deliberately absent from this chart so the palette's
    // red/orange rule holds.
    layout.shapes.push({
        type: 'line', xref: 'x', yref: 'paper', x0: triggerKg, x1: triggerKg, y0: 0, y1: 1,
        line: { color: C.LIMIT, width: 2, dash: 'dot' },
    });
    layout.annotations.push({
        xref: 'x', x: triggerKg, xanchor: triggerKg > PUSH_AXIS_MAX_KG * 0.6 ? 'right' : 'left',
        yref: 'paper', y: 0.02, yanchor: 'bottom',
        text: `arms at ${triggerKg.toFixed(1)} kg`,
        showarrow: false, font: { color: C.LIMIT, size: 10 },
    });
    if (iqPct < 100) {
        layout.shapes.push({
            type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 0.46, y0: iqPct, y1: iqPct,
            line: { color: C.LIMIT, width: 2, dash: 'dot' },
        });
    }
    layout.annotations.push({
        xref: 'paper', x: 0.46, xanchor: 'right', yref: 'y', y: iqPct, yanchor: 'bottom',
        text: iqPct < 100
            ? `Maximum motor current — ${iqPct}%`
            : 'No current ceiling (100%)',
        showarrow: false, font: { color: iqPct < 100 ? C.LIMIT : C.EVENT_TEXT, size: 10 },
    });

    // Right panel: the two times, and the fact that they add up.
    if (boostOn) {
        layout.shapes.push({
            type: 'rect', xref: 'x2', yref: 'paper', x0: 0, x1: durationMs, y0: 0, y1: 1,
            fillcolor: 'rgba(42, 120, 214, 0.07)', line: { width: 0 },
        });
        layout.annotations.push({
            xref: 'x2', x: durationMs / 2, yref: 'paper', y: 0.93, yanchor: 'bottom',
            text: `Boost — ${durationMs} ms`, showarrow: false,
            font: { color: C.SERIES_1, size: 10 },
        });
    }
    layout.annotations.push({
        xref: 'x2', x: (boostOn ? durationMs : 0) + fadeMs / 2, yref: 'paper', y: 0.93,
        yanchor: 'bottom',
        text: releaseMs > 0 ? `Release — ${releaseMs} ms` : `Release: AUTO — ≈${autoFadeMs} ms`,
        showarrow: false, font: { color: C.EVENT_TEXT, size: 10 },
    });

    layout.annotations.push({
        xref: 'paper', x: 0.5, xanchor: 'center', yref: 'paper', y: 1.20, yanchor: 'bottom',
        text: boostOn
            ? `A ${examplePushKg.toFixed(1)} kg push holds ${Math.round(examplePct)}% for `
                + `${durationMs} ms, then fades — ${durationMs + fadeMs} ms from cranks stopped to zero`
            : 'Extended Boost is OFF (duration 0) — the right panel is what you get today',
        showarrow: false,
        font: { color: boostOn ? C.SERIES_1 : C.EVENT_TEXT, size: 11 },
    });
    layout.annotations.push({
        xref: 'paper', x: 0, xanchor: 'left', yref: 'paper', y: -0.20, yanchor: 'top',
        text: 'Height comes from the peak load of the last confirmed push, held 30 ms. '
            + 'In legal mode the boost is non-pedal: nothing above 7 km/h.',
        showarrow: false, font: { color: C.EVENT_TEXT, size: 10 },
    });

    draw('ebicsEnginePreviewExtendedBoostChart', traces, layout);
}

export function renderEnginePreview(level, tuning) {
    if (typeof Plotly === 'undefined') return;
    if (!tabIsVisible('tab-ebics-profiles')) return;
    if (!level) return;

    renderLimitsChart(level);
    renderStartChart(level);
    renderLaunchChart(level, tuning);
    renderRampsChart(level);
    renderSmoothingChart(level);
    renderExtendedBoostChart(level); //FW-084
}

export function bindEnginePreviewControls() {
    // Nothing to bind globally — each group's chart redraws via the "toggle" listener
    // profiles.js attaches to its own <details>, and via the shared field refresh callback.
}

// Called by profiles.js whenever the selected level's fields (re)render or change.
export function updateEnginePreviewUI(level, tuning) {
    renderEnginePreview(level, tuning);
}
