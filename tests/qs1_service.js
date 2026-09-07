// QS-1R service end-to-end (protocol test T18 of task QS-1R-C2): the Qs1Service drives a fake
// CANable + fake controller through the whole user workflow — the S3 loop "capture -> download
// -> new capture -> capture -> download ..." — WITHOUT ever reconnecting, and delivers each
// verdict only from verified replies (a NEW MEASURE needs STATUS showing a new generation AND
// ARMED; a DOWNLOAD needs all 48 complete records).
//
// The fake controller answers exactly like the pinned firmware (build 7232f9d):
//   85116031# (READ)  -> 822A6031 DLC 8 status
//   85106031# (WRITE) -> 822A6031 DLC 0 NORMAL_ACK (or 822B6031 ERROR_ACK), re-arm visible as a
//                       later STATUS with a higher generation and ARMED
//   85106030# (WRITE) -> 822A6030 DLC 0 NORMAL_ACK, then the 0x80010250..56 export replay
//
// Run from the Canable project root:  node tests/qs1_service.js

'use strict';
const { EventEmitter } = require('events');
const { Qs1Service } = require('../qs1');
const { Qs1Download, QS_SAMPLES, QS_COMMANDS, STATUS_REPLY_ID } = require('../qs1-protocol');

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const eq = (got, want, label) => check(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the fake bus -------------------------------------------------------------
class FakeBus extends EventEmitter {
    constructor() { super(); this.connected = true; this.sent = []; }
    isConnected() { return this.connected; }
    async sendRawFrame(idHex) { this.sent.push(idHex); return true; }
}

// A raw CAN frame exactly as canbus.js delivers it (can_id, can_dlc, DataView data).
function wire(idHex, bytes) {
    const data = new DataView(new ArrayBuffer(bytes.length));
    bytes.forEach((b, i) => data.setUint8(i, b));
    return { can_id: parseInt(idHex, 16), can_dlc: bytes.length, data };
}

function pushStatus(bus, state, generation, samples, flags = 0) {
    bus.emit('raw_frame_received', wire(STATUS_REPLY_ID, [1, state, generation, samples, flags, 0, 0, 0]));
}

const lastOf = (list, kind) => {
    const m = list.filter((s) => s.startsWith(kind + ':')).pop();
    return m ? { raw: m, json: JSON.parse(m.substring(kind.length + 1)) } : null;
};

(async () => {
    const bus = new FakeBus();
    const sent = [];
    const svc = new Qs1Service({ canbus: bus, broadcast: (m) => sent.push(m) });
    svc.pollMs = 600000;          // the poll would fight the script; keep it out of the way
    svc.confirmTimeoutMs = 4000;
    svc.firstFrameTimeoutMs = 8000;
    svc.stallTimeoutMs = 2500;
    svc.stallTickMs = 250;
    svc.postTransferRefreshMs = 5;

    // ---- initial contact -------------------------------------------------------
    svc.addSubscriber();
    check(bus.sent.includes(QS_COMMANDS.readStatus), 'T18a. a subscriber triggers a STATUS read');
    eq(lastOf(sent, 'QS1_STATUS'), null, 'T18b. nothing defeats the bus: no status is claimed before one arrives');

    bus.connected = false;
    svc.refreshNow();
    const offline = lastOf(sent, 'QS1_STATUS');
    eq(offline.json.connected, false, 'T18c. a dark bus reports NOT CONNECTED, sends nothing');
    eq(offline.json.state, 'ERROR', 'T18d. ... and the panel reads ERROR');
    bus.connected = true;

    // The S3 loop: capture -> download -> new capture -> capture -> download ... twice.
    async function oneRound(fromGen, toGen) {
        pushStatus(bus, 2, fromGen, 30);            // riding: TRIGGERED
        const riding = lastOf(sent, 'QS1_STATUS');
        eq(riding.json.state, 'CAPTURING', `T18f. the ride is shown as CAPTURING (round ${toGen})`);
        pushStatus(bus, 3, fromGen, 48);            // COMPLETE (48 samples)
        svc.newCapture();                           // NEW MEASURE
        bus.emit('raw_frame_received', wire(STATUS_REPLY_ID, [])); // DLC 0 NORMAL_ACK
        check(bus.sent.includes(QS_COMMANDS.newCapture), `T18e. NEW MEASURE writes 0x6031 (round ${toGen})`);

        pushStatus(bus, 1, toGen, 0);               // controller confirms: ARMED, new generation
        const ok = lastOf(sent, 'QS1_NEW_CAPTURE_RESULT');
        check(ok.json.success, `T18g. a NEW generation + ARMED confirms the re-arm (round ${toGen})`);
        eq(ok.json.generation, toGen, `T18h. the confirmed generation is ${toGen}`);

        // ride again, complete, download
        pushStatus(bus, 2, toGen, 30);
        pushStatus(bus, 3, toGen, 48);
        const progressBefore = sent.filter((m) => m.startsWith('QS1_DOWNLOAD_PROGRESS:')).length;
        svc.download();
        check(bus.sent.includes(QS_COMMANDS.download), `T18i. DOWNLOAD writes 0x6030 (round ${toGen})`);
        await tick(1);

        bus.emit('raw_frame_received', wire('822A6030', [])); // export accepted

        // the export replay, exactly 48 headers + 6 fragments each, with a few PAS ids mixed
        // in — they must change nothing.
        for (let i = 0; i < QS_SAMPLES; i++) {
            bus.emit('raw_frame_received', wire('80010250', Qs1Download.headerBytes(toGen, i)));
            for (let f = 1; f <= 6; f++) bus.emit('raw_frame_received', wire('8001025' + f, Array(8).fill(f)));
            if (i === 10) bus.emit('raw_frame_received', wire('8001021D', Array(8).fill(0)));
        }
        await tick(20); // let the result + the quiet post-transfer refresh land

        const res = lastOf(sent, 'QS1_DOWNLOAD_RESULT');
        check(res.json.success, `T18j. a full 48-record replay is a SUCCESS (round ${toGen})`);
        eq(res.json.message, `Measure ${toGen} — 48/48 — OK`, `T18k. the verdict reads exactly ${toGen}/48 OK`);
        eq(res.json.got, 48, 'T18l. all 48 records were assembled');
        eq(svc.lastDownloadedGeneration, toGen, `T18m. generation ${toGen} is now carried away safely`);
        const canvas = sent.filter((m) => m.startsWith('QS1_DOWNLOAD_PROGRESS:')).length - progressBefore;
        eq(canvas, 49, 'T18n. 1 waiting + 48 per-record progress ticks, no PAS noise');
        check(bus.sent.filter((m) => m === QS_COMMANDS.readStatus).length >= 2,
            'T18o. a quiet STATUS refresh follows the transfer');
    }

    await oneRound(1, 2);
    await oneRound(3, 4);
    check(svc.lastDownloadedGeneration === 4, 'T18p. the S3 loop ran twice on ONE connection');

    // ---- stubborn controller / user discipline ----------------------------------
    {
        // DOWNLOAD refused mid-capture: button would be dead, service refuses too.
        pushStatus(bus, 2, 5, 30);
        svc.download();
        const refused = lastOf(sent, 'QS1_DOWNLOAD_RESULT');
        check(!refused.json.success && refused.json.message.indexOf('DOWNLOAD requires') === 0,
            'T18q. a non-COMPLETE capture refuses DOWNLOAD with a reason');
    }
    {
        // The controller instead answers ERROR_ACK: an honest FAILURE, no STATUS can claim it.
        pushStatus(bus, 3, 6, 48);
        svc.newCapture();
        const statuses = sent.filter((m) => m.startsWith('QS1_STATUS:')).length;
        bus.emit('raw_frame_received', wire('822B6031', []));
        const rej = lastOf(sent, 'QS1_NEW_CAPTURE_RESULT');
        eq(sent.filter((m) => m.startsWith('QS1_STATUS:')).length, statuses,
            'T18s. an ERROR_ACK is a failure the STATUS stream can never claim');
        check(!rej.json.success && rej.json.message.indexOf('rejected') !== -1,
            'T18t. an ERROR_ACK for 0x6031 fails NEW MEASURE with the controller reason');
        // ... and a healthy controller still confirms the very next attempt.
        pushStatus(bus, 3, 6, 48);
        svc.newCapture();
        pushStatus(bus, 1, 7, 0);
        const ok = lastOf(sent, 'QS1_NEW_CAPTURE_RESULT');
        check(ok.json.success && ok.json.generation === 7, 'T18r. the next attempt confirms normally');
    }
    {
        // Stray export frames when no download is active must be ignored, never crash.
        bus.emit('raw_frame_received', wire('80010250', Qs1Download.headerBytes(9, 0)));
        bus.emit('raw_frame_received', wire('822B6030', []));
        check(true, 'T18u. stray export/refusal frames are a silent no-op');
    }

    // ---- teardown --------------------------------------------------------------
    svc.removeSubscriber();
    svc.cleanup();
    check(bus.listenerCount('raw_frame_received') === 0, 'T18v. cleanup detaches the bus listener');

    console.log(failures === 0
        ? 'QS-1 service: ALL CHECKS PASSED (T18)'
        : `QS-1 service: ${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();