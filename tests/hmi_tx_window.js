const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Updater = require('../fw-updater');

async function main() {
    const bus = new EventEmitter();
    bus.isConnected = () => true;
    const updater = new Updater(bus);
    updater.setupForHMI();
    updater.logMessage = () => {};
    const sent = [];
    bus.sendRawFrame = async id => { sent.push(id); return true; };
    const echo = id => bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) });
    try {
        await updater.sendRawFrameWithRetry('51D0002', '00', 3, true);
        await updater.sendRawFrameWithRetry('51D0003', '00', 3, true);
        assert.equal(updater.hmiPendingEchoes.size, 2);
        const third = updater.sendRawFrameWithRetry('51D0004', '00', 3, true);
        echo('85FF3005');
        echo('851D0001');
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(sent.length, 2, 'unrelated and stale echoes cannot open the window');
        echo('851D0003'); // out-of-order echo frees only this frame
        await third;
        assert.equal(sent.length, 3);
        assert.equal(updater.hmiPendingEchoes.size, 2);
        echo('851D0004');
        updater.hmiPendingEchoes.get('851D0002').deadline = 0;
        await assert.rejects(updater.waitForHmiWindow(1), /851D0002/);
        assert.equal(sent.length, 3, 'missing confirmation must not retransmit');
        echo('851D0002');
        await updater.waitForHmiWindow(1);
        assert.equal(updater.hmiPendingEchoes.size, 0);

        bus.sendRawFrame = async id => { echo(id); return true; };
        await updater.sendRawFrameWithRetry('51D0005', '00', 3, true);
        assert.equal(updater.hmiPendingEchoes.size, 0, 'early echo is retained');
        bus.sendRawFrame = async () => false;
        await updater.sendRawFrameWithRetry('51D0006', '00', 1, true);
        await assert.rejects(updater.waitForHmiWindow(1), /USB write failed/);
    } finally { updater.cleanup(); }
    console.log('HMI bounded transmit window tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
