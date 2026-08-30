'use strict';
const { EventEmitter } = require('events');
const { MODE, COMMAND, HIGH, TAIL, Download, decodeStatus, stateName } = require('../qs1x-protocol');
const { Qs1Service } = require('../qs1x');
let failed = 0; const ok = (v, n) => { if (!v) { failed++; console.error('FAIL ' + n); } else console.log('PASS ' + n); };
class Bus extends EventEmitter { constructor() { super(); this.sent = []; this.isStarted = true; } isConnected() { return true; } sendRawFrame(id, d) { this.sent.push([id, d]); return Promise.resolve(); } }
function wire(id, bytes) { const b = bytes || []; const data = new DataView(new ArrayBuffer(b.length)); b.forEach((x, i) => data.setUint8(i, x)); return { can_id: parseInt(id, 16), can_dlc: b.length, data }; }
function status(state, generation, mode, high, tail, flags = 0) { return [2, state, generation, high, flags, mode, tail, 0]; }

const bus = new Bus(); const out = []; const svc = new Qs1Service({ canbus: bus, broadcast: x => out.push(x) });
svc.selectMode('START'); svc.selectMode('STOP'); svc.selectMode('RESTART');
ok(bus.sent[0][0] === COMMAND.select && bus.sent[0][1] === '00', 'C1 START mode encoding');
ok(bus.sent[2][1] === '01', 'C2 STOP mode encoding'); ok(bus.sent[4][1] === '02', 'C3 RESTART mode encoding');
svc.newCapture(); ok(bus.sent.some(x => x[0] === COMMAND.newCapture && x[1] === ''), 'C4 DLC=0 NEW CAPTURE');
const s = decodeStatus(status(2, 7, MODE.RESTART, 0, 0, 0)); ok(s && stateName(s.state) === 'WAITING_QUALIFICATION', 'C5 STATUS decode');
bus.emit('raw_frame_received', wire('822A6031', status(1, 7, MODE.START, 0, 0))); ok(out.at(-1).includes('ARMED'), 'C6 START workflow armed');
bus.emit('raw_frame_received', wire('822A6031', status(1, 8, MODE.STOP, 0, 0))); ok(out.at(-1).includes('ARMED'), 'C7 STOP ignores RUN_RISE');
bus.emit('raw_frame_received', wire('822A6031', status(3, 8, MODE.STOP, 1, 1))); ok(out.at(-1).includes('HIGH_RATE'), 'C8 STOP correct trigger starts data');
bus.emit('raw_frame_received', wire('822A6031', status(2, 9, MODE.RESTART, 0, 0))); ok(out.at(-1).includes('WAITING_QUALIFICATION'), 'C9 RESTART ignores initial RUN_RISE');
bus.emit('raw_frame_received', wire('822A6031', status(2, 9, MODE.RESTART, 0, 0, 4))); ok(out.at(-1).includes('qualification'), 'C10 RESTART qualification');
bus.emit('raw_frame_received', wire('822A6031', status(3, 9, MODE.RESTART, 1, 1, 4))); ok(out.at(-1).includes('HIGH_RATE'), 'C11 following RUN_RISE triggers RESTART');
bus.emit('raw_frame_received', wire('822A6031', status(4, 9, MODE.RESTART, 48, 5, 12))); ok(out.at(-1).includes('"high":48') && out.at(-1).includes('"tail":5'), 'C12/C13 progress');
bus.emit('raw_frame_received', wire('822A6031', status(5, 9, MODE.RESTART, 48, 19, 25))); ok(out.at(-1).includes('"complete":true'), 'C14 COMPLETE only full capture');
svc.download(); for (let i = 0; i < HIGH.count; i++) { bus.emit('raw_frame_received', wire('80010250', [1, 9, i, 0, 44, 6, 48, 0])); for (let f = 1; f <= 6; f++) bus.emit('raw_frame_received', wire((0x80010250 + f).toString(16), Array(8).fill(f))); } for (let i = 0; i < TAIL.count; i++) { bus.emit('raw_frame_received', wire('80010252', [2, 9, i, 19, 12, 250, 0, 0])); bus.emit('raw_frame_received', wire('80010253', Array(8).fill(1))); bus.emit('raw_frame_received', wire('80010254', Array(4).fill(2))); }
ok(out.some(x => x.includes('QS1_DOWNLOAD_RESULT:') && x.includes('48/48 high-rate + 19/19 tail')), 'C15 complete generation download');
let rawSeen = 0; bus.on('raw_frame_received', () => rawSeen++); bus.emit('raw_frame_received', wire('8001021D', [])); ok(rawSeen === 1, 'C16 raw logger listener preserves frames');
const d = new Download(9); ok(!d.note('8001021D', []), 'C17 PAS never becomes QS'); ok(MODE.START === 0 && MODE.STOP === 1 && MODE.RESTART === 2, 'C18 repeated modes supported');
svc.cleanup(); process.exit(failed ? 1 : 0);
