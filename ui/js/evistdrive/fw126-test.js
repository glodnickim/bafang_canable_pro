// evistdrive/fw126-test.js — FW-126 TEST panel (read-only) inside the Sniffer tab.
//
// WHAT IT IS. A passive reader for the two measurements FW-126 needs off a real bike:
//   1. the CH3 trigger-edge sweep, broadcast in the DIAG aggregate block 0x10240..0x10246;
//   2. the phase-current calibration report 0x602D, which the controller sends only when asked.
//
// WHAT IT IS NOT. It is not a transmitter. The only frame this module can ever put on the bus
// is the single read below - no data, no other id, no interval, no write path. There is
// deliberately no code here that takes an id or a payload from the user.
//
// The panel is an ADDITION to the sniffer, never a replacement: frames reach it through a tap
// that sits beside the RAW file write (sniffer.js _forwardFw126Frame), so the full raw log is
// still captured exactly as before and the visual filters/presets are untouched in both
// directions - they cannot starve this panel, and this panel cannot change what they show.
//
// DECODING IS A PORT, NOT A REWRITE. Every layout, threshold and verdict rule below mirrors
// the two decoders already verified against known-answer synthetic logs:
//   tools/decode_fw126_ch3.ps1        (CH3 sweep, schema 7 - HISTORICAL logs only)
//   tools/decode_fw126_cal_dump.ps1   (0x602D, FW-126.7 schema 2)
// The 0x602D layout is defined once in BAFANG_GD32F303RCT6/protocol/fw1267_cal_schema.json and
// pinned by tests/fw1267_cal_parity.js, which runs BOTH decoders on the same bytes.
import { socket, addLog } from '../shared.js';
import {
    createCapture, buildReport,
} from './fw126-decode.js';

// --- the one frame this module may transmit ---------------------------------------------
// source 5 (Canable) -> target 2 (controller), operation 1 (READ), command 0x602D.
// Sent as "<id>#" so canbus.sendFrame() builds it with CAN_EFF_FLAG set and can_dlc = 0.
// The firmware accepts it only in the DIAG image, only as a read, only from source 5
// (src/CAN_Display.c:940) and it touches no bank - it is a report, not a setting.
const READ_CAL_FRAME   = '0511602D#';
const CAL_REPLY_TIMEOUT_MS = 4000;

// The decode/verdict half lives in fw126-decode.js so it can be tested head-on; this file
// owns the panel, the buttons and the single transmit path.

// ---------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------
const capture = createCapture();     // all frame intake and decoding lives in fw126-decode.js
const state = {
    calPending: false,   // a read has gone out and its reply has not landed yet
    calTimer: null,
    pendingFinal: false, // "Get FW-126 Result" is waiting for the dump
};

const el = {};
function bind() {
    if (el.bound) return true;
    el.panel      = document.getElementById('fw126Panel');
    if (!el.panel) return false;
    el.status     = document.getElementById('fw126Status');
    el.out        = document.getElementById('fw126Output');
    el.readCal    = document.getElementById('fw126ReadCalButton');
    el.getResult  = document.getElementById('fw126GetResultButton');
    el.copy       = document.getElementById('fw126CopyReportButton');
    el.clear      = document.getElementById('fw126ClearButton');
    el.bound = true;
    return true;
}

// ---------------------------------------------------------------------------------------
// frame intake — called for every tapped frame, whatever the view filters say
// ---------------------------------------------------------------------------------------
export function fw126NoteFrame(raw) {
    if (!bind()) return;
    const parts = String(raw).split('|');
    if (parts.length < 2) return;
    const result = capture.note(parts[0].trim(), parts[2] !== undefined ? parts[2] : '');
    if (result.calComplete) {
        // The reply landed (well or badly): stop the timeout and give the buttons back.
        clearCalTimer();
        state.calPending = false;
        state.pendingFinal = false;
        setButtonsBusy(false);
    }
    if (result.changed) render();
}

