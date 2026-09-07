// evistdrive/fw126-decode.js — the FW-126 decode/verdict logic, with no DOM and no imports.
//
// Deliberately separate from fw126-test.js (which owns the panel, the buttons and the one
// transmit path) so this half can be run head-on in a test, exactly the way the two verified
// PowerShell decoders were run against known-answer synthetic logs:
//
//   BAFANG_GD32F303RCT6/tools/decode_fw126_ch3.ps1        (CH3 sweep, schema 7)
//   BAFANG_GD32F303RCT6/tools/decode_fw126_cal_dump.ps1   (0x602D calibration dump, 55 B)
//
// This is a PORT of those two, not a second opinion. Every layout, threshold and rule below
// comes from the firmware itself; if a decoder changes, all three change together.

// --- CH3 sweep constants (BAFANG_GD32F303RCT6/inc/config.h, inc/adc_trigger_diag.h) ------
export const T_PERIOD = 3750;              // _T
export const TICK_HZ = 4000;               // CONTROL_TIMEBASE_HZ
export const ISR_PER_TICK_EXPECT = 4;      // one injected conversion per PWM period at 16 kHz
export const SLOPE_TOL = 0.30;             // a 40-count step tolerates ~12 counts of jitter
export const SAMPLES_TARGET = 7;           // FW-126.2: accepted conversions per CH3 value
export const SAMPLES_MIN = 5;              // ...below this a point is not evidence
export const AGG_IDS = ['0x10240','0x10241','0x10242','0x10243','0x10244','0x10245','0x10246'];

// --- 0x602D constants (BAFANG_GD32F303RCT6/src/CAN_Display.c, inc/current_cal.h) ---------
export const DUMP_LEN = 66;   // FW-126.7 calibration report
export const CMD_CAL_DUMP = 0x602D;
export const CAL_STATUS = {
    0:'UNCALIBRATED', 1:'OK', 2:'OUT_OF_RANGE', 3:'TOO_NOISY', 4:'SAMPLE_TIMEOUT',
    5:'USING_LKG', 6:'LEGACY_FALLBACK', 7:'HARD_FAILED', 8:'MOE_ON',
};
export const CAL_SOURCE = {
    0:'NONE (FOC inhibited)', 1:'RUNTIME', 2:'LKG', 3:'LEGACY (hardware offset only)',
};
export const LIFECYCLE = {
    0:'IDLE', 1:'NEUTRAL_COMMIT', 2:'MOE_ON', 3:'NEUTRAL_DWELL', 4:'FOC_RELEASE', 5:'RUN',
};

