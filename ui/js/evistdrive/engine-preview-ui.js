// evistdrive/engine-preview-ui.js — per-group preview charts inside
// "Shared safety and ride settings" (Profiles tab). Each of the five field groups
// (limits / start / launch / ramps / smoothing) gets its own small, focused chart
// built directly from that group's own fields — not one generic ride simulation
// copy-pasted five times. Curves are illustrative (relative 0–100%), not a physical
// model of the motor.
/* global Plotly */
import { el, plotLayout, tabIsVisible } from './common.js';
import { calculateBoostFade, applyPowerFilters } from './engine-preview.js';

const CHART_HEIGHT = 260;

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

// ── Power and current ceiling ──────────────────────────────────────────────
function renderLimitsChart(level) {
    const iqPct = level.max_iq_pct ?? 100;
    const powerW = level.max_motor_power_w ?? 0;

    // A representative full-effort ramp (0 → 100% over 300 ms, then held).
    const demand = { x: [0, 300, 1000], y: [0, 100, 100], name: 'Requested current', line: { width: 3, color: '#2563eb' } };
    const traces = [{ ...demand, type: 'scatter', mode: 'lines' }];

    const layout = baseLayout('Time (ms)', 'Motor current (%)');
    layout.yaxis.range = [0, 110];

    if (iqPct < 100) {
        traces.push({
            x: [0, 1000], y: [iqPct, iqPct], name: `Current ceiling — ${iqPct}%`,
            type: 'scatter', mode: 'lines', line: { width: 2, color: '#dc2626', dash: 'dot' },
        });
        traces.push({
            x: [0, 300, 1000], y: [0, iqPct, iqPct], name: 'Clipped result',
            type: 'scatter', mode: 'lines', line: { width: 3, color: '#16a34a' },
        });
        layout.annotations = [{ x: 700, y: iqPct, text: 'Current is clipped here', showarrow: true, arrowhead: 2, ay: -28 }];
    } else {
        layout.annotations = [{ x: 500, y: 104, text: 'No current ceiling (100%)', showarrow: false, font: { color: '#64748b', size: 11 } }];
    }

    layout.annotations = [
        ...(layout.annotations || []),
        { x: 500, y: 12, text: powerW > 0 ? `Power ceiling: ${powerW} W (separate cap, not shown to scale here)` : 'No power ceiling (0 = off)', showarrow: false, font: { color: '#64748b', size: 11 } },
    ];

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

    const traces = [
        { x: time, y: load, name: 'Pedal load', type: 'scatter', mode: 'lines', line: { width: 3, color: '#2563eb' } },
        { x: [0, 2000], y: [thresholdKg, thresholdKg], name: `Minimum pedal load — ${thresholdKg.toFixed(1)} kg`,
            type: 'scatter', mode: 'lines', line: { width: 2, color: '#dc2626', dash: 'dash' } },
    ];

    if (Math.abs(ridingThresholdKg - thresholdKg) > 0.001) {
        traces.push({
            x: [0, 2000], y: [ridingThresholdKg, ridingThresholdKg], name: `Minimum while riding — ${ridingThresholdKg.toFixed(1)} kg`,
            type: 'scatter', mode: 'lines', line: { width: 2, color: '#f97316', dash: 'dot' },
        });
    }

    const layout = baseLayout('Time (ms)', 'Pedal load (kg)');
    layout.yaxis.range = [0, peakKg * 1.15];
    layout.shapes = [];
    layout.annotations = [];

    if (startTime !== null) {
        layout.shapes.push({ type: 'line', x0: startTime, x1: startTime, y0: 0, y1: 1, yref: 'paper', line: { color: '#16a34a', width: 2, dash: 'dot' } });
        layout.annotations.push({ x: startTime, y: thresholdKg, text: 'Assist starts', showarrow: true, arrowhead: 2, ax: 30, ay: -30, font: { color: '#16a34a' } });
    }

    layout.annotations.push({
        x: 1000, y: peakKg * 1.15 * 0.02, yanchor: 'bottom',
        text: withoutRotation ? 'Can start from a dead stop (no crank rotation needed)' : 'Needs crank rotation AND pedal load together',
        showarrow: false, font: { color: '#64748b', size: 11 },
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
        { x: [0, durationMs], y: [100, 100], name: 'Target level (no boost)', type: 'scatter', mode: 'lines', line: { width: 2, color: '#94a3b8', dash: 'dash' } },
        { x: time, y: value, name: 'With boost / smooth start', type: 'scatter', mode: 'lines', line: { width: 3, color: '#16a34a' } },
    ];

    const layout = baseLayout('Time since start (ms)', 'Requested power (%)');
    const peak = Math.max(...value, 100);
    layout.yaxis.range = [0, peak * 1.15];
    layout.annotations = [];
    if (!boostOn) layout.annotations.push({ x: durationMs * 0.6, y: peak * 1.08, text: 'Startup boost is off', showarrow: false, font: { color: '#64748b', size: 11 } });
    if (!smoothOn) layout.annotations.push({ x: durationMs * 0.15, y: peak * 0.15, text: 'Smooth start is off (instant step)', showarrow: false, font: { color: '#64748b', size: 11 } });

    draw('ebicsEnginePreviewLaunchChart', traces, layout);
}

// ── Current ramps — acceleration and deceleration ───────────────────────────
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
        { ...low, name: `Low speed/cadence — rise ${riseSlow} ms / fall ${fallSlow} ms`, type: 'scatter', mode: 'lines', line: { width: 3, color: '#2563eb' } },
        { ...high, name: `High speed/cadence — rise ${riseFast} ms / fall ${fallFast} ms`, type: 'scatter', mode: 'lines', line: { width: 3, color: '#16a34a' } },
    ];

    const layout = baseLayout('Time — pedal push then release (ms)', 'Motor current (%)');
    layout.xaxis.range = [0, chartEnd];
    layout.yaxis.range = [-5, 110];

    draw('ebicsEnginePreviewRampsChart', traces, layout);
}

// ── Power smoothing and release ─────────────────────────────────────────────
function renderSmoothingChart(level) {
    const riseFilterMs = level.power_rise_filter_ms || 0;
    const fallFilterMs = level.power_fall_filter_ms || 0;
    const releaseMs = level.release_ms || 0;

    const stepUpMs = 150;
    const stepDownMs = 900;
    const totalMs = 1500;
    const dtMs = 20;
    const steps = Math.round(totalMs / dtMs);

    const time = [];
    const raw = [];
    const filtered = [];
    let prevFiltered = 0;
    for (let i = 0; i <= steps; i++) {
        const t = i * dtMs;
        const target = t < stepUpMs ? 0 : (t < stepDownMs ? 100 : 0);
        const isRising = target > prevFiltered;
        const value = applyPowerFilters(target / 100, prevFiltered / 100, { power_rise_filter_ms: riseFilterMs, power_fall_filter_ms: fallFilterMs }, isRising) * 100;
        time.push(t);
        raw.push(target);
        filtered.push(value);
        prevFiltered = value;
    }

    const traces = [
        { x: time, y: raw, name: 'Raw demand', type: 'scatter', mode: 'lines', line: { width: 2, color: '#94a3b8', dash: 'dash' } },
        { x: time, y: filtered, name: 'After rise/fall filters', type: 'scatter', mode: 'lines', line: { width: 3, color: '#2563eb' } },
    ];

    const layout = baseLayout('Time (ms)', 'Power (%)');
    layout.yaxis.range = [-5, 110];
    layout.shapes = [];
    layout.annotations = [];

    if (releaseMs > 0) {
        layout.shapes.push({
            type: 'rect', xref: 'x', yref: 'paper', x0: stepDownMs, x1: Math.min(totalMs, stepDownMs + releaseMs), y0: 0, y1: 1,
            fillcolor: 'rgba(220, 38, 38, 0.08)', line: { width: 0 },
        });
        layout.annotations.push({ x: stepDownMs + releaseMs / 2, y: 104, text: `Release duration — ${releaseMs} ms`, showarrow: false, font: { color: '#dc2626', size: 10 } });
    } else {
        layout.annotations.push({ x: stepDownMs, y: 104, text: 'Release duration: AUTO (firmware decides timing)', showarrow: false, font: { color: '#64748b', size: 10 } });
    }

    draw('ebicsEnginePreviewSmoothingChart', traces, layout);
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
}

export function bindEnginePreviewControls() {
    // Nothing to bind globally — each group's chart redraws via the "toggle" listener
    // profiles.js attaches to its own <details>, and via the shared field refresh callback.
}

// Called by profiles.js whenever the selected level's fields (re)render or change.
export function updateEnginePreviewUI(level, tuning) {
    renderEnginePreview(level, tuning);
}
