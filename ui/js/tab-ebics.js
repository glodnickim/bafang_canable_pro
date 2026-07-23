// tab-ebics.js — separate eVistDrive Ride Core views kept alongside factory tabs
/* global Plotly */
import {
    state, socket, addLog, torqueMvToKg, torqueModel,
    TORQUE_ZERO_MV, TORQUE_DEFAULT_SPAN_MV, TORQUE_FULL_SCALE_KG,
} from './shared.js';

// Native mV per kg on the measured default characteristic (span 1620 / 60 kg = 27).
const EBICS_MV_PER_KG = TORQUE_DEFAULT_SPAN_MV / TORQUE_FULL_SCALE_KG;
import { isEbicsUIAvailable } from './ebics-detection.js';
import { updateEbicsCompatibilityUI } from './ebics-compat.js';

const LEVEL_NAMES = ['ECO', 'TOUR', 'SPORT', 'SPORT+', 'BOOST'];
const MODES = [
    { value: 1, label: 'Power Linear' },
    { value: 2, label: 'Power Progressive' },
    { value: 3, label: 'eMTB TSDZ' },
    { value: 5, label: 'Torque TSDZ' },
];
const MODE_LABELS = Object.fromEntries(MODES.map((mode) => [mode.value, mode.label]));
const TUNING_FIELDS = [
    { key: 'iq_rise_slow_ms', label: 'Acceleration — low speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10 },
    { key: 'iq_rise_fast_ms', label: 'Acceleration — high speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10 },
    { key: 'iq_fall_slow_ms', label: 'Deceleration — low speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10 },
    { key: 'iq_fall_fast_ms', label: 'Deceleration — high speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10 },
    { key: 'startup_boost_cadence_step', label: 'Startup boost fade per cadence step', unit: '', min: 1, max: 100, step: 1 },
];

const el = (id) => document.getElementById(id);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const displayNumber = (value, precision = 0) => isNumber(value) ? value.toFixed(precision) : 'N/A';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let liveChartLastUpdate = 0;
let limitsChartLastUpdate = 0;
const liveHistory = { time: [], load: [], cadence: [], power: [], speed: [] };

function socketReady() {
    if (socket.readyState === WebSocket.OPEN && state.isCanConnected) return true;
    addLog('ERR', 'CAN controller is not connected.');
    return false;
}

function activeBankIndex() {
    const value = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank;
    return value === 1 ? 1 : 0;
}

function currentLevelIndex() {
    const value = state.displayRealtime?.current_assist_level;
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value - 1;
    return 0;
}

function selectedLevel(bankSelectId = 'ebicsProfileBankSelect', levelSelectId = 'ebicsProfileLevelSelect') {
    const bankIndex = parseInt(el(bankSelectId)?.value ?? '0', 10);
    const levelIndex = parseInt(el(levelSelectId)?.value ?? '0', 10);
    return {
        bankIndex,
        levelIndex,
        bank: state.lastBanks?.[bankIndex] || null,
        level: state.lastBanks?.[bankIndex]?.levels?.[levelIndex] || null,
    };
}

function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
}

function getPedalLoadKg() {
    const raw = isNumber(state.controllerRealtime0?.torque)
        ? state.controllerRealtime0.torque
        : state.sensorRealtime?.torque;
    return isNumber(raw) ? torqueMvToKg(raw) : null;
}

function currentElectricalPower() {
    const current = state.controllerRealtime1?.current;
    const voltage = state.controllerRealtime1?.voltage;
    return isNumber(current) && isNumber(voltage) ? Math.max(0, current * voltage) : null;
}

function populateSelects() {
    ['ebicsProfileLevelSelect', 'ebicsLimitsLevelSelect'].forEach((id) => {
        const select = el(id);
        if (!select || select.options.length) return;
        LEVEL_NAMES.forEach((name, index) => select.add(new Option(name, String(index))));
    });
    const modeSelect = el('ebicsProfileModeSelect');
    if (modeSelect && !modeSelect.options.length) {
        MODES.forEach((mode) => modeSelect.add(new Option(mode.label, String(mode.value))));
    }
}

function fieldInput(container, target, descriptor, onChanged) {
    if (!container || !target) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ebics-field';
    const label = document.createElement('label');
    label.textContent = descriptor.unit ? `${descriptor.label} (${descriptor.unit})` : descriptor.label;
    if (descriptor.help) label.title = descriptor.help;
    wrapper.appendChild(label);

    const input = document.createElement('input');
    if (descriptor.type === 'checkbox') {
        input.type = 'checkbox';
        input.checked = !!target[descriptor.key];
        input.addEventListener('change', () => {
            target[descriptor.key] = input.checked;
            onChanged?.();
        });
    } else {
        input.type = 'number';
        input.className = 'form-input';
        input.min = descriptor.min;
        input.max = descriptor.max;
        input.step = descriptor.step ?? 1;
        const fromNative = descriptor.fromNative || ((value) => value);
        const toNative = descriptor.toNative || ((value) => value);
        input.value = fromNative(target[descriptor.key] ?? descriptor.min);
        input.addEventListener('change', () => {
            let value = parseFloat(input.value);
            if (!Number.isFinite(value)) value = descriptor.min;
            value = clamp(value, descriptor.min, descriptor.max);
            input.value = value;
            target[descriptor.key] = toNative(value);
            onChanged?.();
        });
    }
    wrapper.appendChild(input);
    container.appendChild(wrapper);
}

function modeFields(mode) {
    if (mode === 2) {
        return [
            { key: 'support_min_pct', label: 'Minimum support', unit: '%', min: 0, max: 1000, step: 10 },
            { key: 'support_max_pct', label: 'Maximum support', unit: '%', min: 0, max: 1000, step: 10 },
            { key: 'reference_power_w', label: 'Reference rider power', unit: 'W', min: 20, max: 1000, step: 10 },
            { key: 'progression_pct', label: 'Progression', unit: '%', min: 0, max: 100, step: 5 },
        ];
    }
    if (mode === 3) {
        return [
            { key: 'emtb_parameter', label: 'eMTB sensitivity', min: 0, max: 250, step: 5 },
            { key: 'emtb_based_on_power', label: 'Cadence-dependent response', type: 'checkbox' },
            {
                key: 'emtb_reference_voltage_mv', label: 'Reference voltage', unit: 'V', min: 12, max: 84, step: 1,
                fromNative: (value) => Math.round(value / 1000), toNative: (value) => Math.round(value * 1000),
            },
        ];
    }
    if (mode === 5) {
        return [
            {
                key: 'torque_assist_factor', label: 'Torque gain — 120 = 1.0×', min: 0, max: 254, step: 5,
                help: 'Scales the torque-derived target. Unlike Support %, it does not multiply estimated rider power.',
            },
        ];
    }
    return [{ key: 'support_ratio_pct', label: 'Rider power support', unit: '%', min: 0, max: 1000, step: 10 }];
}

function sharedFields() {
    return [
        { key: 'max_motor_power_w', label: 'Maximum motor power — 0 disables', unit: 'W', min: 0, max: 1500, step: 25 },
        { key: 'max_iq_pct', label: 'Maximum motor current', unit: '%', min: 0, max: 100, step: 5 },
        { key: 'assist_without_rotation', label: 'Assist without crank rotation', type: 'checkbox' },
        {
            key: 'without_rotation_threshold_mv', label: 'Minimum pedal load', unit: 'kg', min: 0, max: 11, step: 0.1,
            fromNative: (value) => Math.round((value / EBICS_MV_PER_KG) * 10) / 10,
            toNative: (value) => Math.round(value * EBICS_MV_PER_KG),
            help: 'Relative load above the automatically calibrated zero point. Firmware accepts 0-300 mV native, which is ~0-11 kg on the measured sensor characteristic.',
        },
        { key: 'startup_boost_enabled', label: 'Startup boost', type: 'checkbox' },
        { key: 'startup_boost_strength_pct', label: 'Startup boost strength', unit: '%', min: 0, max: 300, step: 10 },
        { key: 'startup_boost_end_rpm', label: 'Startup boost end cadence', unit: 'rpm', min: 0, max: 120, step: 5 },
        { key: 'smooth_start_enabled', label: 'Smooth start', type: 'checkbox' },
        { key: 'smooth_start_ms', label: 'Smooth start duration', unit: 'ms', min: 0, max: 5000, step: 50 },
        { key: 'release_ms', label: 'Release duration — 0 = automatic', unit: 'ms', min: 0, max: 3000, step: 50 },
        { key: 'power_rise_filter_ms', label: 'Power rise filter', unit: 'ms', min: 0, max: 5000, step: 50 },
        { key: 'power_fall_filter_ms', label: 'Power fall filter', unit: 'ms', min: 0, max: 5000, step: 50 },
    ];
}

function renderProfileEditor() {
    const selected = selectedLevel();
    const source = el('ebicsProfilesSource');
    if (source) source.textContent = state.ebicsReceivedBanks?.[selected.bankIndex]
        ? 'Selected bank read from controller'
        : 'Offline defaults — read selected bank before writing';
    if (!selected.level) {
        if (el('ebicsProfileModeFields')) el('ebicsProfileModeFields').textContent = 'No bank data.';
        if (el('ebicsProfileSharedFields')) el('ebicsProfileSharedFields').textContent = 'No bank data.';
        return;
    }

    const modeSelect = el('ebicsProfileModeSelect');
    if (modeSelect) modeSelect.value = String(selected.level.mode_type || 1);
    const modeContainer = el('ebicsProfileModeFields');
    const sharedContainer = el('ebicsProfileSharedFields');
    if (modeContainer) modeContainer.innerHTML = '';
    if (sharedContainer) sharedContainer.innerHTML = '';
    const refresh = () => {
        renderProfileChart();
        updateTorqueSummary();
        updateLimitsSummary();
    };
    modeFields(selected.level.mode_type || 1).forEach((field) => fieldInput(modeContainer, selected.level, field, refresh));
    sharedFields().forEach((field) => fieldInput(sharedContainer, selected.level, field, refresh));
    renderProfileChart();
}

function plotLayout(titleX, titleY) {
    return {
        margin: { l: 58, r: 24, t: 18, b: 52 },
        paper_bgcolor: '#ffffff', plot_bgcolor: '#f8fafc',
        font: { family: 'system-ui, sans-serif', size: 11, color: '#475569' },
        xaxis: { title: titleX, gridcolor: '#e2e8f0', zerolinecolor: '#cbd5e1' },
        yaxis: { title: titleY, gridcolor: '#e2e8f0', rangemode: 'tozero' },
        legend: { orientation: 'h', y: 1.12 },
        hovermode: 'x unified',
    };
}

function profilePlotLayout(titleX, titleY) {
    const layout = plotLayout(titleX, titleY);
    layout.height = 380;
    layout.margin = { ...layout.margin, b: 78 };
    layout.xaxis = { ...layout.xaxis, automargin: true };
    layout.yaxis = { ...layout.yaxis, automargin: true };
    layout.legend = { ...layout.legend, y: 1.08 };
    return layout;
}

function renderProfileChart() {
    const chart = el('ebicsProfileChart');
    const level = selectedLevel().level;
    if (!chart || !level || typeof Plotly === 'undefined') return;
    const mode = level.mode_type || 1;
    let traces = [];
    let layout;
    if (mode === 1 || mode === 2) {
        const x = Array.from({ length: 21 }, (_, index) => index * 20);
        const y = x.map((humanPower) => {
            let support = level.support_ratio_pct || 0;
            if (mode === 2) {
                const reference = Math.max(20, level.reference_power_w || 200);
                const input = clamp(humanPower / reference, 0, 1);
                const progression = clamp((level.progression_pct || 0) / 100, 0, 1);
                const curve = (1 - progression) * input + progression * input * input;
                support = (level.support_min_pct || 0) + ((level.support_max_pct || 0) - (level.support_min_pct || 0)) * curve;
            }
            const output = humanPower * support / 100;
            return level.max_motor_power_w > 0 ? Math.min(output, level.max_motor_power_w) : output;
        });
        traces = [{ x, y, name: MODE_LABELS[mode], type: 'scatter', mode: 'lines', line: { width: 3, color: '#2563eb' } }];
        layout = profilePlotLayout('Rider power (W)', 'Requested motor power (W)');
    } else {
        const load = Array.from({ length: 31 }, (_, index) => index * 2);
        const referenceVoltage = Math.max(12000, level.emtb_reference_voltage_mv || 36000);
        const cadences = mode === 3 && level.emtb_based_on_power ? [30, 60, 90] : [60];
        traces = cadences.map((cadence, traceIndex) => ({
            x: load,
            y: load.map((kg) => {
                const deltaX160 = kg * 160 / 60;
                let targetX160;
                if (mode === 5) {
                    targetX160 = deltaX160 * (level.torque_assist_factor || 0) / 120;
                } else {
                    const denominator = Math.max(10, 510 - 2 * (level.emtb_parameter || 0) - (level.emtb_based_on_power ? cadence : 0));
                    targetX160 = deltaX160 * deltaX160 / denominator;
                }
                const output = targetX160 * referenceVoltage * 160 / 1000000;
                return level.max_motor_power_w > 0 ? Math.min(output, level.max_motor_power_w) : output;
            }),
            name: mode === 3 && level.emtb_based_on_power ? `${cadence} rpm` : MODE_LABELS[mode],
            type: 'scatter', mode: 'lines', line: { width: 3, color: ['#2563eb', '#16a34a', '#ea580c'][traceIndex] },
        }));
        layout = profilePlotLayout('Pedal load (kg)', 'Requested motor power (W)');
    }
    Plotly.react(chart, traces, layout, { responsive: true, displaylogo: false });
}

function updateLiveSummary(eventType = '') {
    const bankIndex = activeBankIndex();
    const levelIndex = currentLevelIndex();
    const level = state.lastBanks?.[bankIndex]?.levels?.[levelIndex];
    const load = getPedalLoadKg();
    const cadence = isNumber(state.controllerRealtime0?.cadence) ? state.controllerRealtime0.cadence : state.sensorRealtime?.cadence;
    const realtime = state.controllerRealtime1;
    const power = currentElectricalPower();
    const displayLevel = state.displayRealtime?.current_assist_level;

    setText('ebicsLiveBank', state.banksSynced ? `Bank ${bankIndex + 1}` : 'N/A');
    setText('ebicsLiveLevel', Number.isInteger(displayLevel) ? (displayLevel === 0 ? 'OFF' : LEVEL_NAMES[displayLevel - 1] || `Level ${displayLevel}`) : 'N/A');
    setText('ebicsLiveMode', level ? MODE_LABELS[level.mode_type] || `Mode ${level.mode_type}` : 'N/A');
    setText('ebicsLiveTorqueKg', displayNumber(load, 1));
    setText('ebicsLiveCadence', displayNumber(cadence));
    setText('ebicsLiveSpeed', displayNumber(realtime?.speed, 1));
    setText('ebicsLivePower', displayNumber(power));
    setText('ebicsLiveCurrent', displayNumber(realtime?.current, 1));
    setText('ebicsLiveControllerTemp', displayNumber(realtime?.temperature));
    setText('ebicsLiveMotorTemp', displayNumber(realtime?.motor_temperature));
    setText('ebicsLiveControllerState', state.controllerState?.state_number ?? 'N/A');
    setText('ebicsLiveRemainingCapacity', displayNumber(state.controllerRealtime0?.remaining_capacity));
    setText('ebicsLiveRemainingDistance', displayNumber(state.controllerRealtime0?.remaining_distance, 1));
    setText('ebicsLiveLastTrip', displayNumber(state.controllerRealtime0?.single_trip, 1));

    if (['controller_realtime_0', 'controller_realtime_1', 'sensor_realtime'].includes(eventType)) updateLiveChart(load, cadence, power, realtime?.speed);
}

function updateLiveChart(load, cadence, power, speed) {
    const now = Date.now();
    if (!el('tab-ebics-live')?.classList.contains('active')) return;
    if (now - liveChartLastUpdate < 300 || typeof Plotly === 'undefined') return;
    liveChartLastUpdate = now;
    liveHistory.time.push(new Date(now));
    liveHistory.load.push(isNumber(load) ? load : null);
    liveHistory.cadence.push(isNumber(cadence) ? cadence : null);
    liveHistory.power.push(isNumber(power) ? power : null);
    liveHistory.speed.push(isNumber(speed) ? speed : null);
    Object.values(liveHistory).forEach((values) => {
        if (values.length > 180) values.splice(0, values.length - 180);
    });
    const chart = el('ebicsLiveChart');
    if (!chart) return;
    const traces = [
        { x: liveHistory.time, y: liveHistory.load, name: 'Load (kg)', type: 'scatter', mode: 'lines', line: { color: '#2563eb' } },
        { x: liveHistory.time, y: liveHistory.cadence, name: 'Cadence (rpm)', type: 'scatter', mode: 'lines', line: { color: '#16a34a' } },
        { x: liveHistory.time, y: liveHistory.speed, name: 'Speed (km/h)', type: 'scatter', mode: 'lines', line: { color: '#9333ea' } },
        { x: liveHistory.time, y: liveHistory.power, name: 'Power (W)', type: 'scatter', mode: 'lines', yaxis: 'y2', line: { color: '#ea580c' } },
    ];
    const layout = plotLayout('Time', 'Load / cadence / speed');
    layout.yaxis2 = { title: 'Power (W)', overlaying: 'y', side: 'right', rangemode: 'tozero', gridcolor: 'transparent' };
    layout.margin.r = 58;
    Plotly.react(chart, traces, layout, { responsive: true, displaylogo: false });
}

function updateTorqueSummary() {
    const load = getPedalLoadKg();
    const safeLoad = isNumber(load) ? clamp(load, 0, 60) : 0;
    setText('ebicsTorqueKg', safeLoad.toFixed(1));
    const fill = el('ebicsTorqueGaugeFill');
    if (fill) fill.style.width = `${safeLoad / 60 * 100}%`;
    const level = selectedLevel().level || state.lastBanks?.[activeBankIndex()]?.levels?.[currentLevelIndex()];
    const minLoad = isNumber(level?.without_rotation_threshold_mv) ? level.without_rotation_threshold_mv / EBICS_MV_PER_KG : null;
    setText('ebicsTorqueMinLoadKg', displayNumber(minLoad, 1));
}

const CAL_STATE_LABELS = ['Idle', 'Capturing zero…', 'Apply reference weight', 'Capturing load…', 'Preview ready', 'Success', 'Failed', 'Cancelled'];
const CAL_ERROR_LABELS = ['None', 'Not stationary', 'Signal unstable', 'Reference out of range', 'Load too small', 'Sensor saturated', 'Computed scale out of range', 'Sensor fault', 'Timeout'];

// FW-013: refresh calibration/telemetry card from a 0x6025 snapshot.
export function updateTorqueCalUI(t) {
    if (!t) return;
    setText('ebicsTorqueSourcePill', torqueModel.source === 'firmware'
        ? `Scale: firmware (${torqueModel.calibrationSource === 'user' ? 'calibrated' : 'default'})`
        : 'Scale: default (estimated)');
    setText('ebicsTorqueKg', ((t.load_centikg || 0) / 100).toFixed(1));
    const fill = el('ebicsTorqueGaugeFill');
    if (fill) fill.style.width = `${clamp((t.load_centikg || 0) / 6000 * 100, 0, 100)}%`;
    setText('ebicsTorqueCalSource', t.calibration_source === 1 ? 'User calibrated' : 'Default');
    setText('ebicsTorqueZero', t.zero_effective_native ?? 'N/A');
    setText('ebicsTorqueFullScale', t.full_scale_native ?? 'N/A');
    setText('ebicsCalState', CAL_STATE_LABELS[t.calibration_state] ?? String(t.calibration_state));
    setText('ebicsCalError', CAL_ERROR_LABELS[t.calibration_error] ?? String(t.calibration_error));
    setText('ebicsCalPreviewSpan', t.preview_span_native ? `${t.preview_span_native}` : 'N/A');
}

// FW-015: TSDZ diagnostics card
export function updateDiagUI(d) {
    if (!d) return;
    setText('diagCadence', d.cadence_for_assist);
    setText('diagTorque', d.torque_for_assist_mv);
    setText('diagHumanPower', d.human_power_w);
    setText('diagSupport', d.support_ratio_pct);
    setText('diagMotorPower', d.motor_power_w);
    setText('diagBatCurrent', d.requested_battery_current_ma);
    setText('diagIqRequest', d.iq_request);
    setText('diagIqSetpoint', d.iq_setpoint);
    setText('diagSpeed', (d.speed_x100 / 100).toFixed(1));
}

// FW-014: ride engine status card
export function updateEngineUI(s) {
    if (!s) return;
    setText('ebicsEngineActive', s.ride_engine === 1 ? 'TSDZ (new ride-core)' : 'Legacy (proven)');
    setText('ebicsEnginePending', s.ride_engine_pending === null || s.ride_engine_pending === undefined
        ? 'None'
        : (s.ride_engine_pending === 1 ? 'TSDZ (new) — waiting for standstill' : 'Legacy — waiting for standstill'));
}

function ensureTuningDefaults() {
    if (!state.lastTuning) {
        state.lastTuning = {
            iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
            iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
            startup_boost_cadence_step: 20,
        };
    }
}

function renderDynamics() {
    ensureTuningDefaults();
    const groups = [
        { container: el('ebicsDynamicsAccelerationFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('iq_rise_')) },
        { container: el('ebicsDynamicsDecelerationFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('iq_fall_')) },
        { container: el('ebicsDynamicsBoostFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('startup_boost_')) },
    ];
    groups.forEach((group) => {
        if (!group.container) return;
        group.container.innerHTML = '';
        group.fields.forEach((field) => fieldInput(group.container, state.lastTuning, field, renderDynamicsCharts));
    });
    renderDynamicsCharts();
}

function renderDynamicsCharts() {
    if (typeof Plotly === 'undefined') return;
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
    if (boostChart) Plotly.react(boostChart, [{ x: cadence, y: boost, name: 'Boost', type: 'scatter', mode: 'lines', fill: 'tozeroy', line: { width: 3, color: '#2563eb' } }], plotLayout('Cadence (rpm)', 'Boost (%)'), { responsive: true, displaylogo: false });
}

function updateLimitsSummary(forceChart = false) {
    const selection = selectedLevel('ebicsLimitsBankSelect', 'ebicsLimitsLevelSelect');
    const level = selection.level;
    const batteryLimit = state.controllerParams1?.current_limit;
    const motorLimit = state.controllerParams1?.max_current_on_low_charge;
    const liveCurrent = state.controllerRealtime1?.current;
    const livePower = currentElectricalPower();
    setText('ebicsLimitBatteryCurrent', displayNumber(batteryLimit));
    setText('ebicsLimitMotorCurrent', displayNumber(motorLimit));
    setText('ebicsLimitPower', displayNumber(level?.max_motor_power_w));
    setText('ebicsLimitIq', displayNumber(level?.max_iq_pct));
    setText('ebicsLimitLiveCurrent', displayNumber(liveCurrent, 1));
    setText('ebicsLimitLivePower', displayNumber(livePower));

    const chart = el('ebicsLimitsChart');
    if (!chart || typeof Plotly === 'undefined') return;
    const now = Date.now();
    if (!forceChart && (!el('tab-ebics-limits')?.classList.contains('active') || now - limitsChartLastUpdate < 300)) return;
    limitsChartLastUpdate = now;
    const currentPct = isNumber(liveCurrent) && isNumber(batteryLimit) && batteryLimit > 0 ? 100 * liveCurrent / batteryLimit : null;
    const powerPct = isNumber(livePower) && isNumber(level?.max_motor_power_w) && level.max_motor_power_w > 0 ? 100 * livePower / level.max_motor_power_w : null;
    Plotly.react(chart, [
        { x: ['Battery current', 'Motor power'], y: [currentPct, powerPct], name: 'Live / ceiling', type: 'bar', marker: { color: ['#2563eb', '#16a34a'] }, text: [currentPct, powerPct].map((value) => isNumber(value) ? `${value.toFixed(0)}%` : 'N/A'), textposition: 'auto' },
        { x: ['Battery current', 'Motor power'], y: [100, level?.max_motor_power_w > 0 ? 100 : null], name: 'Configured ceiling', type: 'bar', marker: { color: '#cbd5e1' } },
    ], { ...plotLayout('', 'Configured ceiling (%)'), barmode: 'group', yaxis: { title: 'Configured ceiling (%)', range: [0, Math.max(120, currentPct || 0, powerPct || 0)], gridcolor: '#e2e8f0' } }, { responsive: true, displaylogo: false });
}

function updateWalkAndLegacy() {
    const p0 = state.controllerParams0;
    const p1 = state.controllerParams1;
    const p2 = state.controllerParams2;
    setText('ebicsWalkCurrent', p1?.speed_limit_enabled ?? 'N/A');
    setText('ebicsWalkSpeed', displayNumber(p1?.walk_assist_speed, 1));
    const rows = [
        ['0x6010', 'Acceleration table entries', p0?.acceleration_levels?.length ?? 'N/A'],
        ['0x6010', 'Assist-ratio table entries', p0?.assist_ratio_levels?.length ?? 'N/A'],
        ['0x6011', 'System voltage', isNumber(p1?.system_voltage) ? `${p1.system_voltage} V` : 'N/A'],
        ['0x6011', 'Battery current limit', isNumber(p1?.current_limit) ? `${p1.current_limit} A` : 'N/A'],
        ['0x6011', 'Stored low-charge current byte', isNumber(p1?.max_current_on_low_charge) ? `${p1.max_current_on_low_charge} A` : 'N/A'],
        ['0x6011', 'Walk current (legacy byte)', p1?.speed_limit_enabled ?? 'N/A'],
        ['0x6011', 'Walk speed', isNumber(p1?.walk_assist_speed) ? `${p1.walk_assist_speed.toFixed(1)} km/h` : 'N/A'],
        ['0x6012', 'Torque profile rows', p2?.torque_profiles?.length ?? 'N/A'],
    ];
    const body = el('ebicsLegacyTableBody');
    if (!body) return;
    body.innerHTML = '';
    rows.forEach((values) => {
        const row = body.insertRow();
        values.forEach((value) => { row.insertCell().textContent = value; });
        row.insertCell().textContent = 'Use original Controller / Assist tabs';
    });
}

export function updateEbicsUI(eventType = '') {
    if (!isEbicsUIAvailable()) return;
    updateEbicsCompatibilityUI(eventType);
    const fullUpdate = !eventType;
    if (fullUpdate || ['controller_realtime_0', 'controller_realtime_1', 'controller_state', 'sensor_realtime', 'display_realtime', 'controller_bank'].includes(eventType)) {
        updateLiveSummary(eventType);
        updateTorqueSummary();
    }
    if (fullUpdate || ['controller_realtime_1', 'controller_params_1', 'controller_bank'].includes(eventType)) {
        updateLimitsSummary(fullUpdate);
    }
    if (fullUpdate || ['controller_params_0', 'controller_params_1', 'controller_params_2'].includes(eventType)) updateWalkAndLegacy();
    if (fullUpdate || eventType === 'controller_bank') renderProfileEditor();
    if (fullUpdate || eventType === 'controller_tuning') renderDynamics();
}

function bindControls() {
    populateSelects();
    ['ebicsProfileBankSelect', 'ebicsProfileLevelSelect'].forEach((id) => el(id)?.addEventListener('change', renderProfileEditor));
    el('ebicsProfileModeSelect')?.addEventListener('change', () => {
        const level = selectedLevel().level;
        if (!level) return;
        level.mode_type = parseInt(el('ebicsProfileModeSelect').value, 10);
        renderProfileEditor();
        updateLiveSummary();
    });
    ['ebicsLimitsBankSelect', 'ebicsLimitsLevelSelect'].forEach((id) => el(id)?.addEventListener('change', updateLimitsSummary));

    el('ebicsProfilesReadButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        addLog('REQ', 'Reading eVistDrive profile banks...');
        socket.send('READ_BANK:0');
        setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send('READ_BANK:1'); }, 400);
    });
    el('ebicsProfilesApplyButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        const selected = selectedLevel();
        if (!selected.bank) { addLog('ERR', 'No eVistDrive bank data to apply.'); return; }
        if (!state.ebicsReceivedBanks?.[selected.bankIndex]) {
            addLog('ERR', `Read eVistDrive bank ${selected.bankIndex + 1} before applying changes.`);
            return;
        }
        socket.send(`WRITE_BANK:${JSON.stringify(selected.bank)}`);
        addLog('SAVE_REQ', `eVistDrive bank ${selected.bankIndex + 1} -> controller RAM`);
    });
    el('ebicsProfilesSaveButton')?.addEventListener('click', () => {
        if (!socketReady() || !confirm('Persist both eVistDrive banks and tuning to flash at full standstill?')) return;
        socket.send('SAVE_BANKS');
        addLog('SAVE_REQ', 'Persist eVistDrive banks and tuning at standstill');
    });
    el('ebicsDynamicsReadButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        socket.send('READ_TUNING');
        addLog('REQ', 'Reading eVistDrive global tuning...');
    });
    el('ebicsDynamicsApplyButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        if (!state.tuningSynced) {
            addLog('ERR', 'Read eVistDrive tuning before applying changes.');
            return;
        }
        ensureTuningDefaults();
        socket.send(`WRITE_TUNING:${JSON.stringify(state.lastTuning)}`);
        addLog('SAVE_REQ', 'eVistDrive tuning -> controller RAM');
    });
    el('ebicsDynamicsSaveButton')?.addEventListener('click', () => {
        if (!socketReady() || !confirm('Persist eVistDrive tuning and banks to flash at full standstill?')) return;
        socket.send('SAVE_BANKS');
        addLog('SAVE_REQ', 'Persist eVistDrive tuning and banks at standstill');
    });

    // FW-013: torque telemetry live read + load calibration operations
    el('ebicsTorqueReadButton')?.addEventListener('click', () => {
        if (socketReady()) { socket.send('READ_TORQUE'); addLog('REQ', 'Reading torque telemetry'); }
    });
    const calRefCentikg = () => {
        const kg = parseFloat(el('ebicsCalRefKg')?.value);
        return (isNumber(kg) && kg > 0) ? Math.round(kg * 100) : 0;
    };
    const calOp = (op, ref) => {
        if (!socketReady()) return;
        socket.send(`TORQUE_CAL:${op}${ref !== undefined ? ':' + ref : ''}`);
        setTimeout(() => socket.send('READ_TORQUE'), 300); // refresh status after the op
    };
    el('ebicsCalStart')?.addEventListener('click', () => { calOp(1); addLog('REQ', 'Calibration: start (capture zero)'); });
    el('ebicsCalCapture')?.addEventListener('click', () => {
        const ref = calRefCentikg();
        if (ref < 500 || ref > 3000) { alert('Reference weight must be 5–30 kg.'); return; }
        calOp(2, ref); addLog('REQ', `Calibration: capture ${ref / 100} kg`);
    });
    el('ebicsCalSave')?.addEventListener('click', () => { calOp(3); addLog('SAVE_REQ', 'Calibration: commit (saved at standstill)'); });
    el('ebicsCalCancel')?.addEventListener('click', () => { calOp(4); addLog('REQ', 'Calibration: cancel'); });
    el('ebicsCalRestore')?.addEventListener('click', () => {
        if (!confirm('Restore the default sensor scale (discard user calibration)?')) return;
        calOp(5); addLog('REQ', 'Calibration: restore default');
    });

    // FW-014: ride engine switch
    el('ebicsEngineReadButton')?.addEventListener('click', () => {
        if (socketReady()) { socket.send('READ_SYSTEM'); addLog('REQ', 'Reading system status'); }
    });
    el('ebicsEngineLegacyButton')?.addEventListener('click', () => {
        if (socketReady()) { socket.send('SET_ENGINE:0'); addLog('REQ', 'Ride engine -> Legacy (at standstill)'); }
    });
    el('ebicsEngineTsdzButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        if (!confirm('Switch to the new TSDZ ride-core engine? It is untested on this motor — do the first switch with the rear wheel in the air.')) return;
        socket.send('SET_ENGINE:1'); addLog('REQ', 'Ride engine -> TSDZ new (at standstill)');
    });

    // FW-015: diagnostics read + auto-poll
    let diagTimer = null;
    el('ebicsDiagReadButton')?.addEventListener('click', () => {
        if (socketReady()) socket.send('READ_DIAG');
    });
    el('ebicsDiagAuto')?.addEventListener('change', (e) => {
        if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
        if (e.target.checked) {
            diagTimer = setInterval(() => { if (socketReady()) socket.send('READ_DIAG'); }, 500);
        }
    });

    window.addEventListener('app-tab-changed', (event) => {
        const tab = String(event.detail?.tab || '');
        if (tab.startsWith('ebics-')) updateEbicsUI();
        if (tab === 'ebics-torque' && socketReady()) socket.send('READ_TORQUE');
        if (tab === 'ebics-system' && socketReady()) socket.send('READ_SYSTEM');
    });
    window.addEventListener('controller-flavor-changed', () => updateEbicsUI());
}

bindControls();
updateEbicsUI();
