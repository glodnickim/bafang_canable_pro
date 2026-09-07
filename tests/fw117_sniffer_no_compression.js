// FW-117 host test: sniffer.js must never compress the bridge lifecycle trace's five frame
// IDs (0x10234-0x10238), against the SHIPPED Sniffer class.
//
// Run from the Canable project root:  node tests/fw117_sniffer_no_compression.js
//
// THE BUG. Sniffer.rawFrameRecived accumulates per CAN ID: a frame whose payload matches the
// PREVIOUS frame seen for that same ID is folded into a running count instead of being written.
// One FW-117 sample is five DIFFERENT IDs in a fixed order (header 0x10234, then fragments
// 0x10235..0x10238); fragments 0x10236-0x10238 carry no per-sample counter of their own (only
// 0x10235's tick_abs does), so two consecutive samples captured during a quiet/idle stretch can
// be byte-identical on those IDs. Compressing them away per-ID silently drops real samples and
// desyncs the fixed 5-frame cadence a decoder relies on to pair each header with its own
// fragments - exactly what this test drives at the worst case (every sample byte-identical to
// the last) to prove the fix holds even then.
//
// THE FIX. These five IDs bypass frameAccumulator entirely: every frame is written immediately,
// in arrival order, with its own timestamp - see the FW-117 BYPASS block in sniffer.js.

'use strict';
const path = require('path');
const Sniffer = require(path.join(__dirname, '..', 'sniffer'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

// A stub canbus: the constructor only needs .on(), cleanup() only needs .removeListener().
const stubCanbus = { on: () => {}, removeListener: () => {} };

function makeFrame(idHex, bytes, timestampUs) {
    const data = new DataView(new ArrayBuffer(bytes.length));
    bytes.forEach((b, i) => data.setUint8(i, b));
    return { can_id: parseInt(idHex, 16), can_dlc: bytes.length, data, timestamp_us: timestampUs };
}

// --- Test 1: 480 sets of 5 frames, EVERY set byte-identical to every other set (the worst
// case for the old per-ID accumulator - it would have collapsed all 480 repeats of each ID
// into a single "(Repeated 480 times)" summary line, 5 lines total instead of 2400). ---
{
    const sniffer = new Sniffer(stubCanbus);
    const captured = [];
    sniffer.logMessage = (message) => { captured.push(message); }; // spy: no console/file/ws

    const fw117Ids = ['80010234', '80010235', '80010236', '80010237', '80010238'];
    // Fixed, identical-across-samples payload per ID (only the id-specific first byte differs,
    // so a bug that mixed up fragments between IDs would also be visible in the assertions below).
    const payloadFor = (idHex) => [parseInt(idHex.slice(-2), 16), 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00];

    const N_SAMPLES = 480;
    let ts = 1_000_000;
    for (let sample = 0; sample < N_SAMPLES; sample++) {
        for (const idHex of fw117Ids) {
            sniffer.rawFrameRecived(makeFrame(idHex, payloadFor(idHex), ts));
            ts += 250; // distinct, monotonically increasing timestamp per frame
        }
    }

    check(captured.length === 2400,
        `1. exactly 2400 frames logged for 480 x 5 (got ${captured.length})`);

    // 2. Strict order: 10234,10235,10236,10237,10238 repeating, every one of the 480 cycles.
    let orderOk = true;
    for (let sample = 0; sample < N_SAMPLES && orderOk; sample++) {
        for (let k = 0; k < fw117Ids.length; k++) {
            const line = captured[sample * 5 + k];
            if (!line || !line.includes(`ID:${fw117Ids[k]}`)) { orderOk = false; break; }
        }
    }
    check(orderOk, '2. all 480 samples appear in strict 10234..10238 order');

    // 3. No compression: not one of the 2400 lines is a "(Repeated ...)" summary - every frame
    // was written as its own line, never folded into a count.
    const anyRepeated = captured.some((line) => line.includes('Repeated'));
    check(!anyRepeated, '3. no frame was summarized as "(Repeated N times)" - zero compression');

    // 4. Original timestamps preserved and strictly increasing (proves frames were written
    // immediately with their own timestamp, not an accumulator's lastTimestamp).
    let ts2 = 1_000_000;
    let timestampsOk = true;
    for (const line of captured) {
        const [tsField] = line.split('\t');
        if (Number(tsField) !== ts2) { timestampsOk = false; break; }
        ts2 += 250;
    }
    check(timestampsOk, '4. every logged line carries its own original, distinct timestamp');

    // 5. Every DLC/Data field matches exactly what was fed for that ID (no cross-ID mixing).
    let dataOk = true;
    for (let sample = 0; sample < N_SAMPLES && dataOk; sample++) {
        for (let k = 0; k < fw117Ids.length; k++) {
            const idHex = fw117Ids[k];
            const line = captured[sample * 5 + k];
            const expectedFirstByte = payloadFor(idHex)[0].toString(16).toUpperCase().padStart(2, '0');
            if (!line.includes(`Data:${expectedFirstByte} AA BB CC DD EE FF 00`)) { dataOk = false; break; }
        }
    }
    check(dataOk, '5. each frame carries its own correct, unmixed payload');

    sniffer.cleanup();
    // 6. cleanup() must not emit anything more for these IDs - they never entered
    // frameAccumulator, so there is nothing left to flush. cleanup() always appends its own
    // unconditional "Stoping sniffer..." line, so the count grows by exactly one, not more.
    check(captured.length === 2401,
        `6. cleanup() added only its own shutdown line, no FW-117 flush (got ${captured.length}, want 2401)`);
    check(captured[2400].includes('Stoping sniffer'), '6b. the one line cleanup() added is the shutdown line');
}

// --- Test 2: non-FW-117 IDs must keep the EXISTING per-ID compression behaviour. ---
{
    const sniffer = new Sniffer(stubCanbus);
    const captured = [];
    sniffer.logMessage = (message) => { captured.push(message); };

    const otherId = '80010111';
    const bytes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
    for (let i = 0; i < 5; i++) {
        sniffer.rawFrameRecived(makeFrame(otherId, bytes, 2_000_000 + i * 250));
    }
    // First occurrence is written; the next 4 identical repeats are only counted, not written -
    // unchanged accumulator behaviour for every ID outside the FW-117 set.
    check(captured.length === 1, `non-FW-117 ID still compresses identical repeats (got ${captured.length} line(s))`);
    check(sniffer.frameAccumulator[otherId] && sniffer.frameAccumulator[otherId].count === 5,
        'non-FW-117 ID still accumulates a running count (5)');

    sniffer.cleanup();
    // cleanup() flushes the pending "(Repeated 5 times)" summary, then appends its own
    // unconditional "Stoping sniffer..." shutdown line - 3 lines total.
    check(captured.length === 3, `cleanup() flushes the pending summary + its shutdown line (got ${captured.length}, want 3)`);
    check(captured[1].includes('Repeated 5 times'), 'the flushed summary names the correct count');
    check(captured[2].includes('Stoping sniffer'), 'the final line is the shutdown message');
}

console.log(failures === 0
    ? 'FW-117 sniffer no-compression: PASS'
    : `FW-117 sniffer no-compression: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
