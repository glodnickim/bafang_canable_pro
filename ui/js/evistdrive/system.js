// evistdrive/system.js — eVistDrive System card: the ride-core diagnostics stream (0x6029)
//
// Peak values are what the firmware saw since the last read; the "now" column is the
// current sample. A field an older controller does not send shows "—" rather than 0,
// because a zero here reads as a real measurement.
import { socket, addLog } from '../shared.js';
import { el, setText, socketReady } from './common.js';

const DIAG_POLL_INTERVAL_MS = 100; // 10 Hz

// FW-015/017: ride-core diagnostics card (peak + live)
export function updateDiagUI(d) {
    if (!d) return;
    // peak
    setText('diagCadence', d.cadence_for_assist);
    setText('diagTorque', d.torque_for_assist_mv);
    setText('diagHumanPower', d.human_power_w);
    setText('diagSupport', d.support_ratio_pct);
    setText('diagMotorPower', d.motor_power_w);
    setText('diagBatCurrent', d.requested_battery_current_ma);
    setText('diagIqRequest', d.iq_request);
    setText('diagIqSetpoint', d.iq_setpoint);
    setText('diagSpeed', (d.speed_x100 / 100).toFixed(1));
    // live (v2 only; null -> "—" so v1 firmware never shows a fake 0)
    const dash = (v) => (v === null || v === undefined) ? '—' : v;
    setText('diagPasIdle', dash(d.pas_idle_ms));
    setText('diagPedaling', d.pedaling_active === null ? '—' : (d.pedaling_active ? 'yes' : 'no'));
    setText('diagFastPressure', dash(d.fast_pressure));
    setText('diagRunPressure', dash(d.run_pressure)); // FW-033: slow RUN estimator
    setText('diagIqReqNow', dash(d.iq_request_now));
    setText('diagIqSetNow', dash(d.iq_setpoint_now));
    setText('diagIqMeasured', dash(d.measured_iq)); // FW-033: actual FOC current
    setText('diagBattLimit', d.battery_limiting === null ? '—' : (d.battery_limiting ? 'yes' : 'no'));
    // FW-061: these two fields were showing the wrong thing — the firmware packs
    // brake and torque-fault here, not pedal release / release latch.
    setText('diagRelease', d.brake_active === null ? '—' : (d.brake_active ? 'yes' : 'no'));
    setText('diagLatched', d.torque_fault === null ? '—' : (d.torque_fault ? 'yes' : 'no'));
    // FW-084: Extended Boost (v5 diagnostics). "idle" and "—" are different answers:
    // the first means the firmware reported the module is doing nothing, the second that
    // this controller does not report the module at all.
    setText('diagExtBoostState', d.ext_boost_active === null ? '—'
        : (d.ext_boost_active ? 'ACTIVE'
            : (d.ext_boost_armed ? 'armed'
                : (d.ext_boost_qualifying ? 'qualifying'
                    : (d.ext_boost_arm_expired ? 'idle (arming expired)' : 'idle')))));
    setText('diagExtBoostPeak', d.ext_boost_peak_load_kg === null ? '—'
        : d.ext_boost_peak_load_kg.toFixed(2));
    setText('diagExtBoostIq', dash(d.ext_boost_iq));
    setText('diagExtBoostLeft', dash(d.ext_boost_remaining_ms));
    setText('diagExtBoostCancel', d.ext_boost_cancel_reason === null ? '—'
        : (EXT_BOOST_CANCEL[d.ext_boost_cancel_reason] ?? d.ext_boost_cancel_reason));
    /*
     * FW-129 (v6 diagnostics): the unit-domain block. This is the row that answers "why is the
     * bike pushing this hard", in the order the firmware actually computes it:
     *
     *   pedal load (kg)  ->  normalized torque (eMTB/Torque only)  ->  requested motor power
     *   ->  the two conversion anchors and the crossfade between them  ->  pre-limit current
     *
     * Blend is the weight of the MEASURED-duty anchor: 0 % = the launch anchor is carrying the
     * request (standstill, stall, a slipping start), 100 % = the measured duty is. In ordinary
     * riding both anchors read almost the same number — that is the design, not a coincidence,
     * and seeing them diverge is the signal that something is wrong with the duty measurement.
     *
     * u_abs is shown next to cadence deliberately: their ratio is the motor's volts per crank
     * rpm, the one quantity the firmware's launch reference is still only a hypothesis about.
     */
    setText('diagAssistLoadKg', d.assist_load_kg === null || d.assist_load_kg === undefined
        ? '—' : d.assist_load_kg.toFixed(2));
    setText('diagAssistTorqueX160', dash(d.assist_torque_x160));
    setText('diagReqMotorPower', dash(d.requested_motor_power_w));
    setText('diagIqLaunch', dash(d.iq_launch_request));
    setText('diagIqNormal', dash(d.iq_normal_request));
    setText('diagLaunchBlend', d.launch_blend_permille === null || d.launch_blend_permille === undefined
        ? '—' : `${(d.launch_blend_permille / 10).toFixed(0)}%`);
    setText('diagIqPreLimit', dash(d.iq_pre_limit));
    setText('diagUabsLive', dash(d.u_abs_live));
}

// Wire values from assist_extended_boost_cancel_t (inc/assist_extended_boost.h).
// Index 13 is reserved: FW-095 reported it when pedalling stopped, but under FW-100 that is
// what STARTS the boost, so it can never be reported. It stays in the table so every other
// index keeps its position.
const EXT_BOOST_CANCEL = [
    'none', 'disabled', 'safety cut', 'backward crank', 'sensor invalid', 'walk assist',
    'calibration', 'level/bank change', 'motion lost', 'pedalling resumed', 'arming expired',
    'completed', 'bank config written', '(reserved)',
];

let diagTimer = null;

// Exported so leaving the tab can stop the 10 Hz poll from anywhere.
export function stopDiagPoll() {
    if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
    const cb = el('ebicsDiagAuto');
    if (cb) cb.checked = false;
}

// FW-015/017: diagnostics read + auto-poll + stored fall-ramp read
export function bindSystemControls() {
    el('ebicsDiagReadButton')?.addEventListener('click', () => {
        if (socketReady()) socket.send('READ_DIAG');
    });
    el('ebicsDiagTuningButton')?.addEventListener('click', () => {
        if (socketReady()) { socket.send('READ_TUNING'); addLog('REQ', 'Reading stored fall ramps'); }
    });
    el('ebicsDiagAuto')?.addEventListener('change', (e) => {
        if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
        if (e.target.checked && socketReady()) {
            diagTimer = setInterval(() => { if (socketReady()) socket.send('READ_DIAG'); else stopDiagPoll(); }, DIAG_POLL_INTERVAL_MS);
        }
    });
}
