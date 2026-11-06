const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const utils = require('../utils');
const fixture = require('./fixtures/besst_hmi_success.json');
const immediate = () => new Promise(resolve => setImmediate(resolve));

async function main() {
    let now = 0;
    const context = { module: { exports: {} }, process, Buffer, console, setTimeout, clearTimeout, setImmediate,
        performance: { now: () => now }, Date: class extends Date { static now() { return now; } },
        require: name => name === './utils' ? { ...utils,
            delay: async ms => { now += ms; await immediate(); }, delayu: immediate,
        } : require(name) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../fw-updater'), 'utf8'), context);
    const bus = new EventEmitter();
    bus.isConnected = () => true;
    const updater = new context.module.exports(bus);
    updater.setupForHMI();
    updater.logMessage = () => {};
    updater.initFile(Buffer.alloc(16 + fixture.payloadBytes));
    const acks = new Map(fixture.acks.map(a => [parseInt(a.id.slice(4), 16), a]));
    const rx = a => bus.emit('raw_frame_received', { can_id: parseInt(a.id, 16), can_dlc: a.dlc,
        data: new DataView(Uint8Array.from(Buffer.from(a.data, 'hex')).buffer) });
    const writes = [];
    let active = 0, peak = 0;
    bus.sendRawFrame = (id, data) => {
        active++; peak = Math.max(peak, active);
        writes.push({ id: id.toLowerCase(), data, at: now });
        return new Promise(resolve => setImmediate(() => {
            bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) });
            const chunk = parseInt(id.slice(4), 16);
            const ack = acks.get(chunk + 1);
            if (/^851[de]/i.test(id) && ack) rx(ack);
            active--; resolve(true);
        }));
    };
    try {
        await updater.sendFirstChunk();
        await updater.sendDataChunks();
        await updater.sendLastPackageAndEndTransfer();
        assert.equal(writes.length, fixture.chunks);
        assert.equal(peak, 2, 'two USB requests must actually overlap');
        assert.equal(active, 0);
        assert.equal(updater.hmiPendingEchoes.size, 0);
        assert.equal(writes.at(-1).id, '851edeed');
        assert.equal(writes.at(-1).data.length, 8, 'last chunk is four bytes');
        const ackAt = updater.finalAckAt;
        await updater.announceFirmwareUpgradeEnd();
        const end = writes.slice(fixture.chunks);
        assert.equal(end[0].id, fixture.endCommand.id);
        assert.equal(end[0].data, '01');
        assert.ok(end[0].at - ackAt >= 200);
        assert.ok(end.slice(1).every(x => x.id === '85ff3005' && x.data === '00'));
        assert.ok(now - end[0].at >= 34000);
        assert.equal(end.filter(x => x.data === '01').length, 1);

        updater.lastChunkConfirmed = true;
        updater.lastChunkAckDlc = 4;
        updater.lastChunkAckData = '00 00 00 01';
        bus.sendRawFrame = async id => { bus.emit('raw_frame_sent', { can_id: parseInt(id, 16) }); return true; };
        await assert.rejects(updater.sendLastPackageAndEndTransfer(), /not the successful/);
        updater.lastChunkAckDlc = 0;
        updater.lastChunkAckData = '';
        await assert.rejects(updater.sendLastPackageAndEndTransfer(), /not the successful/);
    } finally { updater.cleanup(); }
    console.log('BESST replay: 57070 chunks, captured ACKs, USB overlap and closing sequence passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
