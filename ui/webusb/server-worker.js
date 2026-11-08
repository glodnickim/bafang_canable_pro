// The server side of the browser (WebUSB) version, in a dedicated worker.
//
// server.js and the modules it uses run here unchanged through node-shim.js, and the
// CANable is reached over WebUSB from this thread. In the Node build the server is a
// separate process; running it on the page's own thread instead meant that anything
// blocking the UI - a confirm() dialog before a save, a heavy chart redraw - also
// stopped the USB reads. The adapter then filled up with bus traffic and dropped the
// first frames sent after the dialog closed: the opening frame of a parameter write,
// so the controller acknowledged the rest but kept the old values. A worker keeps
// reading whatever the UI thread is doing, as the Node process did.
//
// boot.js talks to this worker with messages carrying the same strings the UI and
// server exchange over a WebSocket in the Node build.
/* global NodeShim, importScripts */
'use strict';

importScripts('node-shim.js');

const MODULES = [
    'server.js', 'canbus.js', 'gsusb.js', 'canframe.js', 'bafang-parser.js', 'bafang-serializer.js',
    'request-manager.js', 'bafang-can-requests.js', 'bafang-constants.js',
    'bafang-can-read-commands.js', 'bafang-can-write-commands.js', 'bafang-can-broadcast-commands.js',
    'fw-updater.js', 'sniffer.js', 'logger.js', 'utils.js',
    'qs1x.js', 'qs1x-protocol.js', 'stop-trace.js', 'stop-trace-protocol.js',
];

// Ride mode (boot.js starts this worker with ?listen=1): the adapter is opened
// listen-only, so it puts nothing on the bus, not even the CAN-level acknowledgement.
const LISTEN_ONLY = new URLSearchParams(self.location.search).get('listen') === '1';
if (LISTEN_ONLY) process.env.CAN_LISTEN_ONLY = '1';
// Same list as GSUSBConstants.GS_USB_DEVICES.
const USB_FILTERS = [
    { vendorId: 0x1D50, productId: 0x606F },
    { vendorId: 0x1209, productId: 0x606F },
    { vendorId: 0x1CD2, productId: 0x606F },
    { vendorId: 0x16D0, productId: 0x10B8 },
];
const isAdapter = (d) => USB_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);

const started = new Date();

// Everything the server side prints (sent frames, ACK timeouts, connect errors) is
// kept as a session log, so a test away from a developer console can be sent over.
// Session logs go to the browser's private file system when it has one (node-shim.js),
// so they are not capped: a whole ride is kept.
const consoleLines = NodeShim.logs.open('logs/console.log');
for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        original(...args);
        const text = args.map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return `${a.name}: ${a.message}`;
            try { return JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch (e) { return String(a); }
        }).join(' ');
        consoleLines.push(`${new Date().toISOString().slice(11, 23)} ${level === 'log' || level === 'info' ? '' : level.toUpperCase() + ' '}${text}`);
    };
}

// --- 'ws', 'http', 'child_process' for server.js --------------------------------
let wsServer = null;
const sockets = new Map(); // bridge id -> ServerSocket

// The server's end of one bridged connection (one UI page).
class ServerSocket {
    constructor(id) {
        this.id = id;
        this.readyState = 1;
        this.handlers = {};
        // server.js attaches its 'message' handler only after an awaited presence
        // check; over a real socket anything sent before that is lost. Hold it instead.
        this.early = [];
    }
    on(event, fn) {
        (this.handlers[event] = this.handlers[event] || []).push(fn);
        if (event === 'message' && this.early.length) this.early.splice(0).forEach((m) => this.receive(m));
        return this;
    }
    receive(message) {
        const fns = this.handlers.message;
        if (!fns || !fns.length) { this.early.push(message); return; }
        for (const fn of fns) fn(message);
    }
    send(message) { postMessage({ type: 'msg', id: this.id, data: String(message) }); }
    terminate() {}
    close() {}
}
class WsServer {
    constructor() { this.handlers = { connection: [] }; wsServer = this; }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    close(cb) { if (cb) cb(); }
}
NodeShim.registerBuiltin('ws', { Server: WsServer, OPEN: 1 });
NodeShim.registerBuiltin('http', {
    createServer: () => ({
        listen(port, ...rest) { const cb = rest.find((a) => typeof a === 'function'); if (cb) setTimeout(cb, 0); return this; },
        on() { return this; },
        once() { return this; },
        close(cb) { if (cb) cb(); },
    }),
});
NodeShim.registerBuiltin('child_process', { exec() {} });

// --- adapters -------------------------------------------------------------------
// The chooser runs on the page (it needs a user gesture); an adapter allowed there is
// visible here through getDevices().
async function refreshDevices() {
    const list = (await navigator.usb.getDevices()).filter(isAdapter);
    NodeShim.setDevices(list);
    postMessage({ type: 'devices', count: list.length });
    // Tell the UI now rather than at server.js's next 3 s presence poll.
    for (const s of sockets.values()) s.receive('GET_CAN_INTERFACE_STATUS');
}

