// Sniffer diag dump tracker: accounting, timeout, and DATA/END sequence correlation for the
// eVistDrive Ride Diagnostics dump tracker in sniffer.js (Sniffer#_updateDiagTransfer).
//
// Run from the Canable project root:  node tests/sniffer_diag_dump_tracker.js
//
// Drives Sniffer#rawFrameRecived with synthetic frames (same pattern as
// fw117_sniffer_no_compression.js) through a stub canbus/ws, and reads back the
// SNIFFER_DIAG_STATUS payloads the stub ws captures.

'use strict';
const path = require('path');
const Sniffer = require(path.join(__dirname, '..', 'sniffer'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

function makeFrame(idHex, bytes, timestampUs) {
    const data = new DataView(new ArrayBuffer(bytes.length));
    bytes.forEach((b, i) => data.setUint8(i, b));
    return { can_id: parseInt(idHex, 16), can_dlc: bytes.length, data, timestamp_us: timestampUs || Date.now() * 1000 };
}

function makeSniffer(timeoutMs) {
    const statuses = [];
    const stubCanbus = { on: () => {}, removeListener: () => {} };
    const stubWs = { send: (m) => { if (m.startsWith('SNIFFER_DIAG_STATUS:')) statuses.push(JSON.parse(m.slice('SNIFFER_DIAG_STATUS:'.length))); } };
    const sniffer = new Sniffer(stubCanbus, stubWs);
    sniffer.logMessage = () => {}; // silence unrelated per-frame log noise; _sendDiagStatus bypasses this
    sniffer.diagTransferTimeoutMs = timeoutMs; // per-instance override — no real 5s wait needed
    return { sniffer, statuses };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    // --- Test 1: REQUEST/START/6xDATA/END reports COMPLETE with DATA and END accounted for
    // separately — never collapsed into one ambiguous "7 frames" figure. ---
    {
        const { sniffer, statuses } = makeSniffer(5000);
        sniffer.rawFrameRecived(makeFrame('85116029', [0, 0, 0, 0, 0, 0, 0, 0]));
        sniffer.rawFrameRecived(makeFrame('822C6029', [55, 0, 0, 0, 0, 0, 0, 0]));
        for (let i = 0; i < 6; i++) sniffer.rawFrameRecived(makeFrame(`822D000${i}`, [1, 2, 3, 4, 5, 6, 7, 8]));
        sniffer.rawFrameRecived(makeFrame('822E0006', [1, 2, 3]));

        check(statuses.length === 2, `1. exactly 2 status pushes (active, complete) (got ${statuses.length})`);
        check(statuses[0]?.state === 'active', '1b. first status is active');
        check(statuses[1]?.state === 'complete', '1c. final status is complete');
        check(statuses[1]?.dataFrameCount === 6, `1d. dataFrameCount is exactly 6, not 7 (got ${statuses[1]?.dataFrameCount})`);
        check(statuses[1]?.hasEnd === true, '1e. hasEnd is true');
        check(statuses[1]?.expectedLength === 55, `1f. expectedLength read from the START payload (got ${statuses[1]?.expectedLength})`);
        check(statuses[1]?.receivedBytes === 6 * 8 + 3, `1g. receivedBytes sums DATA+END dlc (got ${statuses[1]?.receivedBytes})`);
        check(statuses[1]?.suspicious === false, '1h. not flagged suspicious');
        sniffer.cleanup();
    }

    // --- Test 2: START with no END must time out to INCOMPLETE — a short per-instance timeout
    // instead of waiting out the real 5s default. ---
    {
        const { sniffer, statuses } = makeSniffer(50);
        sniffer.rawFrameRecived(makeFrame('822C6029', [55, 0, 0, 0, 0, 0, 0, 0]));
        for (let i = 0; i < 3; i++) sniffer.rawFrameRecived(makeFrame(`822D000${i}`, [1, 2, 3, 4, 5, 6, 7, 8]));
        // no END
        await delay(120);
        check(statuses.length === 2, `2. active then incomplete (got ${statuses.length})`);
        check(statuses[1]?.state === 'incomplete', '2b. final status is incomplete after timeout');
        check(statuses[1]?.hasEnd === false, '2c. hasEnd is false (END never arrived)');
        check(statuses[1]?.dataFrameCount === 3, `2d. dataFrameCount reflects what was actually received (got ${statuses[1]?.dataFrameCount})`);
        sniffer.cleanup();
    }

    // --- Test 2b (regression): once COMPLETE fires, the pending timeout must be cancelled — no
    // late INCOMPLETE once the original timeout window elapses. ---
    {
        const { sniffer, statuses } = makeSniffer(50);
        sniffer.rawFrameRecived(makeFrame('822C6029', [16, 0, 0, 0, 0, 0, 0, 0]));
        sniffer.rawFrameRecived(makeFrame('822D0000', [1, 2, 3, 4, 5, 6, 7, 8]));
        sniffer.rawFrameRecived(makeFrame('822E0001', [1, 2, 3]));
        check(statuses.length === 2 && statuses[1]?.state === 'complete', '2b-pre. reached complete before the timeout window');
        await delay(120); // well past the 50ms window armed before END
        check(statuses.length === 2, `2b. no further status pushed after COMPLETE (got ${statuses.length})`);
        sniffer.cleanup();
    }

    // --- Test 3: a sequence gap (dropped frame) must not crash, and must not let a subsequent
    // END claim COMPLETE over data with a hole in it. ---
    {
        const { sniffer, statuses } = makeSniffer(5000);
        sniffer.rawFrameRecived(makeFrame('822C6029', [24, 0, 0, 0, 0, 0, 0, 0]));
        sniffer.rawFrameRecived(makeFrame('822D0000', [1, 2, 3, 4, 5, 6, 7, 8])); // seq 0
        sniffer.rawFrameRecived(makeFrame('822D0002', [1, 2, 3, 4, 5, 6, 7, 8])); // seq 2 — seq 1 missing
        sniffer.rawFrameRecived(makeFrame('822E0003', [1, 2, 3]));
        check(statuses[1]?.state === 'incomplete', `3. a sequence gap downgrades the final status to incomplete (got ${statuses[1]?.state})`);
        check(statuses[1]?.suspicious === true, '3b. suspicious flag set for the gap');
        check(statuses[1]?.dataFrameCount === 2, `3c. still counts every DATA frame actually received (got ${statuses[1]?.dataFrameCount})`);
        sniffer.cleanup();
    }

    // --- Test 4: a duplicated sequence number must not crash either, and is also flagged. ---
    {
        const { sniffer, statuses } = makeSniffer(5000);
        sniffer.rawFrameRecived(makeFrame('822C6029', [24, 0, 0, 0, 0, 0, 0, 0]));
        sniffer.rawFrameRecived(makeFrame('822D0000', [1, 2, 3, 4, 5, 6, 7, 8])); // seq 0
        sniffer.rawFrameRecived(makeFrame('822D0000', [1, 2, 3, 4, 5, 6, 7, 8])); // seq 0 again (duplicate)
        sniffer.rawFrameRecived(makeFrame('822D0001', [1, 2, 3, 4, 5, 6, 7, 8])); // seq 1
        sniffer.rawFrameRecived(makeFrame('822E0002', [1, 2, 3]));
        check(statuses[1]?.state === 'incomplete', `4. a duplicate sequence downgrades the final status to incomplete (got ${statuses[1]?.state})`);
        check(statuses[1]?.suspicious === true, '4b. suspicious flag set for the duplicate');
        check(statuses[1]?.dataFrameCount === 3, `4c. every received DATA frame is still counted, duplicate included (got ${statuses[1]?.dataFrameCount})`);
        sniffer.cleanup();
    }

    console.log(failures === 0
        ? 'Sniffer diag dump tracker: PASS'
        : `Sniffer diag dump tracker: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
