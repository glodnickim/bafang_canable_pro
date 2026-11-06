const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const utils = require('../utils');

async function main() {
    let delays = 0;
    const context = {
        module: { exports: {} }, process, Buffer, console, setTimeout, clearTimeout, setImmediate,
        require: name => name === './utils'
            ? { ...utils, delayu: async () => { delays++; } } : require(name),
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../fw-updater'), 'utf8'), context);
    const Updater = context.module.exports;
    for (const hmi of [true, false]) {
        const bus = new EventEmitter();
        bus.isConnected = () => true;
        const updater = new Updater(bus);
        updater.logMessage = () => {};
        if (hmi) updater.setupForHMI(); else updater.setupForNewMotor();
        updater.firmwareBuffer = Buffer.alloc(16 + 260 * 8);
        updater.FIRMWARE_FILE_SIZE = updater.firmwareBuffer.length;
        updater.NUM_CHUNKS = 260;
        let sent = 0;
        bus.sendRawFrame = async id => {
            sent++;
            bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) });
            if (updater.lastChunkSendIndex === 257) {
                updater.chunksACKObjectplus1[257] = true;
                updater.lastAckWriteAddress = 258 * 8;
            }
            return true;
        };
        delays = 0;
        try { await updater.sendDataChunks(); } finally { updater.cleanup(); }
        assert.equal(sent, 257);
        assert.equal(delays, hmi ? 1 : 257,
            'HMI waits only at block ACK; motor retains existing inter-chunk pacing');
    }
    console.log('HMI block pacing tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
