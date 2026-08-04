// evistdrive/torque.js — eVistDrive Torque card: pedal load in kg, calibration, coast re-zero
import { state, socket, addLog, torqueModel } from '../shared.js';
import {
    el, isNumber, displayNumber, clamp, setText, socketReady,
    selectedLevel, activeBankIndex, currentLevelIndex, getPedalLoadKg,
} from './common.js';

// The gauge is drawn against the sensor's full range, not the rider's own maximum.
const GAUGE_FULL_SCALE_KG = 60;

export function updateTorqueSummary() {
    const load = getPedalLoadKg();
    const safeLoad = isNumber(load) ? clamp(load, 0, GAUGE_FULL_SCALE_KG) : 0;
    setText('ebicsTorqueKg', safeLoad.toFixed(1));
    const fill = el('ebicsTorqueGaugeFill');
    // Rounded to whole percent and written only on change: the gauge is ~200 px wide, so
    // sub-percent precision is invisible while every write forces a layout pass.
    const width = `${Math.round(safeLoad / GAUGE_FULL_SCALE_KG * 100)}%`;
    if (fill && fill.style.width !== width) fill.style.width = width;
    const level = selectedLevel().level || state.lastBanks?.[activeBankIndex()]?.levels?.[currentLevelIndex()];
    const minLoad = isNumber(level?.minimum_pedal_load_kg) ? level.minimum_pedal_load_kg : null;
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
    const calWidth = `${Math.round(clamp((t.load_centikg || 0) / (GAUGE_FULL_SCALE_KG * 100) * 100, 0, 100))}%`;
    if (fill && fill.style.width !== calWidth) fill.style.width = calWidth;
    setText('ebicsTorqueCalSource', t.calibration_source === 1 ? 'User calibrated' : 'Default');
    setText('ebicsTorqueZero', t.zero_effective_native ?? 'N/A');
    setText('ebicsTorqueFullScale', t.full_scale_native ?? 'N/A');
    setText('ebicsCalState', CAL_STATE_LABELS[t.calibration_state] ?? String(t.calibration_state));
    setText('ebicsCalError', CAL_ERROR_LABELS[t.calibration_error] ?? String(t.calibration_error));
    setText('ebicsCalPreviewSpan', t.preview_span_native ? `${t.preview_span_native}` : 'N/A');
    updateCoastDiag(t); // FW-061
}

// FW-061: coast re-zero diagnostics (torque telemetry v2). Answers the question
// "did the zero move, by how much, and if not — why not", which is impossible to
// tell from the load reading alone.
const COAST_RESULT_HINTS = {
    NONE: 'No coast evaluated yet since power-on.',
    APPLIED: 'The zero was corrected.',
    NO_CHANGE: 'Evaluated, but the zero was already on target (or drift is still awaiting confirmation).',
    TOO_SHORT: 'Coasts are ending before the 5.5 s window completes — the zero is simply never sampled.',
    UNSTABLE: 'The sampling window was too noisy to trust (rough surface, chain slap, foot shifting).',
    LOCKOUT: 'Blocked by the 60 s minimum between in-ride corrections.',
    OUT_OF_REACQUIRE_RANGE: 'Rest sits more than 40 mV off target — never corrected automatically. Check the sensor.',
    IMPLAUSIBLE_RAW: 'Raw baseline outside the plausible window — sensor fault territory.',
};

function updateCoastDiag(t) {
    const has = t.version >= 2;
    const dash = (v) => (has && v !== undefined && v !== null) ? v : '—';
    setText('coastLastResult', has ? t.coast_last_result : '—');
    setText('coastResultHint', has ? (COAST_RESULT_HINTS[t.coast_last_result] || '') : 'Needs firmware with torque telemetry v2.');
    setText('coastRaw', dash(t.raw_native));
    setText('coastZero', dash(t.zero_effective_native));
    setText('coastCandidate', dash(t.coast_candidate_native));
    setText('coastSpread', has ? `${t.coast_spread_mv} mV (limit 10)` : '—');
    setText('coastLastStep', has ? `${t.coast_last_step_mv > 0 ? '+' : ''}${t.coast_last_step_mv} mV` : '—');
    setText('coastOffset', has ? `${t.offset_correction_mv} mV` : '—');
    setText('coastLockout', has ? (t.coast_lockout_s ? `${t.coast_lockout_s} s` : 'ready') : '—');
    setText('coastState', has
        ? `${t.coast_active ? 'window open' : 'idle'}, ${t.coast_was_moving ? 'riding' : 'standstill'}`
        : '—');
    setText('coastWindows', has ? `${t.coast_windows_completed} / ${t.coast_windows_started}` : '—');
    setText('coastApplied', dash(t.coast_applied));
    setText('coastRejTooShort', dash(t.coast_rejected_too_short));
    setText('coastRejUnstable', dash(t.coast_rejected_unstable));
    setText('coastRejLockout', dash(t.coast_rejected_lockout));
    setText('coastRejRange', dash(t.coast_rejected_out_of_range));
    setText('coastRejImplausible', dash(t.coast_rejected_implausible));
    setText('coastNoChange', dash(t.coast_no_change));
}

// FW-013: torque telemetry live read + load calibration operations
export function bindTorqueControls() {
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
}
