'use strict';
/* global NodeShim */

const assert = require('node:assert/strict');
// The shim replaces global process; retain Node's exit to stop its timers.
const nodeProcess = process;

try {
    require('../ui/webusb/node-shim.js');

    const usb = NodeShim.require('usb');
    assert.ok(usb.usb);
    assert.equal(typeof usb.usb.on, 'function');
    const a = { vendorId: 0x1D50, productId: 0x606F, productName: 'x', manufacturerName: 'y', serialNumber: '1' };
    const b = { ...a };

    // Initial enumeration happens before the server installs hotplug listeners.
    NodeShim.setDevices([a]);
    assert.equal(usb.getDeviceList().length, 1);
    NodeShim.setDevices([]);
    assert.equal(usb.getDeviceList().length, 0);

    const events = [];
    usb.usb.on('attach', (device) => {
        events.push({ type: 'attach', device, count: usb.getDeviceList().length });
    });
    usb.usb.on('detach', (device) => {
        events.push({ type: 'detach', device, count: usb.getDeviceList().length });
    });

    NodeShim.setDevices([a]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'attach');
    assert.equal(events[0].device.deviceDescriptor.idVendor, 0x1D50);
    assert.equal(events[0].device.deviceDescriptor.idProduct, 0x606F);
    assert.equal(events[0].count, 1);
    assert.equal(usb.getDeviceList().length, 1);

    NodeShim.setDevices([a]);
    assert.equal(events.length, 1);
    assert.equal(usb.getDeviceList().length, 1);

    NodeShim.setDevices([]);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'detach');
    assert.equal(events[1].device.deviceDescriptor.idVendor, 0x1D50);
    assert.equal(events[1].count, 0);
    assert.equal(usb.getDeviceList().length, 0);

    NodeShim.setDevices([b]);
    assert.equal(events.length, 3);
    assert.equal(events[2].type, 'attach');
    assert.equal(events[2].device.deviceDescriptor.idVendor, 0x1D50);
    assert.equal(usb.getDeviceList().length, 1);

    // Equal descriptors still represent distinct WebUSB device identities.
    NodeShim.setDevices([a]);
    assert.equal(events.length, 5);
    assert.deepEqual(events.slice(3).map((event) => event.type), ['detach', 'attach']);
    assert.deepEqual(events.slice(3).map((event) => event.count), [1, 1]);
    assert.equal(usb.getDeviceList().length, 1);

    console.log('webusb_hotplug: ok');
    nodeProcess.exit(0);
} catch (e) {
    console.error(e);
    nodeProcess.exit(1);
}
