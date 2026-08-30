'use strict';
const { formatRawCanFrameData } = require('./utils');
const { MODE, COMMAND, STATUS_ID, HIGH, TAIL, modeByte, decodeStatus, stateName, Download } = require('./qs1x-protocol');

class Qs1Service {
    constructor({ canbus, broadcast }) { this.canbus = canbus; this.broadcast = broadcast || (() => {}); this.status = null; this.mode = 'START'; this.downloadState = null; this.subscribers = 0; this._raw = f => this._onRaw(f); canbus.on('raw_frame_received', this._raw); }
    addSubscriber() { this.subscribers++; this.refreshNow(); }
    removeSubscriber() { this.subscribers = Math.max(0, this.subscribers - 1); }
    cleanup() { this.canbus.removeListener('raw_frame_received', this._raw); }
    connected() { return !!(this.canbus.isConnected ? this.canbus.isConnected() : this.canbus.isStarted); }
    send(id, data = '') { if (!this.connected()) return this._error('CAN not connected'); return this.canbus.sendRawFrame(id, data).catch(e => this._error(e.message)); }
    refreshNow() { if (this.connected()) this.send(COMMAND.status); else this._publish({ error: 'CAN not connected' }); }
    selectMode(name) { const b = modeByte(name); if (b === null) return this._error('invalid QS mode'); this.mode = name; this.send(COMMAND.select, b.toString(16).padStart(2, '0')); this.refreshNow(); }
    newCapture() { this.send(COMMAND.newCapture); }
    download() {
        if (!this.status || this.status.state !== 5 || !this.status.highComplete || !this.status.tailComplete) return this._downloadResult(false, 'DOWNLOAD requires COMPLETE high-rate and tail capture');
        this.downloadState = new Download(this.status.generation, this.status.mode); this.send(COMMAND.download);
    }
    _onRaw(raw) {
        const { idHex, dataHex, dlc } = formatRawCanFrameData(raw); const d = String(dataHex).trim().split(/\s+/).filter(Boolean).map(x => parseInt(x, 16));
        if (idHex === STATUS_ID && dlc === 8) { const s = decodeStatus(d); if (s) { this.status = s; this._publish(); } return; }
        if (!this.downloadState) return;
        if (this.downloadState.note(idHex, d)) { const x = this.downloadState.snapshot(); this.broadcast('QS1_DOWNLOAD_PROGRESS:' + JSON.stringify(x)); if (x.complete) this._downloadResult(true); }
    }
    _publish(extra = {}) { const s = this.status; this.broadcast('QS1_STATUS:' + JSON.stringify({ connected: this.connected(), mode: this.mode, firmwareMode: s ? s.mode : null, generation: s ? s.generation : null, state: s ? stateName(s.state) : 'ERROR', qualification: s ? s.restartQualified : false, high: s ? s.highCount : 0, tail: s ? s.tailCount : 0, highComplete: s ? s.highComplete : false, tailComplete: s ? s.tailComplete : false, complete: !!(s && s.state === 5 && s.highComplete && s.tailComplete), error: extra.error || '' })); }
    _downloadResult(ok, message) { const x = this.downloadState ? this.downloadState.snapshot() : { generation: this.status && this.status.generation, high: 0, tail: 0 }; this.broadcast('QS1_DOWNLOAD_RESULT:' + JSON.stringify({ success: ok, generation: x.generation, mode: this.mode, high: x.high, tail: x.tail, message: message || (ok ? `Generation ${x.generation}: 48/48 high-rate + 19/19 tail — OK` : x.error) })); this.downloadState = null; }
    _error(error) { this._publish({ error }); }
}
module.exports = { Qs1Service, MODE, HIGH, TAIL };
