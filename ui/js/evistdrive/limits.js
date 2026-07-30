// evistdrive/limits.js — eVistDrive Limits card: live draw against the configured ceilings
//
// The editable limit FIELDS (0x6011 and friends) are rendered by compat.js, which owns
// the legacy parameter blocks. This module owns the summary and the live/ceiling chart.
/* global Plotly */
import { state, socket, addLog } from '../shared.js';
import {
    el, isNumber, displayNumber, setText, socketReady, selectedLevel,
    currentElectricalPower, plotLayout,
} from './common.js';

const REDRAW_INTERVAL_MS = 300;
let limitsChartLastUpdate = 0;

export function updateLimitsSummary(forceChart = false) {
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
    if (!forceChart && (!el('tab-ebics-limits')?.classList.contains('active') || now - limitsChartLastUpdate < REDRAW_INTERVAL_MS)) return;
    limitsChartLastUpdate = now;
    const currentPct = isNumber(liveCurrent) && isNumber(batteryLimit) && batteryLimit > 0 ? 100 * liveCurrent / batteryLimit : null;
    const powerPct = isNumber(livePower) && isNumber(level?.max_motor_power_w) && level.max_motor_power_w > 0 ? 100 * livePower / level.max_motor_power_w : null;
    Plotly.react(chart, [
        { x: ['Battery current', 'Motor power'], y: [currentPct, powerPct], name: 'Live / ceiling', type: 'bar', marker: { color: ['#2563eb', '#16a34a'] }, text: [currentPct, powerPct].map((value) => isNumber(value) ? `${value.toFixed(0)}%` : 'N/A'), textposition: 'auto' },
        { x: ['Battery current', 'Motor power'], y: [100, level?.max_motor_power_w > 0 ? 100 : null], name: 'Configured ceiling', type: 'bar', marker: { color: '#cbd5e1' } },
    ], { ...plotLayout('', 'Configured ceiling (%)'), barmode: 'group', yaxis: { title: 'Configured ceiling (%)', range: [0, Math.max(120, currentPct || 0, powerPct || 0)], gridcolor: '#e2e8f0' } }, { responsive: true, displaylogo: false });
}

// FW-018: full-charge pack-voltage threshold (100% anchor). It travels in the system
// status frame (0x6028) but belongs here — it is what the rider's 100% actually means.
export function updateSocFullUI(s) {
    if (!s) return;
    const v = s.soc_full_pack_v; // volts, or null when unset / unavailable (old firmware)
    setText('ebicsSocFullActive', v == null
        ? (s.soc_full_pack_mv === null ? 'Unavailable (older firmware)' : 'Not set')
        : `${v.toFixed(1)} V`);
    const input = el('ebicsSocFullInput');
    if (input && document.activeElement !== input && v != null) input.value = v.toFixed(1);
}

export function bindLimitsControls() {
    ['ebicsLimitsBankSelect', 'ebicsLimitsLevelSelect'].forEach((id) => el(id)?.addEventListener('change', updateLimitsSummary));

    el('ebicsSocFullSaveButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        const volts = parseFloat(el('ebicsSocFullInput')?.value);
        if (!(volts >= 20 && volts <= 90)) { alert('Enter the measured full-charge pack voltage in the range 20–90 V.'); return; }
        const pack10mv = Math.round(volts * 100); // V -> units of 10 mV
        socket.send(`SET_SOC_FULL:${pack10mv}`);
        addLog('REQ', `Full-charge voltage -> ${volts.toFixed(1)} V (saves at standstill)`);
    });
}
