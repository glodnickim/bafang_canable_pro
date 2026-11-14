// V3 per-level model protocol (spec: integration/roadmap/V3_MODEL_CAN_PROTOCOL_PL.md).
// Imports the real module, so the test checks the code the UI runs, not a copy.
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
function check(name, ok, detail = '') {
    if (ok) console.log(`  PASS ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const throwsMsg = (name, fn, part) => {
    try { fn(); check(name, false, '(did not throw)'); } catch (e) { check(name, e.message.includes(part), `(message "${e.message}")`); }
};

(async () => {
    const P = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'v3-model-protocol.js')).href);

    // CRC16-CCITT/FALSE reference vector.
    eq('crc16 "123456789" = 0x29B1', P.crc16(Uint8Array.from('123456789', (c) => c.charCodeAt(0))), 0x29B1);

    // Variant A multiplier equals the firmware Q16 table at spot positions.
    eq('Q16 0', P.multiplierQ16(0), 32768);
    eq('Q16 1', P.multiplierQ16(1), 33225);
    eq('Q16 25', P.multiplierQ16(25), 46341);
    eq('Q16 50', P.multiplierQ16(50), 65536);
    eq('Q16 75', P.multiplierQ16(75), 92682);
    eq('Q16 99', P.multiplierQ16(99), 129267);
    eq('Q16 100', P.multiplierQ16(100), 131072);

    // Factory preset and effective values match the design document table (ECO 95 % / 3.5 s).
    const factory = P.factoryLevels();
    eq('factory modes ECO..BOOST', factory.map((l) => l.mode), [0, 1, 2, 3, 4]);
    eq('factory ECO limits', [factory[0].maxPowerW, factory[0].maxTorquePct], [350, 80]);
    eq('factory BOOST hw power', factory[4].maxPowerW, 65000);
    const eco50 = P.effectiveValues(factory[0]);
    eq('ECO@50 ratio', eco50.ratioPct, 95);
    eq('ECO@50 attack ms', eco50.attackMs, 3500);
    eq('ECO@50 release ms', eco50.releaseMs, 2334);
    eq('ECO@50 start/carry', [eco50.start, eco50.carry], [40, 20]);
    const eco100 = P.effectiveValues({ ...factory[0], assist: 100, attack: 100 });
    eq('ECO assist 100 -> 190 %', eco100.ratioPct, 190);
    eq('ECO attack 100 -> 1750 ms (faster)', eco100.attackMs, 1750);
    const eco0 = P.effectiveValues({ ...factory[0], assist: 0, attack: 0 });
    eq('ECO assist 0 -> 47.5 %', eco0.ratioPct, 47.5);
    eq('ECO attack 0 -> 7000 ms (slower)', eco0.attackMs, 7000);
    const sp = P.effectiveValues(factory[3]);
    check('S+ slope 2.62 at 50', Math.abs(sp.slope - 2.62) < 0.001, `(${sp.slope})`);
    eq('Start 0 switches off', P.effectiveValues({ ...factory[0], start: 0 }).start, 0);
    eq('Carry 0 switches off', P.effectiveValues({ ...factory[0], carry: 0 }).carry, 0);

    // Validation: reject, never clamp.
    eq('valid factory', factory.map((l) => P.validateLevel(l).length), [0, 0, 0, 0, 0]);
    check('assist 101 rejected', P.validateLevel({ ...factory[0], assist: 101 }).length > 0);
    check('mode 6 rejected', P.validateLevel({ ...factory[0], mode: 6 }).length > 0);
    check('power 49 rejected', P.validateLevel({ ...factory[0], maxPowerW: 49 }).length > 0);
    check('power 65001 rejected', P.validateLevel({ ...factory[0], maxPowerW: 65001 }).length > 0);
    check('torque 0 rejected', P.validateLevel({ ...factory[0], maxTorquePct: 0 }).length > 0);
    check('fraction rejected', P.validateLevel({ ...factory[0], attack: 50.5 }).length > 0);

    // Write object layout.
    const all = P.encodeModelWrite(1, factory);
    eq('5-level length 68', all.length, 68);
    eq('header magic/schema/version', [...all.slice(0, 4)], [0x42, 0x56, 4, 1]);
    eq('header len/index/count/stride', [all[4] | (all[5] << 8), all[6], all[7], all[8]], [68, 1, 5, 10]);
    eq('generation 0xFFFF (no check)', [all[14], all[15]], [0xFF, 0xFF]);
    eq('record 0 bytes', [...all.slice(16, 26)], [1, 0, 50, 50, 50, 50, 50, 350 & 0xFF, 350 >> 8, 80]);
    eq('record 4 power 65000 LE', [all[16 + 40 + 7], all[16 + 40 + 8]], [65000 & 0xFF, 65000 >> 8]);
    eq('crc matches', all[66] | (all[67] << 8), P.crc16(all, 66));
    const one = P.encodeModelWrite(3, [factory[2]], { baseGeneration: 0x1234 });
    eq('1-level length 28', one.length, 28);
    eq('1-level index/count', [one[6], one[7]], [3, 1]);
    eq('base generation LE', [one[14], one[15]], [0x34, 0x12]);
    eq('record carries level number', one[16], 3);
    for (const n of [1, 2, 3, 4, 5]) {
        const len = P.encodeModelWrite(1, factory.slice(0, n)).length;
        check(`length ${len} passes the transport declare rule (>=18, even-18, <=90)`, len >= 18 && ((len - 18) % 2) === 0 && len <= 90);
    }
    throwsMsg('write past level 5', () => P.encodeModelWrite(5, [factory[0], factory[1]]), 'zakres');
    throwsMsg('invalid value never encoded', () => P.encodeModelWrite(1, [{ ...factory[0], assist: 200 }]), 'Poziom 1');
    const keep = P.encodeModelWrite(2, [{ mode: 1, assist: 0xFF, attack: 50, release: 50, start: 50, carry: 50, maxPowerW: 0xFFFE, maxTorquePct: 0xFF }], { allowKeep: true });
    eq('KEEP sentinels pass through', [keep[18], keep[23], keep[24], keep[25]], [0xFF, 0xFE, 0xFF, 0xFF]);

    // Multiframe split.
    const split = P.splitIntoFrames(all);
    eq('68 B -> declare 68, 9 frames', [split.declaredLength, split.frames.length], [68, 9]);
    eq('last frame is end with 4 bytes', [split.frames[8].isEnd, split.frames[8].data.length], [true, 4]);
    check('only the last frame is end', split.frames.slice(0, 8).every((f) => !f.isEnd && f.data.length === 8));
    throwsMsg('8 B is not a multiframe', () => P.splitIntoFrames(new Uint8Array(8)), 'długość');

    // Read request / control.
    eq('read all saved', [...P.buildReadRequest(0, P.VIEW.SAVED)], [4, 0, 0, 0]);
    eq('read level 2 effective', [...P.buildReadRequest(2, P.VIEW.EFFECTIVE)], [4, 2, 1, 0]);
    throwsMsg('effective needs one level', () => P.buildReadRequest(0, P.VIEW.EFFECTIVE), 'jednego');
    eq('persist with generation', [...P.buildControl(P.OP.PERSIST, 0, 0x0102)], [1, 0, 2, 1]);
    eq('restore level 4', [...P.buildControl(P.OP.RESTORE_LEVEL, 4)], [6, 4, 0xFF, 0xFF]);
    throwsMsg('restore level 0 refused', () => P.buildControl(P.OP.RESTORE_LEVEL, 0), 'poziomu');

    // Decode: a firmware-shaped reply for all five levels round-trips; defects are rejected.
    const reply = Uint8Array.from(all);
    reply[6] = 0; reply[9] = P.VIEW.CONFIGURED; reply[14] = 7; reply[15] = 0;
    reply[10] = 0x00; reply[11] = 0x03; // caps bits 8 and 9
    const seal = (b) => { const c = P.crc16(b, b.length - 2); b[b.length - 2] = c & 0xFF; b[b.length - 1] = c >> 8; return b; };
    seal(reply);
    const dec = P.decodeModelObject(reply);
    eq('decode count/first/generation', [dec.count, dec.firstLevel, dec.generation], [5, 1, 7]);
    check('decode levels equal factory', P.levelsEqual(dec.levels, factory));
    const bad = Uint8Array.from(reply); bad[20] ^= 1;
    throwsMsg('bad CRC rejected', () => P.decodeModelObject(bad), 'CRC');
    const badVer = seal(Uint8Array.from(reply.map((v, i) => (i === 3 ? 2 : v))));
    throwsMsg('unknown schema version rejected', () => P.decodeModelObject(badVer), 'wersja');
    const badLevelNo = seal(Uint8Array.from(reply.map((v, i) => (i === 16 ? 2 : v))));
    throwsMsg('record with wrong level number rejected', () => P.decodeModelObject(badLevelNo), 'numer poziomu');
    const badRange = seal(Uint8Array.from(reply.map((v, i) => (i === 18 ? 101 : v))));
    throwsMsg('out-of-range value in reply rejected', () => P.decodeModelObject(badRange), 'niepoprawny');
    throwsMsg('truncated reply rejected', () => P.decodeModelObject(reply.slice(0, 40)), 'długość');

    // Effective view (stride 20) decoding.
    const eff = new Uint8Array(38);
    eff.set(one.slice(0, 16));
    eff[4] = 38; eff[6] = 3; eff[7] = 1; eff[8] = 20; eff[9] = P.VIEW.EFFECTIVE;
    eff.set(one.slice(16, 26), 16);
    eff[26] = 3100 & 0xFF; eff[27] = 3100 >> 8; // ratio 310.0 %
    eff[28] = 0; eff[29] = 0; eff[30] = 2200 & 0xFF; eff[31] = 2200 >> 8; eff[32] = 1467 & 0xFF; eff[33] = 1467 >> 8; eff[34] = 80; eff[35] = 50;
    seal(eff);
    const decEff = P.decodeModelObject(eff);
    eq('effective decode', [decEff.effective[0].ratioPct, decEff.effective[0].attackMs, decEff.effective[0].start], [310, 2200, 80]);

    // CAPS and the capability guard.
    const caps = new Uint8Array(30);
    caps[0] = 0x42; caps[1] = 0x56; caps[2] = 2; caps[3] = 2;
    const setCaps = (value) => { caps[12] = value & 0xFF; caps[13] = (value >> 8) & 0xFF; caps[14] = 0; caps[15] = 0; seal(caps); return Uint8Array.from(caps); };
    const noModel = P.parseCaps(setCaps(0x7F));
    eq('caps without bit 8 -> no model', noModel.model, false);
    const withModel = P.parseCaps(setCaps(0x7F | P.CAP_MODEL | P.CAP_MODEL_EFFECTIVE | P.CAP_MODEL_WRITABLE));
    eq('caps with bits 8..10 -> model, effective, writable', [withModel.model, withModel.modelEffective, withModel.modelWritable], [true, true, true]);
    eq('bad caps CRC -> null', P.parseCaps(Uint8Array.from(caps.map((v, i) => (i === 5 ? v ^ 1 : v)))), null);

    const log = [];
    const makeTransport = (capsBytes) => {
        let ram = factory.map((l) => ({ ...l }));
        return {
            async caps() { log.push('caps'); return capsBytes; },
            async read(req) {
                log.push(`read ${req[1]}/${req[2]}`);
                const idx = req[1];
                const first = idx === 0 ? 1 : idx;
                const part = idx === 0 ? ram : [ram[idx - 1]];
                const b = P.encodeModelWrite(first, part);
                b[6] = idx; b[9] = req[2]; b[14] = 9; b[15] = 0; return seal(b);
            },
            async write(obj) {
                log.push(`write ${obj.length}`);
                const d = P.decodeModelObject(Uint8Array.from(seal((() => { const c = Uint8Array.from(obj); c[9] = P.VIEW.CONFIGURED; return c; })())));
                d.levels.forEach((l, i) => { ram[d.firstLevel - 1 + i] = l; });
                return { ok: true, generation: 9 };
            },
            async control(req) { log.push(`control ${req[0]}`); return { ok: true, generation: 10 }; },
            ram: () => ram,
        };
    };

    // Old firmware: no reply to CAPS -> no model -> nothing is ever written.
    const silent = { async caps() { return null; }, async write() { log.push('WRITE SENT'); return { ok: true }; }, async control() { log.push('CONTROL SENT'); return { ok: true }; }, async read() { log.push('READ SENT'); return new Uint8Array(); } };
    const oldClient = P.createModelClient(silent);
    eq('old firmware: discover -> null', await oldClient.discover(), null);
    const blockedWrite = await oldClient.write(1, [factory[0]]);
    check('old firmware: write refused', blockedWrite.ok === false && /zablokowany/.test(blockedWrite.text));
    const blockedControl = await oldClient.persist();
    check('old firmware: control refused', blockedControl.ok === false);
    check('old firmware: no frame reached the transport', !log.some((l) => /SENT/.test(l)), `(${log.join(',')})`);
    let readThrew = false;
    try { await oldClient.read(0, P.VIEW.CONFIGURED); } catch { readThrew = true; }
    check('old firmware: read refused', readThrew && !log.includes('READ SENT'));

    // Capable firmware: write, readback, persist, restore.
    log.length = 0;
    const tr = makeTransport(setCaps(0x7F | P.CAP_MODEL | P.CAP_MODEL_EFFECTIVE | P.CAP_MODEL_WRITABLE));
    const client = P.createModelClient(tr);
    check('discover finds the model', (await client.discover()).model === true);
    const edited = { ...factory[1], assist: 70, release: 20, maxPowerW: 500 };
    const res = await client.write(2, [edited]);
    check('write one level ok with readback', res.ok === true && res.generation === 9, JSON.stringify(res));
    eq('RAM now holds edited level 2', tr.ram()[1], edited);
    check('single-level readback reads index 2', log.includes('read 2/3'));
    const all2 = await client.write(1, tr.ram());
    check('write all levels ok', all2.ok === true);
    check('multi-level readback reads all (index 0)', log.includes('read 0/3'));
    eq('persist control op 1', (await client.persist(9)).ok, true);
    eq('restore model op 5', (await client.restoreFactory()).ok, true);
    check('control ops sent', log.includes('control 1') && log.includes('control 5'));
    const eff1 = await client.read(1, P.VIEW.EFFECTIVE).catch((e) => e);
    check('effective read goes out as 1/1', log.includes('read 1/1'), eff1.message || '');

    // Read-only firmware: model seen, not writable.
    const ro = P.createModelClient(makeTransport(setCaps(0x7F | P.CAP_MODEL)));
    await ro.discover();
    check('read-only firmware refuses write', (await ro.write(1, [factory[0]])).ok === false);

    // Mismatching readback is reported, not hidden.
    const liar = makeTransport(setCaps(0x7F | P.CAP_MODEL | P.CAP_MODEL_WRITABLE));
    liar.write = async () => ({ ok: true, generation: 3 });
    const liarClient = P.createModelClient(liar);
    await liarClient.discover();
    const lied = await liarClient.write(1, [{ ...factory[0], assist: 80 }]);
    check('readback mismatch reported', lied.ok === false && /różni/.test(lied.text));

    // Firmware error mapping.
    const rejecting = makeTransport(setCaps(0x7F | P.CAP_MODEL | P.CAP_MODEL_WRITABLE));
    rejecting.write = async () => ({ ok: false, reason: 6, index: 0 });
    const rejClient = P.createModelClient(rejecting);
    await rejClient.discover();
    const rej = await rejClient.write(1, [factory[0]]);
    check('stale generation error text', rej.ok === false && rej.reason === 6 && /nieaktualna/.test(rej.text));

    // Preset file: round trip, hardware settings never included, invalid values rejected (not clamped).
    const presetText = JSON.stringify(P.buildPreset(factory, 'góry', 'test'));
    const loaded = P.parsePreset(presetText);
    check('preset round trip', P.levelsEqual(loaded.levels, factory) && loaded.name === 'góry');
    check('preset carries no hardware keys', !/phase|battery|calibration|speed|walk|pas/i.test(presetText.replace(/"name":"[^"]*"/, '')));
    const hand = JSON.parse(presetText); hand.levels[2].assist = 101;
    throwsMsg('preset with assist 101 rejected', () => P.parsePreset(JSON.stringify(hand)), 'Poziom 3');
    throwsMsg('preset of another kind rejected', () => P.parsePreset('{"kind":"evistdrive-preset"}'), 'preset modelu V3');
    throwsMsg('preset with 4 levels rejected', () => P.parsePreset(JSON.stringify({ ...JSON.parse(presetText), levels: factory.slice(0, 4) })), '5 poziomów');
    throwsMsg('non-JSON rejected', () => P.parsePreset('nope'), 'JSON');

    if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
    console.log('\nALL V3 MODEL PROTOCOL TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
