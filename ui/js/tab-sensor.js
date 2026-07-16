// tab-sensor.js — ES Module
import {
    state, socket,
    sensorElements,
    safeSetText,
    addLog,
    torqueMvToKg,
} from './shared.js';

export function updateSensorUI() {
    safeSetText(sensorElements.sensorTorqueValue, torqueMvToKg(state.sensorRealtime?.torque));
    safeSetText(sensorElements.sensorCadenceValue, state.sensorRealtime?.cadence);

    if (sensorElements.realtimePlaceholder) {
        sensorElements.realtimePlaceholder.style.display = state.sensorRealtime ? 'none' : 'block';
    }
}

sensorElements.syncButton.onclick = () => {
    addLog('REQ', 'Syncing all Sensor data...');
    socket.send('READ:1:49:0'); // Realtime
};
