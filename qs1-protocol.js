// qs1-protocol.js — QS-1R capture protocol, fingerprint-pinned to the DIAG build
//                       (firmware commit 7232f9d, eVD 0.0413). No Bafang FW changes.
//
// Pure protocol knowledge for the QS-1 MEASURE panel: the on-wire command frames, the
// 0x822A6031 status reply layout, the state vocabulary, the download assembler that turns
// the 0x80010250..0x80010256 export stream back into 48 records, and the UI rules that
// derive from it. It imports nothing from the app and never touches the DOM or a socket, so
// every fact here is testable head-on in Node (tests/qs1_protocol.js, T1..T17).
//
// Everything is pinned to the firmware source at the DIAG build:
//   src/CAN_Display.c      READ/WRITE 0x6030, READ/WRITE 0x6031, send_qs_transition_status,
//                          sendWriteResult (NORMAL_ACK op 2 / ERROR_ACK op 3, DLC 0)
//   src/qs_transition_diag.c  48 samples, generation starts at 1 and grows on rearm
//   src/qs_transition_dump.c  header 0x10250 + 6 fragments 0x10251..0x10256 per sample
//
// ID notation: every id is the 8-hex CANable string for an extended (EFF) frame, i.e. the
// same string the sniffer writes to its raw log ("80010250" == can_id 0x80010250).

'use strict';

// --- the three commands this panel may ever put on the bus -------------------------------
// operation 0 = WRITE, operation 1 = READ; source 5 (CANable/BESST) -> target 2 (controller).
const QS_COMMANDS = Object.freeze({
    // READ 0x6031, DLC 0 -> the controller answers 0x822A6031 DLC 8 (see STATUS_REPLY_ID).
    readStatus: '85116031',
    // WRITE 0x6031, DLC 0 -> re-arm / NEW MEASURE. Accepted only when the capture is COMPLETE
    // (the ISR actually clears the ring; completion is confirmed via STATUS, see qs1.js).
    newCapture: '85106031',
    // WRITE 0x6030, DLC 0 -> request the export replay (existing capture download).
    download: '85106030',
});

// --- the one reply family that carries live capture state ---------------------------------
// 0x022A6031 = command 0x6031, operation 2 (NORMAL_ACK), target 5, source 2.
// DLC 8 = READ 0x6031 STATUS reply (layout below). DLC 0 = WRITE 0x6031 NORMAL_ACK.
const STATUS_REPLY_ID = '822A6031';

// WRITE 0x6031 rejected (op 3 / ERROR_ACK): capture not COMPLETE, or the export is busy.
const NEW_CAPTURE_REJECTED_ID = '822B6031';
// WRITE 0x6030 results — DLC 0 either way (NORMAL_ACK op 2 / ERROR_ACK op 3).
const DOWNLOAD_ACK_ID = '822A6030';
const DOWNLOAD_REJECTED_ID = '822B6030';

// --- the export stream family (0x80010250 = header, 0x80010251..56 = fragments) -----------
const QS_EXPORT_ID_LO = 0x80010250;
const QS_EXPORT_ID_HI = 0x80010256;

function isQ1ExportId(idHex) {
    const n = parseInt(idHex, 16);
    if (!Number.isInteger(n)) return false;
    return n >= QS_EXPORT_ID_LO && n <= QS_EXPORT_ID_HI;
}

// --- the PAS diagnostic family (NOT QS — never counts, never advances anything) -----------
// Firmware broadcast frames that happen to live in the same 0x1021x area. They are
// ride-session diagnostics, unrelated to the QS-1 capture; a host that mistakes one for QS
// export data corrupts the 48-record assembly. Rejected at the door (T13).
const PAS_DIAG_IDS = new Set([
    '8001021D', '80010218', '80010216', '80010217', '8001021B', '8001021C',
]);
function isPasDiagId(idHex) {
    return PAS_DIAG_IDS.has(idHex);
}

// --- capture geometry (src/qs_transition_diag.h) ------------------------------------------
const QS_SAMPLES = 48;         // fixed ring depth
const QS_SAMPLE_BYTES = 44;    // sizeof(qs_transition_sample_t), the per-record payload
const QS_FRAGMENTS = 6;        // 44 B spread over 6 CAN DATA frames (8 B each; last holds 4)

// --- the wire state vocabulary (qs_transition_diag.h's state enum) ------------------------
const QS_STATES = Object.freeze({
    IDLE: 0,        // intra-firmware only: the status fn maps every non-active state to >= ARMED,
    ARMED: 1,       //   so wire carries 1, 2 or 3 in practice.
    TRIGGERED: 2,
    COMPLETE: 3,
});

