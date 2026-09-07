// qs1.js — the QS-1R server-side service behind the QS-1 MEASURE panel (ui/js/evistdrive/qs1-panel.js).
//
// WHAT IT IS. A single process-wide service that talks to the DIAG firmware (pinned build
// 7232f9d) over the CANable bus: it polls the 0x6031 STATUS reply, drives WRITE 0x6031
// (NEW MEASURE) and WRITE 0x6030 (DOWNLOAD), and reassembles the 0x80010250..0x80010256
// export stream into the 48 records of one capture. It listens to canbus.raw_frame_received
// directly — NOT through the sniffer — so the panel works without Start Sniffing, and it never
// filters or drops anything: the raw log keeps every frame it always kept (see sniffer.js).
//
// VERDICTS, NOT HOPE. A NEW MEASURE is never reported as OK just because the CAN write went
// out: success requires a later STATUS showing a NEW generation AND state ARMED (the ISR owns
// the ring clear, so only the firmware's own reply may confirm it). A DOWNLOAD is OK only when
// the assembler holds all 48 complete records. Everything else is a FAILURE with a reason.
//
// Frame IDs and reply layouts are pinned in qs1-protocol.js; the pure decode/assemble half
// lives there and is exercised head-on by tests/qs1_protocol.js (T1..T17). This file owns the
// bus, the timers and the broadcast — driven end-to-end by tests/qs1_service.js (T18).

'use strict';

const { formatRawCanFrameData } = require('./utils');
const {
    QS_COMMANDS,
    STATUS_REPLY_ID,
    NEW_CAPTURE_REJECTED_ID,
    DOWNLOAD_ACK_ID,
    DOWNLOAD_REJECTED_ID,
    QS_SAMPLES,
    QS_STATES,
    isQ1ExportId,
    isPasDiagId,
    decodeStatus,
    panelStateFromStatus,
    Qs1Download,
    formatDownloadResult,
} = require('./qs1-protocol');

const STATE_NAME = { [QS_STATES.IDLE]: 'idle', [QS_STATES.ARMED]: 'armed',
    [QS_STATES.TRIGGERED]: 'triggered', [QS_STATES.COMPLETE]: 'complete' };

class Qs1Service {
    /**
     * @param {object} opts
     * @param {object} opts.canbus    CanBusService singleton (on/emit/sendRawFrame/isConnected).
     * @param {function(string):void} [opts.broadcast]  one line to every client, or a no-op.
     */
    constructor({ canbus, broadcast }) {
        this.canbus = canbus;
        this.broadcast = broadcast || (() => {});

        // Timing, exposed so tests (and a future user) can tune them without touching code.
        this.pollMs = 2000;              // STATUS poll cadence (slow / non-invasive on the bus)
        this.confirmTimeoutMs = 4000;    // how long a NEW MEASURE may stay unconfirmed
        this.firstFrameTimeoutMs = 8000; // first export header must appear inside this
        this.stallTimeoutMs = 2500;      // silence between export frames -> incomplete
        this.stallTickMs = 250;          // how often the download watchdog looks
        this.postTransferRefreshMs = 300;// quiet beat before the STATUS refresh after a transfer

        this.subCount = 0;               // browsers watching the panel right now
        this.pollTimer = null;
        this.stallTimer = null;

        this.lastStatus = null;          // decoded 0x822A6031 DLC 8, or null before the first
        this.lastStatusAt = null;
        this.lastDownloadedGeneration = null; // generation fully carried away by a download

        this._pendingNewCapture = null;  // { prevGeneration, timer } while a re-arm is unconfirmed
        this._download = null;           // { assembler, startedAt, lastFrameAt, generation }

        this._onRaw = (rawFrame) => {
            try { this._onRawFrame(rawFrame); } catch (err) {
                console.error('[QS-1] raw frame handler failed:', err);
            }
        };
        this.canbus.on('raw_frame_received', this._onRaw);
    }

    // ------------------------------------------------------------------ lifecycle / publish
    addSubscriber() {
        this.subCount += 1;
        if (this.subCount === 1) this._startPolling();
        this.refreshNow();
    }

