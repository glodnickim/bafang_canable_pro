import { socket } from '../shared.js';

let bound = false;
let lastAt = 0;
const el = id => document.getElementById(id);
function send(command) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(command);
    else disconnected();
}
function disconnected() {
    el('stopTraceStatus').textContent = 'Brak połączenia z panelem pomiaru';
    el('stopTraceHint').textContent = 'Uruchom ponownie serwer CANable i odśwież stronę.';
    el('stopTraceArm').disabled = true;
    el('stopTraceDump').disabled = true;
}
export function stopTraceNoteStatus(raw) {
    if (!el('stopTracePanel')) return;
    let s; try { s = JSON.parse(raw); } catch { return; }
    lastAt = Date.now();
    el('stopTraceStatus').textContent = s.label;
    el('stopTraceHint').textContent = s.hint;
    el('stopTraceError').textContent = s.error || '';
    el('stopTraceArm').disabled = !s.canArm;
    el('stopTraceDump').disabled = !s.canDump;
    el('stopTraceFile').textContent = s.file ? 'Plik zapisany: ' + s.file : '';
    el('stopTraceProgress').hidden = !s.downloading;
    if (s.expected) { el('stopTraceProgress').max = s.expected; el('stopTraceProgress').value = s.received; }
    else el('stopTraceProgress').removeAttribute('value');
    el('stopTraceCount').textContent = s.downloading && s.expected
        ? Math.floor(s.received * 100 / s.expected) + '% — ' + s.received + ' / ' + s.expected + ' fragmentów'
        : s.generation === null ? '' : 'Pomiar nr ' + s.generation;
}
export function initStopTracePanel() {
    if (bound || !el('stopTracePanel')) return;
    bound = true;
    const action = command => {
        el('stopTraceArm').disabled = true; el('stopTraceDump').disabled = true;
        send(command);
    };
    el('stopTraceArm').onclick = () => action('STOP_TRACE_ARM');
    el('stopTraceDump').onclick = () => action('STOP_TRACE_DUMP');
    socket.addEventListener('open', () => send('STOP_TRACE_SUBSCRIBE'));
    socket.addEventListener('close', disconnected);
    if (socket.readyState === WebSocket.OPEN) send('STOP_TRACE_SUBSCRIBE');
    window.addEventListener('app-tab-changed', event => {
        if (event.detail?.tab === 'sniffer') send('STOP_TRACE_REFRESH');
    });
    setInterval(() => { if (Date.now() - lastAt > 6000) disconnected(); }, 2000);
}
