// Server side of the V3 config transport (v3-config-server.js) against a fake CAN bus.
//
// Real code under test: v3-config-server.js, bafang-can-requests.js, request-manager.js, the
// multiframe receiver in canbus.js (_handleFrameReceived) and bafang-serializer.sendLongDataFrames.
// Only sendFrame is replaced: frames go to a small firmware emulator that follows
// V3_MODEL_CAN_PROTOCOL_PL.md §1/§4 and the firmware CAN_Display.c / assist_v3_config.c
// behaviour (declaration -> DECL_ACK, START = frame 0, MULTIFRAME n = n+1, END, one result
// frame; reads answered with START[len] / DATA / END). Object bytes are built with the
// browser module, so both sides of the WebSocket are checked against each other.
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
function check(name, ok, detail = '') {
    if (ok) console.log(`  PASS ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// canbus.js logs every frame; keep the test output readable.
const realLog = console.log;
const quiet = () => { console.log = () => {}; console.warn = () => {}; };
const loud = () => { console.log = realLog; };

(async () => {
    const P = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'v3-model-protocol.js')).href);
    quiet();
    const canbus = require(path.join(__dirname, '..', 'canbus'));
    const { createV3ConfigTransport, handleV3mMessage, parseV3mCommand } = require(path.join(__dirname, '..', 'v3-config-server'));
    loud();

    // ---- firmware emulator ----
    const fw = {
        capsBits: P.CAP_MODEL | P.CAP_MODEL_EFFECTIVE | P.CAP_MODEL_WRITABLE | P.CAP_RIDER,
        silent: false,
        generation: 7,
        levels: P.factoryLevels(),
        rider: P.factoryRider(),
        xfer: null,
        rejectDeclaration: null,   // reason to answer the declaration with
        abortAtFrame: null,        // frame number that triggers ERROR_ACK [1, n]
        declAckDelayMs: 30,
        tx: [],                    // every frame the tool sent: {t, op, cmd, data}
        events: [],                // ordered log: 'decl-ack', 'tx START' ...
    };
    const t0 = Date.now();
    const deliver = (op, cmd, data) => {
        const efid = (cmd & 0xFFFF) | (op << 16) | (5 << 19) | (2 << 24);
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        data.forEach((b, i) => view.setUint8(i, b));
        canbus._handleFrameReceived({ can_id: efid, can_dlc: data.length, data: view, timestamp_us: 0n });
    };
    const reply = (op, cmd, data, delay = 0) => setTimeout(() => deliver(op, cmd, data), delay);
    const sendMultiframe = (cmd, bytes) => {
        // Same fragment arithmetic as firmware can_multiframe.c.
        const len = bytes.length;
        const n = (len % 8) ? (len >> 3) : ((len >> 3) - 1);
        const frames = [[4, cmd, [len]]];
        for (let k = 0; k < n; k++) frames.push([5, k, [...bytes.slice(k * 8, k * 8 + 8)]]);
        frames.push([6, n, [...bytes.slice(n * 8)]]);
        frames.forEach(([op, c, d], i) => reply(op, c, d, 2 + i * 2));
    };
    const capsBytes = () => {
        const c = new Uint8Array(30);
        c[0] = 0x42; c[1] = 0x56; c[2] = 2; c[3] = 2;
        c[12] = fw.capsBits & 0xFF; c[13] = (fw.capsBits >> 8) & 0xFF;
        c[20] = fw.generation & 0xFF; c[21] = fw.generation >> 8;
        const crc = P.crc16(c, 28); c[28] = crc & 0xFF; c[29] = crc >> 8;
        return c;
    };
    const seal = (b) => { const c = P.crc16(b, b.length - 2); b[b.length - 2] = c & 0xFF; b[b.length - 1] = c >> 8; return b; };
    const modelObject = (index, view) => {
        const first = index === 0 ? 1 : index;
        const part = index === 0 ? fw.levels : [fw.levels[index - 1]];
        const b = P.encodeModelWrite(first, part, { requiredCaps: fw.capsBits, baseGeneration: fw.generation });
        b[6] = index; b[9] = view; return seal(b);
    };
    const riderObject = (view) => { const b = P.encodeRiderWrite(fw.rider, { requiredCaps: fw.capsBits, baseGeneration: fw.generation }); b[9] = view; return seal(b); };
    const err = (cmd, reason, index) => reply(3, cmd, [reason, index], 2);
    const ack = (cmd, delay = 2) => reply(2, cmd, [fw.generation & 0xFF, fw.generation >> 8], delay);

    const onTx = (commandString) => {
        const [idHex, dataHex] = commandString.split('#');
        const id = parseInt(idHex, 16);
        const op = (id >> 16) & 7;
        const target = (id >> 19) & 0x1F;
        const cmd = id & 0xFFFF;
        const data = dataHex ? [...Buffer.from(dataHex, 'hex')] : [];
        if (target !== 2) return;
        fw.tx.push({ t: Date.now() - t0, op, cmd, data });
        if (op === 2) return; // the tool ACKs our multiframe replies
        if (fw.silent) return;
        if (op === 1 && cmd === 0x6035) { sendMultiframe(0x6035, capsBytes()); return; }
        if (op === 1 && cmd === 0x6036) {
            const [obj, index, view] = data;
            if (obj === 4 && !(fw.capsBits & P.CAP_MODEL)) return err(0x6036, 4, 0);
            if (obj === 5 && !(fw.capsBits & P.CAP_RIDER)) return err(0x6036, 4, 0);
            if (obj === 4 && index <= 5 && !(view === 1 && index === 0) && view <= 3 && view !== 1) return sendMultiframe(0x6036, modelObject(index, view));
            if (obj === 5 && index === 0 && [0, 2, 3].includes(view)) return sendMultiframe(0x6036, riderObject(view));
            return err(0x6036, 3, view === 1 ? 2 : 1);
        }
        if (op === 0 && cmd === 0x6036 && data.length === 1 && data[0] > 8) {
            fw.events.push('decl');
            if (fw.rejectDeclaration !== null) return err(0x6036, fw.rejectDeclaration, 0xFF);
            if (data[0] < 18 || data[0] > 90) return err(0x6036, 1, 4);
            fw.xfer = { len: data[0], buf: new Array(data[0]).fill(null), seen: new Set() };
            setTimeout(() => { fw.events.push('decl-ack'); deliver(2, 0x6036, [fw.generation & 0xFF, fw.generation >> 8]); }, fw.declAckDelayMs);
            return;
        }
        if (op === 0 && cmd === 0x6037) {
            const [o, arg] = data;
            if (o === 5) fw.levels = P.factoryLevels();
            else if (o === 6) fw.levels[arg - 1] = P.factoryLevels()[arg - 1];
            if (o !== 1) fw.generation++;
            return ack(0x6037);
        }
        if (op >= 4 && op <= 6 && fw.xfer) {
            const frameNo = op === 4 ? 0 : cmd + 1;
            fw.events.push(`frame ${frameNo}`);
            const x = fw.xfer;
            if (fw.abortAtFrame === frameNo) { fw.xfer = null; return err(0x6036, 1, frameNo); }
            data.forEach((b, i) => { x.buf[frameNo * 8 + i] = b; });
            if (op !== 6) return;
            fw.xfer = null;
            if (x.buf.some((b) => b === null)) return err(0x6036, 1, 0);
            const bytes = Uint8Array.from(x.buf);
            if ((bytes[x.len - 2] | (bytes[x.len - 1] << 8)) !== P.crc16(bytes, x.len - 2)) return err(0x6036, 2, 0);
            try {
                const viewed = Uint8Array.from(bytes); viewed[9] = 3; seal(viewed);
                if (bytes[2] === 4) {
                    const d = P.decodeModelObject(viewed);
                    d.levels.forEach((l, i) => { fw.levels[d.firstLevel - 1 + i] = l; });
                } else {
                    fw.rider = P.decodeRiderObject(viewed).rider;
                }
            } catch { return err(0x6036, 3, 0); }
            fw.generation++;
            ack(0x6036);
        }
    };

    canbus.isConnected = () => true;
    canbus.isStarted = true;
    canbus.sendFrame = async (commandString) => { onTx(commandString); return true; };

    // ---- the WebSocket command layer ----
    const ws = (transport) => async (message) => {
        let out = null;
        quiet();
        const handled = await handleV3mMessage(transport, message, (text) => { out = JSON.parse(text); });
        loud();
        return handled ? out : 'unhandled';
    };

    eq('not a V3M command -> unhandled', await ws(createV3ConfigTransport(canbus))('READ:2:96:54'), 'unhandled');
    eq('parse READ with id', parseV3mCommand('V3M_READ:4:0:3#12'), { id: 12, cmd: 'V3M_READ', objectId: 4, index: 0, view: 3 });
    eq('parse CONTROL', parseV3mCommand('V3M_CONTROL:1:0:65535'), { id: undefined, cmd: 'V3M_CONTROL', op: 1, arg: 0, generation: 65535 });
    check('bad READ format -> error reply', (await ws(createV3ConfigTransport(canbus))('V3M_READ:4:x#3')).error?.includes('V3M_READ'));
    check('bad WRITE hex -> error reply', (await ws(createV3ConfigTransport(canbus))('V3M_WRITE:4z#4')).ok === false);

    // ---- capable firmware ----
    let transport = createV3ConfigTransport(canbus, { frameDelayMs: 5 });
    let send = ws(transport);
    const caps = await send('V3M_CAPS#1');
    check('CAPS reply ok with id', caps.ok === true && caps.id === 1 && caps.type === 'v3m_reply', JSON.stringify(caps));
    const parsedCaps = P.parseCaps(P.fromHex(caps.hex));
    check('CAPS reassembled by canbus.js and parsed', parsedCaps?.model && parsedCaps.rider && parsedCaps.generation === 7);

    const readAll = await send('V3M_READ:4:0:3#2');
    check('READ object 4 all levels ok', readAll.ok === true, JSON.stringify(readAll));
    const decodedAll = P.decodeModelObject(P.fromHex(readAll.hex));
    check('READ object 4: 73 B schema 2, factory levels', decodedAll.schemaVersion === 2 && P.levelsEqual(decodedAll.levels, P.factoryLevels()));

    fw.tx.length = 0; fw.events.length = 0;
    const edited = { ...P.factoryLevels()[2], assist: 70, range: 80, maxPowerW: 900 };
    const obj = P.encodeModelWrite(3, [edited], { baseGeneration: 7 });
    const wr = await send(`V3M_WRITE:${P.toHex(obj)}#3`);
    check('WRITE object 4 one level -> NORMAL_ACK with new generation', wr.ok === true && wr.generation === 8, JSON.stringify(wr));
    eq('emulator stored level 3', fw.levels[2], edited);
    const writes = fw.tx.filter((f) => f.op !== 2 && f.op !== 1);
    eq('wire: declaration [29], START 8 B, MF 0, MF 1, END 2 (5 B)',
        writes.map((f) => [f.op, f.op === 4 || f.op === 0 ? f.cmd : f.cmd, f.data.length]),
        [[0, 0x6036, 1], [4, 0x6036, 8], [5, 0, 8], [5, 1, 8], [6, 2, 5]]);
    eq('declaration carries the length', writes[0].data, [29]);
    eq('data frames carry the object bytes', writes.slice(1).flatMap((f) => f.data), [...obj]);
    eq('START is sent only after DECL_ACK', fw.events.slice(0, 3), ['decl', 'decl-ack', 'frame 0']);

    const back = P.decodeModelObject(P.fromHex((await send('V3M_READ:4:3:3')).hex));
    check('read back level 3 equals written (incl. range 80)', P.levelsEqual(back.levels, [edited]));

    // Object 5 round trip.
    const rider = { riderStrengthX10kg: 350, lowAssistOffIq: 30, lowAssistOnIq: 45, effortMap: false };
    const wr5 = await send(`V3M_WRITE:${P.toHex(P.encodeRiderWrite(rider))}#5`);
    check('WRITE object 5 ok', wr5.ok === true && wr5.generation === 9, JSON.stringify(wr5));
    const rd5 = await send('V3M_READ:5:0:3#6');
    eq('READ object 5 = written', P.decodeRiderObject(P.fromHex(rd5.hex)).rider, rider);

    // Firmware errors are passed through as reason/index.
    const corrupt = Uint8Array.from(obj); corrupt[20] ^= 0x01;
    const crcErr = await send(`V3M_WRITE:${P.toHex(corrupt)}`);
    eq('bad CRC -> ERROR_ACK reason 2', [crcErr.ok, crcErr.reason, crcErr.index], [false, 2, 0]);
    const readErr = await send('V3M_READ:4:0:1');
    eq('read error -> reason 3 index 2', [readErr.ok, readErr.reason, readErr.index], [false, 3, 2]);

    fw.tx.length = 0; fw.rejectDeclaration = 5;
    const busy = await send(`V3M_WRITE:${P.toHex(obj)}`);
    eq('rejected declaration -> reason 5', [busy.ok, busy.reason], [false, 5]);
    check('rejected declaration: no data frame sent', !fw.tx.some((f) => f.op >= 4 && f.op <= 6), JSON.stringify(fw.tx));
    fw.rejectDeclaration = null;

    fw.tx.length = 0; fw.abortAtFrame = 1;
    const all5 = P.encodeModelWrite(1, P.factoryLevels());
    const aborted = await send(`V3M_WRITE:${P.toHex(all5)}`);
    eq('mid-transfer abort -> reason 1 index 1', [aborted.ok, aborted.reason, aborted.index], [false, 1, 1]);
    check('mid-transfer abort: the END frame is never sent', !fw.tx.some((f) => f.op === 6), JSON.stringify(fw.tx.map((f) => f.op)));
    fw.abortAtFrame = null;

    const ctl = await send('V3M_CONTROL:6:3:65535#7');
    check('CONTROL op 6 level 3 -> ack', ctl.ok === true && ctl.id === 7);
    eq('level 3 restored to factory', fw.levels[2], P.factoryLevels()[2]);
    const persist = await send('V3M_CONTROL:1:0:11');
    check('CONTROL op 1 persist -> ack', persist.ok === true);
    const persistFrame = fw.tx.filter((f) => f.cmd === 0x6037).pop();
    eq('persist frame [1, 0, gen lo, gen hi]', persistFrame.data, [1, 0, 11, 0]);
    check('CONTROL op 4 refused by server', (await send('V3M_CONTROL:4:1:65535')).ok === false);

    // The browser client over the real server path (socket stub -> handleV3mMessage).
    const listeners = [];
    const socket = {
        addEventListener: (type, fn) => listeners.push(fn),
        send: async (text) => {
            quiet();
            await handleV3mMessage(transport, text, (out) => listeners.forEach((fn) => fn({ data: out })));
            loud();
        },
    };
    const client = P.createModelClient(P.createSocketTransport(socket, { timeoutMs: 5000 }));
    await client.discover();
    const cw = await client.write(1, P.factoryLevels().map((l) => ({ ...l, start: 60 })));
    check('browser client -> server -> fake bus: write all + readback ok', cw.ok === true, JSON.stringify(cw));
    const cr = await client.writeRider(P.factoryRider());
    check('browser client: rider write + readback ok', cr.ok === true, JSON.stringify(cr));

    // ---- firmware without bit 8 / bit 11: nothing is written ----
    fw.capsBits = P.CAP_MODEL_EFFECTIVE; // no 8, 10, 11
    transport = createV3ConfigTransport(canbus, { frameDelayMs: 5 });
    send = ws(transport);
    fw.tx.length = 0;
    const r4 = await send(`V3M_WRITE:${P.toHex(obj)}`);
    const r5 = await send(`V3M_WRITE:${P.toHex(P.encodeRiderWrite(rider))}`);
    const c5 = await send('V3M_CONTROL:5:0:65535');
    const c1 = await send('V3M_CONTROL:1:0:65535');
    eq('no caps bits: object 4 / 5 writes, op 5, op 1 refused (reason 4)', [r4.reason, r5.reason, c5.reason, c1.reason], [4, 4, 4, 4]);
    check('no caps bits: only the CAPS read went out', fw.tx.every((f) => f.op === 1 && f.cmd === 0x6035) || fw.tx.every((f) => f.op === 1 || f.op === 2), JSON.stringify(fw.tx.map((f) => [f.op, f.cmd.toString(16)])));
    check('no caps bits: no 0x6036 write and no 0x6037 frame', !fw.tx.some((f) => (f.op !== 1 && f.op !== 2) || f.cmd === 0x6037));

    fw.capsBits = P.CAP_MODEL | P.CAP_MODEL_WRITABLE; // model yes, rider no
    transport = createV3ConfigTransport(canbus, { frameDelayMs: 5 });
    send = ws(transport);
    await send('V3M_CAPS');
    fw.tx.length = 0;
    const r5b = await send(`V3M_WRITE:${P.toHex(P.encodeRiderWrite(rider))}`);
    eq('bit 8 without bit 11: object 5 refused', [r5b.ok, r5b.reason], [false, 4]);
    check('bit 8 without bit 11: no frame sent', fw.tx.length === 0, JSON.stringify(fw.tx));

    // ---- silent controller: CAPS times out, writes stay blocked ----
    fw.silent = true;
    fw.capsBits = P.CAP_MODEL | P.CAP_MODEL_WRITABLE | P.CAP_RIDER;
    transport = createV3ConfigTransport(canbus, { readTimeoutMs: 300, replyTimeoutMs: 300 });
    send = ws(transport);
    const sc = await send('V3M_CAPS#9');
    check('silent controller: CAPS -> timeout', sc.ok === false && sc.timeout === true, JSON.stringify(sc));
    fw.tx.length = 0;
    const sw = await send(`V3M_WRITE:${P.toHex(obj)}`);
    check('silent controller: write refused, no write frame', sw.ok === false && sw.reason === 4 && !fw.tx.some((f) => f.op !== 1), JSON.stringify(fw.tx));

    // Disconnected adapter.
    canbus.isConnected = () => false;
    const dc = await ws(createV3ConfigTransport(canbus))('V3M_CAPS');
    check('disconnected: error reply', dc.ok === false && /not connected/.test(dc.error));

    quiet();
    canbus.requestManager.clearAllRequests();
    Object.values(canbus.multiFrameTimeouts).forEach(clearTimeout);
    loud();
    if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
    console.log('\nALL V3 CONFIG SERVER TESTS PASS');
    process.exit(0);
})().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
