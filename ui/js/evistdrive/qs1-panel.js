// evistdrive/qs1-panel.js — QS-1X MEASURE panel (normal-user) inside the Sniffer tab.
//
// WHAT IT IS. The front-end for the QS-1X capture workflow. All protocol traffic happens in
// qs1x.js on the server; this module renders ONLY from the state the server publishes and
// forwards button presses. The state machine lives server-side (qs1x.js); this module's
// `busy` flags and button.disabled are outputs of that state, never the state machine itself.
//
// WORKFLOW (task QS-1X-C3): SELECT SCENARIO -> NOWY POMIAR -> ARMING -> READY -> CAPTURING /
// WAITING FOR EVENT -> COMPLETE -> DOWNLOAD -> RESULT -> next capture. The service drives the
// whole NEW MEASURE as one transaction (authoritative STATUS -> mode write -> verify -> NEW
// CAPTURE -> post-ACK STATUS). If a COMPLETE capture is undownloaded, the server asks for an
// explicit discard confirm before it will arm a new one; the UI relays that via a confirm
// dialog and the QS1_NEW_CAPTURE_CONFIRM command.

import { socket, addLog } from '../shared.js';

const el = {};
let bound = false;
let lastStatus = null;          // decoded QS1_STATUS payload
let busyNewCapture = false;     // a NEW MEASURE transaction is in flight
let busyDownload = false;       // a download is in flight

// Status line text per (panelState, host). Polish first line, then a host hint.
function statusLabel(st) {
    if (!st) return '—';
    if (!st.connected) return 'BRAK POŁĄCZENIA';
    if (st.error) return 'BŁĄD — ' + st.error;
    switch (st.host) {
        case 'SYNCING': return 'SYNCHRONIZACJA STATUS…';
        case 'MODE_SETTING': return 'UZBRAJANIE — wybór trybu…';
        case 'MODE_CONFIRMED': return 'TRYB POTWIERDZONY';
        case 'REARMING': return 'UZBRAJANIE — NOWY POMIAR…';
        case 'WAIT_ARMED': return 'UZBRAJANIE — czekanie na STATUS…';
        case 'ARMED':
            switch (st.state) {
                case 'ARMED': return 'GOTOWY — RUSZAJ';
                case 'WAITING_QUALIFICATION': return 'GOTOWY — RESTART: czekanie na STOP';
                default: return 'GOTOWY';
            }
        case 'HIGH_RATE': return 'ZAPISYWANIE — HIGH-RATE';
        case 'TAIL': return 'ZAPISYWANIE — TAIL';
        case 'CAPTURING': return 'OCZEKIWANIE NA ZDARZENIE';
        case 'COMPLETE': return 'POMIAR GOTOWY — POBIERZ';
        case 'DOWNLOADING': return 'POBIERANIE…';
        case 'DOWNLOADED': return 'POMIAR POBRANY';
        case 'READY_NEXT': return 'POMIAR POBRANY — MOŻESZ ZACZĄĆ NASTĘPNY';
        case 'ERROR': return 'BŁĄD';
        case 'IDLE': return '—';
        case 'DISCONNECTED': return 'BRAK POŁĄCZENIA';
        default: return st.state || st.host || '—';
    }
}

// Button availability is a pure function of state (an output, not the machine).
function buttonRules(st) {
    if (!st || !st.connected) return { newMeasure: false, download: false, mode: false };
    if (busyNewCapture || busyDownload) return { newMeasure: false, download: false, mode: false };
    const complete = !!st.complete;
    const downloaded = Number.isInteger(st.downloadedGeneration) && st.generation === st.downloadedGeneration;
    const undownloaded = complete && !downloaded;   // a COMPLETE capture not yet carried away by a download
    // Scenario (NEXT mode) cannot change while an undownloaded COMPLETE capture is held, but
    // once it is downloaded the selector unlocks so the user can pick the NEXT scenario.
    const modeEnabled = !undownloaded;
    const downloadAvailable = complete && undownloaded;
    switch (st.host) {
        case 'ARMED':
        case 'HIGH_RATE':
        case 'TAIL':
            return { newMeasure: false, download: false, mode: modeEnabled };
        case 'READY_NEXT':
            // Downloaded capture sitting on the controller: start the NEXT measure (or pick
            // its scenario) without being re-offered the previous download.
            return { newMeasure: true, download: false, mode: true };
        case 'COMPLETE':
            return { newMeasure: true, download: downloadAvailable, mode: modeEnabled };
        case 'MODE_CONFIRMED':
        case 'REARMING':
        case 'WAIT_ARMED':
        case 'MODE_SETTING':
            return { newMeasure: false, download: false, mode: false };
        case 'DISCONNECTED':
            return { newMeasure: false, download: false, mode: false };
        case 'ERROR':
            return { newMeasure: false, download: false, mode: false };
        default:
            return { newMeasure: true, download: downloadAvailable, mode: modeEnabled };
    }
}

function bind() {
    if (bound) return true;
    el.panel       = document.getElementById('qs1Panel');
    if (!el.panel) return false;
    el.status      = document.getElementById('qs1Status');
    el.measureNo   = document.getElementById('qs1MeasureNo');
    el.samples     = document.getElementById('qs1Samples');
    el.resultLine  = document.getElementById('qs1ResultLine');
    el.errorLine   = document.getElementById('qs1ErrorLine');
    el.newMeasure  = document.getElementById('qs1NewMeasureButton');
    el.download    = document.getElementById('qs1DownloadMeasureButton');
    el.mode        = document.getElementById('qs1Mode');
    el.lastMode    = document.getElementById('qs1LastMode');
    el.tail        = document.getElementById('qs1Tail');
    el.qualification = document.getElementById('qs1Qualification');
    bound = true;
    return true;
}

