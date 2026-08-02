// evistdrive/dynamics.js — eVistDrive Dynamics card: the global ride-feel tuning block (0x6023)
/* global Plotly */
import { state, socket, addLog } from '../shared.js';
import { markUnsavedInRam } from './global-actions.js';
import {
    el, clamp, setText, socketReady, selectedLevel, activeBankIndex, currentLevelIndex, tabIsVisible,
    writeTuningAndWait,
    fieldInput, plotLayout,
} from './common.js';

// FW-069: the four Iq ramps moved OUT of this card. They are per level now and live in
// Profiles, next to the other power build-up settings (release, rise/fall filters).
const TUNING_FIELDS = [
    // FW-068: the crank-movement half of the start condition. Global on purpose — it guards
    // against the cranks being rocked back and forth, which is a property of the bike and its
    // sensor rather than of an assist level.
    { key: 'assist_start_steps', label: 'Crank movement to start', unit: 'steps', min: 1, max: 20, step: 1,
        help: 'How many forward steps of the cadence sensor are needed before assist may start at all. 4 ≈ 15° of crank rotation. Lower = assist catches sooner when pulling away; higher = harder to trigger by rocking the cranks back and forth on a descent. Works together with "Minimum pedal load" on each level — both conditions must be met.' },
    { key: 'startup_boost_cadence_step', label: 'Startup boost fade per cadence step', unit: '', min: 1, max: 100, step: 1,
        help: 'How fast each level’s "Startup boost" fades away as cadence rises. Higher = the boost disappears sooner after you start pedalling; lower = it lingers longer.' },
    // FW-032: ride latch (keeps assist alive through the crank dead-spots after a legal start).
    { key: 'assist_run_deadband_mv', label: 'Run deadband (keep-alive load)', unit: 'mV', min: 0, max: 100, step: 1,
        help: 'Once assist has properly started (see "Minimum pedal load" on a level), pedal load can drop this low before assist is allowed to release — keeps the motor pulling through the light spot of each pedal stroke instead of pulsing on/off. Higher values let light pedalling release sooner. Example presets (Aggressive / Normal / Smooth): 10 / 8 / 5 mV.' },
    { key: 'assist_hold_ms', label: 'Sustain through dead-spot', unit: 'ms', min: 0, max: 3000, step: 10,
        help: 'How long assist stays latched at very light pedal load (below Run deadband) before it gives up and releases. Lower values release sooner; higher values bridge longer dead spots but can make light pedalling keep pulling. Example presets (Aggressive / Normal / Smooth): 300 / 600 / 1000 ms.' },
    { key: 'assist_min_iq_pct', label: 'Current floor while latched', unit: '%', min: 0, max: 25, step: 1,
        help: 'Minimum motor current (percent of the level’s current limit) while assist is latched and you are still pedalling forward. Lower values allow very light assistance; higher values keep the motor pulling between pedal strokes. Example presets (Aggressive / Normal / Smooth): 0 / 1 / 2%.' },
    // FW-033: RUN torque estimator — smooths per-leg peaks in the power calc (0 = off).
    { key: 'assist_torque_run_filter_ms', label: 'RUN torque smoothing (anti-pulse)', unit: 'ms', min: 0, max: 1000, step: 10,
        help: 'Smooths the pedal-load signal used for RUN power/eMTB/torque calculations (not for starting or stopping). Higher values reduce per-leg pulsing but react more slowly to effort changes; lower values feel more immediate. 0 = raw signal. Example presets (Aggressive / Normal / Smooth): 100 / 200 / 350 ms.' },
];

// CB-020: the global block's fields, for the preset importer to clamp with. Same list the
// card renders from, so the two cannot drift apart.
export function tuningFieldDescriptors() {
    return TUNING_FIELDS;
}

// Must match .ebics-chart min-height in style.css, so the reserved space and the drawn chart
// agree — otherwise the plot either overlaps the next card or leaves a gap.
const DYNAMICS_CHART_HEIGHT = 380;

