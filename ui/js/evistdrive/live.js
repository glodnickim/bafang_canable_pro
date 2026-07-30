// evistdrive/live.js — eVistDrive Live card: the rolling picture of what the bike is doing now
/* global Plotly */
import { state } from '../shared.js';
import {
    LEVEL_NAMES, MODE_LABELS, el, isNumber, displayNumber, setText,
    activeBankIndex, currentLevelIndex, getPedalLoadKg, currentElectricalPower, plotLayout,
} from './common.js';

// Roughly the last minute at the 300 ms redraw rate below.
const HISTORY_POINTS = 180;
const REDRAW_INTERVAL_MS = 300;

let liveChartLastUpdate = 0;
const liveHistory = { time: [], load: [], cadence: [], power: [], speed: [] };

export function updateLiveSummary(eventType = '') {
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
    if (now - liveChartLastUpdate < REDRAW_INTERVAL_MS || typeof Plotly === 'undefined') return;
    liveChartLastUpdate = now;
    liveHistory.time.push(new Date(now));
    liveHistory.load.push(isNumber(load) ? load : null);
    liveHistory.cadence.push(isNumber(cadence) ? cadence : null);
    liveHistory.power.push(isNumber(power) ? power : null);
    liveHistory.speed.push(isNumber(speed) ? speed : null);
    Object.values(liveHistory).forEach((values) => {
        if (values.length > HISTORY_POINTS) values.splice(0, values.length - HISTORY_POINTS);
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
