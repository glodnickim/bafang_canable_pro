const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const FwUpdater = require('../fw-updater');

// The four-byte status is a DPC245 capture. Other displays must not fail on its length,
// but a non-zero status is a rejection on every display.
async function finish(setup, dlc, data) {
    const bus = new EventEmitter();
    bus.isConnected = () => true;
    const updater = new FwUpdater(bus);
    updater.logMessage = () => {};
    updater[setup]();
    updater.firmwareBuffer = Buffer.alloc(16 + 4 * 8);
    updater.NUM_CHUNKS = 4;
    bus.sendRawFrame = async id => {
        bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) });
        updater.lastChunkAckDlc = dlc;
        updater.lastChunkAckData = data;
        updater.lastChunkConfirmed = true;
        return true;
    };
    try { await updater.sendLastPackageAndEndTransfer(); } finally { updater.cleanup(); }
}

async function main() {
    const zero8 = '00 00 00 00 00 00 00 00';
    await finish('setupForHMI', 4, '00 00 00 00');
    await assert.rejects(finish('setupForHMI', 8, zero8), /not the successful four-byte status/);
    for (const setup of ['setupForDPC18', 'setupForDPE160']) {
        await finish(setup, 8, zero8);
        await assert.rejects(finish(setup, 4, '01 00 00 00'), error => /rejected the image/.test(error));
    }
    console.log('HMI final ACK mode tests passed');
    process.exit(0); // the updater's timer library keeps the loop alive
}
main().catch(error => { console.error(error); process.exit(1); });
