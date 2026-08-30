// evistdrive/qs1-panel.js — QS-1X MEASURE panel (normal-user) inside the Sniffer tab.
//
// WHAT IT IS. The simple front-end for the QS-1X capture: mode select (START/STOP/RESTART),
// STATUS (polled server-side, QS1_STATUS), NEW MEASURE (WRITE 0x6031) and DOWNLOAD MEASURE
// (WRITE 0x6030 + export reassembly server-side). All protocol traffic happens in qs1x.js;
// this module only renders and forwards button presses, mirroring the FW-126 TEST panel
// pattern (ui/js/evistdrive/fw126-test.js) but as a client of the server service instead of
// a bus tap.
//
// WHAT IT RELIES ON. The server owns the whole protocol (qs1x.js): the STATUS poll cadence,
// the "NEW MEASURE confirmed by a later STATUS showing a new generation AND ARMED" rule, the
// download's 48/48 high-rate + 19/19 tail assembly and the verdicts. This module must never
// conclude success from a button press — it waits for QS1_DOWNLOAD_RESULT / QS1_NEW_CAPTURE_RESULT
// and shows exactly what the server verified.
//
// ENGLISH LABELS. The rest of the Canable UI is consistently English, so the Polish source
// strings map to English equivalents (task QS-1R-C2 §3 allows exactly this).

import { socket, addLog } from '../shared.js';

// The two UI rules below are this panel's own local copy of the button-availability logic,
// kept in sync by hand, exactly the way sniffer.js and can-frame-info.js share the DIAG frame
// layout. This copy only decides cosmetics and the wipe-confirm; the server is the sole
// authority on what a button press does.

// UI state vocabulary — the same tokens qs1x.js sends on QS1_STATUS.
const STATE_LABEL = {
    ARMED: 'UZBROJONY',
    WAITING_QUALIFICATION: 'UZBROJONY — RESTART: oczekiwanie na STOP',
    HIGH_RATE: 'ZAPIS HIGH-RATE',
    TAIL: 'ZAPIS TAIL',
    COMPLETE: 'COMPLETE',
    READY_TO_MEASURE: 'READY TO MEASURE',
    CAPTURING: 'CAPTURING',
    MEASURE_READY: 'MEASURE READY',
    ERROR: 'ERROR',
};

const el = {};
let bound = false;
let lastStatus = null;         // decoded QS1_STATUS payload, or null before the first reply
let busyDownload = false;      // a download is in flight (button lockdown)
let busyNewCapture = false;    // a NEW MEASURE is awaiting its STATUS confirmation
let lastDownloadedGeneration = null; // generation the server <full OK> download delivered

function bind() {
    if (bound) return true;
    el.panel        = document.getElementById('qs1Panel');
    if (!el.panel) return false;
    el.status       = document.getElementById('qs1Status');
    el.measureNo    = document.getElementById('qs1MeasureNo');
    el.samples      = document.getElementById('qs1Samples');
    el.resultLine   = document.getElementById('qs1ResultLine');
    el.errorLine    = document.getElementById('qs1ErrorLine');
    el.newMeasure   = document.getElementById('qs1NewMeasureButton');
    el.download     = document.getElementById('qs1DownloadMeasureButton');
    el.mode         = document.getElementById('qs1Mode');
    el.tail         = document.getElementById('qs1Tail');
    el.qualification = document.getElementById('qs1Qualification');
    bound = true;
    return true;
}

// ---------------------------------------------------------------------------------------
// the four messages the server can push at this panel
// ---------------------------------------------------------------------------------------
export function qs1NoteStatus(raw) {
    if (!bind()) return;
    try { lastStatus = JSON.parse(raw); } catch { lastStatus = null; }
    render();
}

export function qs1NoteNewCaptureResult(raw) {
    if (!bind()) return;
    let r;
    try { r = JSON.parse(raw); } catch { r = null; }
    busyNewCapture = false;
    const line = r ? (r.success ? r.message : `FAILED — ${r.message}`) : 'NEW MEASURE: unknown outcome';
    setResultLine(line, r && !r.success ? 'error' : 'ok');
    // Nothing about the bus side changes the moment the verdict lands — the panel wants the
    // controller's own STATUS (fresh generation + ARMED) on screen as soon as possible.
    if (r && r.success) requestRefresh();
    render();
}

export function qs1NoteDownloadProgress(raw) {
    if (!bind()) return;
    let p;
    try { p = JSON.parse(raw); } catch { p = null; }
    busyDownload = true;
    if (p && el.samples) {
        el.samples.textContent = `${p.complete ?? 0}/${p.total ?? 48}`;
    }
    if (el.status) el.status.textContent = 'DOWNLOADING';
    setButtons();
}

export function qs1NoteDownloadResult(raw) {
    if (!bind()) return;
    let r;
    try { r = JSON.parse(raw); } catch { r = null; }
    busyDownload = false;
    if (r && r.success && Number.isInteger(r.generation)) {
        lastDownloadedGeneration = r.generation;
    }
    const line = r ? r.message || (r.success ? 'OK' : 'FAILED') : 'DOWNLOAD: unknown outcome';
    setResultLine(line, r && !r.success ? 'error' : 'ok');
    if (r) requestRefresh();
    render();
}

// UI rules: which buttons are usable, and when starting NEW must be confirmed (mirrors
    // qs1-protocol.js buttonRules). `busy` covers the panel's own in-flight operations.
