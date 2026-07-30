// evistdrive/dynamics.js — eVistDrive Dynamics card: the global ride-feel tuning block (0x6023)
/* global Plotly */
import { state, socket, addLog } from '../shared.js';
import { markUnsavedInRam } from './global-actions.js';
import {
    el, clamp, setText, socketReady, selectedLevel, activeBankIndex, currentLevelIndex, tabIsVisible,
    writeTuningAndWait,
    fieldInput, plotLayout,
} from './common.js';

const TUNING_FIELDS = [
    { key: 'iq_rise_slow_ms', label: 'Acceleration — low speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp from 0% to 100% while pedalling slowly or riding slowly. This is the SLOW end of an adaptive ramp — firmware blends toward the fast value as your speed/cadence rises.' },
    { key: 'iq_rise_fast_ms', label: 'Acceleration — high speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp from 0% to 100% once you are already riding at speed/cadence. Shorter than the slow value — quicker response once you are moving.' },
    { key: 'iq_fall_slow_ms', label: 'Deceleration — low speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp down to 0% at low speed/cadence. Also the base timing for the release fade after you stop pedalling, whenever a level’s "Release duration" is 0 (automatic).' },
    { key: 'iq_fall_fast_ms', label: 'Deceleration — high speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp down to 0% while riding at speed/cadence — shorter than the slow value.' },
    { key: 'startup_boost_cadence_step', label: 'Startup boost fade per cadence step', unit: '', min: 1, max: 100, step: 1,
        help: 'How fast each level’s "Startup boost" fades away as cadence rises. Higher = the boost disappears sooner after you start pedalling; lower = it lingers longer.' },
    // FW-032: ride latch (keeps assist alive through the crank dead-spots after a legal start).
    { key: 'assist_run_deadband_mv', label: 'Run deadband (keep-alive load)', unit: 'mV', min: 0, max: 100, step: 1,
        help: 'Once assist has properly started (see "Minimum pedal load" on a level), pedal load can drop this low before assist is allowed to release — keeps the motor pulling through the light spot of each pedal stroke instead of pulsing on/off.' },
    { key: 'assist_hold_ms', label: 'Sustain through dead-spot', unit: 'ms', min: 0, max: 3000, step: 10,
        help: 'How long assist stays latched at very light pedal load (below Run deadband) before it gives up and releases. Stops a single weak moment — a dead spot in the pedal stroke — from cutting assist.' },
    { key: 'assist_min_iq_pct', label: 'Current floor while latched', unit: '%', min: 0, max: 25, step: 1,
        help: 'Minimum motor current (percent of the level’s current limit) while assist is latched and you are still pedalling forward, even if pedal load momentarily reads near zero. Keeps the motor from stalling between pedal strokes.' },
    // FW-033: RUN torque estimator — smooths per-leg peaks in the power calc (0 = off).
    { key: 'assist_torque_run_filter_ms', label: 'RUN torque smoothing (anti-pulse)', unit: 'ms', min: 0, max: 1000, step: 10,
        help: 'Smooths the pedal-load signal used for RUN power/eMTB/torque calculations (not for starting or stopping), so the motor follows your average effort instead of pulsing with every single leg push. 0 = off (raw signal).' },
];

// Must match .ebics-chart min-height in style.css, so the reserved space and the drawn chart
// agree — otherwise the plot either overlaps the next card or leaves a gap.
const DYNAMICS_CHART_HEIGHT = 380;

function ensureTuningDefaults() {
    if (!state.lastTuning) {
        state.lastTuning = { ...TUNING_DEFAULTS };
        return;
    }
    // FW-032/033: an older controller read won't include these fields — backfill defaults.
    ['assist_run_deadband_mv', 'assist_hold_ms', 'assist_min_iq_pct', 'assist_torque_run_filter_ms']
        .forEach((key) => {
            if (state.lastTuning[key] == null) state.lastTuning[key] = TUNING_DEFAULTS[key];
        });
}

