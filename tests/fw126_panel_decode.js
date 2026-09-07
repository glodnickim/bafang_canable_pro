// FW-126 TEST panel decode logic — the same known-answer cases the two verified PowerShell
// decoders were run against, so the panel in the Sniffer tab cannot quietly disagree with them:
//
//   BAFANG_GD32F303RCT6/tools/decode_fw126_ch3.ps1
//   BAFANG_GD32F303RCT6/tools/decode_fw126_cal_dump.ps1
//
// Every payload here is BUILT the way the firmware builds it (src/adc_trigger_diag.c
// adc_trigger_diag_aggregate_frame, src/CAN_Display.c current_cal_serialize_dump,
// src/can_multiframe.c build_current_fragment) and then checked against the answer that was
// put in - never against the decoder's own output.
//
// Run from the Canable project root:  node tests/fw126_panel_decode.js

'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const eq = (got, want, label) => check(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// --- builders: the wire format, from the producer -----------------------------------------
const T = 3750;
const CCR3 = [3740, 3700, 3660];

function be(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }

// One aggregate block, schema 7. `cnts` are the CNT-at-ISR-entry values the sweep recorded.
function buildBlock(cnts, opts = {}) {
    const isrPerTick = opts.isrPerTick ?? 4;
    const late = opts.late ?? [0, 0, 0];
    const complete = opts.complete ?? [true, true, true];
    const dwell = opts.dwell ?? [true, true, true];
    const adc1Rdy = opts.adc1Rdy ?? [true, true, true];
    const tag = opts.tag ?? 0xA0;
    const blk = {};
    blk['0x10240'] = [2, 3, ...be(12), isrPerTick, late[0], late[1], late[2]];
    for (let i = 0; i < 3; i++) {
        const flags = 0x01 | 0x02 | (adc1Rdy[i] ? 0x04 : 0) | 0x08 | 0x10 | (dwell[i] ? 0x20 : 0);
        blk['0x1024' + (1 + i)] = [
            (complete[i] ? 0x80 : 0) | i, CCR3[i] - 3500, ...be(cnts[i]), ...be(i + 1), 3, flags,
        ];
    }
    const rawBase = [2050, 2044, 2036];
    for (let p = 0; p < 3; p++) {
        const body = [tag === 0xA0 ? (0xA0 + p) : (0xA1 + p)];
        for (let i = 0; i < 3; i++) body.push(...be(rawBase[p] + i));
        body.push(0x80);
        blk['0x1024' + (4 + p)] = body;
    }
    return blk;
}

const upCnts   = (convL) => CCR3.map(c => 2 * T - c - convL);   // slope -1
const downCnts = (convL) => CCR3.map(c => c - convL);           // slope +1

function crc16(bytes, len) {
    let c = 0xFFFF;
    for (let i = 0; i < len; i++) {
        c ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return c & 0xFFFF;
}

// FW-126.7 0x602D fixture, built from protocol/fw1267_cal_schema.json so this file can never
// disagree with the decoders about an offset. Only VALUES live here.
const CAL_SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'EBICS',
    'BAFANG_GD32F303RCT6', 'protocol', 'fw1267_cal_schema.json'), 'utf8'));

