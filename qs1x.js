'use strict';
const { formatRawCanFrameData } = require('./utils');
const {
    MODE, MODE_NAME, COMMAND, STATUS_ID, HIGH, TAIL,
    modeByte, decodeStatus, stateName, isComplete, panelStateFromStatus, Download,
} = require('./qs1x-protocol');

// Host-side state machine. The UI is rendered from this state, never from button.disabled.
// Every asynchronous step is a named stage with a timeout so no operation can strand the
// panel in a silent pending state (no permanent grey button).
const HOST = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    SYNCING: 'SYNCING',
    IDLE: 'IDLE',
    MODE_SETTING: 'MODE_SETTING',
    MODE_CONFIRMED: 'MODE_CONFIRMED',
    REARMING: 'REARMING',
    WAIT_ARMED: 'WAIT_ARMED',
    ARMED: 'ARMED',
    CAPTURING: 'CAPTURING',
    COMPLETE: 'COMPLETE',
    DOWNLOADING: 'DOWNLOADING',
    DOWNLOADED: 'DOWNLOADED',
    ERROR: 'ERROR',
});

class Qs1Service {
    constructor({ canbus, broadcast }) {
        this.canbus = canbus;
        this.broadcast = broadcast || (() => {});
        this.status = null;            // last decoded firmware STATUS (authoritative)
        this.nextMode = 'START';       // scenario selected for the NEXT capture (user choice)
        this.capturedMode = null;      // mode latched to the current armed/completed capture
        this.capturedGeneration = null;// generation latched at ARMING / COMPLETE
        this.lastDownloadedGeneration = null; // generation fully downloaded
        this.host = HOST.DISCONNECTED;
        this.errorMessage = '';
        this.downloadState = null;
        this.subscribers = 0;

        // --- timing (exposed for tests) ---
        this.pollMs = 2000;
        this.modeAckTimeoutMs = 4000;
        this.newCaptureAckTimeoutMs = 4000;
        this.statusConfirmTimeoutMs = 4000;
        this.downloadAckTimeoutMs = 4000;
        this.stallTimeoutMs = 1500;
        this.stallTickMs = 200;

        this.pollTimer = null;
        this.stallTimer = null;
        this.pending = null;           // active transaction stage {name, timer, ...}

        this._raw = (f) => this._onRaw(f);
        this.canbus.on('raw_frame_received', this._raw);
    }

    // ---------------------------------------------------------------- lifecycle
    addSubscriber() { this.subscribers++; if (this.subscribers === 1) this._startPolling(); this.refreshNow(); }
    removeSubscriber() { this.subscribers = Math.max(0, this.subscribers - 1); if (this.subscribers === 0) this._stopPolling(); }
    cleanup() {
        this._stopPolling();
        this.canbus.removeListener('raw_frame_received', this._raw);
    }
    connected() { return !!(this.canbus.isConnected ? this.canbus.isConnected() : this.canbus.isStarted); }

    // ---------------------------------------------------------------- transmit
    send(id, data = '') {
        if (!this.connected()) return this._fail('CAN not connected');
        return this.canbus.sendRawFrame(id, data || '').catch((e) => this._fail(`write ${id} failed: ${e.message}`));
    }

    // ---------------------------------------------------------------- commands
    refreshNow() {
        if (!this.connected()) { this._setHost(HOST.DISCONNECTED, 'CAN not connected'); this._publish(); return; }
        this._setHost(HOST.SYNCING, '');
        this.send(COMMAND.status);
    }

    // User selected a scenario for the NEXT capture. This never relabels an existing
    // completed capture; capturedMode stays latched until the next capture is armed.
    selectMode(name) {
        const b = modeByte(name);
        if (b === null) return this._fail('invalid QS mode');
        // Never let scenario selection relabel an existing, undownloaded COMPLETE capture.
        if (this.status && isComplete(this.status) && this.status.generation !== this.lastDownloadedGeneration) {
            return this._fail('Cannot change scenario while a COMPLETE capture is undownloaded — download or discard it first.');
        }
        if (this.pending) return this._fail('a transaction is running — wait for it to finish.');
        this.nextMode = name;
        this._publish();
        return b;
    }

