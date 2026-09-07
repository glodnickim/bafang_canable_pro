// FW-130 TEST firmware updater: frame pacing, hard send failures, final-ACK status and the
// end-of-flash window.
//
// Why these four and not "does the flash work": the DPC245 update protocol has NO
// retransmission and no way to report a gap. Block ACKs (x2A**02) confirm a POSITION, never
// a missing frame, so a chunk that never reached the bus is invisible until the very end -
// which is exactly the "stops at 99 %" report from the testers. Everything that can still
// catch that class of failure is therefore worth pinning:
//
//   1. pacing floor      - frames are never emitted faster than the wire (~810 us/frame on
//                          250 kbit/s, the cadence the official BESST tool uses), and a
//                          block-ACK wait must not turn into credit for a catch-up burst;
//   2. send failures     - a frame the adapter refused aborts the update instead of leaving
//                          a hole in the image;
//   3. final-ACK status  - the closing ACK carries status bytes (all zero = accepted); a
//                          non-zero status must fail the update;
//   4. end-of-flash      - after the last chunk the display programs its own flash. The
//                          official tool holds the session open (00 announce every ~60 ms)
//                          and closes with 01; dropping that window is a second, independent
//                          way to end up with a half-written display.
//
// The bus is a fake that answers exactly like a DPC245 in HMI mode, so the whole procedure
// runs end to end without hardware.
//
// Run from the Canable project root:  node tests/fw130_updater_pacing_and_end_phase.js

'use strict';
const EventEmitter = require('events');

// Stub the log-file writer BEFORE fw-updater destructures it, so the test does not litter
// logs/ on every npm test run.
const utils = require('../utils');
utils.setupLogger = async () => async () => {};
const FwUpdater = require('../fw-updater');

let failures = 0;
const check = (ok, label) => {
    if (!ok) { failures++; console.log(`  FAIL  ${label}`); }
    else { console.log(`  ok    ${label}`); }
};

const CHUNKS = 600;                       // 600 * 810 us = ~0.5 s, enough to measure pacing
const FIRMWARE = Buffer.alloc(16 + CHUNKS * 8, 0xA5);

class FakeBus extends EventEmitter {
    constructor() {
        super();
        this.sent = [];          // { id, data, t } - t in ms, float
        this.connected = true;
        this.failOnId = null;
        this.device = null;
    }
    isConnected() { return this.connected; }
    async checkAlive() { return { ok: true }; }
    async sendRawFrame(id, data) {
        this.sent.push({ id, data, t: performance.now() });
        if (this.failOnId && id === this.failOnId) return false;
        if (this.device) this.device(id, data);
        return true;
    }
    reply(idHex, bytes = []) {
        const buf = new Uint8Array(bytes);
        this.emit('raw_frame_received', {
            can_id: parseInt(idHex, 16),
            can_dlc: bytes.length,
            data: new DataView(buf.buffer),
            timestamp_us: 0,
        });
    }
}

const ackId = (n) => `832A${(n % 65536).toString(16).toUpperCase().padStart(4, '0')}`;

// A DPC245 in HMI mode, as observed on the bus: ready ACK, model id on 6008, length ACK,
// first-chunk ACK at position 2, a block ACK at every (i-1)%256 checkpoint, and a closing
// ACK carrying four status bytes.
function dpc245Device(bus, numChunks, opts = {}) {
    return (id) => {
        if (id === '85194000') return bus.reply('832A4000');
        if (id === '85196008') return bus.reply('832A6008', [0x44, 0x50, 0x42, 0x46, 0x38, 0x31, 0x2E, 0x30]);
        if (id === '85184001') return bus.reply('832A4001');
        if (!id.startsWith('851')) return;
        const prefix = id[3];
        const num = parseInt(id.slice(4), 16);
        if (prefix === 'D') {
            if (num === 1) return bus.reply('832A0002');
            if ((num - 1) % 256 === 0 && num !== 2) return bus.reply(ackId(num + 1));
            return;
        }
        if (prefix === 'E') return bus.reply(ackId(numChunks), opts.finalAck || [0, 0, 0, 0]);
    };
}

function newUpdater(bus, msgs) {
    const upd = new FwUpdater(bus, { send: (m) => msgs.push(m) });
    upd.flashWriteWindowMs = 400;    // the real 26 s window, shortened for the test
    upd.flashWriteKeepaliveMs = 60;
    return upd;
}