function buildCalPayload(opts = {}) {
    const d = new Array(CAL_SPEC.length).fill(0);
    const IOFF = { A: 2020, B: 2028, C: 2012 };
    const jdr = opts.fail ? { A: 1854, B: 1882, C: 1886 }    // the saturated dark measurement
                          : { A: -16, B: -5, C: 8 };          // the settled neutral reading
    const v = {
        flags: opts.fail ? 0x04 | 0x08 : 0x01 | 0x04 | 0x08,
        state: opts.fail ? 4 : 3,
        failure_reason: opts.fail ? 2 : 0,
        source: opts.fail ? 0 : 1,
        attempts: 1, cycles: 47, stable_count: 8,
        eligible: opts.fail ? 32 : 32, restarts: 0,
        gate_stable_cycles: 8, gate_collect_samples: 32,
        gate_max_cycles: 256, gate_residual_window: 300,
    };
    ['A', 'B', 'C'].forEach(p => {
        v['offset_' + p] = jdr[p]; v['mean_' + p] = jdr[p];
        v['min_' + p] = jdr[p] - 2; v['max_' + p] = jdr[p] + 2; v['p2p_' + p] = 4;
        v['ioff_' + p] = IOFF[p]; v['midpoint_' + p] = IOFF[p] + jdr[p];
    });
    CAL_SPEC.fields.forEach(f => {
        if (v[f.name] === undefined) return;
        if (f.type === 'u8') { d[f.offset] = v[f.name] & 0xFF; return; }
        const u = v[f.name] & 0xFFFF;
        d[f.offset] = u & 0xFF; d[f.offset + 1] = (u >> 8) & 0xFF;
    });
    d[0] = CAL_SPEC.magic[0]; d[1] = CAL_SPEC.magic[1]; d[2] = CAL_SPEC.schema;
    let c = crc16(d, CAL_SPEC.crc.over);
    if (opts.badCrc) c ^= 0xFFFF;
    d[CAL_SPEC.crc.offset] = c & 0xFF; d[CAL_SPEC.crc.offset + 1] = (c >> 8) & 0xFF;
    return d;
}

// can_multiframe.c framing: START length, DATA by index, END with nbrofframes.
function buildTransfer(payload, opts = {}) {
    const len = opts.len ?? payload.length;
    const n = (len % 8) ? Math.floor(len / 8) : Math.floor(len / 8) - 1;
    const frags = new Map();
    for (let i = 0; i < n; i++) {
        if (opts.dropFrag === i) continue;
        frags.set(i, payload.slice(i * 8, i * 8 + 8));
    }
    const rem = (len % 8) || 8;
    const end = opts.noEnd ? null : { n: opts.endN ?? n, bytes: payload.slice(n * 8, n * 8 + rem) };
    return { len, frags, end };
}

