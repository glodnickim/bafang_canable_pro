'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { COMMAND, crc32, Download } = require('../stop-trace-protocol');
const { StopTraceService } = require('../stop-trace');

function fixture(g = 7) {
    const m = Buffer.alloc(40), r = Buffer.alloc(40), tail = Buffer.alloc(40);
    m[0] = 1; m[1] = g; m[3] = 1; m.writeUInt32LE(16000, 4); m.writeUInt16LE(320, 8);
    m.writeUInt16LE(40, 10); m.writeUInt16LE(1, 12); m.writeUInt32LE(100, 20);
    m.fill(255, 24, 32); r.writeUInt32LE(100, 0);
    tail.write('DONE'); tail.writeUInt32LE(crc32([m, r]), 4);
    const frames = [];
    for (const [index, block] of [[65535, m], [0, r], [65534, tail]]) for (let f = 0; f < 8; f++) {
        const d = Buffer.alloc(8); d[0] = g; d.writeUInt16LE(index, 1); block.copy(d, 3, f * 5, f * 5 + 5);
        frames.push({ id: 0x10300 + f, d });
    }
    return frames;
}
const consume = frames => { const a = new Download(7); let result; for (const f of frames) result = a.feed(f.id, f.d); return result; };
function raw(id, d, frameType = 'extended') {
    return { can_id: (id | 0x80000000) >>> 0, can_dlc: d.length,
        data: new DataView(d.buffer, d.byteOffset, d.length), frameType };
}
function status(g, state, flags = 4, reason = 0) { return Buffer.from([1, state, g, flags, state === 3 ? 1 : 0, 0, reason, 0]); }

(async () => {
    assert.equal(crc32([Buffer.from('123456789')]), 0xcbf43926);
    assert.equal(consume(fixture()).transport, 'COMPLETE_CRC_OK');
    assert.throws(() => consume(fixture().filter((_, i) => i !== 10)), /Brakuje/);
    const bad = fixture(); bad[8].d[5] ^= 1; assert.throws(() => consume(bad), /CRC/);
    assert.throws(() => consume([...fixture().slice(0, 12), ...fixture().filter((_, i) => i !== 10)]), /Brakuje/);
    const duplicate = fixture(); duplicate.splice(9, 0, duplicate[8]); assert.equal(consume(duplicate).transport, 'COMPLETE_CRC_OK');
    const wrong = fixture(); wrong[10].d[0] = 8; assert.throws(() => consume(wrong), /numery/);
    const bus = new EventEmitter(); let linked = true, clock = 10000, view;
    const sent = []; bus.isConnected = () => linked; bus.sendRawFrame = async (id, d) => sent.push([id, d]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canable-stop-trace-'));
    const service = new StopTraceService({ canbus: bus, broadcast: x => { view = JSON.parse(x.split(/:(.*)/s)[1]); }, logDir: dir, now: () => clock, autoTimer: false });
    const receive = (id, d, type) => bus.emit('raw_frame_received', raw(id, d, type));
    service.handle('tab1', 'STOP_TRACE_ARM');
    assert.deepEqual(sent.pop(), [COMMAND.status, '']);
    receive(0x022a6033, status(6, 0)); assert.deepEqual(sent.pop(), [COMMAND.arm, '']);
    receive(0x022a6033, Buffer.alloc(0)); assert.ok(service.pending, 'ACK alone is not ARMED');
    receive(0x022a6033, status(7, 1), 'echo'); assert.ok(service.pending, 'ignore own echo');
    receive(0x022a6033, status(7, 1)); assert.equal(service.pending, null); assert.match(view.label, /wykonaj próbę/);
    receive(0x022a6033, status(7, 3, 20)); assert.equal(view.canArm, false); assert.equal(view.canDump, true);
    service.handle('tab1', 'STOP_TRACE_ARM'); receive(0x022a6033, status(7, 3, 20)); assert.match(view.error, /Najpierw pobierz/);
    service.handle('tab1', 'STOP_TRACE_DUMP'); receive(0x022a6033, status(7, 3, 20)); assert.deepEqual(sent.pop(), [COMMAND.dump, '']);
    service.unsubscribe('tab1'); assert.ok(service.transfer, 'tab closing must not abort transfer');
    for (const f of fixture()) receive(f.id, f.d);
    for (let i = 0; i < 100 && service.transfer; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.transfer, null); assert.ok(view.file); assert.equal(view.canArm, true);
    assert.match(fs.readFileSync(view.file, 'utf8'), /ID:80010300 DLC:8/);
    assert.equal(JSON.parse(fs.readFileSync(view.file + '.json')).transport, 'COMPLETE_CRC_OK');
    console.log('Saved test fixture: ' + view.file);
    clock += 5000; service.publish(); assert.equal(view.canArm, false); assert.equal(view.canDump, false);
    service.handle('tab1', 'STOP_TRACE_ARM'); receive(0x022a6033, status(7, 3, 20)); receive(0x022b6033, Buffer.alloc(0)); assert.match(view.error, /odrzucił/);
    service.handle('tab1', 'STOP_TRACE_ARM'); clock += 5100; service.tick(); assert.equal(service.pending, null); assert.match(view.error, /nie potwierdził/);
    linked = false; service.tick(); assert.equal(view.canArm, false); assert.equal(service.status, null);
    linked = true; receive(0x022a6033, status(0, 0, 0)); assert.equal(view.canArm, false); assert.match(view.label, /niedostępny/);
    service.cleanup();
    console.log('PASS: protocol CRC/completeness/replay isolation; ARM confirmation; overwrite protection; persistence without tab; timeout/disconnect/DIAG.');
})().catch(e => { console.error(e); process.exitCode = 1; });
