'use strict';

/* Exact QS-1X wire contract, mirrored from firmware qs_transition_dump.c and CAN_Display.c. */
const MODE = Object.freeze({ START: 0, STOP: 1, RESTART: 2 });
const COMMAND = Object.freeze({ status: '85116031', select: '85106031', newCapture: '85106031', download: '85106030' });
const STATUS_ID = '822A6031';
const EXPORT = Object.freeze({ highHeader: '80010250', highFirst: 0x80010251, highLast: 0x80010256, tailHeader: '80010252', tail0: '80010253', tail1: '80010254' });
const HIGH = Object.freeze({ count: 48, bytes: 44, fragments: 6 });
const TAIL = Object.freeze({ count: 19, bytes: 12, fragments: 2, rateHz: 250 });

function modeByte(mode) { return MODE[mode] ?? null; }
const MODE_NAME = Object.freeze(Object.fromEntries(Object.entries(MODE).map(([k, v]) => [v, k])));
function statusToBytes({ state, generation, high, flagByte, mode, tail, trigger }) {
    return [2, state, generation, high, flagByte, mode, tail, trigger];
}
function decodeStatus(d) {
    if (!Array.isArray(d) || d.length !== 8 || d[0] !== 2) return null;
    const f = d[4] & 0xff;
    return { schema: d[0], state: d[1], generation: d[2], highCount: d[3],
        exportReady: !!(f & 1), exportBusy: !!(f & 2), restartQualified: !!(f & 4),
        highComplete: !!(f & 8), tailComplete: !!(f & 16), mode: d[5], modeName: MODE_NAME[d[5]],
        tailCount: d[6], triggerEvents: d[7] };
}
function stateName(s) { return ({ 1: 'ARMED', 2: 'WAITING_QUALIFICATION', 3: 'HIGH_RATE', 4: 'TAIL', 5: 'COMPLETE' })[s] || 'ERROR'; }

// Whether a status proves a full 48/48 + 19/19 capture is sitting on the controller now.
function isComplete(s) { return !!s && s.schema === 2 && s.state === 5 && s.highComplete && s.tailComplete; }

// The host-side panel state derived strictly from a decoded firmware STATUS. This is the
// single renderable state machine; the UI owes nothing to button.disabled.
function panelStateFromStatus(s) {
    if (!s || s.schema !== 2) return 'ERROR';
    if (s.state === 5) return (s.highComplete && s.tailComplete) ? 'COMPLETE' : 'ERROR';
    if (s.state === 4) return 'TAIL';
    if (s.state === 3) return 'HIGH_RATE';
    if (s.state === 2) return 'WAITING_QUALIFICATION';
    if (s.state === 1) return 'ARMED';
    return 'ERROR';
}

class Download {
    constructor(expectedGeneration, expectedMode) { this.expectedGeneration = expectedGeneration; this.expectedMode = expectedMode; this.reset(); }
    reset() { this.generation = null; this.high = []; this.tail = []; this.current = null; this.error = ''; }
    note(id, d) {
        if (!Array.isArray(d)) return false;
        if (id === EXPORT.highHeader) return this._highHeader(d);
        if (this.current && this.current.kind === 'high') return this._highFragment(id, d);
        if (id === EXPORT.tailHeader) return this._tailHeader(d);
        if (this.current && this.current.kind === 'tail') return this._tailFragment(id, d);
        return false;
    }
    _sameGen(g) { if (this.generation === null) this.generation = g; return this.generation === g && (this.expectedGeneration == null || g === this.expectedGeneration); }
    _highHeader(d) {
        if (d[0] !== 1 || d[4] !== HIGH.bytes || d[5] !== HIGH.fragments || d[6] !== HIGH.count || !this._sameGen(d[1])) return this._bad('bad high-rate header');
        this.current = { kind: 'high', index: d[2], fragments: [] }; return true;
    }
    _highFragment(id, d) {
        const n = parseInt(id, 16); if (n < EXPORT.highFirst || n > EXPORT.highLast) return false;
        this.current.fragments.push(d.slice(0, 8));
        if (this.current.fragments.length === HIGH.fragments) { this.high.push(this.current); this.current = null; }
        return true;
    }
    _tailHeader(d) {
        if (this.high.length !== HIGH.count || d[0] !== 2 || d[3] !== TAIL.count || d[4] !== TAIL.bytes || d[5] !== 250 || d[6] !== 0 || !this._sameGen(d[1])) return this._bad('bad tail header');
        this.current = { kind: 'tail', index: d[2], fragments: [] }; return true;
    }
    _tailFragment(id, d) {
        if (id !== EXPORT.tail0 && id !== EXPORT.tail1) return false;
        this.current.fragments.push(d.slice(0, id === EXPORT.tail0 ? 8 : 4));
        if (this.current.fragments.length === TAIL.fragments) { this.tail.push(this.current); this.current = null; }
        return true;
    }
    _bad(e) { this.error = e; return false; }
    complete() { return !this.error && !this.current && this.high.length === HIGH.count && this.tail.length === TAIL.count; }
    snapshot() { return { generation: this.generation, high: this.high.length, tail: this.tail.length, error: this.error, complete: this.complete() }; }
}

module.exports = { MODE, MODE_NAME, COMMAND, STATUS_ID, EXPORT, HIGH, TAIL, modeByte, decodeStatus, stateName, isComplete, panelStateFromStatus, statusToBytes, Download };