    removeSubscriber() {
        this.subCount = Math.max(0, this.subCount - 1);
        if (this.subCount === 0) this._stopPolling();
    }

    _startPolling() {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this._pollTick(), this.pollMs);
    }

    _stopPolling() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        this._abortNewCapture();
        this._abortDownload('cleanup');
    }

    _isConnected() {
        return !!(this.canbus && typeof this.canbus.isConnected === 'function'
            ? this.canbus.isConnected() : this.canbus.isStarted);
    }

    _pushStatus(extra = {}) {
        const s = this.lastStatus;
        this.broadcast('QS1_STATUS:' + JSON.stringify({
            connected: this._isConnected(),
            wireState: s ? (STATE_NAME[s.state] || 'invalid') : null,
            state: panelStateFromStatus(s),
            generation: s ? s.generation : null,
            samples: s ? s.sampleCount : null,
            exportReady: s ? s.exportReady : false,
            exportBusy: s ? s.exportBusy : false,
            triggerEvents: s ? s.triggerEvents : null,
            triggerIndex: s ? s.triggerIndex : null,
            error: extra.error || '',
            lastReceivedAt: this.lastStatusAt,
        }));
    }

    // --------------------------------------------------------- commands (from the browser)
    refreshNow() {
        if (!this._isConnected()) {
            this._pushStatus({ error: 'CAN not connected — waiting for the adapter.' });
            return;
        }
        this._sendStatusRequest();
    }

    newCapture() {
        if (this._download) return this._failNewCapture('a download is running; wait for it to finish.');
        if (this._pendingNewCapture) return; // already on it
        if (!this.lastStatus || !this.lastStatus.valid || this.lastStatus.state !== QS_STATES.COMPLETE) {
            return this._failNewCapture('NEW MEASURE requires a COMPLETE capture — the button is disabled otherwise.');
        }
        const prevGeneration = this.lastStatus.generation;
        this._pendingNewCapture = {
            prevGeneration,
            timer: setTimeout(() => this._failNewCapture(
                `no STATUS confirmed a new generation within ${this.confirmTimeoutMs / 1000} s.`), this.confirmTimeoutMs),
        };
        this._sendWrite(QS_COMMANDS.newCapture);
    }

    download() {
        if (this._download) return;
        if (this._pendingNewCapture) return this._failDownload('a NEW MEASURE is still being confirmed.');
        if (!this.lastStatus || !this.lastStatus.valid || this.lastStatus.state !== QS_STATES.COMPLETE) {
            return this._failDownload('DOWNLOAD requires a COMPLETE capture — the button is disabled otherwise.');
        }
        this._download = {
            assembler: new Qs1Download(),
            generation: this.lastStatus.generation,
            startedAt: Date.now(),
            lastFrameAt: Date.now(),
        };
        this._broadcastProgress({ state: 'waiting', generation: this._download.generation, complete: 0 });
        this._startStallWatch();
        this._sendWrite(QS_COMMANDS.download);
    }

    // ----------------------------------------------------------------- bus transmit helper
    _sendWrite(idHex) {
        if (!this._isConnected()) {
            this._failWrite(idHex);
            return;
        }
        this.canbus.sendRawFrame(idHex, '').catch((err) => this._failWrite(idHex, err));
    }

    _failWrite(idHex, err) {
        const message = `write ${idHex} could not be sent${err ? `: ${err.message}` : ' — CAN not connected'}.`;
        if (idHex === QS_COMMANDS.newCapture) this._failNewCapture(message);
        else if (idHex === QS_COMMANDS.download) this._failDownload(message);
        else this._pushStatus({ error: message });
    }

    _sendStatusRequest() {
        if (!this._isConnected()) return;
        this.canbus.sendRawFrame(QS_COMMANDS.readStatus, '').catch((err) => {
            // A refused probe tells us nothing about the layout; the next poll retries.
            // Only surface it when nothing has ever been heard, so a single lost read does
            // not paint an ERROR over a panel that is working.
            if (!this.lastStatus) this._pushStatus({ error: `status read failed: ${err.message}` });
        });
    }

    // ------------------------------------------------------------- raw frame intake / tap
    _onRawFrame(rawFrame) {
        const { idHex, dataHex, dlc } = formatRawCanFrameData(rawFrame);
        if (idHex === 'INVALID') return;

        // THE PAS GATE: ride-session diagnostics are not QS data (T13). Before anything else.
        if (isPasDiagId(idHex)) return;

        if (idHex === STATUS_REPLY_ID) {
            if (dlc === 8) this._onStatusRx(dataHex);
            else this._onNewCaptureAckRx(); // DLC 0 NORMAL_ACK for WRITE 0x6031
            return;
        }
        if (idHex === NEW_CAPTURE_REJECTED_ID) {
            this._failNewCapture('NEW MEASURE rejected — the capture is not COMPLETE or an export is running.');
            return;
        }
        if (idHex === DOWNLOAD_ACK_ID) return;          // export request accepted; frames follow
        if (idHex === DOWNLOAD_REJECTED_ID) {
            this._failDownload('DOWNLOAD refused by the controller — no COMPLETE capture, or an export is already running.');
            return;
        }
        if (isQ1ExportId(idHex)) this._onExportRx(idHex, dataHex);
    }

    _bytesFromHex(dataHex) {
        return String(dataHex).trim().split(/\s+/)
            .filter((s) => s)
            .map((s) => parseInt(s, 16))
            .filter((b) => Number.isInteger(b));
    }

    // 0x822A6031 DLC 8 — the STATUS reply.
    _onStatusRx(dataHex) {
        const status = decodeStatus(this._bytesFromHex(dataHex));
        if (!status) return;
        this.lastStatus = status;
        this.lastStatusAt = Date.now();
        this._pushStatus();
        this._confirmPendingNewCapture(status);
    }

    _confirmPendingNewCapture(status) {
        const pending = this._pendingNewCapture;
        if (!pending) return;
        if (status.generation !== pending.prevGeneration
            && panelStateFromStatus(status) === 'READY_TO_MEASURE') {
            this.lastDownloadedGeneration = null; // the old capture is gone; nothing is "downloaded"
            this._succeedNewCapture(status.generation);
        }
    }

    _onNewCaptureAckRx() {
        // Fast hint that the WRITE was accepted; the verdict still waits on STATUS
        // (generation changed AND ARMED). Nothing to do here — the phone line is open.
    }

    _succeedNewCapture(generation) {
        const pending = this._pendingNewCapture;
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pendingNewCapture = null;
        const message = pending.prevGeneration === null
            ? `NEW MEASURE armed (generation ${generation}).`
            : `NEW MEASURE armed — generation ${pending.prevGeneration} -> ${generation}.`;
        this.broadcast('QS1_NEW_CAPTURE_RESULT:' + JSON.stringify({ success: true, generation, message }));
    }

    _failNewCapture(message) {
        if (!this._pendingNewCapture) {
            // A failure already broadcast for a finished attempt must not double-fire from a
            // stray late frame; only a live attempt (or a precondition error at the moment the
            // user asks) gets a result message.
            if (message.indexOf('NEW MEASURE requires') === 0 || message.indexOf('a download is running') === 0) {
                this.broadcast('QS1_NEW_CAPTURE_RESULT:' + JSON.stringify({ success: false, generation: null, message }));
            }
            return;
        }
        const pending = this._pendingNewCapture;
        this._pendingNewCapture = null;
        clearTimeout(pending.timer);
        this.broadcast('QS1_NEW_CAPTURE_RESULT:' + JSON.stringify({ success: false, generation: null, message }));
    }

    // ------------------------------------------------------------------ export (download)
    _onExportRx(idHex, dataHex) {
        if (!this._download) return; // a stray export is not ours to assemble
        const dl = this._download;
        dl.lastFrameAt = Date.now();
        const change = dl.assembler.note(idHex, this._bytesFromHex(dataHex));
        if (!change) return;
        if (change.blockComplete) {
            this._broadcastProgress({ state: 'receiving', generation: dl.assembler.generation ?? dl.generation, complete: change.progress });
        }
        if (dl.assembler.isComplete()) this._finishDownload(true);
    }

    _startStallWatch() {
        if (this.stallTimer) clearInterval(this.stallTimer);
        this.stallTimer = setInterval(() => {
            const dl = this._download;
            if (!dl) return;
            const now = Date.now();
            const idle = now - dl.lastFrameAt;
            const firstPending = dl.assembler.headers === 0 && (now - dl.startedAt) > this.firstFrameTimeoutMs;
            const stalled = dl.assembler.headers > 0 && !dl.assembler.isComplete() && idle > this.stallTimeoutMs;
            if (firstPending) {
                this._failDownload(
                    `export never started — no 0x80010250 header within ${this.firstFrameTimeoutMs / 1000} s. Is the bike parked and powered?`);
            } else if (stalled) {
                this._failDownload(`export stalled — no frame for ${this.stallTimeoutMs / 1000} s (${dl.assembler.completeBlocks}/${QS_SAMPLES} records).`);
            }
        }, this.stallTickMs);
    }

    _broadcastProgress(p) {
        this.broadcast('QS1_DOWNLOAD_PROGRESS:' + JSON.stringify({
            state: p.state,
            generation: Number.isInteger(p.generation) ? p.generation : null,
            complete: p.complete,
            total: QS_SAMPLES,
        }));
    }

    _finishDownload(ok) {
        const dl = this._download;
        if (!dl) return;
        const snap = dl.assembler.snapshot();
        const result = {
            success: ok,
            generation: snap.generation ?? dl.generation,
            got: snap.completeBlocks,
            total: QS_SAMPLES,
            incomplete: !ok,
            snapshot: snap,
        };
        result.message = formatDownloadResult({ ok, generation: result.generation, complete: result.got });
        if (ok) this.lastDownloadedGeneration = result.generation;
        this.broadcast('QS1_DOWNLOAD_RESULT:' + JSON.stringify(result));
        this._teardownDownload('done');
    }

    _failDownload(message) {
        if (!this._download) {
            if (message.indexOf('DOWNLOAD requires') === 0
                || message.indexOf('a NEW MEASURE is still being confirmed.') === 0) {
                this.broadcast('QS1_DOWNLOAD_RESULT:' + JSON.stringify({ success: false, message }));
            }
            return;
        }
        const dl = this._download;
        const snap = dl.assembler.snapshot();
        const result = {
            success: false,
            generation: snap.generation ?? dl.generation,
            got: snap.completeBlocks,
            total: QS_SAMPLES,
            incomplete: true,
            message,
        };
        this.broadcast('QS1_DOWNLOAD_RESULT:' + JSON.stringify(result));
        this._teardownDownload('failed');
    }

    _abortDownload(reason) {
        if (this._download) this._failDownload(`download stopped (${reason}).`);
    }

    _teardownDownload() {
        if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null; }
        this._download = null;
        // The export machine needs a moment to go quiet again; then fetch a fresh STATUS so the
        // panel reflects the post-transfer world (bit1 export-busy cleared, same generation).
        setTimeout(() => this.refreshNow(), this.postTransferRefreshMs);
    }

    _abortNewCapture() {
        if (this._pendingNewCapture) {
            clearTimeout(this._pendingNewCapture.timer);
            this._pendingNewCapture = null;
        }
    }

    // ----------------------------------------------------------------------------- teardown
    cleanup() {
        this._stopPolling();
        this.canbus.removeListener('raw_frame_received', this._onRaw);
    }

    _pollTick() {
        if (!this._isConnected()) {
            // Keep the panel honest while the bus is dark — one quiet line, no frames sent.
            this._pushStatus({ error: 'CAN not connected — waiting for the adapter.' });
            return;
        }
        // No STATUS requests while a download run owns the bus (they would only compete for
        // bandwidth with the 336-frame export and are answered out of order anyway).
        if (this._download) return;
        this._sendStatusRequest();
    }
}

module.exports = { Qs1Service };