function ensureTuningDefaults() {
    if (!state.lastTuning) {
        state.lastTuning = { ...TUNING_DEFAULTS };
        return;
    }
    // FW-032/033/068: an older controller read won't include these fields — backfill defaults.
    ['assist_run_deadband_mv', 'assist_hold_ms', 'assist_min_iq_pct', 'assist_torque_run_filter_ms',
        'assist_start_steps']
        .forEach((key) => {
            if (state.lastTuning[key] == null) state.lastTuning[key] = TUNING_DEFAULTS[key];
        });
}

export function renderDynamics() {
    ensureTuningDefaults();
    const groups = [
        { container: el('ebicsDynamicsBoostFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('startup_boost_')) },
        { container: el('ebicsDynamicsLatchFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('assist_start_') || field.key.startsWith('assist_run_') || field.key.startsWith('assist_hold_') || field.key.startsWith('assist_min_')) },
        { container: el('ebicsDynamicsTorqueRunFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('assist_torque_run_')) },
    ];
    groups.forEach((group) => {
        if (!group.container) return;
        group.container.innerHTML = '';
        // CB-012: Shift+click a single field to put just that one back.
        group.fields.forEach((field) => fieldInput(group.container, state.lastTuning, {
            ...field,
            factoryDefault: TUNING_DEFAULTS[field.key],
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
    // FW-069: still sent on the wire so an older controller keeps a sane blob, but this
    // firmware ignores them — the live values are per level in Profiles.
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
    iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20,
    assist_start_steps: 4, // FW-068
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
    // FW-069: the acceleration/deceleration ramp charts moved to the Profiles card together
    // with the fields that drive them — they are per level now. Only the boost chart is left.
    // FW-070: and that one now lives in the Profiles tab too, in the global band. Plotly must
    // not draw into a hidden container (it sizes to 0 and the chart comes back blank), so the
    // visibility gate has to follow the fields to their new tab.
    if (!tabIsVisible('tab-ebics-profiles')) return;
    ensureTuningDefaults();
    const tuning = state.lastTuning;

    const profile = selectedLevel().level || state.lastBanks?.[activeBankIndex()]?.levels?.[currentLevelIndex()];
    const strength = profile?.startup_boost_enabled ? profile.startup_boost_strength_pct || 0 : 0;
    const endRpm = Math.max(10, profile?.startup_boost_end_rpm || 90);
    const cadence = Array.from({ length: Math.ceil(endRpm / 5) + 1 }, (_, index) => index * 5);
    const fade = clamp((256 - tuning.startup_boost_cadence_step) / 256, 0, 1);
    const boost = cadence.map((rpm) => strength * Math.pow(fade, rpm / 5));
    const boostChart = el('ebicsDynamicsBoostChart');
    const boostLayout = plotLayout('Cadence (rpm)', 'Boost (%)');
    // Declare the height explicitly. Without it Plotly falls back to its own 450px default
    // while .ebics-chart only reserves min-height, and the chart paints over the card below.
    boostLayout.height = DYNAMICS_CHART_HEIGHT;
    if (boostChart) Plotly.react(boostChart, [{ x: cadence, y: boost, name: 'Boost', type: 'scatter', mode: 'lines', fill: 'tozeroy', line: { width: 3, color: '#2563eb' } }], boostLayout, { responsive: true, displaylogo: false });
}

// FW-017: fall ramps shown in the System card next to the live diagnostics they explain.
// FW-069: they are per level now, so the tuning block is no longer the right source — its
// copy of these bytes is dead weight kept only for wire compatibility. Read them from the
// level actually selected in Profiles, which is what the controller is running.
export function updateDiagTuning() {
    const level = selectedLevel().level;
    setText('diagFallSlow', level?.iq_fall_slow_ms ?? '—');
    setText('diagFallFast', level?.iq_fall_fast_ms ?? '—');
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