// ---------------------------------------------------------------------------------------
// messages the server pushes
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
    if (r) {
        if (r.needsConfirm) {
            // Server found an undownloaded COMPLETE capture and refuses to silently wipe it.
            const g = Number.isInteger(r.generation) ? r.generation : '?';
            const confirmed = window.confirm(
                'Istnieje gotowy, niepobrany pomiar (generacja ' + g + ', 48/48 + 19/19).\n\n' +
                'Pobierz go (POBIERZ POMIAR) albo potwierdź, że chcesz go odrzucić i rozpocząć nowy.');
            if (confirmed) {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send('QS1_NEW_CAPTURE_CONFIRM');
                    busyNewCapture = true;
                }
            }
            return;
        }
        const line = r.success ? r.message : 'BŁĄD — ' + (r.message || 'nieznany wynik');
        setResultLine(line, r.success ? 'ok' : 'error');
        if (r.success) requestRefresh();
        render();
        return;
    }
    setResultLine('NOWY POMIAR: nieznany wynik', 'error');
    render();
}

export function qs1NoteDownloadProgress(raw) {
    if (!bind()) return;
    let p;
    try { p = JSON.parse(raw); } catch { p = null; }
    busyDownload = true;
    if (p && el.samples) el.samples.textContent = `${p.high ?? 0}/48`;
    if (p && el.tail) el.tail.textContent = `${p.tail ?? 0}/19`;
    if (el.status) el.status.textContent = 'POBIERANIE…';
    setButtons();
}

export function qs1NoteDownloadResult(raw) {
    if (!bind()) return;
    let r;
    try { r = JSON.parse(raw); } catch { r = null; }
    busyDownload = false;
    // The durable downloaded-generation latch lives server-side and is published in every
    // QS1_STATUS payload; the GUI stays dumb and reads it from there.
    const line = r ? (r.success ? r.message : 'BŁĄD — ' + (r.message || 'niekompletny export')) : 'POBIERANIE: nieznany wynik';
    setResultLine(line, r && !r.success ? 'error' : 'ok');
    if (r) requestRefresh();
    render();
}

// ---------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------
function setResultLine(text, kind) {
    if (!el.resultLine) return;
    el.resultLine.textContent = text;
    el.resultLine.className = 'font-mono text-sm ' + (kind === 'error' ? 'text-red-600' : 'text-green-700');
}

function setButtons() {
    if (!el.newMeasure || !el.download) return;
    const rules = buttonRules(lastStatus);
    el.newMeasure.disabled = !rules.newMeasure;
    el.download.disabled = !rules.download;
    if (el.mode) el.mode.disabled = !rules.mode;
}

function render() {
    if (!bind()) return;
    const st = lastStatus;
    if (el.status) {
        if (busyDownload) el.status.textContent = 'POBIERANIE…';
        else el.status.textContent = statusLabel(st);
    }
    if (el.measureNo) {
        const g = (st && st.complete) ? st.generation : (st && st.generation);
        el.measureNo.textContent = Number.isInteger(g) ? String(g) : '—';
    }
    if (el.samples && !busyDownload) {
        el.samples.textContent = `${(st && Number.isInteger(st.high)) ? st.high : 0}/48`;
    }
    if (el.tail && !busyDownload) {
        el.tail.textContent = `${(st && Number.isInteger(st.tail)) ? st.tail : 0}/19`;
    }
    // The <select> is the NEXT-capture scenario (never the finished capture's mode); the
    // finished capture's mode is shown separately as read-only text (qs1LastMode). The two
    // must never overwrite each other.
    if (st && st.nextMode && el.mode && document.activeElement !== el.mode) {
        el.mode.value = st.nextMode;
    }
    if (el.lastMode) {
        el.lastMode.textContent = (st && st.capturedMode) ? st.capturedMode : '—';
    }
    if (el.qualification) {
        el.qualification.textContent = (st && st.fwState === 'WAITING_QUALIFICATION')
            ? 'RESTART GOTOWY — oczekiwanie na ponowne ruszenie' : '';
    }
    if (el.errorLine) {
        el.errorLine.textContent = (st && st.error) ? st.error : '';
    }
    setButtons();
}

// ---------------------------------------------------------------------------------------
// transmit paths
// ---------------------------------------------------------------------------------------
function requestRefresh() {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send('QS1_REFRESH');
}
function safeSend(tag, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        setResultLine(`${tag}: brak połączenia — nic nie wysłano.`, 'error');
        return false;
    }
    socket.send(payload);
    return true;
}

function onNewMeasure() {
    if (busyDownload || busyNewCapture) return;
    if (!safeSend('NOWY POMIAR', 'QS1_NEW_CAPTURE')) return;
    busyNewCapture = true;
    addLog('TX', 'QS-1X: NOWY POMIAR (transakcja 0x6031).');
    render();
}

function onDownload() {
    if (busyDownload || busyNewCapture) return;
    if (!safeSend('POBIERZ POMIAR', 'QS1_DOWNLOAD')) return;
    busyDownload = true;
    addLog('TX', 'QS-1X: POBIERZ POMIAR (WRITE 0x6030, DLC 0).');
    render();
}

function onMode() {
    const mode = el.mode && el.mode.value;
    if (!safeSend('TYP', `QS1_MODE:${mode}`)) return;
    addLog('TX', `QS-1X: wybrano scenariusz ${mode}.`);
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
    if (el.mode) { el.mode.disabled = true; el.mode.onchange = onMode; }

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send('QS1_SUBSCRIBE');
    }

    window.addEventListener('app-tab-changed', (event) => {
        const tab = String(event.detail?.tab || '');
        if (tab === 'sniffer') requestRefresh();
    });
    requestRefresh();
    render();
}
