// Ride mode: with listenOnly the adapter is started with the gs_usb listen-only flag and
// this tool puts nothing on the bus, neither requests nor multi-frame ACKs.
const assert = require('assert');
const canbus = require('../canbus');
const { GSUsb } = require('../gsusb');

(async () => {
    let startFlags = null;
    let written = 0;
    const device = canbus.canDevice;
    device.start = async (bitrate, flags) => {
        startFlags = flags;
        device.device_flags = flags;
        return { ok: true };
    };
    device.writeCANFrame = async () => { written++; return true; };

    assert.strictEqual(await canbus.init('fake', { listenOnly: true }), true);
    assert.strictEqual(startFlags, GSUsb.GS_DEVICE_FLAGS.listenOnly, 'adapter started listen-only');
    assert.strictEqual(canbus.listenOnly, true);

    await assert.rejects(canbus.sendFrame('82F83200#00'), /Ride mode/);
    await canbus._sendAck({ sourceDeviceCode: 2, canCommandCode: 0x60, canCommandSubCode: 0x10 });
    assert.strictEqual(written, 0, 'nothing written to the adapter');

    // An adapter without the feature: the flag is masked off, the tool still stays silent.
    device.start = async () => { device.device_flags = 0; return { ok: true }; };
    canbus.isStarted = false;
    await canbus.init('fake', { listenOnly: true });
    assert.strictEqual(canbus.listenOnly, false);
    await assert.rejects(canbus.sendFrame('82F83200#00'), /Ride mode/);

    console.log('Ride listen-only: ALL CHECKS PASSED');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