// ------------------------------------------------------------------------------------------
// status reply decode (send_qs_transition_status: d[0..7])
// ------------------------------------------------------------------------------------------
function decodeStatus(bytes) {
    if (!Array.isArray(bytes) || bytes.length !== 8) return null;
    const d = bytes;
    const schema = d[0];
    const rawState = d[1];
    const generation = d[2];
    const sampleCount = d[3];
    const flags = d[4] & 0xFF;
    return {
        schema,
        state: rawState,
        generation,
        sampleCount,
        exportReady: !!(flags & 0x01),
        exportBusy: !!(flags & 0x02),
        flags,
        triggerEvents: d[5],
        triggerIndex: d[6],
        valid: schema === 1,
    };
}

const STATE_NAME = { 0: 'idle', 1: 'armed', 2: 'triggered', 3: 'complete' };
const PANEL_STATE_NAME = {
    // no 'idle': the status fn never emits 0 on the wire, so a 0 out here is a fault.
    armed: 'READY_TO_MEASURE',
    triggered: 'CAPTURING',
    complete: 'MEASURE_READY',
};

// The panel's four displayed states, mapped exactly as the task specifies:
//   ARMED    -> GOTOWY DO POMIARU / READY TO MEASURE
//   TRIGGERED -> ZAPISYWANIE / CAPTURING
//   COMPLETE  -> POMIAR GOTOWY / MEASURE READY
//   anything else (IDLE on the wire, out-of-range, schema mismatch) -> BŁĄD / ERROR
function panelStateFromStatus(status) {
    if (!status || !status.valid) return 'ERROR';
    const name = STATE_NAME[status.state];
    if (!name) return 'ERROR';
    return PANEL_STATE_NAME[name] || 'ERROR';
}

// ------------------------------------------------------------------------------------------
// UI rules: which buttons are usable, and when starting NEW must be confirmed.
//
// States here are the STATUS-driven ones ("READY_TO_MEASURE" / "CAPTURING" / "MEASURE_READY" /
// "ERROR"). `busy` covers the panel's own in-flight operations (download running, NEW MEASURE
// awaiting its STATUS confirmation) — while either is pending every button is inert.
function buttonRules(opts) {
    const { connected, state, busy } = opts || {};
    if (!connected || busy) return { newMeasure: false, download: false };
    switch (state) {
        case 'MEASURE_READY':
            // A complete capture can be re-armed (subject to the undownloaded confirmation)
            // and it is the only state in which a download may even be asked for.
            return { newMeasure: true, download: true };
        case 'READY_TO_MEASURE':
            // Armed and empty: there is nothing to download, and nothing to re-arm.
            return { newMeasure: false, download: false };
        default:
            // CAPTURING, ERROR, unknown: hold everything.
            return { newMeasure: false, download: false };
    }
}

// Do we have to ask before wiping a capture that exists right now but that no download has
// carried off yet? Tracked against the current status: confirmation is needed whenever the
// capture is COMPLETE and its generation differs from the last one fully downloaded. A fresh
// COMPLETE capture (power-on, or a NEW MEASURE that captured) is therefore protected by
// default, and a successful download of this very generation clears the need.
function needsUndownloadedConfirm({ state, generation, lastDownloadedGeneration }) {
    return state === 'MEASURE_READY' && generation !== lastDownloadedGeneration;
}

// ------------------------------------------------------------------------------------------
// export stream assembler (qs_transition_dump.c's frame layout)
// ------------------------------------------------------------------------------------------
//
// One sample costs one header + six fragments, strictly in order:
//   header 0x80010250  data = [1, capture_id, index, trigger_index, 44, 6, 48, 0]
//   frag  0x80010251   bytes 0..7 of the 44-byte record
//   frag  0x80010252   bytes 8..15  ...  frag 0x80010256  bytes 40..43 (+4 padded)
class Qs1Download {
    constructor() {
        this.reset();
    }

    reset() {
        this.headers = 0;            // samples whose header was seen
        this.completeBlocks = 0;     // samples with header + all 6 fragments
        this.blocks = [];            // COMPLETE blocks, for index accounting + record assembly
        this.incomplete = [];        // blocks cut short by the next header (never reached 6 frags)
        this.current = null;         // block currently being assembled
        this.generation = null;      // capture_id from the first valid header
        this.badHeaders = 0;         // headers that contradicted the geometry
        this.suspect = false;        // set once anything inconsistent is seen
    }

    // Builds the exact wire bytes for a header of sample `index` of `generation`.
    static headerBytes(generation, index) {
        return [QS_GEOMETRY_SCHEMA, generation, index, 0, QS_SAMPLE_BYTES, QS_FRAGMENTS, QS_SAMPLES, 0];
    }