function buttonRules(opts) {
    const { connected, state, busy } = opts || {};
    if (!connected || busy) return { newMeasure: false, download: false };
    switch (state) {
        case 'MEASURE_READY':
        case 'COMPLETE':
            return { newMeasure: true, download: true };
        case 'READY_TO_MEASURE':
        case 'ARMED':
        case 'WAITING_QUALIFICATION':
            return { newMeasure: true, download: false };
        default:
            return { newMeasure: false, download: false };
    }
}

// Confirm before wiping a COMPLETE capture that no download has carried away yet (mirrors
// qs1-protocol.js needsUndownloadedConfirm).
function needsUndownloadedConfirm({ state, generation, lastDownloadedGeneration }) {
    return state === 'MEASURE_READY' && generation !== lastDownloadedGeneration;
}

// ---------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------
function setResultLine(text, kind) {
    if (!el.resultLine) return;
    el.resultLine.textContent = text;
    el.resultLine.className = 'font-mono text-sm ' + (kind === 'error'
        ? 'text-red-600' : 'text-green-700');
}

function setStatusLine() {
    if (!el.status) return;
    if (busyDownload) { el.status.textContent = 'DOWNLOADING'; return; }
    if (busyNewCapture) { el.status.textContent = 'ARMING NEW MEASURE…'; return; }
    if (!lastStatus) { el.status.textContent = '—'; return; }
    if (!lastStatus.connected) { el.status.textContent = 'NOT CONNECTED'; return; }
    el.status.textContent = STATE_LABEL[lastStatus.state] || 'ERROR';
}

function setButtons() {
    if (!el.newMeasure || !el.download) return;
    const connected = !!(lastStatus && lastStatus.connected);
    const state = lastStatus ? lastStatus.state : 'ERROR';
    const busy = busyDownload || busyNewCapture;
    const rules = buttonRules({ connected, state, busy });
    el.newMeasure.disabled = !rules.newMeasure;
    el.download.disabled = !rules.download;
}

function render() {
    if (!bind()) return;
    setStatusLine();
    if (el.measureNo) {
        el.measureNo.textContent = (lastStatus && Number.isInteger(lastStatus.generation))
            ? String(lastStatus.generation) : '—';
    }
    if (el.samples && !busyDownload) {
        const samples = (lastStatus && Number.isInteger(lastStatus.high)) ? lastStatus.high : ((lastStatus && Number.isInteger(lastStatus.samples)) ? lastStatus.samples : 0);
        el.samples.textContent = `${samples}/48`;
    }
    if (el.tail) el.tail.textContent = `${(lastStatus && Number.isInteger(lastStatus.tail)) ? lastStatus.tail : 0}/19`;
    if (el.qualification) el.qualification.textContent = lastStatus && lastStatus.mode === 'RESTART' && lastStatus.qualification ? 'RESTART GOTOWY — oczekiwanie na ponowne ruszenie' : '';
    if (el.errorLine) {
        el.errorLine.textContent = (lastStatus && lastStatus.error) ? lastStatus.error : '';
    }
    setButtons();
}

// ---------------------------------------------------------------------------------------
// transmit paths (the only three things this panel may ask of the bus)
// ---------------------------------------------------------------------------------------
function requestRefresh() {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send('QS1_REFRESH');
}

function safeSend(tag, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        setResultLine(`${tag}: not connected — nothing was sent.`, 'error');
        return false;
    }
    socket.send(payload);
    return true;
}

function onNewMeasure() {
    if (busyDownload || busyNewCapture) return;
    if (needsUndownloadedConfirm({
        state: lastStatus && lastStatus.state,
        generation: lastStatus && lastStatus.generation,
        lastDownloadedGeneration,
    })) {
        const g = (lastStatus && Number.isInteger(lastStatus.generation)) ? lastStatus.generation : '?';
        if (!window.confirm('A completed capture (measure ' + g + ' / 48 samples) has not been downloaded yet.\n\nStarting a new measure will erase it permanently. Continue?')) {
            return;
        }
    }
    if (!safeSend('NEW MEASURE', 'QS1_NEW_CAPTURE')) return;
    busyNewCapture = true;
    addLog('TX', 'QS-1: NEW MEASURE requested (WRITE 0x6031, DLC 0).');
    render();
}

function onDownload() {
    if (busyDownload || busyNewCapture) return;
    if (!safeSend('DOWNLOAD MEASURE', 'QS1_DOWNLOAD')) return;
    busyDownload = true;
    setResultLine('Downloading…', 'ok');
    addLog('TX', 'QS-1: DOWNLOAD requested (WRITE 0x6030, DLC 0).');
    render();
}

function onMode() {
    const mode = el.mode && el.mode.value;
    if (!safeSend('TYPE', `QS1_MODE:${mode}`)) return;
    addLog('TX', `QS-1X: selected ${mode} (WRITE 0x6031, DLC 1).`);
    requestRefresh();
}

// ---------------------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------------------
export function initQs1Panel() {
    if (!bind()) return;
    el.newMeasure.disabled = true;
    el.download.disabled = true;
    el.newMeasure.onclick = onNewMeasure;
    el.download.onclick = onDownload;
    if (el.mode) el.mode.onchange = onMode;

    // A normal-user panel must start working without anyone clicking Start Sniffing.
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send('QS1_SUBSCRIBE');
    }

    // Refresh whenever the Sniffer tab (which hosts this panel) is opened, plus right after
    // the tab area first loads — a settled Status line is the whole point of the panel.
    window.addEventListener('app-tab-changed', (event) => {
        const tab = String(event.detail?.tab || '');
        if (tab === 'sniffer') requestRefresh();
    });
    requestRefresh();
    render();
}