async function testHappyPath() {
    console.log('1) full flash through a fake DPC245');
    const bus = new FakeBus();
    const msgs = [];
    const upd = newUpdater(bus, msgs);
    bus.device = dpc245Device(bus, CHUNKS);
    const ok = await upd.startUpdateProcedure(FIRMWARE, 'HMI');
    check(ok === true, 'update reports success');
    check(msgs.some((m) => m === 'FW_UPDATE_END:OK'), 'end message is OK');

    // Pacing: the schedule is absolute, so the average period can only ever come out at or
    // above the floor. Anything materially below it means frames are being pushed into the
    // adapter faster than the bus can drain them.
    const chunks = bus.sent.filter((f) => f.id.startsWith('851D'));
    check(chunks.length === CHUNKS - 2, `all data chunks sent (${chunks.length})`);
    const gaps = [];
    for (let i = 1; i < chunks.length; i++) gaps.push((chunks[i].t - chunks[i - 1].t) * 1000);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const fast = gaps.filter((g) => g < 400).length;
    console.log(`      measured ${avg.toFixed(0)} us/frame, ${fast} gap(s) under 400 us`);
    check(avg >= 700, `average period respects the ~810 us floor (${avg.toFixed(0)} us)`);
    check(fast <= Math.ceil(gaps.length * 0.05), 'no catch-up burst after the ACK checkpoints');

    // End phase, as captured from the official tool: 01, 00, keepalive 00 ..., 01.
    const lastChunkAt = bus.sent.findIndex((f) => f.id.startsWith('851E'));
    const tail = bus.sent.slice(lastChunkAt).filter((f) => f.id === '85FF3005');
    check(tail.length >= 5, `end phase keeps the session open (${tail.length} announces)`);
    check(tail[0] && tail[0].data === '01', 'end phase opens with 01');
    check(tail[1] && tail[1].data === '00', 'end phase then sends 00');
    check(tail.slice(1, -1).every((f) => f.data === '00'), 'keepalives are all 00');
    check(tail[tail.length - 1].data === '01', 'end phase closes with 01');
    const windowMs = tail[tail.length - 1].t - tail[0].t;
    check(windowMs >= 400, `session held for the whole write window (${windowMs.toFixed(0)} ms)`);
}

async function testRejectedImage() {
    console.log('2) non-zero status in the closing ACK');
    const bus = new FakeBus();
    const msgs = [];
    const upd = newUpdater(bus, msgs);
    bus.device = dpc245Device(bus, CHUNKS, { finalAck: [0, 0, 0, 1] });
    const ok = await upd.startUpdateProcedure(FIRMWARE, 'HMI');
    check(ok === false, 'update fails instead of reporting success');
    check(msgs.some((m) => m.startsWith('FW_UPDATE_END:FAILED')), 'failure is reported to the UI');
    check(msgs.some((m) => /rejected the image/.test(m)), 'reason names the rejected image');
    // The write window must not run for an image the device did not accept.
    check(!bus.sent.some((f) => f.id === '85FF3005' && f.data === '01'),
        'no end-of-flash announce after a rejected image');
}

async function testSendFailureAborts() {
    console.log('3) a frame the adapter refuses aborts the flash');
    const bus = new FakeBus();
    const msgs = [];
    const upd = newUpdater(bus, msgs);
    bus.device = dpc245Device(bus, CHUNKS);
    bus.failOnId = '851D0064';   // chunk 100, well inside the stream
    const ok = await upd.startUpdateProcedure(FIRMWARE, 'HMI');
    check(ok === false, 'update fails instead of writing a hole into the image');
    check(msgs.some((m) => /could not be sent/.test(m)), 'reason names the unsent frame');
    const after = bus.sent.filter((f) => f.id.startsWith('851D') && parseInt(f.id.slice(4), 16) > 100);
    check(after.length === 0, 'no further chunks are sent after the failure');
}

function testChunkNumberCap() {
    console.log('4) chunk numbering cannot silently wrap');
    const upd = new FwUpdater(new FakeBus());
    upd.logToFile = async () => {};
    let threw = false;
    try {
        upd.initFile(Buffer.alloc(16 + (0xFFFF + 1) * 8));
    } catch (e) {
        threw = /too large/i.test(`${e}`);
    }
    check(threw, 'a file needing more than 65535 chunks is refused');

    const okUpd = new FwUpdater(new FakeBus());
    okUpd.logToFile = async () => {};
    okUpd.initFile(Buffer.alloc(16 + 0xFFFF * 8));
    check(okUpd.NUM_CHUNKS === 0xFFFF, 'the largest representable file is still accepted');
}

function testPeriodKnob() {
    console.log('5) the UI delay knob can only slow the stream down');
    const upd = new FwUpdater(new FakeBus());
    check(upd.framePeriodUs() === 810, 'default period is the BESST cadence');
    upd.delayUs = 100;
    check(upd.framePeriodUs() === 810, 'a smaller knob value cannot go below the floor');
    upd.delayUs = 1500;
    check(upd.framePeriodUs() === 1500, 'a larger knob value is honoured');
}

(async () => {
    await testHappyPath();
    await testRejectedImage();
    await testSendFailureAborts();
    testChunkNumberCap();
    testPeriodKnob();
    console.log(failures ? `\nFW-130: ${failures} FAILURE(S)` : '\nFW-130: all checks passed');
    process.exit(failures ? 1 : 0);
})();