    // Feed one download frame. idHex is the 8-hex string ('80010250'..), bytes its data.
    // Returns the change this frame caused (or null for a non-export frame).
    note(idHex, bytes) {
        if (!isQ1ExportId(idHex)) return null;
        const change = { header: false, fragment: false, blockComplete: false, progress: this.completeBlocks };
        const n = parseInt(idHex, 16);

        if (n === QS_EXPORT_ID_LO) {
            change.header = true;
            this.headers++;
            if (this.current) {
                // A fresh header while a block is still open means that block ended short of
                // its 6th fragment. It keeps its header (headers++) but can never become a
                // complete block; it is parked so a later header cannot join it either.
                this.incomplete.push(this.current);
                this.current = null;
            }
            this._openHeader(bytes);
        } else {
            const frag = n - QS_EXPORT_ID_LO; // 1..6
            if (!this.current) return change; // orphan fragment: cannot be placed, ignored
            change.fragment = true;
            this.current.fragments.push({
                index: frag,
                bytes: (Array.isArray(bytes) ? bytes : []).slice(0, 8),
            });
            if (this.current.fragments.length === QS_FRAGMENTS) {
                this.current.complete = true;
                change.blockComplete = true;
                this.completeBlocks++;
                this.blocks.push(this.current);
                this.current = null;
            }
        }
        change.progress = this.completeBlocks;
        return change;
    }

    // Validate a header against the fixed geometry. A header that contradicts the protocol
    // (wrong schema, wrong record size, wrong fragment count, wrong total) is accepted as a
    // sample boundary but counted as bad — the final verdict refuses to claim 48/48 over it.
    _openHeader(bytes) {
        const d = Array.isArray(bytes) && bytes.length >= 8 ? bytes : [];
        const bad = d[0] !== QS_GEOMETRY_SCHEMA
            || d[4] !== QS_SAMPLE_BYTES
            || d[5] !== QS_FRAGMENTS
            || d[6] !== QS_SAMPLES;
        if (bad) {
            this.badHeaders++;
            this.suspect = true;
        }
        const index = d[2];
        this.current = {
            index,
            captureId: d[1],
            triggerIndex: d[3],
            fragments: [],
            complete: false,
            good: !bad,
        };
        if (this.generation === null) {
            this.generation = d[1];
        } else if (d[1] !== this.generation) {
            this.suspect = true; // a second capture appeared mid-download — possibly a rearm raced us
        }
    }

    // Assembles the 44-byte record from a complete block (fragments 1..6, 8 bytes each).
    static recordFromBlock(block) {
        const out = [];
        for (const f of block.fragments) {
            const src = f.bytes || [];
            for (let i = 0; i < src.length && out.length < QS_SAMPLE_BYTES; i++) out.push(src[i]);
        }
        return out;
    }

    // --- report helpers ---------------------------------------------------------------
    isComplete() {
        return this.completeBlocks === QS_SAMPLES
            && !this.suspect
            && this.headers >= QS_SAMPLES
            && this._allIndicesSeenOnce();
    }

    _allIndicesSeenOnce() {
        if (this.completeBlocks !== QS_SAMPLES) return false;
        const seen = new Set();
        for (const b of this.blocks) {
            if (!Number.isInteger(b.index) || seen.has(b.index)) return false;
            seen.add(b.index);
        }
        return seen.size === QS_SAMPLES;
    }

    // The per-sample indices that made it through (ordered 0..47 for the report).
    completeIndices() {
        return this.blocks.map((b) => b.index).sort((a, b) => a - b);
    }

    missingIndices() {
        const present = new Set(this.completeIndices());
        const out = [];
        for (let i = 0; i < QS_SAMPLES; i++) if (!present.has(i)) out.push(i);
        return out;
    }

    snapshot() {
        return {
            generation: this.generation,
            headers: this.headers,
            completeBlocks: this.completeBlocks,
            totalSamples: QS_SAMPLES,
            badHeaders: this.badHeaders,
            incomplete: this.incomplete.length,
            suspect: this.suspect,
            missing: this.missingIndices(),
        };
    }
}

// The fixed constants Qs1Download.headerBytes closes over (kept out of the class body so the
// geometry and the validator share the same source).
const QS_GEOMETRY_SCHEMA = 1;

// ------------------------------------------------------------------------------------------
// result wording — exactly the verdict strings the task specifies:
//   SUCCESS: "Measure N — 48/48 — OK"
//   FAILURE: "Measure N — INCOMPLETE — x/48"
// ------------------------------------------------------------------------------------------
function formatDownloadResult({ ok, generation, complete }) {
    const g = Number.isInteger(generation) ? generation : '?';
    if (ok) return `Measure ${g} — ${complete}/${QS_SAMPLES} — OK`;
    return `Measure ${g} — INCOMPLETE — ${complete}/${QS_SAMPLES}`;
}

module.exports = {
    QS_COMMANDS,
    STATUS_REPLY_ID,
    NEW_CAPTURE_REJECTED_ID,
    DOWNLOAD_ACK_ID,
    DOWNLOAD_REJECTED_ID,
    QS_EXPORT_ID_LO,
    QS_EXPORT_ID_HI,
    QS_SAMPLES,
    QS_SAMPLE_BYTES,
    QS_FRAGMENTS,
    QS_STATES,
    isQ1ExportId,
    isPasDiagId,
    decodeStatus,
    panelStateFromStatus,
    buttonRules,
    needsUndownloadedConfirm,
    Qs1Download,
    formatDownloadResult,
};