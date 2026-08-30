'use strict';
// QS-1X workflow end-to-end regression tests (task QS-1X-C3). These cover the fixed state
// machine: NOWY POMIAR runs as ONE transaction (STEP A authoritative STATUS -> STEP C mode
// write -> STEP D mode verify -> STEP E NEW CAPTURE -> STEP F mandatory post-ACK STATUS), the
// captured mode stays latched and separate from next mode, COMPLETE is restored from STATUS
// on reconnection, and no operation can leave a permanent grey button.
//
// The fake controller answers exactly like the verified EBICS QS-1X 0.0467 firmware:
//   85106031# DLC0 (NEW CAPTURE)  -> 822A6031 DLC0
//   85106031# DLC1 (mode select)  -> 822A6031 DLC0 (or a spontaneous 822A6031 DLC8 STATUS)
//   85116031#   (READ STATUS)     -> 822A6031 DLC8: [2, state, gen, high, flags, mode, tail, trig]
//   85106030#   (DOWNLOAD)        -> 822A6030, then the export replay
//
// Run: node tests/qs1x_final.js

'use strict';
const { EventEmitter } = require('events');
const { MODE, COMMAND, HIGH, TAIL, modeByte, Download, isComplete } = require('../qs1x-protocol');
const { Qs1Service } = require('../qs1x');
let failed = 0;
const ok = (v, n) => { if (!v) { failed++; console.error('  FAIL ' + n); } else console.log('  PASS ' + n); };
const eq = (a, b, n) => ok(a === b, n + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

class Bus extends EventEmitter {
    constructor() { super(); this.sent = []; this.isStarted = true; }
    isConnected() { return true; }
    sendRawFrame(id, d) { this.sent.push([id, d || '']); return Promise.resolve(); }
}
function wire(id, bytes) {
    const b = bytes || [];
    const data = new DataView(new ArrayBuffer(b.length));
    b.forEach((x, i) => data.setUint8(i, x));
    return { can_id: parseInt(id, 16), can_dlc: b.length, data };
}
// schema 2 STATUS byte layout: [2, state, gen, high, flags, mode, tail, trig].
function status(state, generation, high, flags, mode, tail, trigger) {
    return [2, state, generation, high, flags, mode, tail, trigger || 0];
}
const ACK = wire('822A6031', []);
const DL_ACK = wire('822A6030', []);

function newService() {
    const bus = new Bus();
    const out = [];
    const svc = new Qs1Service({ canbus: bus, broadcast: (m) => out.push(m) });
    svc.pollMs = 600000;   // keep the poll out of the way in unit-style tests
    return { bus, out, svc, lastOf: (k) => { const m = out.filter((s) => s.startsWith(k + ':')).pop(); return m ? JSON.parse(m.substring(k.length + 1)) : null; } };
}
function armedStatus(gen) { return wire('822A6031', status(1, gen, 0, 0, MODE.START, 0)); }
const completeStatus = () => wire('822A6031', status(5, 2, 48, 0x19, MODE.STOP, 19, 1));

// Drive the transaction up to the NEW CAPTURE write, then STOP with the service sitting at
// the newCaptureAck stage (waiting for the ACK). This is the exact scenario from the real
// logs (85106031 DLC0 -> 822A6031 DLC0) that must be followed by an immediate STATUS read.
function driveToNewCaptureAck(ctx, gen) {
    const { bus, svc } = ctx;
    svc.status = { schema: 2, state: 1, generation: gen, highCount: 0, tailCount: 0, mode: 0, modeName: 'START', highComplete: false, tailComplete: false };
    svc.selectMode('START');
    bus.sent.length = 0;
    svc.newCapture();
    bus.emit('raw_frame_received', armedStatus(gen));       // STEP A
    bus.emit('raw_frame_received', ACK);                     // mode ACK -> STEP D
    bus.emit('raw_frame_received', armedStatus(gen));        // STEP D verify -> STEP E
    // now at newCaptureAck stage; bus.sent ends with the NEW CAPTURE write
}

// Drive all the way through STEP F, leaving the service waiting for the post-ACK STATUS.
function driveToStepF(ctx, gen) {
    const { bus } = ctx;
    driveToNewCaptureAck(ctx, gen);
    bus.emit('raw_frame_received', ACK);                     // NEW CAPTURE ACK -> STEP F (sends STATUS)
}

(async () => {
    // ------------------------------------------------------------------ mode encoding (1-3)
    eq(modeByte('START'), 0, '1. START mode encoding = 00');
    eq(modeByte('STOP'), 1, '2. STOP mode encoding = 01');
    eq(modeByte('RESTART'), 2, '3. RESTART mode encoding = 02');

    // ------------------------------------------------------------------ mode ACK handling (4)
    const t4 = newService();
    eq(t4.svc.selectMode('START'), 0, '4. selectMode returns the mode byte');

    // ------------------------------------------------------------------ NEW CAPTURE as ONE transaction (5-13)
    {
        const ctx = newService(); const { bus, svc, lastOf } = ctx;
        svc.status = { schema: 2, state: 1, generation: 1, highCount: 0, tailCount: 0, mode: 0, modeName: 'START', highComplete: false, tailComplete: false };
        svc.selectMode('START');
        bus.sent.length = 0;
        svc.newCapture();
        ok(bus.sent.some((x) => x[0] === COMMAND.status), '5. NEW CAPTURE starts with an authoritative STATUS read (STEP A)');
        bus.emit('raw_frame_received', armedStatus(1));
        ok(bus.sent.some((x) => x[0] === COMMAND.select && x[1] === '00'), '6. STEP C writes requested mode START (DLC1 00)');
        bus.emit('raw_frame_received', ACK);
        ok(bus.sent.some((x) => x[0] === COMMAND.status), '7. STEP D reads STATUS to verify the mode');
        bus.emit('raw_frame_received', armedStatus(1));
        ok(bus.sent.some((x) => x[0] === COMMAND.newCapture && x[1] === ''), '8. STEP E sends NEW CAPTURE (WRITE 0x6031 DLC0)');
        const before = bus.sent.length;
        bus.emit('raw_frame_received', ACK);
        ok(bus.sent.length > before, '9. post-ACK: an automatic STATUS is requested immediately (STEP F)');
        eq(bus.sent[bus.sent.length - 1][0], COMMAND.status, '9b. the immediate post-ACK request is STATUS 0x6031');
        bus.emit('raw_frame_received', armedStatus(2));      // ARMED, generation advanced
        const r = lastOf('QS1_NEW_CAPTURE_RESULT');
        ok(r && r.success, '10. NEW CAPTURE confirmed by post-ACK STATUS (ARMED)');
        eq(r.generation, 2, '11. generation increment confirmed 1 -> 2');
        const st = lastOf('QS1_STATUS');
        eq(st.host, 'ARMED', '12. host reaches ARMED');
        eq(st.capturedMode, 'START', '13. captured mode latched at ARMED');
    }

    // ------------------------------------------------------------------ capturedMode != nextMode / no relabel (14, 15)
    {
        const ctx = newService(); const { svc } = ctx;
        svc.status = { schema: 2, state: 5, generation: 2, highCount: 48, tailCount: 19, mode: 1, modeName: 'STOP', highComplete: true, tailComplete: true };
        svc.capturedMode = 'STOP'; svc.capturedGeneration = 2;
        ok(svc.nextMode === 'START', '14. nextMode is tracked separately from capturedMode');
        svc.selectMode('RESTART');
        eq(svc.nextMode, 'START', '15. scenario change REJECTED while COMPLETE undownloaded');
        eq(svc.capturedMode, 'STOP', '15b. completed capture never relabelled');
    }

    // ------------------------------------------------------------------ CASE A: ACK -> immediate STATUS (no silent pending)
    {
        const ctx = newService(); const { bus } = ctx;
        driveToNewCaptureAck(ctx, 1);
        const before = bus.sent.length;
        bus.emit('raw_frame_received', ACK);                 // NEW CAPTURE ACK (85106031 DLC0)
        ok(bus.sent.length > before, 'CASE A: after NEW CAPTURE ACK the service immediately requests STATUS (no silent pending)');
        eq(bus.sent[bus.sent.length - 1][0], COMMAND.status, 'CASE A: the immediate request is STATUS 0x6031');
    }

    // ------------------------------------------------------------------ CASE B: COMPLETE status -> DOWNLOAD available
    {
        const ctx = newService(); const { bus, lastOf } = ctx;
        svcOf(ctx).refreshNow();
        bus.emit('raw_frame_received', completeStatus());
        const st = lastOf('QS1_STATUS');
        eq(st.complete, true, 'CASE B: 48/48 + 19/19 => COMPLETE');
        eq(st.state, 'COMPLETE', 'CASE B: rendered state COMPLETE');
        eq(st.high, 48, 'CASE B: high-rate 48/48');
        eq(st.tail, 19, 'CASE B: tail 19/19');
        eq(st.host, 'COMPLETE', 'CASE B: host COMPLETE -> DOWNLOAD AVAILABLE');
        ok(isComplete(svcOf(ctx).status), 'CASE B: isComplete() true for schema 2');
    }

    // ------------------------------------------------------------------ CASE C/D: completed capture not relabelled
    {
        const ctx = newService(); const { svc } = ctx;
        svc.status = { schema: 2, state: 5, generation: 2, highCount: 48, tailCount: 19, mode: 1, modeName: 'STOP', highComplete: true, tailComplete: true };
        svc.capturedMode = 'STOP'; svc.capturedGeneration = 2;
        svc.selectMode('RESTART');
        eq(svc.capturedMode, 'STOP', 'CASE C: completed capture not relabelled to RESTART');
        svc.selectMode('START');
        eq(svc.capturedMode, 'STOP', 'CASE D: completed capture not relabelled to START');
    }

    // ------------------------------------------------------------------ CASE E: reconnect restores COMPLETE from STATUS alone
    {
        const ctx = newService(); const { bus, svc, lastOf } = ctx;
        svc.lastDownloadedGeneration = null; svc.capturedMode = null; svc.capturedGeneration = null;
        svc.refreshNow();
        bus.emit('raw_frame_received', completeStatus());
        const st = lastOf('QS1_STATUS');
        eq(st.complete, true, 'CASE E: reconnect restores COMPLETE from STATUS alone');
        eq(st.generation, 2, 'CASE E: generation 2 restored');
        eq(st.high, 48, 'CASE E: 48/48 restored');
        eq(st.tail, 19, 'CASE E: 19/19 restored');
        eq(st.capturedMode, 'STOP', 'CASE E: captured mode restored from firmware status');
    }

    // ------------------------------------------------------------------ repeated capture without reboot (24)
    {
        const ctx = newService(); const { bus, svc, lastOf } = ctx;
        for (let g = 1; g <= 2; g++) {
            svc.status = { schema: 2, state: 5, generation: g, highCount: 48, tailCount: 19, mode: 0, modeName: 'START', highComplete: true, tailComplete: true };
            svc.capturedMode = 'START'; svc.capturedGeneration = g;
            svc.lastDownloadedGeneration = g;                  // pretend downloaded
            driveToStepF(ctx, g);
            bus.emit('raw_frame_received', armedStatus(g + 1));
            const r = lastOf('QS1_NEW_CAPTURE_RESULT');
            ok(r && r.success, `24. repeated capture round ${g} armed (gen ${g} -> ${g + 1}) without reboot`);
            eq(svc.status.generation, g + 1, `24b. firmware generation advanced to ${g + 1}`);
        }
    }

    // ------------------------------------------------------------------ DOWNLOAD (18-21) and incomplete rejection (22)
    {
        const ctx = newService(); const { bus, svc, lastOf } = ctx;
        svc.status = { schema: 2, state: 5, generation: 2, highCount: 48, tailCount: 19, mode: 0, modeName: 'START', highComplete: true, tailComplete: true };
        svc.capturedMode = 'START'; svc.capturedGeneration = 2;
        svc.download();
        ok(bus.sent.some((x) => x[0] === COMMAND.download), '18. DOWNLOAD sends 85106030');
        bus.emit('raw_frame_received', DL_ACK);
        for (let i = 0; i < HIGH.count; i++) {
            bus.emit('raw_frame_received', wire('80010250', [1, 2, i, 0, 44, 6, 48, 0]));
            for (let f = 1; f <= 6; f++) bus.emit('raw_frame_received', wire((0x80010250 + f).toString(16), Array(8).fill(f)));
        }
        for (let i = 0; i < TAIL.count; i++) {
            bus.emit('raw_frame_received', wire('80010252', [2, 2, i, 19, 12, 250, 0, 0]));
            bus.emit('raw_frame_received', wire('80010253', Array(8).fill(1)));
            bus.emit('raw_frame_received', wire('80010254', Array(4).fill(2)));
        }
        const r = lastOf('QS1_DOWNLOAD_RESULT');
        ok(r && r.success, '19. 48/48 high-rate reconstruction OK');
        eq(r.high, 48, '19b. high-rate = 48');
        eq(r.tail, 19, '20. 19/19 tail reconstruction OK');
        ok(String(r.message || '').includes('MOE metadata'), '21. MOE metadata reported OK');
        eq(r.generation, 2, '21b. generation consistent (2)');

        // incomplete download rejected
        const ctx2 = newService(); const { bus: bus2, svc: svc2, lastOf: lastOf2 } = ctx2;
        svc2.status = { schema: 2, state: 5, generation: 3, highCount: 48, tailCount: 19, mode: 0, modeName: 'START', highComplete: true, tailComplete: true };
        svc2.stallTimeoutMs = 5; svc2.stallTickMs = 1;
        svc2.download();
        bus2.emit('raw_frame_received', wire('822A6030', []));
        for (let i = 0; i < 10; i++) {
            bus2.emit('raw_frame_received', wire('80010250', [1, 3, i, 0, 44, 6, 48, 0]));
            for (let f = 1; f <= 6; f++) bus2.emit('raw_frame_received', wire((0x80010250 + f).toString(16), Array(8).fill(f)));
        }
        await waitFor(() => !!lastOf2('QS1_DOWNLOAD_RESULT'));
        const r2 = lastOf2('QS1_DOWNLOAD_RESULT');
        ok(r2 && r2.success === false, '22. incomplete download is rejected (no false success)');
        eq(r2.high, 10, '22b. partial progress reported (10/48)');
    }

    // ------------------------------------------------------------------ PAS/QS separation (23)
    {
        const d = new Download(2);
        ok(!d.note('8001021D', [1, 2, 0, 0, 44, 6, 48, 0]), '23. PAS diagnostic frame never counts as QS data');
        ok(!d.note('80010218', [2, 2, 0, 19, 12, 250, 0, 0]), '23b. second PAS frame id rejected');
    }

    // ------------------------------------------------------------------ STATUS polling (10)
    {
        const ctx = newService(); const { bus, svc } = ctx;
        svc.pollMs = 2;
        svc.status = { schema: 2, state: 1, generation: 1, highCount: 0, tailCount: 0, mode: 0, modeName: 'START', highComplete: false, tailComplete: false };
        svc.addSubscriber();
        await waitFor(() => bus.sent.filter((x) => x[0] === COMMAND.status).length >= 2);
        ok(true, '10. STATUS polling emits repeated 0x6031 reads while armed');
        svc.removeSubscriber();
    }

    // ------------------------------------------------------------------ timeout recovery / no grey button (17, CASE F)
    {
        const ctx = newService(); const { bus, svc, lastOf } = ctx;
        svc.status = { schema: 2, state: 1, generation: 1, highCount: 0, tailCount: 0, mode: 0, modeName: 'START', highComplete: false, tailComplete: false };
        svc.selectMode('START');
        svc.statusConfirmTimeoutMs = 5;
        driveToStepF(ctx, 1);                              // NEW CAPTURE ACK sent, then no STATUS
        await waitFor(() => { const r = lastOf('QS1_NEW_CAPTURE_RESULT'); return !!(r && r.success === false); });
        const rr = lastOf('QS1_NEW_CAPTURE_RESULT');
        ok(rr && rr.success === false, 'CASE F: post-ACK STATUS timeout yields an explicit ERROR (no silent grey)');
        const st = lastOf('QS1_STATUS');
        eq(st.host, 'ERROR', 'CASE F: host recovers to ERROR (controls back for retry)');
        ok(svc.pending === null, 'CASE F: no transaction left pending after the timeout');
        ok(!svc._tx, 'CASE F: transaction torn down');
    }

    console.log(failed ? `\n${failed} FAILURES` : '\nALL QS-1X WORKFLOW TESTS PASS');
    process.exit(failed ? 1 : 0);
})();

function svcOf(ctx) { return ctx.svc; }
function waitFor(fn) {
    const start = Date.now();
    return new Promise((res, rej) => {
        const iv = setInterval(() => {
            if (fn()) { clearInterval(iv); res(); }
            else if (Date.now() - start > 3000) { clearInterval(iv); rej(new Error('waitFor timeout')); }
        }, 2);
    });
}