    // Full NEW MEASURE transaction (STEP A -> F), without an explicit discard confirmation.
    // If the firmware holds an undownloaded COMPLETE capture, this refuses and asks the UI
    // to confirm a discard; the confirmed variant performs the transaction.
    newCapture() {
        if (!this.connected()) return this._fail('CAN not connected');
        if (this.pending) return; // an earlier transaction still owns the bus
        if (!this.status || this.status.schema !== 2) return this._fail('no valid STATUS yet — cannot arm');
        if (isComplete(this.status) && this.status.generation !== this.lastDownloadedGeneration) {
            this._setHost(HOST.COMPLETE, 'undownloaded capture');
            this._broadcastResult('QS1_NEW_CAPTURE_RESULT', {
                success: false, needsConfirm: true,
                generation: this.status.generation, mode: this.capturedMode || this.status.modeName,
                message: 'A completed capture is waiting to be downloaded. Download it, or confirm that you want to discard it and start a new one.',
            });
            return;
        }
        this._runTransaction();
    }

    // User explicitly confirmed discarding the undownloaded capture. Same transaction.
    newCaptureConfirmed() {
        if (this.pending) return;
        this._runTransaction();
    }

    download() {
        if (!this.connected()) return this._fail('CAN not connected');
        if (this.pending) return this._fail('a transaction is running — wait for it to finish');
        if (!this.status || !isComplete(this.status)) {
            return this._broadcastResult('QS1_DOWNLOAD_RESULT', {
                success: false, message: 'DOWNLOAD requires a COMPLETE (48/48 + 19/19) capture.',
            });
        }
        this._setHost(HOST.DOWNLOADING, '');
        this.downloadState = new Download(this.status.generation, this.status.mode);
        this._startStage('downloadAck', () => this._finishDownload(false, 'no ACK to DOWNLOAD 0x6030 within ' + (this.downloadAckTimeoutMs / 1000) + ' s.'));
        this._broadcastProgress({ state: 'waiting', generation: this.status.generation, high: 0, tail: 0 });
        this.send(COMMAND.download);
    }

    // ------------------------------------------------------------------ the transaction
    _runTransaction() {
        const gen = this.status ? this.status.generation : null;
        this._setHost(HOST.IDLE, 'arming');
        this._tx = {
            demanding: this.nextMode,          // requested mode for the new capture (STEP C/D)
            prevGeneration: gen,
            newGeneration: null,
        };
        this._stepA_status();
    }

    // STEP A — authoritative STATUS (also gives us a baseline and a fresh generation).
    _stepA_status() {
        this._setHost(HOST.SYNCING, 'STEP A — STATUS 0x6031');
        this._startStage('stepA', () => this._failTx('STATUS 0x6031 nie odpowiedział (STEP A).'));
        this.send(COMMAND.status);
    }

    _stepB_check() {
        // After STEP A status we know the true firmware generation. Nothing else to gate on
        // here for the normal path — the discard gate was handled at newCapture() entry.
        this._stepC_mode();
    }

    // STEP C — write the requested mode (WRITE 0x6031 DLC1 0x/1/2).
    _stepC_mode() {
        const b = modeByte(this._tx.demanding);
        if (b === null) return this._failTx('unknown mode ' + this._tx.demanding);
        this._setHost(HOST.MODE_SETTING, 'STEP C — WRITE tryb ' + this._tx.demanding);
        this._startStage('modeAck', () => this._failTx('Brak potwierdzenia wyboru trybu (STEP C).'));
        this.send(COMMAND.select, b.toString(16).padStart(2, '0'));
        this._tx.modeReq = true;
    }

    // DLC0 ACK to the mode write: confirm the mode with a fresh STATUS read (STEP D).
    _onModeAck() {
        if (!this._tx) return;
        if (this.pending && this.pending.name !== 'modeAck') return;
        this._clearStage();
        this._setHost(HOST.MODE_SETTING, 'STEP D — weryfikacja trybu');
        this._startStage('stepD', () => this._failTx('Tryb nie został potwierdzony przez STATUS (STEP D).'));
        this.send(COMMAND.status);
    }