// Every frame the adapter confirms it put on the bus (its echo: the real bus order of
// what we sent) and every frame received, with a timestamp. This is the full capture:
// no ID filter and no merging of repeated frames.
let canbus = null;
const traffic = { rx: 0, tx: 0, lastRxAt: 0 };
function traceCanTraffic(canbus) {
    const lines = NodeShim.logs.open('logs/can-trace.log');
    lines.push(`# CAN trace, started ${started.toISOString()} (local ${started.toString()})`);
    lines.push(`# columns: seconds since start, RX/TX, 29-bit ID (hex), [DLC], data bytes${LISTEN_ONLY ? '; adapter listen-only' : ''}`);
    const t0 = performance.now();
    const add = (dir, f) => {
        if (!f || !f.data) return;
        const n = Math.min(f.can_dlc || 0, 8), bytes = [];
        for (let i = 0; i < n && i < f.data.byteLength; i++) bytes.push(f.data.getUint8(i).toString(16).toUpperCase().padStart(2, '0'));
        const id = ((f.can_id >>> 0) & 0x1FFFFFFF).toString(16).toUpperCase().padStart(8, '0');
        lines.push(`${((performance.now() - t0) / 1000).toFixed(4)} ${dir} ${id} [${n}] ${bytes.join(' ')}`);
        if (dir === 'RX') { traffic.rx++; traffic.lastRxAt = Date.now(); } else traffic.tx++;
    };
    canbus.on('raw_frame_sent', (f) => add('TX', f));
    canbus.on('raw_frame_received', (f) => add('RX', f));
    canbus.on('can_status', (connected, message) => {
        lines.push(`# ${new Date().toISOString()} t=${((performance.now() - t0) / 1000).toFixed(4)} adapter ${connected ? 'connected' : 'disconnected'}: ${message || ''}`);
    });
}

// For the ride-mode banner: frames so far, bytes stored, and whether storage works.
async function postStats() {
    const status = NodeShim.logs.status();
    let bytes = 0;
    for (const f of NodeShim.logFiles.values()) bytes += f.bytes + f.queuedChars;
    postMessage({ type: 'stats', ...traffic, bytes, ...status, listenOnly: LISTEN_ONLY, since: started.getTime() });
}

// --- messages from the page -----------------------------------------------------
onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
    case 'open': {
        const s = new ServerSocket(m.id);
        sockets.set(m.id, s);
        for (const fn of wsServer.handlers.connection) fn(s);
        break;
    }
    case 'msg':
        if (sockets.has(m.id)) sockets.get(m.id).receive(m.data);
        break;
    case 'close':
        sockets.delete(m.id);
        break;
    case 'refresh':
        refreshDevices();
        break;
    case 'note':
        console.log('[webusb] ' + m.text);
        break;
    case 'listLogs':
        NodeShim.logs.list().then(
            (sessions) => postMessage({ type: 'logs', sessions, status: NodeShim.logs.status() }),
            (err) => postMessage({ type: 'logs', sessions: [], status: { ...NodeShim.logs.status(), error: err.message } }));
        break;
    case 'getLog':
        NodeShim.logs.read(m.session, m.name).then(
            (blob) => postMessage({ type: 'log', session: m.session, name: m.name, share: !!m.share, batch: m.batch, blob }),
            (err) => postMessage({ type: 'logError', batch: m.batch, message: err.message }));
        break;
    case 'deleteSession':
        NodeShim.logs.removeSession(m.session).then(
            () => postLogList(),
            (err) => postMessage({ type: 'logError', message: err.message }));
        break;
    case 'flush':
        NodeShim.logs.flush().then(() => postMessage({ type: 'flushed' }));
        break;
    case 'release':
        releaseAdapter();
        break;
    case 'stats':
        postStats();
        break;
    }
};

function postLogList() { onmessage({ data: { type: 'listLogs' } }); }

async function releaseAdapter() {
    if (canbus) {
        let timer;
        try {
            await Promise.race([
                canbus.close(),
                new Promise((resolve) => { timer = setTimeout(resolve, 2000); }),
            ]);
        } catch (e) { console.warn('[webusb] release:', e); }
        finally { clearTimeout(timer); }
    }
    await NodeShim.logs.flush();
    postMessage({ type: 'released' });
}

async function start() {
    await NodeShim.logs.ready();
    navigator.usb.addEventListener('connect', refreshDevices);
    navigator.usb.addEventListener('disconnect', refreshDevices);
    await refreshDevices();
    // Modules live at the repository root, two levels above this file.
    await NodeShim.preload('../../', MODULES);
    NodeShim.require('./server');
    canbus = NodeShim.require('./canbus');
    traceCanTraffic(canbus);
    // server.js turns a failed connect into a bare FOUND status; the reason only reaches
    // the console. In a browser that reason is usually WebUSB specific (another tab or
    // program holds the adapter), so show it in the UI log as well.
    canbus.on('can_status', (connected, message) => {
        if (connected || !/error|fail/i.test(message || '')) return;
        let hint = '';
        if (/claim|access|in use|busy|open/i.test(message))
            hint = ' - close any other tab or program using the adapter (another copy of this page, the Node app), then try again';
        for (const s of sockets.values()) s.send(`CAN_ERROR: ${message}${hint}`);
    });
    console.log('[webusb] server.js running in a worker');
}

start().then(
    () => postMessage({ type: 'ready' }),
    (e) => { console.error('[webusb]', e); postMessage({ type: 'fail', message: e.message || String(e) }); });
