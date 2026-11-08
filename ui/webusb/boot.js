// Browser (WebUSB) version of the application: no Node install, no server process.
//
// server.js runs unchanged in a dedicated worker (server-worker.js) and reaches the
// CANable over WebUSB from there. The UI keeps talking to it exactly as before: the
// global WebSocket is replaced by a bridge to that worker before the UI modules load,
// so every UI <-> server message is the same string it is over the network in the
// Node build. The worker matters: on the page's own thread a confirm() dialog stopped
// the USB reads and the next parameter write lost its opening frame.
//
// Active only when the UI is served from a static web server with the repository
// root as document root (the page is at .../ui/, or at the root through index.html
// there, which sets <base href="ui/">), because the server modules are fetched from
// the directory above. Served by server.js (page at /, no base) nothing here runs and
// the UI uses its real WebSocket. Needs Chrome or Edge, over https or http://localhost.
'use strict';

(function () {
if (!new URL(document.baseURI).pathname.includes('/ui/')) return;
window.WEBUSB_BUILD = true;

// Same list as GSUSBConstants.GS_USB_DEVICES.
const USB_FILTERS = [
    { vendorId: 0x1D50, productId: 0x606F },
    { vendorId: 0x1209, productId: 0x606F },
    { vendorId: 0x1CD2, productId: 0x606F },
    { vendorId: 0x16D0, productId: 0x10B8 },
];

let worker = null;
let markReady, markFailed;
const ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
ready.catch(() => {}); // reported on the page; each socket reports it again

// --- the UI's WebSocket ---------------------------------------------------------
const clients = new Map(); // bridge id -> BridgeWebSocket
let nextClientId = 1;

class BridgeWebSocket {
    constructor() {
        this.id = nextClientId++;
        this.readyState = BridgeWebSocket.CONNECTING;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this.listeners = {};
        ready.then(() => this.connect(), (e) => this.fail(e));
    }
    connect() {
        clients.set(this.id, this);
        worker.postMessage({ type: 'open', id: this.id });
        this.readyState = BridgeWebSocket.OPEN;
        this.emit('open', { type: 'open' });
    }
    fail(e) {
        this.readyState = BridgeWebSocket.CLOSED;
        this.emit('error', { type: 'error', message: e.message });
        this.emit('close', { type: 'close' });
    }
    send(message) {
        if (this.readyState !== BridgeWebSocket.OPEN) throw new Error('Bridge not open');
        onOutgoing(message);
        worker.postMessage({ type: 'msg', id: this.id, data: String(message) });
    }
    deliver(text) {
        onIncoming(text);
        this.emit('message', { type: 'message', data: text });
    }
    emit(type, event) {
        const handler = this['on' + type];
        if (handler) handler.call(this, event);
        (this.listeners[type] || []).forEach((fn) => fn.call(this, event));
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    close() {
        if (this.readyState !== BridgeWebSocket.OPEN) return;
        this.readyState = BridgeWebSocket.CLOSED;
        clients.delete(this.id);
        worker.postMessage({ type: 'close', id: this.id });
    }
}
Object.assign(BridgeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
window.WebSocket = BridgeWebSocket;

// --- firmware update guard ------------------------------------------------------
// A sleeping screen can suspend the page and its worker, and a hidden tab may be
// throttled: say so for the duration of an update, and hold a screen wake lock.
// The ride log holds the same lock for as long as it runs. The browser drops the lock
// whenever the page is hidden, so it is taken again when the page comes back.
let wakeLock = null;
const wakeReasons = new Set();
async function holdWake(reason) {
    wakeReasons.add(reason);
    if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { console.warn('[webusb] wake lock refused:', e.message); }
}
function releaseWake(reason) {
    wakeReasons.delete(reason);
    if (!wakeReasons.size && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { for (const r of wakeReasons) holdWake(r); }
    else if (worker) worker.postMessage({ type: 'flush' }); // keep what is buffered if the tab is killed now
});
function onOutgoing(message) {
    if (typeof message === 'string' && message.startsWith('FW_UPDATE_START:')) {
        ui.fwBanner.hidden = false;
        holdWake('firmware');
    }
}
function onIncoming(text) {
    if (text.startsWith('FW_UPDATE_END')) {
        ui.fwBanner.hidden = true;
        releaseWake('firmware');
        if (!ui.logs.hidden) worker.postMessage({ type: 'listLogs' });
    }
}

// --- ride log ---------------------------------------------------------------------
// Ride mode restarts the server side with the adapter listen-only (it sends nothing,
// not even CAN acknowledgements), records every frame to the device's storage and keeps
// the screen on. It survives a reload: the flag is kept until "Stop" is pressed.
const RIDE_KEY = 'webusb.rideMode';
function rideModeOn() { try { return localStorage.getItem(RIDE_KEY) === '1'; } catch (e) { return false; } }
function setRideMode(on) {
    try { if (on) localStorage.setItem(RIDE_KEY, '1'); else localStorage.removeItem(RIDE_KEY); } catch (e) { /* private mode */ }
}
const RIDE = rideModeOn();
let stopRequested = false;
let startRequested = false;
let rideDisconnected = false;

// Set across the reload that ends a ride, so the page opens on the logs just recorded.
const RIDE_DONE_KEY = RIDE_KEY + '-done';
function takeRideDone() {
    try {
        const done = localStorage.getItem(RIDE_DONE_KEY) === '1';
        localStorage.removeItem(RIDE_DONE_KEY);
        return done;
    } catch (e) { return false; }
}
let rideJustEnded = takeRideDone();

function startRide() {
    if (startRequested) return;
    if (!confirm('Ride log: the page reloads and reopens the adapter listen-only.\n\n'
        + 'Every CAN frame is saved on this device until you press Stop. Settings cannot be read or '
        + 'written meanwhile. Keep this page on screen (it keeps the screen on).')) return;
    setRideMode(true);
    startRequested = true;
    setTimeout(finishStart, 3000); // Do not hang if closing the adapter stalls.
    if (worker) worker.postMessage({ type: 'release' });
    else finishStart();
}
function finishStart() {
    if (!startRequested) return;
    startRequested = false;
    location.reload();
}
function stopRide() {
    stopRequested = true;
    ui.rideStop.disabled = true;
    ui.rideText.textContent = 'Saving...';
    setTimeout(finishStop, 3000); // Allow the stop sequence and log flush before reloading.
    if (worker) worker.postMessage({ type: 'release' });
    else finishStop();
}
function finishStop() {
    if (!stopRequested) return;
    stopRequested = false;
    setRideMode(false);
    try { localStorage.setItem(RIDE_DONE_KEY, '1'); } catch (e) { /* private mode */ }
    location.reload();
}

const two = (n) => String(n).padStart(2, '0');
function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function showRideStats(m) {
    if (stopRequested || rideDisconnected) return;
    const t = Math.max(0, Math.floor((Date.now() - m.since) / 1000));
    const clock = `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}`;
    const quiet = m.lastRxAt ? Math.floor((Date.now() - m.lastRxAt) / 1000) : null;
    let text = `RIDE LOG ${clock} · ${m.rx.toLocaleString()} frames · ${formatBytes(m.bytes)}`;
    let warn = false;
    if (!m.persistent) { text += ' · NOT SAVED ON DEVICE, memory only - save it before closing'; warn = true; }
    if (m.error) { text += ` · storage: ${m.error}`; warn = true; }
    if (!m.lastRxAt) { text += ' · waiting for frames'; warn = true; }
    else if (quiet >= 5) { text += ` · no frames for ${quiet} s`; warn = true; }
    ui.rideText.textContent = text;
    ui.rideBanner.classList.toggle('warn', warn);
}

// --- adapter selection and logs panel -------------------------------------------
const ui = {};
function buildPanel() {
    const css = document.createElement('style');
    css.textContent = `
      #webusb-panel { position: fixed; left: 12px; bottom: 12px; z-index: 9999; display: flex; gap: 6px; align-items: center;
        flex-wrap: wrap; max-width: calc(100vw - 24px); padding: 6px 8px; border-radius: 8px; font: 13px/1.3 system-ui, sans-serif;
        background: #1f2937; color: #f3f4f6; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
      #webusb-panel button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #60a5fa;
        background: #2563eb; color: #fff; cursor: pointer; }
      #webusb-panel button.secondary { background: transparent; color: #bfdbfe; }
      #webusb-logs { position: fixed; left: 12px; bottom: 56px; z-index: 9999; max-height: 50vh; overflow: auto; min-width: 260px;
        max-width: calc(100vw - 24px); padding: 8px; border-radius: 8px; background: #111827; color: #f3f4f6;
        font: 12px/1.5 ui-monospace, Consolas, monospace; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
      #webusb-logs a { color: #93c5fd; display: block; }
      #webusb-fw { position: fixed; top: 0; left: 0; right: 0; z-index: 10000; padding: 8px 12px; text-align: center;
        background: #b45309; color: #fff; font: 600 14px/1.3 system-ui, sans-serif; }
      #webusb-ride-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 10001; display: flex; gap: 8px; align-items: center;
        padding: 8px 12px; background: #15803d; color: #fff; font: 600 14px/1.3 system-ui, sans-serif; }
      #webusb-ride-banner[hidden] { display: none; }
      #webusb-ride-banner.warn { background: #b91c1c; }
      #webusb-ride-banner span { flex: 1; min-width: 0; }
      #webusb-ride-banner button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid #fff;
        background: transparent; color: #fff; cursor: pointer; }
      #webusb-logs .session { margin-top: 8px; padding-top: 6px; border-top: 1px solid #374151; }
      #webusb-logs .session:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
      #webusb-logs .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
      #webusb-logs .row button.primary { background: #2563eb; color: #fff; border-color: #60a5fa; }
      #webusb-logs .row button { font: inherit; padding: 1px 8px; margin-left: 4px; border-radius: 4px; border: 1px solid #60a5fa;
        background: transparent; color: #bfdbfe; cursor: pointer; }
      #webusb-logs .note { color: #9ca3af; }
      /* Room below the page for the panel, so it never covers the last rows. */
      body { padding-bottom: 64px; }
      @media (max-width: 640px) {
        #webusb-panel { left: 8px; right: 8px; bottom: 8px; max-width: none; flex-wrap: nowrap; }
        #webusb-state { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #webusb-panel:has(.error) { flex-wrap: wrap; }
        #webusb-state.error { flex-basis: 100%; white-space: normal; }
        #webusb-logs { left: 8px; right: 8px; bottom: 56px; min-width: 0; max-width: none; }
      }`;
    document.head.appendChild(css);

    const panel = document.createElement('div');
    panel.id = 'webusb-panel';
    panel.innerHTML = `<span>WebUSB</span><span id="webusb-state"></span>
      <button id="webusb-select">Select adapter</button>
      <button id="webusb-ridebtn" class="secondary">Ride log</button>
      <button id="webusb-logbtn" class="secondary">Logs</button>`;
    const logs = document.createElement('div');
    logs.id = 'webusb-logs';
    logs.hidden = true;
    const fw = document.createElement('div');
    fw.id = 'webusb-fw';
    fw.hidden = true;
    fw.textContent = 'Firmware update running in the browser - keep this page on screen and the device awake until it finishes.';
    const ride = document.createElement('div');
    ride.id = 'webusb-ride-banner';
    ride.hidden = true;
    ride.innerHTML = '<span id="webusb-ride-text">RIDE LOG starting...</span><button id="webusb-ride-reconnect" hidden>Reconnect</button><button id="webusb-ride-stop">Stop</button>';
    document.body.append(panel, logs, fw, ride);

    Object.assign(ui, {
        state: panel.querySelector('#webusb-state'),
        select: panel.querySelector('#webusb-select'),
        logBtn: panel.querySelector('#webusb-logbtn'),
        rideBtn: panel.querySelector('#webusb-ridebtn'),
        logs, fwBanner: fw,
        rideBanner: ride,
        rideText: ride.querySelector('#webusb-ride-text'),
        rideReconnect: ride.querySelector('#webusb-ride-reconnect'),
        rideStop: ride.querySelector('#webusb-ride-stop'),
    });
    ui.rideBtn.onclick = startRide;
    ui.rideStop.onclick = stopRide;
    ui.rideReconnect.onclick = selectAdapter;
    ui.rideBtn.hidden = RIDE;
    ui.select.onclick = selectAdapter;
    ui.logBtn.onclick = () => {
        ui.logs.hidden = !ui.logs.hidden;
        if (!ui.logs.hidden) worker.postMessage({ type: 'listLogs' });
    };
}

function showState(text, isError = false) {
    if (!ui.state) return;
    ui.state.textContent = text;
    ui.state.classList.toggle('error', isError);
}

function showDevices(count) {
    ui.select.hidden = count > 0;
    showState(count ? '' : '- no adapter allowed yet');
    if (RIDE) {
        rideDisconnected = count === 0;
        ui.rideReconnect.hidden = !rideDisconnected;
        if (!stopRequested) {
            ui.rideText.textContent = rideDisconnected ? 'ADAPTER DISCONNECTED - recording paused, tap Reconnect' : 'RIDE LOG waiting for frames';
            ui.rideBanner.classList.toggle('warn', rideDisconnected);
        }
    }
}

async function selectAdapter() {
    try {
        const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
        if (worker) worker.postMessage({ type: 'note', text: `requestDevice succeeded: ${device.productName}` });
    } catch (e) {
        // Closing the chooser is a NotFoundError too ("No device selected"); anything
        // else rejects without a chooser ever appearing, and used to fail silently.
        console.warn('[webusb] requestDevice:', e.name, e.message);
        if (worker) worker.postMessage({ type: 'note', text: `requestDevice failed: ${e.name}: ${e.message}` });
        if (e.name === 'NotFoundError' && /no device selected/i.test(e.message)) return;
        let hint = '';
        if (e.name === 'SecurityError' || e.name === 'NotAllowedError' || e.name === 'NotFoundError')
            hint = ' - USB access may be blocked: check the site settings (lock icon > USB devices) and open the page'
                + ' directly in Chrome, not inside another app';
        showState(`- ${e.name}: ${e.message}${hint}`, true);
        return;
    }
    worker.postMessage({ type: 'refresh' });
}

// Session logs (CAN trace, firmware update, sniffer, ride logger, console). Kept in the
// browser's private storage where it has one, so earlier sessions are listed too; each
// file can be saved or shared (Android: to Drive, a messenger, ...).
function showLogs(sessions, status) {
    ui.logs.innerHTML = '';
    const total = sessions.reduce((n, s) => n + s.files.length, 0);
    ui.logBtn.textContent = `Logs (${total})`;
    if (status && !status.persistent) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = `Kept in memory only (${status.error || 'no device storage'}): lost on reload, save before closing.`;
        ui.logs.appendChild(note);
    }
    if (!total) { ui.logs.appendChild(document.createTextNode('No logs yet.')); return; }
    const finished = rideJustEnded ? sessions.find((s) => !s.current && s.files.length) : null;
    rideJustEnded = false;
    if (finished) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Ride log finished. Save all puts the whole session in one zip file.';
        ui.logs.appendChild(note);
    }
    for (const s of sessions) {
        if (!s.files.length) continue;
        const box = document.createElement('div');
        box.className = 'session';
        const head = document.createElement('div');
        head.className = 'row';
        const title = document.createElement('b');
        const size = s.files.reduce((n, f) => n + f.bytes, 0);
        title.textContent = `${s.session}${s.current ? ' (this session)' : ''} · ${formatBytes(size)}`;
        head.appendChild(title);
        const saveAllBtn = document.createElement('button');
        saveAllBtn.textContent = 'Save all';
        saveAllBtn.classList.toggle('primary', s === finished);
        saveAllBtn.onclick = () => saveAll(s, saveAllBtn);
        head.appendChild(saveAllBtn);
        if (!s.current) {
            const del = document.createElement('button');
            del.textContent = 'Delete';
            del.onclick = () => {
                if (confirm(`Delete all logs of ${s.session}? This cannot be undone.`))
                    worker.postMessage({ type: 'deleteSession', session: s.session });
            };
            head.appendChild(del);
        }
        box.appendChild(head);
        for (const f of s.files) {
            const row = document.createElement('div');
            row.className = 'row';
            const label = document.createElement('span');
            label.textContent = `${f.name} (${formatBytes(f.bytes)})`;
            const buttons = document.createElement('span');
            const save = document.createElement('button');
            save.textContent = 'Save';
            save.onclick = () => worker.postMessage({ type: 'getLog', session: s.session, name: f.name });
            buttons.appendChild(save);
            if (navigator.canShare) {
                const share = document.createElement('button');
                share.textContent = 'Share';
                share.onclick = () => worker.postMessage({ type: 'getLog', session: s.session, name: f.name, share: true });
                buttons.appendChild(share);
            }
            row.append(label, buttons);
            box.appendChild(row);
        }
        ui.logs.appendChild(box);
    }
}

async function saveLog(m) {
    const fileName = `${m.session}_${m.name}`;
    if (m.share) {
        const file = new File([m.blob], fileName, { type: 'text/plain' });
        try {
            if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: fileName }); return; }
        } catch (e) {
            if (e.name === 'AbortError') return; // share sheet closed
            console.warn('[webusb] share failed, saving instead:', e.message);
        }
    }
    download(m.blob, fileName);
}