    // A STATUS reply to (or after) the mode write is ALSO a mode confirmation (STEP D).
    // Some controller builds answer a WRITE with a STATUS instead of a separate ACK.
    _confirmMode(status) {
        if (!this._tx) return;
        if (status.mode === modeByte(this._tx.demanding)) {
            this._clearStage();
            this._tx.modeOk = true;
            this._setHost(HOST.MODE_CONFIRMED, 'STEP D — tryb ' + this._tx.demanding + ' potwierdzony');
            this._stepE_capture();
            return true;
        }
        return false;
    }

    // STEP E — NEW CAPTURE (WRITE 0x6031 DLC0), then wait for the DLC0 ACK.
    _stepE_capture() {
        this._setHost(HOST.REARMING, 'STEP E — NEW CAPTURE 0x6031');
        this._startStage('newCaptureAck', () => this._failTx('Brak potwierdzenia NEW CAPTURE (STEP E).'));
        this.send(COMMAND.newCapture, '');
    }

    _onNewCaptureAck() {
        if (!this._tx) return;
        if (this.pending && this.pending.name !== 'newCaptureAck') return; // stray ACK for a different write
        this._clearStage();
        this._postAckStatus();
    }

    // STEP F — mandatory post-ACK STATUS: do not leave the UI waiting passively.
    _postAckStatus() {
        this._setHost(HOST.WAIT_ARMED, 'STEP F — STATUS po NEW CAPTURE');
        this._startStage('stepF', () => {
            this._failTx('Firmware potwierdził NEW CAPTURE, ale nie potwierdził stanu ARMED (STEP F).');
        });
        this.send(COMMAND.status);
    }

    _confirmArmed(status) {
        // Post-ACK STATUS validation (STEP F): valid schema, generation advanced,
        // recorder in a valid waiting state, mode matches, counters reset.
        const tx = this._tx;
        const okSchema = status.schema === 2;
        const genAdvanced = tx && status.generation > tx.prevGeneration;
        const waitingState = status.state === 1 || status.state === 2; // ARMED / WAITING_QUALIFICATION
        const modeOk = status.mode === modeByte(tx.demanding);
        const reset = status.highCount === 0 && status.tailCount === 0;
        if (!(okSchema && genAdvanced && waitingState && modeOk && reset)) {
            return this._failTx('STATUS po NEW CAPTURE nie potwierdził ARMED (schema=' + status.schema +
                ', generacja ' + (tx ? tx.prevGeneration : '?') + '→' + status.generation +
                ', tryb ' + (status.modeName || status.mode) + ', high=' + status.highCount + ', tail=' + status.tailCount + ').');
        }
        this._clearTxStage();
        // Latch captured mode + generation at ARMED.
        this.capturedMode = tx.demanding;
        this.capturedGeneration = status.generation;
        this.lastDownloadedGeneration = null;
        this._tx = null;
        this._setHost(HOST.ARMED, '');
        this._publish();
        this._broadcastResult('QS1_NEW_CAPTURE_RESULT', {
            success: true, generation: status.generation, mode: this.capturedMode,
            message: 'NOWY POMIAR gotowy — ARMED (generacja ' + status.generation + ', tryb ' + this.capturedMode + ').',
        });
    }

    _failTx(message) {
        const tx = this._tx;
        this._tx = null;
        this._clearStage();
        this._setHost(HOST.ERROR, message);
        this._publish();
        this._broadcastResult('QS1_NEW_CAPTURE_RESULT', { success: false, generation: tx ? tx.newGeneration : null, message });
    }

    // ---------------------------------------------------------------- raw intake
    _onRaw(raw) {
        try { this._onRawFrame(raw); } catch (e) { console.error('[QS-1X] frame handler failed:', e); }
    }

