// evistdrive/index.js — the eVistDrive Ride Core configurator, wired together
//
// One entry point for the whole ui/js/evistdrive/ folder: it is the only module the
// rest of the app imports from, so the factory tabs never reach into an individual
// eVistDrive card. Each card owns its own rendering and its own control bindings;
// this file decides WHEN a card refreshes, based on which CAN frame just arrived.
import { isEbicsUIAvailable } from './detection.js';
import { updateLegacyParamsUI } from './legacy-params.js';
import { socketReady } from './common.js';
import { socket } from '../shared.js';

import { updateLiveSummary } from './live.js';
import { updateTorqueSummary, bindTorqueControls } from './torque.js';
import { updateLimitsSummary, bindLimitsControls } from './limits.js';
import { updateWalkAndLegacy } from './walk.js';
import { renderProfileEditor, bindProfileControls } from './profiles.js';
import { renderDynamics, bindDynamicsControls } from './dynamics.js';
import { bindSystemControls, stopDiagPoll } from './system.js';
import { updateDeviceInfoUI, bindDeviceInfoControls } from './device-info.js';
import { bindGlobalActions } from './global-actions.js';

// Re-exported for websocket.js, which pushes freshly parsed frames straight at the
// card that displays them.
export { updateTorqueCalUI } from './torque.js';
export { updateDiagUI } from './system.js';
export { updateDiagTuning } from './dynamics.js';
export { updateSocFullUI } from './limits.js';

export function updateEbicsUI(eventType = '') {
    if (!isEbicsUIAvailable()) return;
    updateLegacyParamsUI(eventType);
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
    // Identification arrives one field per frame across four devices, so refresh on any of
    // them rather than trying to name every sub-code here.
    if (fullUpdate || DEVICE_INFO_EVENTS.test(eventType)) updateDeviceInfoUI();
}

// controller_hw_version, display_sn, sensor_mn, battery_sw_version, … — the identification
// replies all end in one of these suffixes and no realtime frame does.
const DEVICE_INFO_EVENTS = /_(hw_version|sw_version|bootloader_version|sn|mn|cn|mfg)$/;

function bindControls() {
    bindProfileControls();
    bindLimitsControls();
    bindDynamicsControls();
    bindTorqueControls();
    bindSystemControls();
    bindDeviceInfoControls();
    bindGlobalActions(); // CB-017: Read all / Save to Flash in the top bar

    // FW-030/043: the "Ride engine (developer)" card is gone (single ride-core engine).
    // READ_SYSTEM survives because the FW-018 full-charge threshold shares 0x6028.
    window.addEventListener('app-tab-changed', (event) => {
        const tab = String(event.detail?.tab || '');
        if (tab.startsWith('ebics-')) updateEbicsUI();
        if (tab === 'ebics-torque' && socketReady()) socket.send('READ_TORQUE');
        if (tab === 'ebics-system' && socketReady()) socket.send('READ_SYSTEM');
        // FW-018: the full-charge voltage field lives in the Limits tab -> read its value there
        if (tab === 'ebics-limits' && socketReady()) socket.send('READ_SYSTEM');
        // FW-017: stop the diagnostics poll whenever we leave the System tab
        if (tab !== 'ebics-system') stopDiagPoll();
    });
    window.addEventListener('controller-flavor-changed', () => updateEbicsUI());
}

bindControls();
updateEbicsUI();
