'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { StopTraceService } = require('../stop-trace');
const { COMMAND, crc32 } = require('../stop-trace-protocol');
function frame(id,d) { return { can_id: (id | 0x80000000) >>> 0, can_dlc: d.length,
    data: new DataView(d.buffer,d.byteOffset,d.length) }; }
function rig() {
    const bus = new EventEmitter(), sent = []; let clock = 10000, connected = true, view;
    bus.isConnected = () => connected; bus.sendRawFrame = async (id,d) => { sent.push([id,d]); };
    const service = new StopTraceService({ canbus: bus, logDir: fs.mkdtempSync(path.join(os.tmpdir(),'stop-auto-')),
        autoTimer: false, now: () => clock, broadcast: s => { view = JSON.parse(s.substring('STOP_TRACE_STATUS:'.length)); } });
    return { service, sent, view: () => view, advance: ms => { clock += ms; }, disconnect: () => { connected=false; },
        status: (g,state,flags=4,reason=0) => bus.emit('raw_frame_received',frame(0x022a6033,Buffer.from([1,state,g,flags,0,0,reason,0]))),
        export(g,overrun=false,corrupt=false) {
            const m=Buffer.alloc(40), tail=Buffer.alloc(40);
            m[0]=1;m[1]=g;m[2]=overrun?12:4;m[3]=1;m.writeUInt32LE(16000,4);m.writeUInt16LE(320,8);m.writeUInt16LE(40,10);m.fill(255,24,32);m.writeUInt16LE(overrun?67:35,34);
            tail.write('DONE');tail.writeUInt32LE((crc32([m]) ^ (corrupt?1:0)) >>> 0,4);
            for(const [index,b] of [[65535,m],[65534,tail]]) for(let f=0;f<8;f++) {
                const d=Buffer.alloc(8);d[0]=g;d.writeUInt16LE(index,1);b.copy(d,3,f*5,f*5+5);
                bus.emit('raw_frame_received',frame(0x10300+f,d));
            }
        } };
}
async function saved(r) { for(let i=0;i<100 && r.service.transfer;i++) await new Promise(resolve=>setTimeout(resolve,10)); assert.equal(r.service.transfer,null); }
(async () => {
    const r=rig();r.service.handle('browser','STOP_TRACE_SUBSCRIBE');r.status(0,0);r.service.tick();r.status(0,0);
    assert.deepEqual(r.sent.at(-1),[COMMAND.arm,'']);r.status(1,1);assert.equal(r.service.pending,null);
    r.status(1,2);r.service.tick();assert.equal(r.service.pending,null);
    r.status(1,3,20);r.service.tick();r.status(1,3,20);assert.deepEqual(r.sent.at(-1),[COMMAND.dump,'']);
    r.service.unsubscribe('browser');r.export(1);await saved(r);
    const first=r.view().file;assert.ok(fs.existsSync(first));assert.equal(r.view().completed,1);
    assert.equal(JSON.parse(fs.readFileSync(first+'.json')).irq_body_max_us,35);
    r.advance(1600);r.status(1,3,20);r.service.tick();r.status(1,3,20);assert.deepEqual(r.sent.at(-1),[COMMAND.arm,'']);
    r.status(2,1);assert.equal(r.view().file,first,'keep last saved file visible after rearm');
    r.status(2,3,20,4);r.service.tick();r.status(2,3,20,4);assert.deepEqual(r.sent.at(-1),[COMMAND.arm,''],'expired empty window renews without a download');
    r.status(3,1);r.service.handle('browser','STOP_TRACE_AUTO_OFF');r.status(3,3,20);r.service.tick();assert.equal(r.service.pending,null);
    r.service.handle('browser','STOP_TRACE_AUTO_ON');r.status(3,3,20);r.service.tick();r.status(3,3,20);assert.equal(r.sent.at(-1)[0],COMMAND.dump);
    r.export(3,true);await saved(r);assert.equal(r.service.automatic,false);assert.match(r.view().error,/FOC/);r.service.cleanup();

    const existing=rig();existing.service.handle('tab','STOP_TRACE_SUBSCRIBE');existing.status(42,3,20);existing.service.tick();existing.status(42,3,20);
    assert.equal(existing.sent.at(-1)[0],COMMAND.dump,'preserve frozen capture found on startup');
    existing.export(42,false,true);assert.equal(existing.service.saved,null);assert.equal(existing.service.automatic,true);
    existing.service.tick();assert.equal(existing.service.pending,null,'retry backoff');
    existing.advance(5100);existing.status(42,3,20);existing.service.tick();existing.status(42,3,20);assert.equal(existing.sent.at(-1)[0],COMMAND.dump,'retry without ARM');existing.service.cleanup();

    const loss=rig();loss.service.handle('tab','STOP_TRACE_SUBSCRIBE');loss.status(7,3,20);loss.service.saved={generation:7,file:'old'};
    loss.advance(5000);loss.service.tick();assert.equal(loss.service.saved,null,'silence invalidates generation latch');
    loss.status(7,3,20);loss.service.tick();loss.status(7,3,20);assert.equal(loss.sent.at(-1)[0],COMMAND.dump);loss.service.cleanup();

    const retry=rig();retry.service.handle('tab','STOP_TRACE_SUBSCRIBE');
    for(let i=0;i<3;i++) retry.service.fail('Test connection failure');
    assert.equal(retry.service.automatic,false);assert.match(retry.view().error,/trzech/);retry.service.cleanup();
    const flash=rig();let flashing=true;flash.service.isBusy=()=>flashing;
    flash.service.handle('tab','STOP_TRACE_SUBSCRIBE');flash.service.tick();assert.equal(flash.sent.length,0);
    flashing=false;flash.status(0,0);flash.service.tick();assert.equal(flash.sent.at(-1)[0],COMMAND.status);
    flash.service.handle('tab','STOP_TRACE_AUTO_OFF');assert.equal(flash.service.pending,null,'pause cancels an automatic write not yet sent');flash.service.cleanup();
    console.log('PASS: automatic arm/capture/download/rearm, no-trigger renewal, closed browser, pause, retry, startup capture preservation, stale generation and overrun pause.');
})().catch(e=>{console.error(e);process.exitCode=1;});