    _onRawFrame(raw) {
        const { idHex, dataHex, dlc } = formatRawCanFrameData(raw);
        if (idHex === 'INVALID') return;
        const d = String(dataHex).trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));

        if (idHex === STATUS_ID) {
            if (dlc === 8) this._onStatus(d);
            else this._onWriteAck(); // DLC 0 NORMAL_ACK for a WRITE 0x6031
            return;
        }
        if (this.downloadState) this._onDownloadFrame(idHex, d);
    }

    _onWriteAck() {
        // DLC 0 on 0x822A6031 is the NORMAL_ACK to whichever WRITE 0x6031 we just sent.
        if (!this.pending) return;
        if (this.pending.name === 'modeAck') this._onModeAck();
        else if (this.pending.name === 'newCaptureAck') this._onNewCaptureAck();
        // download / other ACKs are handled by their own paths.
    }

    _onStatus(d) {
        const s = decodeStatus(d);
        if (!s) return;
        this.status = s;
        this._publish();

        const stage = this.pending ? this.pending.name : null;

        if (!stage) {
            // No transaction in flight: derive and render from firmware state (poll path,
            // reconnect path, post-download path). A COMPLETE capture surfaces automatically.
            this._reflectStatus(s);
            if (isComplete(s) && this.lastDownloadedGeneration !== s.generation) {
                if (this.capturedGeneration !== s.generation || this.capturedMode === null) {
                    this.capturedGeneration = s.generation;
                    this.capturedMode = s.modeName;
                }
            }
            if (!isComplete(s) && (s.state === 1 || s.state === 2)
                && (this.capturedGeneration === null || this.capturedGeneration === s.generation)) {
                this.capturedMode = s.modeName || this.nextMode;
            }
            this._publish(); // host changed by _reflectStatus — emit the updated state
            return;
        }

        switch (stage) {
            case 'stepA':
                // Baseline STATUS: capture the current generation, then move to mode select.
                this._tx.newGeneration = s.generation;
                this._clearStage();
                this._stepB_check();
                break;
            case 'modeAck':
                // A STATUS here is a spontaneous confirmation of the mode WRITE (STEP D).
                this._confirmMode(s);
                break;
            case 'stepD':
                // The verify STATUS read answered: the mode MUST match now.
                if (!this._confirmMode(s)) {
                    this._failTx('MODE NOT CONFIRMED — controller reports ' +
                        ((s.modeName) || s.mode) + ' instead of ' + this._tx.demanding);
                }
                break;
            case 'newCaptureAck':
                // A STATUS here is a spontaneous post-capture reply — treat it as the
                // post-ACK STATUS (STEP F).
                this._clearStage();
                this._confirmArmed(s);
                break;
            case 'stepF':
                // The post-ACK STATUS read answered: confirm ARMED (STEP F).
                this._confirmArmed(s);
                break;
            default:
                break; // other stages do not accept a STATUS as progress
        }
    }

    _reflectStatus(s) {
        if (!s) return;
        if (isComplete(s) && s.generation !== this.lastDownloadedGeneration) this._setHost(HOST.COMPLETE, '');
        else if (s.state === 5) this._setHost(HOST.COMPLETE, isComplete(s) ? '' : 'COMPLETE — incomplete data');
        else if (s.state === 4) this._setHost(HOST.TAIL, '');
        else if (s.state === 3) this._setHost(HOST.HIGH_RATE, '');
        else if (s.state === 2) this._setHost(HOST.WAITING_QUALIFICATION, '');
        else if (s.state === 1) { this._setHost(HOST.ARMED, ''); this.capturedMode = this.capturedMode || this.nextMode; }
        else this._setHost(HOST.ERROR, stateName(s.state));
    }

    // ---------------------------------------------------------------- download
    _onDownloadFrame(idHex, d) {
        if (!this.pending) return; // stray export not ours
        if (this.pending.name !== 'downloadAck' && this.pending.name !== 'downloading') return;

        // WRITE 0x6030 NORMAL_ACK (DLC 0) tells us the controller accepted the request.
        if (idHex === '822A6030') {
            this._clearStage();
            this._startStage('downloading', () => this._finishDownload(false, 'download stalled in the controller.'));
            return;
        }

        // Any further frame (an export header/fragment, or a late status) means the export
        // is rolling — refresh the stall window on activity.
        if (this.pending.name === 'downloading' && this.downloadState) {
            const change = this.downloadState.note(idHex, d);
            if (change) {
                const x = this.downloadState.snapshot();
                this._startStage('downloading', () => this._finishDownload(false, 'download stalled (' + x.high + '/' + HIGH.count + ' high, ' + x.tail + '/' + TAIL.count + ' tail).'));
                this._broadcastProgress({ state: 'downloading', generation: x.generation, high: x.high, tail: x.tail });
                if (x.complete) this._finishDownload(true);
            }
        }
    }

    _finishDownload(ok, message) {
        this._clearStage();
        const x = this.downloadState ? this.downloadState.snapshot() : { generation: this.status && this.status.generation, high: 0, tail: 0 };
        const gen = Number.isInteger(x.generation) ? x.generation : (this.status ? this.status.generation : null);
        if (ok) {
            this.lastDownloadedGeneration = gen;
            this._setHost(HOST.DOWNLOADED, '');
        } else {
            this._setHost(HOST.ERROR, message || 'download incomplete.');
        }
        this._broadcastResult('QS1_DOWNLOAD_RESULT', {
            success: ok, generation: gen, high: x.high, tail: x.tail,
            message: ok
                ? ('POMIAR POBRANY — Tryb: ' + (this.capturedMode || (this.status && this.status.modeName) || '?') +
                    ', Generacja: ' + gen + ', High-rate: ' + HIGH.count + '/' + HIGH.count + ' OK, Tail: ' + TAIL.count + '/' + TAIL.count + ' OK, MOE metadata: OK')
                : (message || 'incomplete download'),
        });
        this.downloadState = null;
        // Refresh STATUS after the transfer so the panel reflects post-export world.
        this.refreshNow();
    }

    // ---------------------------------------------------------------- stages / timers
    _startStage(name, onTimeout) {
        this._clearStage();
        this.pending = { name, onTimeout };
        this.pending.timer = setTimeout(() => {
            if (!this.pending || this.pending.name !== name) return;
            this.pending = null;
            onTimeout();
        }, this._timeoutFor(name));
    }
    _timeoutFor(name) {
        switch (name) {
            case 'modeAck': return this.modeAckTimeoutMs;
            case 'newCaptureAck': return this.newCaptureAckTimeoutMs;
            case 'stepA': case 'stepF': return this.statusConfirmTimeoutMs;
            case 'downloadAck': return this.downloadAckTimeoutMs;
            default: return this.stallTimeoutMs;
        }
    }
    _clearStage() { if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; } }
    _clearTxStage() { this._clearStage(); }

    // ---------------------------------------------------------------- polling
    _startPolling() { if (this.pollTimer) return; this.pollTimer = setInterval(() => this._pollTick(), this.pollMs); }
    _stopPolling() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        this._clearStage();
        this._abortDownload();
    }
    _pollTick() {
        if (!this.connected()) { this._setHost(HOST.DISCONNECTED, 'CAN not connected'); this._publish(); return; }
        // While a transaction or download owns the bus, the poll must not compete.
        if (this.pending || this.downloadState) return;
        this.send(COMMAND.status);
    }
    _abortDownload() {
        if (this.downloadState && this.pending) { this._clearStage(); this.downloadState = null; }
    }

    // ---------------------------------------------------------------- publish
    _setHost(host, error) { this.host = host; if (error !== undefined) this.errorMessage = error; }
    _fail(message) { this._setHost(HOST.ERROR, message); this._publish(); return Promise.resolve(false); }

    _publish() {
        const s = this.status;
        const complete = isComplete(s);
        const shownGen = this.capturedGeneration !== null ? this.capturedGeneration : (s ? s.generation : null);
        const shownMode = this.capturedMode !== null ? this.capturedMode : (s ? s.modeName : null);
        this.broadcast('QS1_STATUS:' + JSON.stringify({
            connected: this.connected(),
            host: this.host,
            state: panelStateFromStatus(s),
            fwState: s ? stateName(s.state) : null,
            nextMode: this.nextMode,
            capturedMode: shownMode,
            generation: shownGen,
            fwGeneration: s ? s.generation : null,
            high: s ? s.highCount : 0,
            tail: s ? s.tailCount : 0,
            highComplete: s ? s.highComplete : false,
            tailComplete: s ? s.tailComplete : false,
            complete,
            mode: shownMode,
            error: this.errorMessage || '',
        }));
    }

    _broadcastResult(kind, obj) { this.broadcast(kind + ':' + JSON.stringify(obj)); }
    _broadcastProgress(p) { this.broadcast('QS1_DOWNLOAD_PROGRESS:' + JSON.stringify(p)); }
}

module.exports = { Qs1Service, MODE, HIGH, TAIL, HOST };