export function renderDynamics() {
    ensureTuningDefaults();
    const groups = [
        { container: el('ebicsDynamicsAccelerationFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('iq_rise_')) },
        { container: el('ebicsDynamicsDecelerationFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('iq_fall_')) },
        { container: el('ebicsDynamicsBoostFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('startup_boost_')) },
        { container: el('ebicsDynamicsLatchFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('assist_run_') || field.key.startsWith('assist_hold_') || field.key.startsWith('assist_min_')) },
        { container: el('ebicsDynamicsTorqueRunFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('assist_torque_run_')) },
    ];
    groups.forEach((group) => {
        if (!group.container) return;
        group.container.innerHTML = '';
        // CB-012: Shift+click a single field to put just that one back.
        group.fields.forEach((field) => fieldInput(group.container, state.lastTuning, {
            ...field,
            restoreValue: () => {
                const { source, tuning } = tuningRestoreSource();
                return { value: tuning[field.key], source };
            },
        }, renderDynamicsCharts));
    });
    renderDynamicsCharts();
}

// Firmware defaults for the tuning block, kept apart from state.lastTuning so editing can
// never overwrite the thing a restore is supposed to go back to.
const TUNING_DEFAULTS = Object.freeze({
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
    iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20,
    assist_run_deadband_mv: 5, assist_hold_ms: 1400, assist_min_iq_pct: 2,
    assist_torque_run_filter_ms: 300,
});

// What a restore should put back: the values as read when there are any, otherwise the
// firmware defaults. Always a copy.
function tuningRestoreSource() {
    const read = state.lastTuningAsRead;
    return read
        ? { source: 'read', tuning: JSON.parse(JSON.stringify(read)) }
        : { source: 'defaults', tuning: { ...TUNING_DEFAULTS } };
}

function renderDynamicsCharts() {
    if (typeof Plotly === 'undefined') return;
    // Three charts. Skipped while the card is hidden and redrawn on the way in — see the
    // app-tab-changed handler in index.js, which runs a full refresh per eVistDrive tab.
    if (!tabIsVisible('tab-ebics-dynamics')) return;
    ensureTuningDefaults();
    const tuning = state.lastTuning;
    const rampTrace = (duration, falling, name, color, chartEnd) => ({
        x: [0, duration, chartEnd],
        y: falling ? [100, 0, 0] : [0, 100, 100],
        name,
        type: 'scatter',
        mode: 'lines+markers',
        line: { width: 3, color },
        marker: { size: [10, 10, 5], color, line: { width: 2, color: '#ffffff' } },
        hovertemplate: '%{x:.0f} ms<br>%{y:.0f}%<extra>%{fullData.name}</extra>',
    });
    const rampLayout = (chartEnd, startText, endText) => {
        const layout = plotLayout('Time from target change (ms)', 'Current command (%)');
        // Declare the height (like the profile charts do). Without it Plotly falls back to its
        // own default (450px) while .ebics-chart only reserves min-height, so the chart painted
        // over the card below it.
        layout.height = DYNAMICS_CHART_HEIGHT;
        layout.xaxis.range = [0, chartEnd];
        layout.yaxis.range = [-5, 105];
        layout.hovermode = 'closest';
        layout.annotations = [
            { x: 0, y: startText === '0%' ? 0 : 100, text: `Start ${startText}`, showarrow: true, arrowhead: 2, ax: 42, ay: startText === '0%' ? -28 : 28 },
            { x: chartEnd, y: endText === '100%' ? 100 : 0, text: `Settled ${endText}`, showarrow: false, xanchor: 'right', yshift: endText === '100%' ? -16 : 16 },
        ];
        return layout;
    };

    const riseEnd = Math.max(tuning.iq_rise_slow_ms, tuning.iq_rise_fast_ms, 100) * 1.15;
    const accelerationChart = el('ebicsDynamicsAccelerationChart');
    if (accelerationChart) Plotly.react(accelerationChart, [
        rampTrace(tuning.iq_rise_slow_ms, false, `Low speed — ${tuning.iq_rise_slow_ms} ms`, '#2563eb', riseEnd),
        rampTrace(tuning.iq_rise_fast_ms, false, `High speed — ${tuning.iq_rise_fast_ms} ms`, '#16a34a', riseEnd),
    ], rampLayout(riseEnd, '0%', '100%'), { responsive: true, displaylogo: false });

    const fallEnd = Math.max(tuning.iq_fall_slow_ms, tuning.iq_fall_fast_ms, 100) * 1.15;
    const decelerationChart = el('ebicsDynamicsDecelerationChart');
    if (decelerationChart) Plotly.react(decelerationChart, [
        rampTrace(tuning.iq_fall_slow_ms, true, `Low speed — ${tuning.iq_fall_slow_ms} ms`, '#ea580c', fallEnd),
        rampTrace(tuning.iq_fall_fast_ms, true, `High speed — ${tuning.iq_fall_fast_ms} ms`, '#9333ea', fallEnd),
    ], rampLayout(fallEnd, '100%', '0%'), { responsive: true, displaylogo: false });

    const profile = selectedLevel().level || state.lastBanks?.[activeBankIndex()]?.levels?.[currentLevelIndex()];
    const strength = profile?.startup_boost_enabled ? profile.startup_boost_strength_pct || 0 : 0;
    const endRpm = Math.max(10, profile?.startup_boost_end_rpm || 90);
    const cadence = Array.from({ length: Math.ceil(endRpm / 5) + 1 }, (_, index) => index * 5);
    const fade = clamp((256 - tuning.startup_boost_cadence_step) / 256, 0, 1);
    const boost = cadence.map((rpm) => strength * Math.pow(fade, rpm / 5));
    const boostChart = el('ebicsDynamicsBoostChart');
    const boostLayout = plotLayout('Cadence (rpm)', 'Boost (%)');
    boostLayout.height = DYNAMICS_CHART_HEIGHT; // see rampLayout: keeps it inside its own card
    if (boostChart) Plotly.react(boostChart, [{ x: cadence, y: boost, name: 'Boost', type: 'scatter', mode: 'lines', fill: 'tozeroy', line: { width: 3, color: '#2563eb' } }], boostLayout, { responsive: true, displaylogo: false });
}

// FW-017: stored fall ramps read from the tuning block (0x6023), shown in the System card
// next to the live diagnostics they explain.
export function updateDiagTuning(t) {
    if (!t) return;
    setText('diagFallSlow', t.iq_fall_slow_ms ?? '—');
    setText('diagFallFast', t.iq_fall_fast_ms ?? '—');
}

export function bindDynamicsControls() {
    el('ebicsDynamicsReadButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        socket.send('READ_TUNING');
        addLog('REQ', 'Reading eVistDrive global tuning...');
    });
    // Writes to controller RAM. Making it permanent is the top bar's "Save to Flash",
    // which is one controller command covering the banks and the tuning together — there
    // is no way to persist the tuning on its own.
    el('ebicsDynamicsApplyButton')?.addEventListener('click', async () => {
        if (!socketReady()) return;
        if (!state.tuningSynced) {
            addLog('ERR', 'Read eVistDrive tuning before writing changes.');
            return;
        }
        ensureTuningDefaults();
        const written = await writeTuningAndWait(state.lastTuning);
        if (!written.ok) {
            addLog('ERR', `Tuning was not written (${written.reason}).`);
            return;
        }
        markUnsavedInRam();
        addLog('SAVE_REQ', 'Tuning written to controller RAM — press "Save to Flash" in the top bar to keep it.');
    });

    // CB-012: undo the whole card. Screen only — the bike keeps its settings until Write.
    el('ebicsDynamicsRestoreButton')?.addEventListener('click', () => {
        const { source, tuning } = tuningRestoreSource();
        const label = source === 'read' ? 'the values read from the controller' : 'the firmware defaults';
        if (!confirm(`Put the ride-feel tuning back to ${label}?\n\nThis only changes what you see here. Nothing is sent to the bike until you press "Write (RAM)".`)) return;
        state.lastTuning = tuning;
        renderDynamics();
        addLog('INFO', `Ride-feel tuning put back to ${label}. Not written to the bike — press "Write (RAM)" to apply.`);
    });
}