// ---------------------------------------------------------------------------------------
// the one transmit path
// ---------------------------------------------------------------------------------------
function clearCalTimer() { if (state.calTimer) { clearTimeout(state.calTimer); state.calTimer = null; } }
function setButtonsBusy(busy) {
    if (!el.bound) return;
    if (el.readCal) el.readCal.disabled = busy;
    if (el.getResult) el.getResult.disabled = busy;
}

function requestCalDump(frame = READ_CAL_FRAME) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        capture.calError = 'not connected - the panel never queues a frame it cannot send';
        render();
        return false;
    }
    capture.calError = null;
    state.calPending = true;
    capture.calTransfer = null;
    setButtonsBusy(true);
    socket.send(frame);
    addLog('TX', 'FW-126: read-only request ' + frame.replace('#','') + ' (DLC 0)');
    clearCalTimer();
    state.calTimer = setTimeout(() => {
        state.calPending = false;
        state.pendingFinal = false;
        setButtonsBusy(false);
        capture.calError = 'no complete 0x602D reply within ' + (CAL_REPLY_TIMEOUT_MS / 1000) +
            ' s. Is the DIAG image running? The NORMAL image does not answer 0x602D.';
        render();
    }, CAL_REPLY_TIMEOUT_MS);
    render();
    return true;
}

// ---------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------
function line(out, text, cls) {
    const div = document.createElement('div');
    div.classList.add('log-entry');
    const span = document.createElement('span');
    span.classList.add('log-data');
    // Split first: classList.add() throws InvalidCharacterError on a token containing a space,
    // and these highlight classes are two-token ('log-prefix tx').
    if (cls) cls.split(/\s+/).filter(Boolean).forEach(c => span.classList.add(c));
    span.textContent = text;
    div.appendChild(span);
    out.appendChild(div);
}

function render() {
    if (!bind()) return;
    const blocks = capture.completeBlocks();
    if (el.status) {
        const bits = [`aggregate frames: ${capture.aggSeen}`, `complete blocks: ${blocks.length}`];
        if (state.calPending) bits.push('waiting for 0x602D reply…');
        else if (capture.cal) bits.push(`0x602D: ${capture.cal.pass ? 'PASS' : 'FAIL'}`);
        else if (capture.calError) bits.push('0x602D: not read');
        el.status.textContent = bits.join('   |   ');
    }
    if (!el.out) return;
    el.out.innerHTML = '';
    buildReport(capture.snapshot()).forEach(t => {
        const cls = /VERDICT\s*:\s*(PASS|UP|DOWN)/.test(t) ? 'log-prefix tx'
            : /VERDICT|FAIL|STOP CONDITIONS|MISMATCH|NO DATA/.test(t) ? 'log-prefix error'
            : null;
        line(el.out, t, cls);
    });
}

// ---------------------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------------------
export function initFw126Panel() {
    if (!bind()) return;
    el.readCal.onclick = () => { state.pendingFinal = false; requestCalDump(READ_CAL_FRAME); };
    el.getResult.onclick = () => {
        // One button for the whole answer: the CH3 half is already in hand (it arrives by
        // itself with each session summary), so this only has to fetch the dump and re-render
        // once the complete reply lands.
        state.pendingFinal = true;
        if (!requestCalDump()) state.pendingFinal = false;
        render();
    };
    el.copy.onclick = async () => {
        const text = buildReport(capture.snapshot()).join('\n');
        try {
            await navigator.clipboard.writeText(text);
            addLog('INFO', 'FW-126 report copied to the clipboard.');
        } catch {
            // Clipboard can be refused (permissions, insecure context). Never lose the report
            // over it - select it instead so Ctrl+C still works.
            const range = document.createRange();
            range.selectNodeContents(el.out);
            const sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
            addLog('ERR', 'Clipboard refused - the report is selected, press Ctrl+C.');
        }
    };
    el.clear.onclick = () => {
        capture.reset();
        state.pendingFinal = false;
        clearCalTimer(); state.calPending = false; setButtonsBusy(false);
        render();
    };
    render();
}