function download(blob, fileName) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    // Long enough for a large file to be handed over on a slow phone.
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// Files of "Save all" are requested one at a time and come back through the same
// 'log' / 'logError' messages, matched by batch number.
const batches = new Map();
let nextBatch = 1;
function fetchLog(session, name) {
    return new Promise((resolve, reject) => {
        const batch = nextBatch++;
        batches.set(batch, { resolve, reject });
        worker.postMessage({ type: 'getLog', session, name, batch });
    });
}
function settleBatch(m) {
    const waiting = batches.get(m.batch);
    batches.delete(m.batch);
    if (!waiting) return;
    if (m.type === 'log') waiting.resolve(m.blob); else waiting.reject(new Error(m.message));
}

let zipStoreLoaded = null;
function loadZipStore() {
    zipStoreLoaded = zipStoreLoaded || new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'webusb/zip-store.js';
        script.onload = () => resolve(self.ZipStore);
        script.onerror = () => { zipStoreLoaded = null; reject(new Error('zip-store.js did not load')); };
        document.head.appendChild(script);
    });
    return zipStoreLoaded;
}

async function saveAll(session, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing...';
    try {
        const { zipStore } = await loadZipStore();
        const files = [];
        for (const f of session.files) files.push({ name: f.name, blob: await fetchLog(session.session, f.name) });
        download(await zipStore(files), `${session.session}.zip`);
    } catch (e) {
        alert(`Log: ${e.message}`);
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}

// --- installable app, offline start ---------------------------------------------
// The manifest and the service worker sit at the repository root, one level above the
// page, so they cover both / and /ui/. Added from here, not in ui/index.html, because
// the Node build serves ui/ as its root and has neither.
function setUpPwa() {
    const root = new URL('../', document.baseURI);
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = new URL('manifest.webmanifest', root).href;
    document.head.appendChild(manifest);
    const theme = document.createElement('meta');
    theme.name = 'theme-color';
    theme.content = '#1f2937';
    document.head.appendChild(theme);
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = new URL('icons/icon.svg', root).href;
    document.head.appendChild(icon);
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register(new URL('sw.js', root).href, { scope: root.href })
            .catch((e) => console.warn('[webusb] offline support unavailable:', e.message));
    }
}
setUpPwa();