(async () => {
    const modUrl = pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'fw126-decode.js')).href;
    const M = await import(modUrl);

    // ---- A. CH3 verdict, against a KNOWN hypothesis -------------------------------------
    {
        const r = M.decodeCh3(buildBlock(upCnts(500)));
        const v = M.verdictCh3(r);
        eq(v.edge, 'UP', 'A1. slope -1 is the UP-count match');
        eq(v.confidence, 'HIGH', 'A2. three clean points give HIGH confidence');
        eq(v.convPlusLatency, 500, 'A3. the intercept recovers CONV + L');
        check(v.slopes.every(s => s === -1), 'A4. both pair slopes are exactly -1');
        eq(v.stop.length, 0, 'A5. a clean run raises no stop condition');
    }
    {
        const r = M.decodeCh3(buildBlock(downCnts(500)));
        const v = M.verdictCh3(r);
        eq(v.edge, 'DOWN', 'A6. slope +1 is the DOWN-count match');
        eq(v.convPlusLatency, 500, 'A7. the intercept recovers CONV + L on the DOWN branch too');
    }
    // The trap the FW-126 prose fell into: CNT going DOWN as CH3 goes down is DOWN, not UP.
    {
        const r = M.decodeCh3(buildBlock(downCnts(500)));
        const v = M.verdictCh3(r);
        check(v.edge !== 'UP', 'A8. falling CNT with falling CH3 is never reported as UP');
    }

    // ---- A8. FW-126.2 schema 8: the same verdict, built from MEDIANS ---------------------
    // Two frames per point now. Data0 of 0x10244 is 0xB1, which is how the decoder tells this
    // layout from schema 7 without knowing anything else.
    const buildBlock8 = (medians, opts = {}) => {
        const accepted = opts.accepted ?? [7, 7, 7];
        const readback = opts.readback ?? CCR3.slice();
        const rejected = opts.rejected ?? [0, 0, 0];
        const dirAnyUp = opts.dirAnyUp ?? [false, false, false];
        const eoicAll = opts.eoicAll ?? [true, true, true];
        const complete = opts.complete ?? [true, true, true];
        const spread = opts.spread ?? [4, 4, 4];
        const blk = {};
        blk['0x10240'] = [2, 3, ...be(opts.isrTotal ?? 24), opts.isrPerTick ?? 4,
                          ...(opts.late ?? [0, 3, 0])];
        for (let i = 0; i < 3; i++) {
            const fl = (!dirAnyUp[i] ? 0x01 : 0) | (dirAnyUp[i] ? 0x02 : 0) |
                       (eoicAll[i] ? 0x04 : 0) | (complete[i] ? 0x08 : 0) | 0x10 | 0x20;
            blk['0x1024' + (1 + 2 * i)] = [
                0xC0 | i, CCR3[i] - 3500, readback[i] - 3500, accepted[i],
                ...be(medians[i]), rejected[i], fl,
            ];
            blk['0x1024' + (2 + 2 * i)] = [
                0xB0 | i, ...be(medians[i]), ...be(medians[i] + spread[i]), spread[i],
                ...be(2 + i * 7),
            ];
        }
        return blk;
    };
    {
        const r = M.decodeCh3(buildBlock8(downCnts(500)));
        eq(r.schemaVersion, 8, 'A9. 0x10244 Data0 = 0xB1 identifies schema 8');
        eq(r.points[0].accepted, 7, 'A10. accepted sample count survives the wire');
        eq(r.points[0].ccr3Readback, 3740, 'A11. CH3 readback survives the wire');
        const v = M.verdictCh3(r);
        eq(v.edge, 'DOWN', 'A12. the verdict is built from the medians');
        eq(v.confidence, 'HIGH', 'A13. three full points, both segments agreeing = HIGH');
        eq(v.convPlusLatency, 500, 'A14. CONV + L recovered from the medians');
        eq(v.stop.length, 0, 'A15. ADC1_LATE alone is NOT a stop condition on schema 8');
    }
    {
        // The readback is the whole reason it is on the wire: a compare that is not the one
        // requested means the point measured a different CH3 than it claims.
        const v = M.verdictCh3(M.decodeCh3(buildBlock8(downCnts(500), { readback: [3740, 3740, 3660] })));
        check(v.stop.some(s => s.includes('CH3 readback')), 'A16. a readback mismatch is a stop condition');
        check(v.confidence.startsWith('LOW'), 'A17. ...and it drops the confidence');
    }
    {
        const v = M.verdictCh3(M.decodeCh3(buildBlock8(downCnts(500), { dirAnyUp: [false, true, false] })));
        check(v.stop.some(s => s.includes('counting UP')), 'A18. an accepted UP sample is a stop condition');
    }
    {
        const v = M.verdictCh3(M.decodeCh3(buildBlock8(downCnts(500), { accepted: [7, 4, 7], complete: [true, false, true] })));
        eq(v.edge, 'INCONCLUSIVE', 'A19. a point below SAMPLES_MIN leaves one pair, which is not a verdict');
    }
    {
        const v = M.verdictCh3(M.decodeCh3(buildBlock8(downCnts(500), { accepted: [7, 6, 7] })));
        check(v.stop.some(s => s.includes('of 7 conversions accepted')), 'A20. a short-but-usable point is flagged');
        eq(v.edge, 'DOWN', 'A21. ...but still yields the slope');
    }
    {
        const r = M.decodeCh3(buildBlock8(downCnts(500)));
        const co = M.coherencyCh3(r);
        check(co.eoicCoherent, 'A22. schema 8 EOIC coherency ignores refused interrupts');
        check(co.rateMeasurable, 'A23. 24 interrupts is a long enough window to report the rate');
        const rep = M.buildReport({ blocks: [buildBlock8(downCnts(500))], aggSeen: 7, cal: null, calError: null }).join('\n');
        check(rep.includes('MEDIAN'), 'A24. the report shows the median column');
        check(rep.includes('CH3 VERDICT      : DOWN'), 'A25. the report states the schema 8 verdict');
    }

    // ---- B. the stop conditions ---------------------------------------------------------
    {
        const v = M.verdictCh3(M.decodeCh3(buildBlock(upCnts(500), { isrPerTick: 8 })));
        eq(v.edge, 'BOTH', 'B1. a doubled ISR rate is BOTH, whatever the slope says');
        check(v.stop.some(s => s.includes('BOTH edges are live')), 'B2. BOTH names itself as a stop condition');
    }
    {
        const v = M.verdictCh3(M.decodeCh3(buildBlock(upCnts(500), { late: [3, 0, 1] })));
        eq(v.edge, 'UP', 'B3. late conversions do not change the slope verdict');
        check(v.confidence.startsWith('LOW'), 'B4. ... but they drop the confidence');
        eq(v.stop.length, 2, 'B5. ADC0_LATE and ADC2_LATE are two separate stop conditions');
    }
    {
        const v = M.verdictCh3(M.decodeCh3(buildBlock(upCnts(500), { dwell: [true, false, false] })));
        eq(v.edge, 'INCONCLUSIVE', 'B6. points taken without the dwell are not usable');
    }
    {
        // Legacy FW-121 schema 6 shares all seven ids and means something else entirely.
        const v = M.verdictCh3(M.decodeCh3(buildBlock(upCnts(500), { tag: 0xA1 })));
        eq(v.edge, 'INCONCLUSIVE', 'B7. a legacy dark-bridge block is refused, not decoded');
    }
    {
        const cnts = upCnts(500); cnts[1] += 700;          // nonsense middle point
        const v = M.verdictCh3(M.decodeCh3(buildBlock(cnts)));
        eq(v.edge, 'INCONCLUSIVE', 'B8. slopes matching neither hypothesis stay INCONCLUSIVE');
    }

    // ---- C. coherency facts --------------------------------------------------------------
    {
        const r = M.decodeCh3(buildBlock(upCnts(500)));
        const co = M.coherencyCh3(r);
        check(co.eoicCoherent, 'C1. no late conversions + all ADC1 ready = EOIC coherent');
        check(co.sequenceMonotonic, 'C2. ISR sequence is strictly increasing');
        check(co.allDirDown, 'C3. every point was entered on the down slope');
        eq(co.conversionsPerPwmPeriod, 1, 'C4. 4 ISR per control tick = one conversion per PWM period');
    }

    // ---- D. frame classification (must agree with sniffer.js _isFw126PanelFrame) ---------
    {
        eq(M.classifyFrame('80010240').kind, 'aggregate', 'D1. prefixed aggregate id');
        eq(M.classifyFrame('00010246').kind, 'aggregate', 'D2. unprefixed aggregate id');
        eq(M.classifyFrame('022C602D').kind, 'mfStart',   'D3. 0x602D reply START');
        eq(M.classifyFrame('822C602D').kind, 'mfStart',   'D4. ... and its prefixed form');
        eq(M.classifyFrame('822D0003').kind, 'mfData',    'D5. DATA fragment');
        eq(M.classifyFrame('822E0006').kind, 'mfEnd',     'D6. END fragment');
        eq(M.classifyFrame('822C602D').cmd, 0x602D,       'D7. START carries the command');
        eq(M.classifyFrame('822D0003').cmd, 3,            'D8. DATA carries its fragment INDEX');
        check(M.classifyFrame('85116029') === null,       'D9. a request TO the controller is not a reply');
        check(M.classifyFrame('82F83200') === null,       'D10. ordinary background traffic is ignored');
        check(M.classifyFrame('nonsense') === null,       'D11. an unparsable id is ignored');
    }

    // ---- E. 0x602D reassembly ------------------------------------------------------------
    // The framing is this file's ground; the PAYLOAD decode belongs to
    // tests/fw1267_cal_parity.js, which runs both decoders on the same bytes.
    {
        const asm = M.assembleCalPayload(buildTransfer(buildCalPayload()));
        check(asm.ok, 'E1. a complete transfer reassembles');
        eq(asm.bytes.length, M.DUMP_LEN, 'E2. ... to exactly the schema length');
    }
    {
        const asm = M.assembleCalPayload(buildTransfer(buildCalPayload(), { noEnd: true }));
        check(!asm.ok && asm.error.includes('truncated'), 'E3. a missing END is refused');
    }
    {
        const asm = M.assembleCalPayload(buildTransfer(buildCalPayload(), { dropFrag: 3 }));
        check(!asm.ok && asm.error.includes('missing DATA fragment(s): 3'), 'E4. a missing fragment is NAMED');
    }
    {
        const asm = M.assembleCalPayload(buildTransfer(buildCalPayload(), { len: 40 }));
        check(!asm.ok && asm.error.includes('declared length 40'), 'E5. a wrong declared length is refused');
    }
    {
        const asm = M.assembleCalPayload(buildTransfer(buildCalPayload(), { endN: 5 }));
        check(!asm.ok && asm.error.includes('nbrofframes'), 'E6. an END disagreeing with the length is refused');
    }

    // ---- F. the panel's own contract with the decoder ------------------------------------
    {
        const good = M.decodeCal(buildCalPayload());
        check(good.pass, 'F1. the settled-neutral fixture passes');
        eq(good.stateName, 'VALID', 'F2. state name');
        eq(good.sourceName, 'NEUTRAL_DWELL', 'F3. the only valid source');
        eq(good.offset[0], -16, 'F4. the software offset is signed');
        eq(good.midpoint[0], 2004, 'F5. the physical ADC result is a DIFFERENT domain');
        const bad = M.decodeCal(buildCalPayload({ fail: true }));
        check(!bad.pass, 'F6. the saturated fixture fails');
        const noise = bad.checks.find(c => c.name === 'noise');
        check(noise && noise.pass, 'F7. ...while still passing the noise check, as it always did');
        const crc = M.decodeCal(buildCalPayload({ badCrc: true }));
        check(!crc.crcOk && !crc.pass, 'F8. a corrupt payload never passes');
    }

    // ---- G. the server-side tap (sniffer.js) --------------------------------------------
    // The tap and the panel must agree about what qualifies, and the tap must not disturb the
    // live view: a panel that quietly changed the sniffer's filtering would be a regression in
    // the one tool the whole test depends on.
    {
        const Sniffer = require(path.join(__dirname, '..', 'sniffer'));
        const s = new Sniffer({ on: () => {}, removeListener: () => {} });
        s.logMessage = () => {};

        const ids = ['80010240','00010246','022C602D','822C602D','822D0003','822E0006',
                     '85116029','82F83200','8001023A'];
        ids.forEach(id => {
            const tap = s._isFw126PanelFrame(id);
            const panel = M.classifyFrame(id) !== null;
            check(tap === panel, `G1. tap and panel agree on ${id} (tap=${tap}, panel=${panel})`);
        });

        // No websocket attached: forwarding must be a no-op, never a throw, because it runs on
        // the hot receive path ahead of the display logic.
        s.ws = null;
        let threw = false;
        try { s._forwardFw126Frame('80010240', 8, '02 03 00 0C 04 00 00 00'); } catch { threw = true; }
        check(!threw, 'G2. forwarding without a websocket is a silent no-op');

        // With a websocket, exactly the qualifying frames are forwarded, and the payload is
        // passed through untouched.
        const sent = [];
        s.ws = { send: (m) => sent.push(m) };
        s._forwardFw126Frame('80010240', 8, '02 03 00 0C 04 00 00 00');
        s._forwardFw126Frame('82F83200', 8, 'AA BB');
        eq(sent.length, 1, 'G3. only the qualifying frame is forwarded');
        eq(sent[0], 'FW126_FRAME:80010240|8|02 03 00 0C 04 00 00 00', 'G4. the payload is forwarded verbatim');

        // Filtering behaviour is untouched by this card.
        s.activeFilters = new Set(['DEFAULT TRAFFIC']);
        check(s._isFrameVisible('82F83200') === false, 'G5. Default preset still hides background traffic');
        check(s._isFrameVisible('85116029') === true,  'G6. Default preset still shows the diag request');
    }

    console.log(failures === 0
        ? 'FW-126 panel decode: ALL CHECKS PASSED'
        : `FW-126 panel decode: ${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
