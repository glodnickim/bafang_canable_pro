// FW-126.7 calibration-report parity test.
//
// WHY THIS EXISTS. Two decoders that each hand-wrote the 0x602D layout drifted once before, and
// the PowerShell one read a payload with the wrong offsets - printing BAD MAGIC and then a
// verdict anyway, the exact opposite of the truth. A decoder that confidently reports the wrong
// branch is worse than one that reports nothing.
//
// Four things, on the SAME bytes:
//   1. the JS decoder's embedded field table equals protocol/fw1267_cal_schema.json, field for
//      field (the browser cannot read the file, so it mirrors it - checked here);
//   2. golden payloads decode to the values put into them, and reach the right verdict;
//   3. the PowerShell decoder, run for real, agrees field by field;
//   4. an unknown magic or schema HARD FAILS in both - no fields, no verdict.
//
// The case that matters most is S5/M1: the OLD defect. A saturated amplifier is quiet and
// perfectly self-consistent in the JDR domain; only the physical result (IOFF + JDR) exposes it.
//
// Run from the Canable project root:  node tests/fw1267_cal_parity.js

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const FW = path.join(__dirname, '..', '..', 'EBICS', 'BAFANG_GD32F303RCT6');
const SCHEMA_PATH = path.join(FW, 'protocol', 'fw1267_cal_schema.json');
const PS_DECODER = path.join(FW, 'tools', 'decode_fw126_cal_dump.ps1');

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };
const eq = (got, want, label) => check(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

function crc16(bytes, len) {
    let c = 0xFFFF;
    for (let i = 0; i < len; i++) {
        c ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return c & 0xFFFF;
}

// Build a payload from named values using the spec's OWN offsets, so the fixture cannot drift
// from the layout either - only values are hand-written here, never a position.
function buildPayload(spec, values) {
    const d = new Array(spec.length).fill(0);
    const put = (off, type, v) => {
        if (type === 'u8') { d[off] = v & 0xFF; return; }
        const u = v & 0xFFFF;
        d[off] = u & 0xFF; d[off + 1] = (u >> 8) & 0xFF;
    };
    const known = new Set(spec.fields.map(f => f.name));
    Object.keys(values).forEach(k => {
        if (!known.has(k)) throw new Error(`fixture sets '${k}', which is not a field in the spec`);
    });
    spec.fields.forEach(f => { if (values[f.name] !== undefined) put(f.offset, f.type, values[f.name]); });
    d[0] = spec.magic[0]; d[1] = spec.magic[1]; d[2] = spec.schema;
    const c = crc16(d, spec.crc.over);
    d[spec.crc.offset] = c & 0xFF; d[spec.crc.offset + 1] = (c >> 8) & 0xFF;
    return d;
}

// can_multiframe.c framing, so the PowerShell decoder runs on a real log file.
function writeLog(payload, file) {
    const n = (payload.length % 8) ? Math.floor(payload.length / 8) : Math.floor(payload.length / 8) - 1;
    const hex = a => a.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const id4 = v => v.toString(16).toUpperCase().padStart(4, '0');
    const rows = ['[14:00:00]\t[INFO]\t900000\tID:822C602D\tDLC:1\tData:' + hex([payload.length])];
    for (let i = 0; i < n; i++) {
        rows.push(`[14:00:00]\t[INFO]\t${900001 + i}\tID:822D${id4(i)}\tDLC:8\tData:` + hex(payload.slice(i * 8, i * 8 + 8)));
    }
    const rem = (payload.length % 8) || 8;
    rows.push(`[14:00:00]\t[INFO]\t${900001 + n}\tID:822E${id4(n)}\tDLC:${rem}\tData:` + hex(payload.slice(n * 8, n * 8 + rem)));
    fs.writeFileSync(file, rows.join('\n') + '\n');
}

function runPs(logFile) {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', PS_DECODER, '-Log', logFile, '-OutputJson'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const start = out.indexOf('[');
    const objStart = out.indexOf('{');
    const from = (start >= 0 && (objStart < 0 || start < objStart)) ? start : objStart;
    if (from < 0) throw new Error('PowerShell decoder produced no JSON:\n' + out);
    const parsed = JSON.parse(out.slice(from));
    return Array.isArray(parsed) ? parsed : [parsed];
}

// --- fixture vocabulary --------------------------------------------------------------------
const IOFF = { A: 2020, B: 2028, C: 2012 };           // inc/config.h, written once in adc_config()
const FLAG = { VALID: 0x01, TIMEOUT: 0x02, NEUTRAL: 0x04, FOC: 0x08, DIAG: 0x10 };
const GOOD_FLAGS = FLAG.VALID | FLAG.NEUTRAL | FLAG.FOC;

// A successful calibration, using the settled JDR measured on the bike (FW-126.5).
function report(over) {
    const jdr = (over && over._jdr) || { A: -16, B: -5, C: 8 };
    const base = {
        flags: GOOD_FLAGS, state: 3, failure_reason: 0, source: 1, attempts: 1,
        cycles: 47, stable_count: 8, eligible: 32, restarts: 0,
        gate_stable_cycles: 8, gate_collect_samples: 32,
        gate_max_cycles: 256, gate_residual_window: 300,
    };
    ['A', 'B', 'C'].forEach(p => {
        base['offset_' + p] = jdr[p];
        base['mean_' + p] = jdr[p];
        base['min_' + p] = jdr[p] - 2;
        base['max_' + p] = jdr[p] + 2;
        base['p2p_' + p] = 4;
        base['ioff_' + p] = IOFF[p];
        base['midpoint_' + p] = IOFF[p] + jdr[p];
    });
    const o = Object.assign(base, over);
    delete o._jdr;
    return o;
}

(async () => {
    const spec = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const M = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'evistdrive', 'fw126-decode.js')).href);

    // ---- 1. the JS mirror must equal the JSON spec ---------------------------------------
    {
        const js = M.CAL_SCHEMA;
        eq(js.schema, spec.schema, 'S1. schema version matches the spec');
        eq(js.length, spec.length, 'S2. payload length matches');
        eq(js.fields.length, spec.fields.length, 'S3. field count matches');
        const bad = [];
        spec.fields.forEach((f, i) => {
            const m = js.fields[i];
            if (!m || m.name !== f.name || m.offset !== f.offset || m.type !== f.type) {
                bad.push(f.name + ' (spec ' + f.offset + '/' + f.type + ' vs js ' +
                    (m ? m.offset + '/' + m.type : 'missing') + ')');
            }
        });
        check(bad.length === 0, 'S4. every field matches the spec: ' + bad.join(', '));
        eq(js.crc.offset, spec.crc.offset, 'S5. CRC offset matches');
        eq(js.crc.over, spec.crc.over, 'S6. CRC coverage matches');
        eq(M.DUMP_LEN, spec.length, 'S7. the assembler expects the spec length');
        const last = spec.fields[spec.fields.length - 1];
        check(last.offset < spec.crc.offset, 'S8. the last field ends before the CRC');
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fw1267-'));
    const cases = [
        { name: 'a clean calibration', want: true, v: report({}) },
        /*
         * M1 - THE OLD DEFECT, as a fixture. This is what every calibration before FW-126.7
         * produced: a stable, self-consistent, entirely wrong measurement of a saturated
         * amplifier. In the JDR domain it looks fine; the physical result gives it away.
         */
        { name: 'the saturated dark measurement', want: false,
          v: report({ _jdr: { A: 1854, B: 1882, C: 1886 } }) },
        { name: 'never reached VALID', want: false,
          v: report({ state: 1, flags: GOOD_FLAGS & ~FLAG.VALID }) },
        { name: 'timed out', want: false,
          v: report({ state: 4, failure_reason: 1, flags: (GOOD_FLAGS & ~FLAG.VALID) | FLAG.TIMEOUT,
                      cycles: 256, eligible: 0 }) },
        { name: 'the bridge was not neutral', want: false,
          v: report({ state: 4, failure_reason: 4, flags: GOOD_FLAGS & ~FLAG.NEUTRAL }) },
        { name: 'too few eligible samples', want: false, v: report({ eligible: 7 }) },
        { name: 'too noisy', want: false,
          v: report({ p2p_A: 900, min_A: -400, max_A: 500 }) },
        { name: 'the DIAG post-validation stop was spent', want: true,
          v: report({ flags: GOOD_FLAGS | FLAG.DIAG }) },
        /*
         * M2 - the midpoint check ISOLATED. The saturated fixture above already fails on the
         * residual window, so it never exercises this check on its own. Here the JDR statistics
         * are perfectly healthy and only the PHYSICAL operating point is wrong - which is what a
         * mis-programmed IOFF, or a sense amplifier that moved, would actually look like.
         * Without this case a decoder could drop the midpoint check entirely and stay green.
         */
        { name: 'healthy JDR but the physical operating point is wrong', want: false,
          v: report({ midpoint_A: 3900, midpoint_B: 3910, midpoint_C: 3890 }) },
    ];

    cases.forEach((c, idx) => {
        const payload = buildPayload(spec, c.v);
        const js = M.decodeCal(payload);
        eq(js.pass, c.want, `G${idx + 1}a. JS verdict: ${c.name}`);
        check(js.crcOk && js.magicOk, `G${idx + 1}b. golden payload is well formed`);

        const logFile = path.join(tmp, `case${idx}.log`);
        writeLog(payload, logFile);
        const ps = runPs(logFile);
        check(ps.length === 1, `G${idx + 1}c. PowerShell decoded exactly one transfer`);
        if (ps.length !== 1) return;
        const p = ps[0].dump;
        const pchecks = ps[0].checks || [];

        // THE PARITY CHECK the previous defect would have failed loudly.
        eq(p.schema, js.schema, `G${idx + 1}d. schema agrees`);
        eq(p.crc_ok, js.crcOk, `G${idx + 1}e. CRC verdict agrees`);
        eq(p.state, js.state, `G${idx + 1}f. state agrees`);
        eq(p.failure, js.failure, `G${idx + 1}g. failure reason agrees`);
        eq(p.eligible, js.eligible, `G${idx + 1}h. eligible count agrees`);
        eq(p.valid, js.valid, `G${idx + 1}i. valid flag agrees`);
        eq(p.neutral_ok, js.neutralOk, `G${idx + 1}j. neutral flag agrees`);
        eq(p.timeout_hit, js.timeoutHit, `G${idx + 1}k. timeout flag agrees`);
        [0, 1, 2].forEach(i => {
            const ph = spec.phases[i];
            eq(p.offset[i], js.offset[i], `G${idx + 1}l${i}. software offset ${ph} agrees`);
            eq(p.mean[i], js.mean[i], `G${idx + 1}m${i}. JDR mean ${ph} agrees`);
            eq(p.p2p[i], js.p2p[i], `G${idx + 1}n${i}. JDR P2P ${ph} agrees`);
            eq(p.ioff[i], js.ioff[i], `G${idx + 1}o${i}. hardware IOFF ${ph} agrees`);
            eq(p.midpoint[i], js.midpoint[i], `G${idx + 1}p${i}. physical ADC ${ph} agrees`);
        });
        const psPass = pchecks.length > 0 && pchecks.every(x => x.pass);
        eq(psPass, js.pass, `G${idx + 1}q. PowerShell overall verdict equals the JS one`);
    });

    // ---- the domains must not be conflated ------------------------------------------------
    {
        const js = M.decodeCal(buildPayload(spec, report({})));
        eq(js.mean[0], -16, 'D1. JDR mean is the signed residual');
        eq(js.midpoint[0], 2004, 'D2. physical ADC = IOFF + JDR, a different number');
        eq(js.offset[0], -16, 'D3. the software offset is what the ISR subtracts from JDR');
        check(js.midpoint[0] !== js.mean[0], 'D4. the two domains are not the same value');
        const sat = M.decodeCal(buildPayload(spec, report({ _jdr: { A: 1854, B: 1882, C: 1886 } })));
        const mid = sat.checks.find(c => c.name === 'midpoint sanity');
        check(mid && !mid.pass, 'D5. the saturated fixture fails on the PHYSICAL result...');
        const noise = sat.checks.find(c => c.name === 'noise');
        check(noise && noise.pass, 'D6. ...while still passing the noise check, exactly as it used to');
    }

    // ---- hard fail on an unreadable payload, in BOTH decoders ------------------------------
    {
        const bad = buildPayload(spec, report({}));
        bad[2] = 99;
        const c = crc16(bad, spec.crc.over);
        bad[spec.crc.offset] = c & 0xFF; bad[spec.crc.offset + 1] = (c >> 8) & 0xFF;
        const js = M.decodeCal(bad);
        eq(js.verdict, 'REFUSED', 'H1. JS refuses an unknown schema');
        check(js.hardFail === true, 'H2. ...as a hard fail');
        check(js.fields === undefined, 'H3. ...and decodes no fields from it');
        const logFile = path.join(tmp, 'future.log');
        writeLog(bad, logFile);
        eq(runPs(logFile)[0].dump.verdict, 'REFUSED', 'H4. PowerShell refuses it too');
    }
    {
        // A SUPERSEDED schema is refused just as hard - reading schema 1 with schema 2 offsets
        // is precisely the failure this whole rule was written after.
        const old = buildPayload(spec, report({}));
        old[2] = 1;
        const c = crc16(old, spec.crc.over);
        old[spec.crc.offset] = c & 0xFF; old[spec.crc.offset + 1] = (c >> 8) & 0xFF;
        eq(M.decodeCal(old).verdict, 'REFUSED', 'H5. JS refuses a superseded schema');
        const logFile = path.join(tmp, 'old.log');
        writeLog(old, logFile);
        eq(runPs(logFile)[0].dump.verdict, 'REFUSED', 'H6. PowerShell refuses it too');
    }
    {
        const bad = buildPayload(spec, report({}));
        bad[1] = 0x5A;
        const c = crc16(bad, spec.crc.over);
        bad[spec.crc.offset] = c & 0xFF; bad[spec.crc.offset + 1] = (c >> 8) & 0xFF;
        eq(M.decodeCal(bad).verdict, 'REFUSED', 'H7. JS refuses a bad magic');
    }
    {
        const corrupt = buildPayload(spec, report({}));
        corrupt[spec.crc.offset] ^= 0xFF;
        const js = M.decodeCal(corrupt);
        check(js.crcOk === false, 'H8. JS reports the CRC mismatch');
        check(js.pass === false, 'H9. ...and a corrupt report never passes');
        const logFile = path.join(tmp, 'corrupt.log');
        writeLog(corrupt, logFile);
        eq(runPs(logFile)[0].dump.crc_ok, false, 'H10. PowerShell reports it too');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures === 0
        ? 'FW-126.7 calibration parity: ALL CHECKS PASSED (JS and PowerShell agree on every field)'
        : `FW-126.7 calibration parity: ${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
