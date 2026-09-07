const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const nodes = new Map();
const get = id => { if (!nodes.has(id)) nodes.set(id, { disabled: true, textContent: '', removeAttribute(k) { delete this[k]; } }); return nodes.get(id); };
const sent = [], events = {};
const context = { document: { getElementById: get }, Date, WebSocket: { OPEN: 1 },
    socket: { readyState: 1, send: x => sent.push(x), addEventListener: (n, fn) => { events[n] = fn; } },
    window: { addEventListener() {} }, setInterval() {} };
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '../ui/js/evistdrive/stop-trace-panel.js'), 'utf8').replace(/^import[^\n]*\n/, '').replaceAll('export function ', 'function ');
vm.runInContext(source, context);
context.initStopTracePanel(); assert.equal(sent.pop(), 'STOP_TRACE_SUBSCRIBE');
context.stopTraceNoteStatus(JSON.stringify({ label: 'Gotowy', hint: 'Start', canArm: true, canDump: false, generation: 0 }));
assert.equal(get('stopTraceArm').disabled, false); get('stopTraceArm').onclick(); assert.equal(sent.pop(), 'STOP_TRACE_ARM'); assert.equal(get('stopTraceArm').disabled, true);
context.stopTraceNoteStatus(JSON.stringify({ label: 'Pobieranie', hint: 'Czekaj', downloading: true, expected: 80, received: 40 }));
assert.equal(get('stopTraceProgress').value, 40); assert.match(get('stopTraceCount').textContent, /50%/);
context.stopTraceNoteStatus(JSON.stringify({ label: 'Plik zapisany', hint: '', file: 'logs/test.log', canArm: true }));
assert.match(get('stopTraceFile').textContent, /logs\/test.log/);
events.close(); assert.equal(get('stopTraceArm').disabled, true); assert.equal(get('stopTraceDump').disabled, true);
const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
for (const id of nodes.keys()) assert.ok(html.includes('id="' + id + '"'), 'Missing UI element: ' + id);
assert.ok(html.indexOf('id="stopTracePanel"') < html.indexOf('id="qs1Panel"'));
console.log('PASS: panel commands, progress, saved path, disconnect gating and HTML wiring.');
