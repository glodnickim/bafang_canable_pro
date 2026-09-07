// QS-1R protocol facts, pinned to the DIAG firmware build 7232f9d (eVD 0.0413). Everything
// here is a known-answer check against the firmware source (src/CAN_Display.c
// send_qs_transition_status / sendWriteResult, src/qs_transition_diag.c/.h, src/
// qs_transition_dump.c) recorded in qs1-protocol.js — never built from the module's own
// output. Covers protocol tests T1..T17 of task QS-1R-C2.
//
// Run from the Canable project root:  node tests/qs1_protocol.js

'use strict';
const P = require('../qs1-protocol');
const { Qs1Download } = P;

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const eq = (got, want, label) => check(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// --- wire helpers: build a status reply the way the firmware builds it ---------------------

// ----------------------------------------------------------------------------- T1..T3: ids
{
    eq(P.QS_COMMANDS.readStatus,   '85116031', 'T1. read status is READ 0x6031');
    eq(P.QS_COMMANDS.newCapture,   '85106031', 'T1b. new capture is WRITE 0x6031');
    eq(P.QS_COMMANDS.download,     '85106030', 'T1c. download is WRITE 0x6030, not 0x6031');
    eq(P.STATUS_REPLY_ID,          '822A6031', 'T2. status reply is op2 0x6031');
    eq(P.NEW_CAPTURE_REJECTED_ID,  '822B6031', 'T2b. rejected new capture is op3 0x6031');
    eq(P.DOWNLOAD_ACK_ID,          '822A6030', 'T2c. download ack is op2 0x6030');
    eq(P.DOWNLOAD_REJECTED_ID,     '822B6030', 'T2d. download refused is op3 0x6030');
    eq(P.QS_SAMPLES, 48, 'T3. capture ring is 48 samples');
    eq(P.QS_SAMPLE_BYTES, 44, 'T3a. each record is 44 bytes');
    eq(P.QS_FRAGMENTS, 6, 'T3b. 44 bytes ship over 6 fragments');
}

// ------------------------------------------------------------------------- T4: export ids
{
    check(P.isQ1ExportId('80010250'), 'T4. header id is an export id');
    check(P.isQ1ExportId('80010256'), 'T4a. last fragment id is an export id');
    check(!P.isQ1ExportId('80010257'), 'T4b. 0x80010257 is NOT an export id');
    check(!P.isQ1ExportId('8001024F'), 'T4c. one below the window is not an export id');
    check(!P.isQ1ExportId('8001021D'), 'T4d. a PAS id is not an export id');
    check(!P.isQ1ExportId('zzzz'), 'T4e. a non-id is not an export id');
}

// ---------------------------------------------------------------------------- T5: PAS ids
{
    ['8001021D', '80010218', '80010216', '80010217', '8001021B', '8001021C'].forEach(id => {
        check(P.isPasDiagId(id), `T5. PAS diag id ${id} is recognised as PAS`);
    });
    check(!P.isPasDiagId('80010250'), 'T5a. the export header is not a PAS id');
    check(!P.isPasDiagId('8001021E'), 'T5b. a neighbour is not a PAS id');
}

// -------------------------------------------------------------------- T6..T8: status reply
{
    const d = P.decodeStatus([1, 1, 3, 48, 0x01 | 0x02, 2, 5, 0]);
    eq(d.schema, 1, 'T6. schema byte is 1');
    eq(d.state, P.QS_STATES.ARMED, 'T6a. wire state carries through');
    eq(d.generation, 3, 'T6b. generation carries through');
    eq(d.sampleCount, 48, 'T6c. sample count carries through');
    eq(d.flags, 0x03, 'T6d. raw flags survive');
    check(d.exportReady && d.exportBusy, 'T6e. bit0 export-ready and bit1 export-busy decode');
    eq(d.triggerEvents, 2, 'T6f. trigger events carry through');
    eq(d.triggerIndex, 5, 'T6g. trigger index carries through');
    check(d.valid, 'T6h. schema 1 is valid');
    {
        const busy = P.decodeStatus([1, 3, 7, 48, 0x02, 1, 0, 0]);
        eq(busy.state, P.QS_STATES.COMPLETE, 'T7. a COMPLETE status decodes');
        check(!busy.exportReady && busy.exportBusy, 'T7a. busy dump alone is bit1');
        check(busy.valid, 'T7b. still valid');
    }
    {
        check(!P.decodeStatus([9, 1, 1, 0, 0, 0, 0, 0]).valid, 'T8. a wrong schema is invalid');
        check(P.decodeStatus([1, 1, 1, 0, 0, 0, 0]) === null, 'T8a. a 7-byte frame is not a status');
        check(P.decodeStatus(null) === null, 'T8b. no frame is not a status');
        check(P.decodeStatus('nonsense') === null, 'T8c. a string is not a status');
    }
}

// ----------------------------------------------------------------- T9: state -> panel text
{
    eq(P.panelStateFromStatus(P.decodeStatus([1, 1, 1, 0, 0, 0, 0, 0])), 'READY_TO_MEASURE', 'T9. ARMED -> READY TO MEASURE');
    eq(P.panelStateFromStatus(P.decodeStatus([1, 2, 1, 30, 0, 0, 0, 0])), 'CAPTURING', 'T9a. TRIGGERED -> CAPTURING');
    eq(P.panelStateFromStatus(P.decodeStatus([1, 3, 1, 48, 0x01, 0, 0, 0])), 'MEASURE_READY', 'T9b. COMPLETE -> MEASURE READY');
    eq(P.panelStateFromStatus(P.decodeStatus([1, 0, 1, 0, 0, 0, 0, 0])), 'ERROR', 'T9c. a wire IDLE is a fault, not a ready panel');
    eq(P.panelStateFromStatus(P.decodeStatus([1, 9, 1, 0, 0, 0, 0, 0])), 'ERROR', 'T9d. an out-of-range state is ERROR');
    eq(P.panelStateFromStatus(P.decodeStatus([9, 1, 1, 0, 0, 0, 0, 0])), 'ERROR', 'T9e. a wrong schema is ERROR');
    eq(P.panelStateFromStatus(null), 'ERROR', 'T9f. no status at all is ERROR');
    eq(P.panelStateFromStatus({ valid: true, state: 1 }), 'READY_TO_MEASURE', 'T9g. the vocabulary accepts a decoded object');
}

// -------------------------------------------------------------------------- T10: buttons
{
    const rules = (state, connected = true, busy = false) =>
        P.buttonRules({ connected, state, busy });
    check(rules('MEASURE_READY').newMeasure && rules('MEASURE_READY').download,
        'T10. COMPLETE enables NEW MEASURE and DOWNLOAD');
    check(!rules('READY_TO_MEASURE').newMeasure && !rules('READY_TO_MEASURE').download,
        'T10a. an armed empty capture disables all buttons');
    check(!rules('CAPTURING').newMeasure && !rules('CAPTURING').download,
        'T10b. a capture in progress holds every button');
    check(!rules('ERROR').newMeasure && !rules('ERROR').download,
        'T10c. ERROR holds every button');
    check(!rules('MEASURE_READY', false).download, 'T10d. no adapter means no download');
    check(!rules('MEASURE_READY', true, true).download, 'T10e. a busy panel means no download');
}

// ---------------------------------------------------------------------------- T11: confirm
{
    check(P.needsUndownloadedConfirm({ state: 'MEASURE_READY', generation: 5, lastDownloadedGeneration: 4 }),
        'T11. a COMPLETE capture never downloaded needs confirmation before NEW');
    check(!P.needsUndownloadedConfirm({ state: 'MEASURE_READY', generation: 5, lastDownloadedGeneration: 5 }),
        'T11a. the very generation a download carried away needs no confirmation');
    check(!P.needsUndownloadedConfirm({ state: 'CAPTURING', generation: 5, lastDownloadedGeneration: 4 }),
        'T11b. a capturing panel never asks');
    check(P.needsUndownloadedConfirm({ state: 'MEASURE_READY', generation: 1, lastDownloadedGeneration: null }),
        'T11c. a fresh COMPLETE capture after boot is protected');
}

// ---------------------------------------------------------------------------- T12..T17: export
{
    // Feed one capture: 48 headers + 6 fragments each, built the way the firmware sends them.
    function feedOne(dl, generation, index) {
        const flights = [];
        const fragBytes = (i) => Array.from({ length: 8 }, (_, k) => (i * 16 + k) & 0xFF);
        flights.push(['80010250', Qs1Download.headerBytes(generation, index)]);
        for (let f = 1; f <= P.QS_FRAGMENTS; f++) {
            flights.push(['8001025' + f, fragBytes(f)]);
        }
        flights.forEach(([id, bytes]) => dl.note(id, bytes));
        return flights;
    }

    {
        const dl = new Qs1Download();
        feedOne(dl, 7, 0);
        const rec = Qs1Download.recordFromBlock(dl.blocks[0]);
        eq(dl.blocks.length, 1, 'T12. one complete sample assembles');
        eq(rec.length, P.QS_SAMPLE_BYTES, 'T12a. the assembled record is 44 bytes');
        eq(dl.generation, 7, 'T12b. the generation is learned from the header');
    }
    {
        eq(Qs1Download.headerBytes(7, 0)[0], 1, 'T12c. header schema byte is 1');
        eq(Qs1Download.headerBytes(7, 0)[5], P.QS_FRAGMENTS, 'T12d. header fragment count');
        eq(Qs1Download.headerBytes(7, 0)[6], P.QS_SAMPLES, 'T12e. header totals 48 samples');
    }

    {
        const dl = new Qs1Download();
        let changes = 0;
        for (let i = 0; i < P.QS_SAMPLES; i++) changes += feedOne(dl, 7, i).length;
        check(dl.isComplete(), 'T14. all 48 samples with their fragments make a complete download');
        eq(dl.completeBlocks, 48, 'T14a. complete block count is 48');
        eq(dl.completeIndices().length, 48, 'T14b. all 48 indices are present');
        eq(dl.missingIndices().length, 0, 'T14c. nothing is missing');
        check(!dl.suspect && dl.badHeaders === 0, 'T14d. a clean run is never suspect');
        eq(changes, 48 * 7, 'T14e. every frame produced a change');
    }

    {
        // PAS frames must leave the assembly untouched — this is where the torrent of ride
        // diagnostics would otherwise corrupt a download (T13).
        const dl = new Qs1Download();
        feedOne(dl, 7, 0);
        const before = dl.snapshot();
        ['8001021D', '80010218', '80010216', '80010217', '8001021B', '8001021C'].forEach(id => {
            eq(dl.note(id, [0, 0, 0, 0, 0, 0, 0, 0]), null, `T13. a PAS frame (${id}) is not export data`);
        });
        eq(dl.snapshot().completeBlocks, before.completeBlocks, 'T13a. PAS frames never advance the count');
        eq(dl.blocks.length, 1, 'T13b. the one clean sample is still fully assembled');
        check(!dl.suspect, 'T13c. PAS noise raises no suspicion');
    }

    {
        // A second header before the 6th fragment: the short block is parked, never merged.
        const dl = new Qs1Download();
        for (let i = 0; i < P.QS_SAMPLES; i++) {
            if (i === 0) {
                // sample 0: header + only 3 fragments, then the next header cuts it short
                dl.note('80010250', Qs1Download.headerBytes(7, 0));
                for (let f = 1; f <= 3; f++) dl.note('8001025' + f, Array(8).fill(f));
                continue;
            }
            feedOne(dl, 7, i);
        }
        check(!dl.isComplete(), 'T15. a truncated block means the download is INCOMPLETE');
        eq(dl.completeBlocks, 47, 'T15a. 47 full blocks reach the assembler');
        eq(dl.incomplete.length, 1, 'T15b. one short block is parked, not merged into a later header');
        eq(dl.headers, 48, 'T15c. all 48 headers were counted');
        check(dl.missingIndices().includes(0), 'T15d. sample 0 is the missing one');
        check(!dl.suspect, 'T15e. truncation is incompleteness, not fraud');
    }

    {
        // Two different capture ids in one stream: a rearm raced the download. Even a full 48
        // blocks must then NOT pass as OK — the generation is ambiguous.
        const dl = new Qs1Download();
        for (let i = 0; i < 24; i++) feedOne(dl, 7, i);
        for (let i = 24; i < P.QS_SAMPLES; i++) feedOne(dl, 8, i);
        check(!dl.isComplete(), 'T17. a mixed-generation stream is suspect, never OK');
        check(dl.suspect, 'T17a. the assembler flags the race');
    }

    {
        eq(P.formatDownloadResult({ ok: true, generation: 7, complete: 48 }),
            'Measure 7 — 48/48 — OK', 'T16. the task wording for a full download');
        eq(P.formatDownloadResult({ ok: false, generation: 7, complete: 47 }),
            'Measure 7 — INCOMPLETE — 47/48', 'T16a. the task wording for a short download');
        eq(P.formatDownloadResult({ ok: false, generation: null, complete: 0 }),
            'Measure ? — INCOMPLETE — 0/48', 'T16b. an unknown generation is shown honestly');
    }
}

console.log(failures === 0
    ? 'QS-1 protocol: ALL CHECKS PASSED (T1..T17)'
    : `QS-1 protocol: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);