// --- start ----------------------------------------------------------------------
function start() {
    buildPanel();
    // "Log to file" names the Node app's logs folder; here the files stay in the page.
    for (const el of document.querySelectorAll('.log-target'))
        el.textContent = '→ kept in this page, save it with Logs (bottom of the screen)';
    if (!('usb' in navigator)) {
        showState('- not available in this browser');
        ui.select.hidden = true;
        markFailed(new Error('WebUSB is not available: use Chrome or Edge, over https or http://localhost'));
        return;
    }
    // Ask the browser not to evict the stored logs under storage pressure.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    worker = new Worker(`webusb/server-worker.js${RIDE ? '?listen=1' : ''}`);
    if (RIDE) {
        ui.rideBanner.hidden = false;
        document.body.style.paddingTop = '44px';
        holdWake('ride');
        setInterval(() => worker.postMessage({ type: 'stats' }), 1000);
    }
    worker.onmessage = (e) => {
        const m = e.data;
        switch (m.type) {
        case 'ready':
            markReady();
            if (rideJustEnded) {
                ui.logs.hidden = false;
                worker.postMessage({ type: 'listLogs' });
            }
            break;
        case 'fail': showState('- failed to start, see the browser console'); markFailed(new Error(m.message)); break;
        case 'msg': if (clients.has(m.id)) clients.get(m.id).deliver(m.data); break;
        case 'devices': showDevices(m.count); break;
        case 'logs': showLogs(m.sessions, m.status); break;
        case 'log': if (m.batch) settleBatch(m); else saveLog(m); break;
        case 'logError': if (m.batch) settleBatch(m); else alert(`Log: ${m.message}`); break;
        case 'stats': showRideStats(m); break;
        case 'flushed': break;
        case 'released': finishStart(); finishStop(); break;
        }
    };
    worker.onerror = (e) => {
        console.error('[webusb] worker error', e.message);
        showState('- failed to start, see the browser console');
        markFailed(new Error(e.message || 'worker failed'));
    };
}

// The panel needs <body>; the bridge already exists, and the UI modules only wait on
// `ready` before their socket opens.
if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
