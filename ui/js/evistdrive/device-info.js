// evistdrive/device-info.js — eVistDrive System card: who the four devices on the bus say
// they are (versions, model, serial, production date, manufacturer).
//
// The factory Info tab shows the same data and stays as it is. This exists because the
// "show only eVistDrive tabs" mode hides Info, and losing the ability to read a serial
// number or a firmware version while diagnosing would be a step backwards.
//
// READ ONLY on purpose. Info also lets you write the manufacturer and customer number
// back to the device; that is a factory operation with no place on a riding-configuration
// card, and it stays where it is.
import { state, addLog, syncAllDeviceInfo } from '../shared.js';
import { el, setText, socketReady } from './common.js';

const DASH = '—';
const text = (value) => (value === null || value === undefined || value === '') ? DASH : String(value);

// One row per field. `key` is read straight off the matching state.*OtherInfo object, so a
// device that never answers simply shows dashes rather than an empty card.
const DEVICES = [
    {
        id: 'Ctrl', label: 'Controller', source: () => state.controllerOtherInfo,
        fields: [
            ['hwVersion', 'Hardware version'],
            ['swVersion', 'Software version'],
            ['modelNumber', 'Model number'],
            ['serialNumber', 'Serial number'],
            ['productionDate', 'Production date'],
            ['manufacturer', 'Manufacturer'],
        ],
    },
    {
        id: 'Display', label: 'Display', source: () => state.displayOtherInfo,
        fields: [
            ['hwVersion', 'Hardware version'],
            ['swVersion', 'Software version'],
            ['bootloaderVersion', 'Bootloader version'],
            ['modelNumber', 'Model number'],
            ['serialNumber', 'Serial number'],
            ['productionDate', 'Production date'],
            ['manufacturer', 'Manufacturer'],
            ['customerNumber', 'Customer number'],
        ],
    },
    {
        id: 'Sensor', label: 'Torque sensor', source: () => state.sensorOtherInfo,
        fields: [
            ['hwVersion', 'Hardware version'],
            ['swVersion', 'Software version'],
            ['modelNumber', 'Model number'],
            ['serialNumber', 'Serial number'],
            ['productionDate', 'Production date'],
        ],
    },
    {
        id: 'Battery', label: 'Battery', source: () => state.batteryOtherInfo,
        fields: [
            ['hwVersion', 'Hardware version'],
            ['swVersion', 'Software version'],
            ['modelNumber', 'Model number'],
            ['serialNumber', 'Serial number'],
            ['productionDate', 'Production date'],
        ],
    },
];

let built = false;

// The table bodies are generated rather than written out in index.html: four devices with
// five to eight fields each is 26 rows of near-identical markup, and every row would have
// to be kept in step with the field list by hand.
function build() {
    DEVICES.forEach((device) => {
        const body = el(`evdInfo${device.id}Body`);
        if (!body) return;
        body.innerHTML = '';
        device.fields.forEach(([key, label]) => {
            const row = body.insertRow();
            row.insertCell().textContent = label;
            const value = row.insertCell();
            value.id = `evdInfo${device.id}_${key}`;
            value.textContent = DASH;
        });
    });
    built = true;
}

export function updateDeviceInfoUI() {
    if (!built) build();
    let anyKnown = false;
    DEVICES.forEach((device) => {
        const data = device.source() || {};
        device.fields.forEach(([key]) => {
            const value = data[key];
            if (value !== null && value !== undefined && value !== '') anyKnown = true;
            setText(`evdInfo${device.id}_${key}`, text(value));
        });
    });
    const hint = el('evdInfoSource');
    if (hint) {
        hint.textContent = anyKnown
            ? 'Read from the devices on the bus.'
            : 'Nothing read yet — press "Read device info". Devices that do not answer stay dashed.';
    }
}

export function bindDeviceInfoControls() {
    // CB-026: the top bar's "Read from bike" already asks every device for its identification,
    // so a second button here only ever repeated part of it.
}
