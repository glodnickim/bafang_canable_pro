// Regression for the 2026-10-08 HMI failure at ~22%: chunk 0x3005 goes out as 051D3005,
// the eVistDrive controller restarts on it and drops the display supply, and the display
// comes back in its bootloader announcing 13FF3000#00000000. The updater must stop on that
// frame with the reason instead of waiting out the 15 s ACK timeout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const utils = require('../utils');

function frame(id, bytes) {
    const data = new DataView(new ArrayBuffer(8));
    bytes.forEach((b, i) => data.setUint8(i, b));
    return { can_id: id, can_dlc: bytes.length, data };
}

async function run({ restart, controller }) {
    const context = {
        module: { exports: {} }, process, Buffer, console, setTimeout, clearTimeout, setImmediate,
        require: name => name === './utils'
            ? { ...utils, delayu: async () => {} } : require(name),
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../fw-updater'), 'utf8'), context);
    const Updater = context.module.exports;
    const bus = new EventEmitter();
    bus.isConnected = () => true;
    const updater = new Updater(bus);
    const logs = [];
    updater.logMessage = (m, t) => logs.push(`${t} ${m}`);
    updater.setupForHMI();
    updater.timeout = 300;
    const chunks = 0x3200;
    updater.firmwareBuffer = Buffer.alloc(16 + chunks * 8);
    updater.FIRMWARE_FILE_SIZE = updater.firmwareBuffer.length;
    updater.NUM_CHUNKS = chunks;
    updater.dataPhaseStarted = true;
    if (controller) bus.emit('raw_frame_received', frame(0x82F83202, [0]));
    let sent = 0;
    bus.sendRawFrame = async id => {
        sent++;
        const n = parseInt(id, 16) & 0xFFFF;
        setImmediate(() => {
            bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) });
            if (restart && n === 0x3005) bus.emit('raw_frame_received', frame(0x93FF3000, [0, 0, 0, 0]));
            // The block ACK the display would send, unless it has just restarted.
            if ((n - 1) % 256 === 0 && n !== 2 && !(restart && n >= 0x3005)) {
                const ack = n + 1, addr = ack * 8;
                bus.emit('raw_frame_received', frame((0x832A0000 | ack) >>> 0,
                    [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255, 0, 0, 8, 0]));
            }
        });
        return true;
    };
    let error = null;
    const started = Date.now();
    try { await updater.sendDataChunks(); } catch (e) { error = `${e?.message || e}`; } finally { updater.cleanup(); }
    return { error, sent, logs, elapsed: Date.now() - started };
}

async function main() {
    const clean = await run({ restart: false, controller: true });
    assert.equal(clean.error, null, `clean transfer must pass: ${clean.error}`);
    assert.equal(clean.sent, 0x3200 - 3, 'all data chunks except the last are sent');

    const failed = await run({ restart: true, controller: true });
    assert.match(failed.error || '', /HMI restarted during the transfer/);
    assert.match(failed.error, /chunk 0x3005/);
    assert.match(failed.error, /motor controller/);
    assert.ok(failed.sent <= 0x3101, 'nothing is sent past the block in which the display restarted');

    const noController = await run({ restart: true, controller: false });
    assert.match(noController.error || '', /HMI restarted during the transfer/);
    assert.doesNotMatch(noController.error, /motor controller/, 'no controller hint without controller traffic');
    console.log('HMI restart detection tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
