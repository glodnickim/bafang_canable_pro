// V3 object 5 "rowerzysta i sprzęt", capability gates (bit 8 / bit 11) and the chart math
// (effort map, Start target, C1 band). Spec: integration/roadmap/V3_PLAN_WDROZENIA_20261114_PL.md.
// Imports the real browser module.
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
function check(name, ok, detail = '') {
    if (ok) console.log(`  PASS ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const near = (name, got, want, tol = 1e-9) => check(name, Math.abs(got - want) <= tol, `(got ${got}, want ${want})`);
const throwsMsg = (name, fn, part) => {
    try { fn(); check(name, false, '(did not throw)'); } catch (e) { check(name, e.message.includes(part), `(message "${e.message}")`); }
};

(async () => {
    const P = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'v3-model-protocol.js')).href);
    const seal = (b) => { const c = P.crc16(b, b.length - 2); b[b.length - 2] = c & 0xFF; b[b.length - 1] = c >> 8; return b; };

    // ---- object 5 layout ----
    const rider = P.factoryRider();
    eq('factory rider', rider, { riderStrengthX10kg: 300, lowAssistOffIq: 40, lowAssistOnIq: 55, effortMap: true });
    const w = P.encodeRiderWrite(rider);
    eq('rider object length 26', w.length, 26);
    // Byte vector: 'B','V', obj 5, ver 1, len 26, index 0, count 1, stride 8, flags 0,
    // caps = bit 11 (0x800), generation 0xFFFF, 300 / 40 / 55 LE, flags 1, reserved 0.
    const body = '42560501' + '1a00' + '00010800' + '00080000' + 'ffff' + '2c01' + '2800' + '3700' + '01' + '00';
    const crc = P.crc16(P.fromHex(body));
    eq('rider byte vector', P.toHex(w), body + P.toHex([crc & 0xFF, crc >> 8]));
    const w2 = P.encodeRiderWrite({ riderStrengthX10kg: 600, lowAssistOffIq: 0, lowAssistOnIq: 0, effortMap: false }, { baseGeneration: 0x0304 });
    eq('rider max strength, C1 off, map off, generation', [...w2.slice(14, 24)], [0x04, 0x03, 0x58, 0x02, 0, 0, 0, 0, 0, 0]);

    eq('valid factory rider', P.validateRider(rider), []);
    check('strength 99 rejected', P.validateRider({ ...rider, riderStrengthX10kg: 99 }).length > 0);
    check('strength 601 rejected', P.validateRider({ ...rider, riderStrengthX10kg: 601 }).length > 0);
    check('Iq_off 201 rejected', P.validateRider({ ...rider, lowAssistOffIq: 201, lowAssistOnIq: 210 }).length > 0);
    check('Iq_on below Iq_off rejected', P.validateRider({ ...rider, lowAssistOffIq: 60, lowAssistOnIq: 55 }).length > 0);
    check('Iq_on 251 rejected', P.validateRider({ ...rider, lowAssistOnIq: 251 }).length > 0);
    check('Iq_on == Iq_off accepted', P.validateRider({ ...rider, lowAssistOffIq: 50, lowAssistOnIq: 50 }).length === 0);
    check('fraction rejected', P.validateRider({ ...rider, riderStrengthX10kg: 300.5 }).length > 0);
    check('effortMap must be boolean', P.validateRider({ ...rider, effortMap: 1 }).length > 0);
    throwsMsg('invalid rider never encoded', () => P.encodeRiderWrite({ ...rider, lowAssistOnIq: 300 }), 'Iq_on');

    // Decode: firmware-shaped reply (view 3, generation 7, caps) round-trips; defects rejected.
    const reply = Uint8Array.from(w); reply[9] = 3; reply[14] = 7; reply[15] = 0; seal(reply);
    const dec = P.decodeRiderObject(reply);
    eq('rider decode', [dec.view, dec.generation, dec.rider], [3, 7, rider]);
    const badCrc = Uint8Array.from(reply); badCrc[17] ^= 1;
    throwsMsg('rider bad CRC', () => P.decodeRiderObject(badCrc), 'CRC');
    throwsMsg('rider reserved flag bit', () => P.decodeRiderObject(seal(Uint8Array.from(reply.map((v, i) => (i === 22 ? 3 : v))))), 'zarezerwowane');
    throwsMsg('rider reserved byte', () => P.decodeRiderObject(seal(Uint8Array.from(reply.map((v, i) => (i === 23 ? 1 : v))))), 'zarezerwowane');
    throwsMsg('rider wrong version', () => P.decodeRiderObject(seal(Uint8Array.from(reply.map((v, i) => (i === 3 ? 2 : v))))), 'wersja');
    throwsMsg('rider wrong stride', () => P.decodeRiderObject(seal(Uint8Array.from(reply.map((v, i) => (i === 8 ? 6 : v))))), 'nagłówek');
    throwsMsg('rider out-of-range value', () => P.decodeRiderObject(seal(Uint8Array.from(reply.map((v, i) => (i === 16 ? 0 : (i === 17 ? 0 : v)))))), 'niepoprawny');
    throwsMsg('object 4 is not object 5', () => P.decodeRiderObject(seal(Uint8Array.from(reply.map((v, i) => (i === 2 ? 4 : v))))), 'obiekt');

    // ---- capability gates ----
    const caps = new Uint8Array(30);
    caps[0] = 0x42; caps[1] = 0x56; caps[2] = 2; caps[3] = 2;
    const capsWith = (value) => { caps[12] = value & 0xFF; caps[13] = (value >> 8) & 0xFF; caps[14] = 0; caps[15] = 0; return seal(Uint8Array.from(caps)); };
    eq('caps bit 11 -> rider', P.parseCaps(capsWith(P.CAP_RIDER)).rider, true);
    eq('caps without bit 11 -> no rider', P.parseCaps(capsWith(P.CAP_MODEL | P.CAP_MODEL_WRITABLE)).rider, false);

    const makeTransport = (capsBytes, log) => {
        let stored = Uint8Array.from(reply);
        let model = P.factoryLevels();
        return {
            async caps() { return capsBytes; },
            async read(req) {
                log.push(`read ${req.join('/')}`);
                if (req[0] === 5) return stored;
                const b = P.encodeModelWrite(1, model); b[6] = 0; b[9] = req[2]; return seal(b);
            },
            async write(obj) {
                log.push(`write obj${obj[2]} ${obj.length}`);
                if (obj[2] === 5) { stored = Uint8Array.from(obj); stored[9] = 3; seal(stored); }
                return { ok: true, generation: 8 };
            },
            async control(req) { log.push(`control ${req[0]}`); return { ok: true, generation: 9 }; },
        };
    };

    // Model only (bits 8, 10): object 5 write refused, nothing sent.
    let log = [];
    const modelOnly = P.createModelClient(makeTransport(capsWith(P.CAP_MODEL | P.CAP_MODEL_WRITABLE), log));
    await modelOnly.discover();
    const refusedRider = await modelOnly.writeRider(rider);
    check('no bit 11: rider write refused', refusedRider.ok === false && /bit 11/.test(refusedRider.text));
    check('no bit 11: no object 5 frame sent', !log.some((l) => l.startsWith('write obj5')), log.join(','));
    let threw = false; try { await modelOnly.readRider(); } catch { threw = true; }
    check('no bit 11: rider read refused locally', threw && !log.some((l) => l.startsWith('read 5')));

    // Rider only (bit 11): object 4 write and model presets refused, persist allowed.
    log = [];
    const riderOnly = P.createModelClient(makeTransport(capsWith(P.CAP_RIDER), log));
    await riderOnly.discover();
    check('no bit 8: model write refused', (await riderOnly.write(1, P.factoryLevels())).ok === false);
    check('no bit 8: restore model refused', (await riderOnly.restoreFactory()).ok === false);
    check('no bit 8: restore level refused', (await riderOnly.restoreLevel(2)).ok === false);
    check('no bit 8: no object 4 frame, no op 5/6', !log.some((l) => l.startsWith('write obj4') || l === 'control 5' || l === 'control 6'), log.join(','));
    const edited = { riderStrengthX10kg: 350, lowAssistOffIq: 30, lowAssistOnIq: 45, effortMap: false };
    const wr = await riderOnly.writeRider(edited);
    check('bit 11: rider write + readback ok', wr.ok === true && Number.isInteger(wr.generation), JSON.stringify(wr));
    check('rider readback reads 5/0/3', log.includes('read 5/0/3/0'));
    check('bit 11: persist allowed', (await riderOnly.persist()).ok === true && log.includes('control 1'));

    // Nothing at all: no writes, no controls.
    log = [];
    const none = P.createModelClient(makeTransport(capsWith(0), log));
    await none.discover();
    check('no caps: persist refused', (await none.persist()).ok === false);
    check('no caps: rider write refused', (await none.writeRider(rider)).ok === false);
    eq('no caps: transport untouched', log, []);

    // Readback mismatch on object 5 is reported.
    log = [];
    const liarT = makeTransport(capsWith(P.CAP_RIDER), log);
    liarT.write = async () => ({ ok: true, generation: 2 });
    const liar = P.createModelClient(liarT);
    await liar.discover();
    const lied = await liar.writeRider(edited);
    check('rider readback mismatch reported', lied.ok === false && /różni/.test(lied.text));

    // Schema 1 firmware: the client writes back in the version it read (no range byte).
    log = [];
    const v1T = makeTransport(capsWith(P.CAP_MODEL | P.CAP_MODEL_WRITABLE), log);
    v1T.read = async (req) => { log.push(`read ${req.join('/')}`); const b = P.encodeModelWrite(1, P.factoryLevels(), { schemaVersion: 1 }); b[6] = 0; b[9] = 3; return seal(b); };
    const v1c = P.createModelClient(v1T);
    await v1c.discover();
    await v1c.read(0, P.VIEW.CONFIGURED);
    eq('client remembers schema 1', v1c.modelSchema, 1);
    const v1w = await v1c.write(1, P.factoryLevels());
    check('schema 1 write is 68 B and readback ok', log.includes('write obj4 68') && v1w.ok === true, `${log.join(',')} ${JSON.stringify(v1w)}`);

    // ---- chart math ----
    near('T_max at 0 rpm = T0', P.tMaxKg(0, 30), 30);
    near('T_max at 95 rpm', P.tMaxKg(95, 30), 15);
    near('T_max capped at 150 rpm', P.tMaxKg(180, 30), P.tMaxKg(150, 30));
    near('u(0.3) linear', P.effortCurve(0.3), 0.4);
    near('u(0.6) knee = 0.8', P.effortCurve(0.6), 0.8);
    near('u(0.8) after knee', P.effortCurve(0.8), 0.9);
    eq('u(1) and above = 1', [P.effortCurve(1), P.effortCurve(1.7)], [1, 1]);
    eq('u(<=0) = 0', [P.effortCurve(0), P.effortCurve(-1)], [0, 0]);
    const lv = P.factoryLevels();
    near('e_full S at range 50', P.effortFull(lv[2]), 0.9);
    near('e_full S at range 100 halves', P.effortFull({ ...lv[2], range: 100 }), 0.45);
    near('e_full S at range 0 doubles', P.effortFull({ ...lv[2], range: 0 }), 1.8);
    eq('mode table s', P.MODES.map((m) => m.s), [0.15, 0.33, 0.47, 0.77, 1.0, 0.33]);
    eq('mode table e_full', P.MODES.map((m) => m.eFull), [1.0, 1.0, 0.9, 0.75, 0.6, 1.0]);
    eq('mode table F_full', P.MODES.map((m) => m.fFullKg), [35, 28, 24, 20, 16, 28]);
    // BOOST, 60 rpm, T0 30: T_max = 30*(1-60/190) = 20.526 kg. At 0.6*T_max*0.6 kg -> x = 0.6, u = 0.8.
    const tMax60 = P.tMaxKg(60, 30);
    const boostKnee = P.effortOutput(0.6 * 0.6 * tMax60, 60, lv[4], 30);
    near('BOOST knee x = 0.6', boostKnee.x, 0.6, 1e-12);
    near('BOOST knee output = 0.8 (s 1.0)', boostKnee.output, 0.8, 1e-12);
    const boostFull = P.effortOutput(0.6 * tMax60, 60, lv[4], 30);
    near('BOOST full at 60 % effort', boostFull.output, 1, 1e-12);
    const ecoFull = P.effortOutput(tMax60, 60, lv[0], 30);
    near('ECO full effort = s 0.15 (Max Torque 80 % does not cap)', ecoFull.output, 0.15, 1e-12);
    const sAssist = P.effortOutput(100, 60, { ...lv[3], assist: 100, maxTorquePct: 100 }, 30);
    eq('S+ assist 100 at full effort capped at Max Torque', [sAssist.capped, sAssist.output], [true, 1]);
    const tCap = P.effortOutput(100, 60, { ...lv[1], assist: 100, maxTorquePct: 50 }, 30);
    near('Max Torque 50 % caps TRAIL x2 (0.66 -> 0.5)', tCap.output, 0.5, 1e-12);

    // Start target: S F_full 24 kg; Start 100 halves F_full; Start 0 off; capped by Max Torque.
    near('S start at 12 kg = 50 %', P.startTarget(12, lv[2]), 0.5, 1e-12);
    near('S start at 30 kg = 100 %', P.startTarget(30, lv[2]), 1, 1e-12);
    near('S start 100 at 12 kg = 100 %', P.startTarget(12, { ...lv[2], start: 100 }), 1, 1e-12);
    near('ECO start at 35 kg = Max Torque 80 %', P.startTarget(35, lv[0]), 0.8, 1e-12);
    eq('Start 0 = off', P.startTarget(30, { ...lv[2], start: 0 }), 0);
    eq('F_full effective S start 100', P.startFullForceKg({ ...lv[2], start: 100 }), 12);
    eq('fade: 1 to 25 rpm, 0.5 at 37.5, 0 from 50', [P.startFade(0), P.startFade(25), P.startFade(37.5), P.startFade(50), P.startFade(80)], [1, 1, 0.5, 0, 0]);

    // C1 hysteresis.
    const r = P.factoryRider();
    eq('C1 rising: 50 -> 0, 55 -> 55', [P.lowAssistOutput(50, r, true), P.lowAssistOutput(55, r, true)], [0, 55]);
    eq('C1 falling: 45 -> 45, 39 -> 0', [P.lowAssistOutput(45, r, false), P.lowAssistOutput(39, r, false)], [45, 0]);
    eq('C1 off (Iq_off 0) passes through', P.lowAssistOutput(10, { ...r, lowAssistOffIq: 0 }, true), 10);

    if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
    console.log('\nALL V3 RIDER OBJECT / CHART MATH TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