// --- byte helpers ------------------------------------------------------------------------
export const u16be = (b, o) => (b.length > o + 1) ? (((b[o] << 8) | b[o + 1]) & 0xFFFF) : null;
export const u16le = (b, o) => (((b[o + 1] << 8) | b[o]) & 0xFFFF);
export const i16le = (b, o) => { const v = u16le(b, o); return v >= 0x8000 ? v - 0x10000 : v; };
// `>>> 0` normalises the bitwise result to unsigned so the sign test below reads as written -
// JS bitwise operators produce SIGNED 32-bit values. Both forms happen to return the same
// number here (a negative intermediate simply skips the branch), so this is clarity, not a
// bug fix. The PowerShell port of this function DID have a real bug in the same spot, for a
// different reason: there `0x80000000` is an Int32 literal worth -2147483648, which made the
// sign test true for every value. Written as a decimal comparison in both languages for that
// reason - see tools/decode_fw126_cal_dump.ps1.
export const i32le = (b, o) => {
    const v = ((b[o]) | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    return v >= 2147483648 ? v - 4294967296 : v;
};

export function crc16ccitt(bytes, len) {
    let c = 0xFFFF;
    for (let i = 0; i < len; i++) {
        c ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return c & 0xFFFF;
}

// Which frames the panel is allowed to consume. Mirrors sniffer.js _isFw126PanelFrame so the
// tap and the panel can never disagree about what qualifies.
export function classifyFrame(idHex) {
    const n = parseInt(idHex, 16);
    if (!Number.isFinite(n)) return null;
    const idv = (n >>> 0) & 0x7FFFFFFF;                 // drop the sniffer's 0x80 source prefix
    if (idv >= 0x00010240 && idv <= 0x00010246) {
        return { kind: 'aggregate', ef: '0x' + (idv & 0xFFFFF).toString(16), idv };
    }
    const op  = (idv >>> 16) & 0x07;
    const tgt = (idv >>> 19) & 0x1F;
    const src = (idv >>> 24) & 0x1F;
    if (src !== 2 || tgt !== 5) return null;
    if (op === 4) return { kind: 'mfStart', cmd: idv & 0xFFFF, idv };
    if (op === 5) return { kind: 'mfData',  cmd: idv & 0xFFFF, idv };
    if (op === 6) return { kind: 'mfEnd',   cmd: idv & 0xFFFF, idv };
    return null;
}

// ---------------------------------------------------------------------------------------
// CH3 sweep — src/adc_trigger_diag.c adc_trigger_diag_aggregate_frame()
//
//   0x10240 status : [0] state (0 IDLE 1 RUNNING 2 DONE 3 ABORTED)  [1] completed points
//                    [2:3] total ISR sequence BE  [4] max ISR per control tick
//                    [5] ADC0_LATE  [6] ADC1_LATE  [7] ADC2_LATE
//   0x10241..43 pt : [0] index | 0x80 when complete   [1] CH3 - 3500   [2:3] CNT at ISR entry BE
//                    [4:5] ISR sequence low16 BE   [6] lifecycle
//                    [7] bit0 DIR_DOWN bit1 ADC0_EOIC bit2 ADC1_EOIC bit3 ADC2_EOIC
//                        bit4 POEN bit5 DWELL
//   0x10244..46 raw: [0] 0xA0|phase (A=ADC2, B=ADC1, C=ADC0)
//                    [1:6] three BE u16 raw JDR, one per point   [7] 0x80 = all three points
//
// SCHEMA DISCRIMINATION. These seven ids are shared with the legacy FW-121 dark-bridge sweep
// (schema 6), whose frames mean something else entirely. Data0 of 0x10244 separates them:
// 0xA0 = FW-126 neutral (schema 7), 0xA1 = legacy ABORTED snapshot, 0x83 = legacy point frame.
// Anything else is refused rather than guessed at.
// ---------------------------------------------------------------------------------------
export function decodeCh3(blk) {
    const st = blk['0x10240'];
    const d4 = blk['0x10244'];
    const tag = (d4 && d4.length) ? d4[0] : -1;
    // Data0 of 0x10244 identifies the layout without needing any state:
    //   0xB1 = FW-126.2 schema 8 (point 1 frame B)   0xA0 = FW-126.0 schema 7 (raw phase A)
    //   0xA1 / 0x83 = the legacy FW-121 dark-bridge frames, which mean something else entirely.
    const schema = tag === 0xB1 ? 'FW-126.2 neutral dwell, medians (schema 8)'
        : tag === 0xA0 ? 'FW-126.0 neutral dwell, single sample (schema 7)'
        : tag === 0xA1 ? 'LEGACY FW-121 dark-bridge, ABORTED (schema 6)'
        : tag === 0x83 ? 'LEGACY FW-121 dark-bridge, points (schema 6)'
        : 'UNKNOWN';
    const r = {
        schema, schemaTag: tag,
        schemaVersion: tag === 0xB1 ? 8 : tag === 0xA0 ? 7 : 0,
        state: st[0], stateName: ['IDLE','RUNNING','DONE','ABORTED'][st[0]] || '?',
        pointsDone: st[1], isrSeqTotal: u16be(st, 2), isrPerTick: st[4],
        adc0Late: st[5], adc1Late: st[6], adc2Late: st[7],
        points: [],
    };

    // FW-126.2 schema 8: two frames per point. The MEDIAN is the point's answer; min/max and
    // the sample counts travel with it so a "stable" claim is visible rather than assumed.
    if (tag === 0xB1) {
        for (let i = 0; i < 3; i++) {
            const a = blk['0x1024' + (1 + 2 * i)];
            const b = blk['0x1024' + (2 + 2 * i)];
            const fl = a[7];
            r.points.push({
                index: i,
                ccr3: 3500 + a[1],
                ccr3Readback: 3500 + a[2],
                accepted: a[3],
                cnt: u16be(a, 4),          // the median - what the slope is computed from
                rejected: a[6],
                dirAllDown: (fl & 0x01) !== 0,
                dirAnyUp:   (fl & 0x02) !== 0,
                eoicAll:    (fl & 0x04) !== 0,
                complete:   (fl & 0x08) !== 0,
                poen:       (fl & 0x10) !== 0,
                dwell:      (fl & 0x20) !== 0,
                cntMin: u16be(b, 1),
                cntMax: u16be(b, 3),
                spread: b[5],
                isrSeq: u16be(b, 6),
            });
        }
        return r;
    }

    // FW-126.0 schema 7, kept so the logs already captured stay readable. One sample per point,
    // so min/max are that single reading and accepted is 1 by construction.
    if (tag !== 0xA0) return r;
    for (let i = 0; i < 3; i++) {
        const p = blk['0x1024' + (1 + i)];
        const fl = p[7];
        const cnt = u16be(p, 2);
        r.points.push({
            index: p[0] & 0x7F,
            ccr3: 3500 + p[1],
            ccr3Readback: null,            // schema 7 had no readback - that is why 8 exists
            accepted: (p[0] & 0x80) ? 1 : 0,
            cnt,
            rejected: 0,
            dirAllDown: (fl & 0x01) !== 0,
            dirAnyUp: (fl & 0x01) === 0,
            eoicAll: ((fl & 0x02) !== 0) && ((fl & 0x04) !== 0) && ((fl & 0x08) !== 0),
            complete: (p[0] & 0x80) !== 0,
            poen: (fl & 0x10) !== 0,
            dwell: (fl & 0x20) !== 0,
            cntMin: cnt, cntMax: cnt, spread: 0,
            isrSeq: u16be(p, 4),
            lifecycle: p[6],
            lifeName: LIFECYCLE[p[6]] ?? '?',
            rawA: null, rawB: null, rawC: null,
        });
    }
    [[4,'rawA'],[5,'rawB'],[6,'rawC']].forEach(([sub, key]) => {
        const d = blk['0x1024' + sub];
        for (let i = 0; i < 3; i++) r.points[i][key] = u16be(d, 1 + 2 * i);
    });
    return r;
}

// THE DERIVATION, from first principles - not from prose. Center-aligned timer, _T = 3750,
// CCR3 near the top, CONV the conversion length and L the trigger-to-ISR latency (unknown but
// CONSTANT, which is why a sweep answers this and a single reading cannot):
//
//   UP-count match   the match happens on the way up; the counter runs the remaining
//                    (_T - CCR3) counts to the top, turns round, and the ISR is entered on the
//                    DOWN slope:   CNT = 2*_T - CCR3 - (CONV + L)   ->  dCNT/dCCR3 = -1
//   DOWN-count match the match happens on the way down and the counter keeps descending:
//                                  CNT = CCR3 - (CONV + L)          ->  dCNT/dCCR3 = +1
//
// So CH3 stepped DOWN by 40 with CNT going UP by 40 is the UP-count match. The two hypotheses
// put CNT only 2*(_T - CCR3) = 20 counts apart at the production CCR3, so the ABSOLUTE value
// discriminates nothing - and neither does DIR at ISR entry, since both are entered while the
// counter descends. Only the SLOPE decides. The intercept then hands over (CONV + L) for free.
//
// An older revision of documentation/FW-126_PHASE_CURRENT_ACQUISITION_HARDENING_PL.md stated
// this backwards; it was corrected on 2026-08-25. Follow the derivation, not the prose.
export function verdictCh3(r) {
    const v = {
        edge: 'INCONCLUSIVE', confidence: 'NONE', reason: '',
        slopes: [], convPlusLatency: null, convPlusLatencyNs: null,
        bothEdges: false, stop: [],
    };
    if (r.schemaVersion === 0) {
        v.reason = 'block is not an FW-126 neutral-dwell layout (' + r.schema + ') - the fields mean something else';
        return v;
    }
    // A point is evidence only if it is complete, held the dwell, and - on schema 8 - carries
    // at least SAMPLES_MIN accepted conversions. FW-126.0 points count as one sample each,
    // which is exactly the weakness FW-126.2 exists to remove.
    const minSamples = (r.schemaVersion >= 8) ? SAMPLES_MIN : 1;
    const usable = r.points.filter(p => p.complete && p.dwell && p.accepted >= minSamples);
    // THREE usable points, i.e. TWO segments. A single pair cannot separate a real slope from
    // one disturbed reading - that is exactly what the 2026-08-25 17:44 ride was left with, and
    // FW-126.2 forbids calling UP or DOWN on it. Reported as INCONCLUSIVE, never as a verdict
    // with a low confidence attached: a polarity that is 50% likely to be backwards is not a
    // weaker answer, it is a wrong one.
    if (usable.length < 3) {
        v.reason = 'only ' + usable.length + ' usable point(s) - a verdict needs three, i.e. two independent segments';
        v.stop.push(usable.length < 2
            ? 'fewer than 2 usable sweep points'
            : 'only one usable pair - a single pair is not a verdict (FW-126.2)');
        return v;
    }

    // Hard gates. A trigger verdict read off a run with late conversions, a lost interlock or a
    // compare that was not the one requested is evidence about the fault, not about the trigger.
    if (r.adc0Late > 0) v.stop.push('ADC0_LATE=' + r.adc0Late + ' - phase C conversion had not finished at ISR entry');
    if (r.adc1Late > 0 && r.schemaVersion < 8) v.stop.push('ADC1_LATE=' + r.adc1Late + ' - ISR entered without a completed ADC1 group');
    if (r.adc2Late > 0) v.stop.push('ADC2_LATE=' + r.adc2Late + ' - phase A conversion had not finished at ISR entry');
    if (r.isrPerTick >= ISR_PER_TICK_EXPECT * 2) {
        v.bothEdges = true;
        v.stop.push('ISR/control tick = ' + r.isrPerTick + ' (expected ' + ISR_PER_TICK_EXPECT + ') - two conversions per PWM period, i.e. BOTH edges are live');
    }
    if (r.schemaVersion >= 8) {
        usable.forEach(p => {
            // The first interrupt after MOE ON is discarded by the firmware, so an accepted
            // sample entered while counting UP is something neither hypothesis predicts.
            if (p.dirAnyUp) v.stop.push('point ' + p.index + ': an accepted sample entered while counting UP');
            if (!p.eoicAll) v.stop.push('point ' + p.index + ': not every accepted sample had all three EOIC');
            if (p.ccr3Readback !== p.ccr3) {
                v.stop.push('point ' + p.index + ': CH3 readback ' + p.ccr3Readback + ' is not the requested ' + p.ccr3);
            }
            if (p.accepted < SAMPLES_TARGET) {
                v.stop.push('point ' + p.index + ': only ' + p.accepted + ' of ' + SAMPLES_TARGET + ' conversions accepted');
            }
        });
    }

    for (let i = 1; i < usable.length; i++) {
        const dc = usable[i].ccr3 - usable[i - 1].ccr3;
        if (dc === 0) continue;
        v.slopes.push(Math.round(((usable[i].cnt - usable[i - 1].cnt) / dc) * 1000) / 1000);
    }
    if (!v.slopes.length) { v.reason = 'all usable points share one CH3 value - no slope to measure'; return v; }

    const isUp   = v.slopes.every(s => Math.abs(s - (-1)) <= SLOPE_TOL);
    const isDown = v.slopes.every(s => Math.abs(s - 1) <= SLOPE_TOL);
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

    if (v.bothEdges) {
        v.edge = 'BOTH'; v.confidence = 'MEASURED';
        v.reason = 'doubled ISR rate - the second CC3 event is no longer being swallowed';
    } else if (isUp) {
        v.edge = 'UP';
        v.reason = 'dCNT/dCCR3 = -1: the conversion starts at the UP-count match and the ISR lands on the down slope';
        v.convPlusLatency = Math.round(mean(usable.map(p => 2 * T_PERIOD - p.ccr3 - p.cnt)));
    } else if (isDown) {
        v.edge = 'DOWN';
        v.reason = 'dCNT/dCCR3 = +1: the conversion starts at the DOWN-count match and the counter keeps descending';
        v.convPlusLatency = Math.round(mean(usable.map(p => p.ccr3 - p.cnt)));
    } else {
        v.reason = 'slopes ' + v.slopes.join(', ') + ' match neither -1 nor +1 within +/-' + SLOPE_TOL;
        v.stop.push('slope does not resolve to a single hypothesis');
    }
    if (v.convPlusLatency !== null) {
        v.convPlusLatencyNs = Math.round(v.convPlusLatency * (1000 / 120) * 10) / 10;   // TIMER0 = 120 MHz
    }
    if (v.edge === 'UP' || v.edge === 'DOWN') {
        // THREE points, both segments agreeing, nothing on the stop list. A verdict built on a
        // single pair is precisely what the 17:44 ride could not support.
        v.confidence = (!v.stop.length && usable.length >= 3 && v.slopes.length >= 2)
            ? 'HIGH' : 'LOW - see stop conditions';
    }
    return v;
}

// Extra coherency facts the panel shows, kept here so the test can assert them too.
export function coherencyCh3(r) {
    const seqs = r.points.filter(p => p.complete).map(p => p.isrSeq);
    let monotonic = seqs.length >= 2;
    for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) monotonic = false;
    return {
        sequences: seqs,
        sequenceMonotonic: monotonic,
        // On schema 8 ADC1_LATE is expected to be non-zero and harmless: those interrupts were
        // REFUSED rather than sampled, which is the point of the card. What must hold is that
        // every sample that DID enter a median had all three groups complete.
        eoicCoherent: r.points.length > 0 && r.points.every(p => p.eoicAll) &&
                      (r.schemaVersion >= 8
                          ? (r.adc0Late + r.adc2Late) === 0
                          : (r.adc0Late + r.adc1Late + r.adc2Late) === 0),
        allDirDown: r.points.length > 0 && r.points.every(p => p.dirAllDown && !p.dirAnyUp),
        // The neutral-dwell sweep closes after three accepted points, so the whole measurement
        // can span fewer interrupts than one 4 kHz control tick ever contains. Dividing by the
        // expected count then yields a RATIO OF A TRUNCATED WINDOW - an artifact that reads like
        // a real "0.75 conversions per PWM period". Only report the rate when the window was
        // long enough to hold at least one full control tick.
        rateMeasurable: r.isrSeqTotal >= ISR_PER_TICK_EXPECT * 2,
        conversionsPerPwmPeriod: (r.isrSeqTotal >= ISR_PER_TICK_EXPECT * 2 && r.isrPerTick > 0)
            ? r.isrPerTick / ISR_PER_TICK_EXPECT : null,
    };
}

// ---------------------------------------------------------------------------------------
// 0x602D multi-frame reassembly — src/can_multiframe.c build_current_fragment()
//
//   START  op 4, command 0x602D, DLC 1, data[0] = total payload length
//   DATA   op 5, the low 16 bits of the id are the FRAGMENT INDEX, DLC 8
//   END    op 6, the low 16 bits are nbrofframes, DLC = length % 8 (or 8 when 0)
//
//   nbrofframes = (length % 8) ? length >> 3 : (length >> 3) - 1        <- can_multiframe.c:183
//
// Fragments are placed BY INDEX, never by arrival order, so a reordered or duplicated frame
// cannot silently shift the payload and a missing one is named instead of zero-filled.
// ---------------------------------------------------------------------------------------
export function assembleCalPayload(transfer) {
    const fail = (error) => ({ ok: false, error, bytes: null });
    if (!transfer || transfer.len === null || transfer.len === undefined) return fail('START frame carried no length byte');
    // 0x602D and 0x602E share this framing and are told apart by the payload magic, never by
    // the command we think we asked for - so the START length is checked against the set of
    // layouts that can actually be decoded, and anything else is refused rather than assembled.
    if (transfer.len !== DUMP_LEN) return fail(`declared length ${transfer.len}, expected ${DUMP_LEN}`);
    if (!transfer.end) return fail('no END frame - transfer truncated');
    const n = (transfer.len % 8) ? Math.floor(transfer.len / 8) : Math.floor(transfer.len / 8) - 1;
    if (transfer.end.n !== n) return fail(`END says nbrofframes=${transfer.end.n}, the declared length needs ${n}`);
    const missing = [];
    for (let i = 0; i < n; i++) if (!transfer.frags.has(i)) missing.push(i);
    if (missing.length) return fail(`missing DATA fragment(s): ${missing.join(', ')}`);

    const buf = [];
    for (let i = 0; i < n; i++) {
        const fb = transfer.frags.get(i);
        if (fb.length < 8) return fail(`DATA fragment ${i} has only ${fb.length} byte(s), expected 8`);
        for (let k = 0; k < 8; k++) buf.push(fb[k]);
    }
    const rem = (transfer.len % 8) || 8;
    if (transfer.end.bytes.length < rem) return fail(`END frame has ${transfer.end.bytes.length} byte(s), expected ${rem}`);
    for (let k = 0; k < rem; k++) buf.push(transfer.end.bytes[k]);
    if (buf.length !== transfer.len) return fail(`assembled ${buf.length} bytes, declared ${transfer.len}`);
    return { ok: true, error: null, bytes: buf };
}

// ---------------------------------------------------------------------------------------
// FW-126.7 phase-current calibration report (0x602D schema 2).
//
// ONE SOURCE OF TRUTH. The field table below is GENERATED from
// BAFANG_GD32F303RCT6/protocol/fw1267_cal_schema.json, which the PowerShell decoder reads
// directly. A browser module cannot open a file, so it carries this copy - and
// tests/fw1267_cal_parity.js fails if the copy differs from the file by one field, and again
// if the two decoders disagree on a byte.
//
// THREE DOMAINS, KEPT APART. The payload carries the physical ADC result (midpoint = JDR +
// IOFF), the JDR statistics, and the software offset. JDR is never presented as "raw ADC"
// without qualification - conflating those is what took four cards to untangle.
// ---------------------------------------------------------------------------------------
export const CAL_SCHEMA = {
    magic: [67,67], magic_text: 'CC', schema: 2, length: 66,
    crc: {offset: 64,over: 64,algorithm: 'crc16-ccitt-false'},
    state_names: {0: 'UNCALIBRATED',1: 'SETTLING',2: 'COLLECTING',3: 'VALID',4: 'FAILED'},
    failure_names: {0: 'NONE',1: 'TIMEOUT',2: 'OUT_OF_RANGE',3: 'TOO_NOISY',4: 'NOT_NEUTRAL',5: 'ATTEMPTS_SPENT'},
    source_names: {0: 'NONE',1: 'NEUTRAL_DWELL'},
    reference: {midpoint_nominal: 2048,saturated_dark_example: 3890,rail_example: 4078},
    phases: ['A','B','C'], phase_adc: {A: 2,B: 1,C: 0},
    fields: [
        { name: 'magic0', offset: 0, type: 'u8' },
        { name: 'magic1', offset: 1, type: 'u8' },
        { name: 'schema', offset: 2, type: 'u8' },
        { name: 'flags', offset: 3, type: 'u8' },
        { name: 'state', offset: 4, type: 'u8' },
        { name: 'failure_reason', offset: 5, type: 'u8' },
        { name: 'source', offset: 6, type: 'u8' },
        { name: 'attempts', offset: 7, type: 'u8' },
        { name: 'cycles', offset: 8, type: 'u16' },
        { name: 'stable_count', offset: 10, type: 'u16' },
        { name: 'eligible', offset: 12, type: 'u16' },
        { name: 'restarts', offset: 14, type: 'u16' },
        { name: 'offset_A', offset: 16, type: 'i16' },
        { name: 'offset_B', offset: 18, type: 'i16' },
        { name: 'offset_C', offset: 20, type: 'i16' },
        { name: 'mean_A', offset: 22, type: 'i16' },
        { name: 'mean_B', offset: 24, type: 'i16' },
        { name: 'mean_C', offset: 26, type: 'i16' },
        { name: 'min_A', offset: 28, type: 'i16' },
        { name: 'min_B', offset: 30, type: 'i16' },
        { name: 'min_C', offset: 32, type: 'i16' },
        { name: 'max_A', offset: 34, type: 'i16' },
        { name: 'max_B', offset: 36, type: 'i16' },
        { name: 'max_C', offset: 38, type: 'i16' },
        { name: 'p2p_A', offset: 40, type: 'u16' },
        { name: 'p2p_B', offset: 42, type: 'u16' },
        { name: 'p2p_C', offset: 44, type: 'u16' },
        { name: 'ioff_A', offset: 46, type: 'u16' },
        { name: 'ioff_B', offset: 48, type: 'u16' },
        { name: 'ioff_C', offset: 50, type: 'u16' },
        { name: 'midpoint_A', offset: 52, type: 'u16' },
        { name: 'midpoint_B', offset: 54, type: 'u16' },
        { name: 'midpoint_C', offset: 56, type: 'u16' },
        { name: 'gate_stable_cycles', offset: 58, type: 'u8' },
        { name: 'gate_collect_samples', offset: 59, type: 'u8' },
        { name: 'gate_max_cycles', offset: 60, type: 'u16' },
        { name: 'gate_residual_window', offset: 62, type: 'u16' },
    ],
};

export const CAL_FLAG = { VALID: 0x01, TIMEOUT: 0x02, NEUTRAL: 0x04, FOC_BLOCKED: 0x08, DIAG_STOP: 0x10 };

/*
 * Decode 0x602D. An unknown magic or a schema this decoder does not implement is a HARD FAIL:
 * no fields, no verdict, nothing invented. Reading an older schema with these offsets is
 * exactly the defect this rule was written after.
 */
export function decodeCal(d) {
    const S = CAL_SCHEMA;
    const crcCalc = crc16ccitt(d, S.crc.over);
    const crcWire = u16le(d, S.crc.offset);
    const base = {
        magicOk: d[0] === S.magic[0] && d[1] === S.magic[1],
        schema: d[2],
        crcOk: crcCalc === crcWire,
        crcWire: '0x' + crcWire.toString(16).toUpperCase().padStart(4, '0'),
        crcCalc: '0x' + crcCalc.toString(16).toUpperCase().padStart(4, '0'),
    };
    if (!base.magicOk) {
        return Object.assign(base, { hardFail: true, verdict: 'REFUSED',
            reason: "payload magic is not 'CC' - this is not a calibration report" });
    }
    if (d[2] !== S.schema) {
        return Object.assign(base, { hardFail: true, verdict: 'REFUSED',
            reason: 'schema ' + d[2] + ' is not the one this decoder implements (' + S.schema +
                    ') - decoding it with these offsets would produce confident nonsense' });
    }

    const f = {};
    S.fields.forEach(fd => {
        f[fd.name] = fd.type === 'u8' ? d[fd.offset]
                   : fd.type === 'u16' ? u16le(d, fd.offset)
                   : i16le(d, fd.offset);
    });
    const P = S.phases, fl = f.flags;

    const r = Object.assign(base, {
        fields: f,
        state: f.state, stateName: S.state_names[f.state] ?? String(f.state),
        failure: f.failure_reason, failureName: S.failure_names[f.failure_reason] ?? String(f.failure_reason),
        source: f.source, sourceName: S.source_names[f.source] ?? String(f.source),
        attempts: f.attempts,
        valid: (fl & CAL_FLAG.VALID) !== 0,
        timeoutHit: (fl & CAL_FLAG.TIMEOUT) !== 0,
        neutralOk: (fl & CAL_FLAG.NEUTRAL) !== 0,
        focBlocked: (fl & CAL_FLAG.FOC_BLOCKED) !== 0,
        diagStop: (fl & CAL_FLAG.DIAG_STOP) !== 0,
        flagsRaw: '0x' + fl.toString(16).toUpperCase().padStart(2, '0'),
        cycles: f.cycles, stableCount: f.stable_count,
        eligible: f.eligible, restarts: f.restarts,
        offset:   P.map(p => f['offset_' + p]),
        mean:     P.map(p => f['mean_' + p]),
        min:      P.map(p => f['min_' + p]),
        max:      P.map(p => f['max_' + p]),
        p2p:      P.map(p => f['p2p_' + p]),
        ioff:     P.map(p => f['ioff_' + p]),
        midpoint: P.map(p => f['midpoint_' + p]),
        gate: {
            stableCycles: f.gate_stable_cycles,
            collectSamples: f.gate_collect_samples,
            maxCycles: f.gate_max_cycles,
            residualWindow: f.gate_residual_window,
        },
    });

    // ---- the acceptance criteria, evaluated here rather than trusted ---------------------
    const w = r.gate.residualWindow;
    r.checks = [
        { name: 'CRC', pass: r.crcOk, detail: r.crcWire + ' / ' + r.crcCalc },
        { name: 'state', pass: r.state === 3, detail: r.stateName },
        { name: 'source', pass: r.source === 1, detail: r.sourceName + ' (the only valid source)' },
        { name: 'valid flag', pass: r.valid, detail: r.flagsRaw },
        { name: 'bridge neutral', pass: r.neutralOk, detail: 'MOE on + compares neutral, every sample' },
        { name: 'FOC blocked', pass: r.focBlocked, detail: 'structural: sampled from the dwell branch' },
        { name: 'no timeout', pass: !r.timeoutHit, detail: r.cycles + ' of ' + r.gate.maxCycles + ' cycles' },
        { name: 'eligible samples', pass: r.eligible >= r.gate.collectSamples,
          detail: r.eligible + ' of ' + r.gate.collectSamples + ' required' },
        { name: 'residual window', pass: r.mean.every(x => Math.abs(x) <= w),
          detail: 'JDR mean ' + r.mean.join(' / ') + ', window +-' + w },
        { name: 'noise', pass: r.p2p.every(x => x <= 200),
          detail: 'JDR P2P ' + r.p2p.join(' / ') },
        /*
         * The check the old calibration could never have failed and should have. A saturated
         * amplifier reads near full scale and is very quiet; only the PHYSICAL result says
         * whether the measurement was taken in a valid electrical state at all.
         */
        { name: 'midpoint sanity', pass: r.midpoint.every(x => Math.abs(x - 2048) <= 400),
          detail: 'physical ADC (IOFF+JDR) ' + r.midpoint.join(' / ') + ' - mid-scale is 2048; ' +
                  'a saturated sense amplifier would read ~3900' },
    ];
    r.pass = r.checks.every(c => c.pass);
    return r;
}

// ---------------------------------------------------------------------------------------
// The report text — the thing that actually gets pasted into a handoff, so it is built
// here where a test can assert its exact contents rather than in the DOM layer.
// `snap` is { blocks, aggSeen, cal, calError }; blocks are COMPLETE blocks only.
// ---------------------------------------------------------------------------------------
export function buildReport(snap) {
    const { blocks, aggSeen, cal, calError } = snap;
    const L = [];
    L.push('FW-126 TEST PANEL REPORT');
    L.push(`captured: ${aggSeen} aggregate frame(s), ${blocks.length} complete block(s)`);
    L.push('');

    if (!blocks.length) {
        L.push('CH3 SWEEP: NO DATA - no complete 0x10240..0x10246 block yet.');
        L.push('  1. Start Sniffing must be RUNNING - this panel is fed by the sniffer receive path.');
        L.push('  2. The DIAG image (0.0429) emits these inside a SESSION SUMMARY, ~3 s after a ride');
        L.push('     goes quiet. The NORMAL image does not emit them at all.');
        L.push('  3. The sweep arms once per power cycle, at the FIRST assist start.');
    } else {
        const r = decodeCh3(blocks[blocks.length - 1]);
        const v = verdictCh3(r);
        const sigs = new Set(blocks.map(b => AGG_IDS.map(id => (b[id] || []).join(',')).join('|')));
        L.push(`SCHEMA : ${r.schema}  (0x10244 Data0 = 0x${(r.schemaTag >>> 0).toString(16).toUpperCase()})`);
        L.push(`STATE  : ${r.state} ${r.stateName}   points completed: ${r.pointsDone}/3`);
        L.push(`ISR    : total sequence ${r.isrSeqTotal}   max per control tick ${r.isrPerTick} (expected ${ISR_PER_TICK_EXPECT})`);
        L.push(`LATE   : ADC0=${r.adc0Late}  ADC1=${r.adc1Late}  ADC2=${r.adc2Late}   (all must be 0)`);
        if (sigs.size > 1) L.push(`NOTE   : ${sigs.size} different block contents seen - the last one is used.`);
        L.push('');
        if (r.schemaVersion >= 7) {
            // One row per CH3 value. On schema 8 the answer is the MEDIAN and the range beside
            // it says how much the samples moved - on schema 7 there was only ever one reading,
            // so n=1 and the range collapses to it. That difference is the whole card.
            L.push('  pt  CH3req CH3back  n  rej  MEDIAN   dMED    min    max  spr  ISRseq   DIR  EOIC DWELL');
            let prev = null;
            r.points.forEach(p => {
                const d = prev === null ? '     -' : String(p.cnt - prev.cnt).padStart(6);
                L.push('  ' + p.index + (p.complete ? '*' : '!') +
                    String(p.ccr3).padStart(6) +
                    (p.ccr3Readback === null ? '       -' : String(p.ccr3Readback).padStart(8)) +
                    String(p.accepted).padStart(3) + String(p.rejected).padStart(5) +
                    String(p.cnt).padStart(8) + d +
                    String(p.cntMin).padStart(7) + String(p.cntMax).padStart(7) +
                    String(p.spread).padStart(5) + String(p.isrSeq).padStart(8) +
                    (p.dirAnyUp ? ' MIXED' : '  down') +
                    (p.eoicAll ? '   YES' : '    NO') +
                    (p.dwell ? '   YES' : '    NO'));
                prev = p;
            });
            L.push('  (DIR is the counter at ISR ENTRY and discriminates nothing - both hypotheses are');
            L.push('   entered on the down slope. Only the SLOPE below decides.)');
            L.push('');
            L.push(`SLOPE dCNT/dCCR3 : ${v.slopes.join(', ')}    (-1 => UP-count match, +1 => DOWN-count match)`);
            if (v.convPlusLatency !== null) L.push(`CONV + LATENCY   : ${v.convPlusLatency} counts = ${v.convPlusLatencyNs} ns at 120 MHz`);
            L.push('');
            const co = coherencyCh3(r);
            L.push(`inserted conversions per PWM period : ${co.conversionsPerPwmPeriod ?? 'NOT MEASURABLE'}   (from ${r.isrPerTick} ISR per ${TICK_HZ} Hz control tick, ${r.isrSeqTotal} ISR total)`);
            if (!co.rateMeasurable) L.push('    the sweep spanned only ' + r.isrSeqTotal + ' interrupt(s) - too short to hold a full control tick, so this is a window artifact, not a rate');
            L.push(`conversion on UP   : ${v.edge === 'UP' || v.edge === 'BOTH' ? 'YES' : v.edge === 'DOWN' ? 'NO' : '?'}`);
            L.push(`conversion on DOWN : ${v.edge === 'DOWN' || v.edge === 'BOTH' ? 'YES' : v.edge === 'UP' ? 'NO' : '?'}`);
            L.push(`BOTH / two triggers: ${v.bothEdges ? 'YES' : (v.edge === 'UP' || v.edge === 'DOWN') ? 'NO' : '?'}`);
            L.push(`CNT/DIR coherency  : ${co.allDirDown ? 'all points entered on the down slope (expected under BOTH hypotheses)' : 'MIXED - a point was entered while counting UP, which neither hypothesis predicts'}`);
            L.push(`EOIC coherent      : ${co.eoicCoherent ? 'YES' : 'NO'}`);
            L.push(`sample sequence    : ${co.sequenceMonotonic ? 'YES (strictly increasing: ' + co.sequences.join(' < ') + ')' : 'NO'}`);
            L.push('');
        }
        L.push(`CH3 VERDICT      : ${v.edge}    confidence: ${v.confidence}`);
        L.push(`REASON           : ${v.reason}`);
        if (v.stop.length) {
            L.push('STOP CONDITIONS (handoff section 9 - do NOT implement FW-127 while any stands):');
            v.stop.forEach(s => L.push('  - ' + s));
        }
    }

    L.push('');
    if (calError) {
        L.push(`0x602D CALIBRATION REPORT: ${calError}`);
    } else if (!cal) {
        L.push('0x602D CALIBRATION REPORT: not read yet (use Read CAL 0x602D).');
    } else {
        const c = cal;
        L.push(`0x602D PHASE-CURRENT CALIBRATION (FW-126.7, schema ${c.schema})`);
        L.push(`  magic/CRC     : ${c.magicOk ? 'CC' : 'BAD MAGIC'} v${c.schema}   CRC ${c.crcWire}/${c.crcCalc} -> ${c.crcOk ? 'OK' : 'MISMATCH'}`);
        if (c.hardFail) {
            L.push(`CAL VERDICT      : ${c.verdict}`);
            L.push(`REASON           : ${c.reason}`);
        } else {
            if (!c.crcOk) L.push('  CRC MISMATCH - every field below is suspect. Do not quote these numbers.');
            const yn = b => b ? 'YES' : 'NO';
            const num = (x, w) => String(x).padStart(w);
            L.push(`  state         : ${c.state} ${c.stateName}   source ${c.source} ${c.sourceName}   attempts ${c.attempts}`);
            L.push(`  failure       : ${c.failure} ${c.failureName}`);
            L.push(`  flags         : ${c.flagsRaw}  valid=${+c.valid} neutral=${+c.neutralOk} foc_blocked=${+c.focBlocked} timeout=${+c.timeoutHit} diag_stop=${+c.diagStop}`);
            L.push(`  gate          : ${c.cycles} of ${c.gate.maxCycles} cycles   stable ${c.stableCount}/${c.gate.stableCycles}   eligible ${c.eligible}/${c.gate.collectSamples}   restarts ${c.restarts}`);
            L.push('');
            /*
             * The three domains, as three labelled rows. Reading JDR as "raw ADC" is the mistake
             * that hid a saturated amplifier behind four cards' worth of green checks, so the
             * physical result gets its own row and its own sanity note.
             */
            L.push('                          phase A      phase B      phase C');
            const row = (label, a) => L.push(`  ${label.padEnd(16)}${num(a[0], 10)} ${num(a[1], 12)} ${num(a[2], 12)}`);
            row('JDR mean', c.mean);
            row('JDR min', c.min);
            row('JDR max', c.max);
            row('JDR P2P', c.p2p);
            L.push('');
            row('software offset', c.offset);
            L.push('    ^ what the FOC ISR subtracts from JDR - this IS the calibration result');
            L.push('');
            row('hardware IOFF', c.ioff);
            row('physical ADC', c.midpoint);
            L.push('    ^ IOFF + JDR mean. Mid-scale is 2048; a SATURATED sense amplifier reads');
            L.push('      ~3900, which is exactly what every calibration before FW-126.7 measured.');
            L.push('');
            c.checks.forEach(ch => L.push(`  [${ch.pass ? 'PASS' : 'FAIL'}] ${ch.name.padEnd(20)}${ch.detail}`));
            L.push('');
            L.push(`CAL VERDICT      : ${c.pass ? 'PASS - calibrated in a valid electrical state' :
                'FAIL - ' + c.checks.filter(x => !x.pass).map(x => x.name).join('; ')}`);
            if (c.diagStop) {
                L.push('NOTE             : the DIAG post-validation stop was spent - this boot deliberately');
                L.push('                   refused the FOC release once, so no torque followed the calibration.');
            }
        }
    }
    return L;
}

// ---------------------------------------------------------------------------------------
// Capture state machine — the intake side, kept here (and not in the DOM layer) because it
// decides whether a ride's data is read correctly at all.
//
// Two independent streams arrive interleaved on the same tap:
//   the aggregate block, where a 0x10240 opens a block and 0x10246 closes it. Live frames are
//   uncompressed and in arrival order, which is the branch decode_fw126_ch3.ps1 calls
//   trustworthy for chronological grouping;
//   the 0x602D reply, whose DATA/END frames carry no command at all - they are attributed to
//   the transfer opened by the preceding START, exactly as decode_fw126_cal_dump.ps1 does, and
//   a START for any OTHER command drops the transfer rather than mixing two replies.
//
// `note()` returns what changed, so the panel can re-render without inspecting the internals.
// ---------------------------------------------------------------------------------------
export const MAX_BLOCKS = 8;   // the sweep state is frozen once DONE; a short ring is plenty

export function createCapture() {
    return {
        blocks: [], current: null, aggSeen: 0,
        calTransfer: null, cal: null, calError: null,

        reset() {
            this.blocks = []; this.current = null; this.aggSeen = 0;
            this.calTransfer = null; this.cal = null; this.calError = null;
        },

        completeBlocks() {
            return this.blocks.filter(b => AGG_IDS.every(id => b[id] !== undefined));
        },

        snapshot() {
            return {
                blocks: this.completeBlocks(), aggSeen: this.aggSeen,
                cal: this.cal, calError: this.calError,
            };
        },

        note(idHex, dataHex) {
            const cls = classifyFrame(idHex);
            if (!cls) return { changed: false };
            const bytes = (dataHex || '').trim().split(/\s+/).filter(Boolean)
                .map(x => parseInt(x, 16) & 0xFF);

            if (cls.kind === 'aggregate') {
                this.aggSeen++;
                if (cls.idv === 0x00010240) {
                    if (this.current) this._push(this.current);
                    this.current = {};
                }
                if (!this.current) return { changed: true };   // started mid-block: wait for 0x10240
                if (this.current[cls.ef] === undefined) this.current[cls.ef] = bytes;
                if (cls.ef === '0x10246') { this._push(this.current); this.current = null; }
                return { changed: true };
            }
            if (cls.kind === 'mfStart') {
                // A START for anything else means the controller is answering a different
                // question on its single multi-frame channel - drop, never merge.
                this.calTransfer = (cls.cmd === CMD_CAL_DUMP)
                    ? { len: bytes.length ? bytes[0] : null, frags: new Map(), end: null, cmd: cls.cmd }
                    : null;
                return { changed: true };
            }
            if (cls.kind === 'mfData') {
                const t = this.calTransfer;
                if (t && !t.end && !t.frags.has(cls.cmd)) t.frags.set(cls.cmd, bytes);
                return { changed: false };
            }
            if (cls.kind === 'mfEnd') {
                const t = this.calTransfer;
                if (!t) return { changed: false };
                t.end = { n: cls.cmd, bytes };
                this.calTransfer = null;
                const asm = assembleCalPayload(t);
                if (!asm.ok) {
                    this.calError = asm.error;
                    return { changed: true, calComplete: true, calOk: false };
                }
                this.calError = null;
                this.cal = decodeCal(asm.bytes);
                return { changed: true, calComplete: true, calOk: true };
            }
            return { changed: false };
        },

        _push(blk) {
            this.blocks.push(blk);
            while (this.blocks.length > MAX_BLOCKS) this.blocks.shift();
        },
    };
}
