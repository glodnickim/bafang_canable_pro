const assert = require('assert');
const { pathToFileURL } = require('url');
const path = require('path');
const nodes = new Map();
function node(id) { if (!nodes.has(id)) nodes.set(id, { textContent: '', style: {}, addEventListener(type, fn) { this[type] = fn; } }); return nodes.get(id); }
global.document = { getElementById: node, querySelectorAll: () => [], addEventListener() {} };
global.window = { location: { host: 'localhost' } };
global.WebSocket = class { static OPEN = 1; constructor() { this.readyState = 1; this.sent = []; } send(x) { this.sent.push(x); } };
let timers = []; global.setTimeout = (fn) => { timers.push(fn); return timers.length; }; global.clearTimeout = () => {};
global.alert = () => {};
(async () => {
 const url = (f) => pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href;
 const shared = await import(url('shared.js')); shared.state.isCanConnected = true;
 const torque = await import(url('evistdrive/torque.js'));
 const system = await import(url('evistdrive/system.js'));
 torque.bindTorqueControls(); system.bindSystemControls();
 node('ebicsCalStart').click();
 assert.deepStrictEqual(shared.socket.sent, ['READ_TORQUE']);
 timers.splice(0).forEach(fn => fn());
 assert.match(node('ebicsTorqueDiagStatus').textContent, /NORMAL.*DIAG/);
 node('ebicsDiagReadButton').click(); timers.splice(0).forEach(fn => fn());
 assert.match(node('ebicsDiagStatus').textContent, /NORMAL.*DIAG/);
 system.updateDiagUI({version:9, peak_cadence_rpm:77, forward_valid:false, safety_cut:true, pedal_load_kg:20.5, final_iq_allowed:-100});
 assert.strictEqual(String(node('diagCadence').textContent), '77');
 assert.strictEqual(node('diagPedaling').textContent, 'no');
 assert.strictEqual(node('diagRelease').textContent, 'yes');
 assert.strictEqual(node('diagLatched').textContent, 'brak w tym firmware');
 assert.strictEqual(node('diagAssistLoadKg').textContent, '20.50');
 assert.strictEqual(String(node('diagIqReqNow').textContent), '-100');
 console.log('Diagnostics UI and calibration guard: PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });

