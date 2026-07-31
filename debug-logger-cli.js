// FW-027/FW-028 diag: standalone logger for the ride-core runaway debug frames.
// Logs the original gate/request frame (CAN ID 0x00010203) plus the optional
// FOC/PWM extension frame (CAN ID 0x00010204) into one CSV row.
//
// Usage:  node debug-logger-cli.js
// Output: logs/log-<date>-<time>-nN.csv   (Ctrl+C to stop)
//
// 0x00010203 layout (big-endian, matching print_debug_on_CAN in main.c):
//   Data1 [0..1] = iq_setpoint            (motor current request; >0 => motor driven)
//   Data2 [2]    = cadence rpm            ([3] = flags below)
//   Data2 [3]    = flags: b0 forward_pedaling, b1 backward>=4, b2 pwm_on,
//                          b3 cadence_seeded, b4 assist_without_rotation
//   Data3 [4..5] = pas_fwd_accum          (free-running; diff consecutive rows => EMI test)
//   Data4 [6..7] = torque delta           (torque_on_crank - 750; >0 => pedal load present)
//
// 0x00010204 extension layout:
//   Data1 [0..1] = signed actual i_q
//   Data2 [2..3] = u_abs
//   Data3 [4..5] = signed u_q
//   Data4 [6]    = flags2: b0 safety_cut, b1 pwm_on, b2 pwm_cutoff_active,
//                           b3 brake, b4 backward>=4, b5 torque_fault,
//                           b6 battery_current_limit, b7 overrun
//   Data4 [7]    = half-rotation counter in 4 ms units, capped at 1020 ms

const canbus = require('./canbus');
const { formatRawCanFrameData2, setupLogger } = require('./utils');

const DEBUG_MAIN_ID = '10203'; // 0x00010203
const DEBUG_AUX_ID = '10204';  // 0x00010204

let logToFile = null;
let rowCount = 0;
let pendingMain = null;
let lastAux = null;
const t0 = Date.now();

const HEADER = [
    't_ms', 'iq_setpoint', 'cadence', 'ped', 'back', 'pwm', 'seed', 'norot',
    'pas_fwd_accum', 'torque_delta',
    'iq_actual', 'u_abs', 'u_q', 'safety', 'pwm2', 'pwm_cutoff', 'brake',
    'back2', 'tq_fault', 'bc_lim', 'overrun', 'halfrot_ms'
].join(';');

function timestampMs(timestamp) {
    return timestamp ? Math.round(Number(timestamp) / 1000) : (Date.now() - t0);
}

function parseMain(tms, data) {
    const iq = data.getUint16(0, false);
    const d2 = data.getUint16(2, false);
    const cadence = (d2 >> 8) & 0xFF;
    const flags = d2 & 0xFF;
    return {
        tms,
        iq,
        cadence,
        ped: (flags & 0x01) ? 1 : 0,
        back: (flags & 0x02) ? 1 : 0,
        pwm: (flags & 0x04) ? 1 : 0,
        seed: (flags & 0x08) ? 1 : 0,
        norot: (flags & 0x10) ? 1 : 0,
        pas: data.getUint16(4, false),
        torque: data.getUint16(6, false)
    };
}

function parseAux(data) {
    const flags = data.getUint8(6);
    return {
        iq_actual: data.getInt16(0, false),
        u_abs: data.getUint16(2, false),
        u_q: data.getInt16(4, false),
        safety: (flags & 0x01) ? 1 : 0,
        pwm2: (flags & 0x02) ? 1 : 0,
        pwm_cutoff: (flags & 0x04) ? 1 : 0,
        brake: (flags & 0x08) ? 1 : 0,
        back2: (flags & 0x10) ? 1 : 0,
        tq_fault: (flags & 0x20) ? 1 : 0,
        bc_lim: (flags & 0x40) ? 1 : 0,
        overrun: (flags & 0x80) ? 1 : 0,
        halfrot_ms: data.getUint8(7) * 4
    };
}

async function writeCombined(main, aux = lastAux) {
    if (!main || !logToFile) return;
    const a = aux || {};
    const row = [
        main.tms, main.iq, main.cadence, main.ped, main.back, main.pwm,
        main.seed, main.norot, main.pas, main.torque,
        a.iq_actual ?? '', a.u_abs ?? '', a.u_q ?? '', a.safety ?? '',
        a.pwm2 ?? '', a.pwm_cutoff ?? '', a.brake ?? '', a.back2 ?? '',
        a.tq_fault ?? '', a.bc_lim ?? '', a.overrun ?? '', a.halfrot_ms ?? ''
    ].join(';');

    await logToFile(row);
    rowCount++;
    if (rowCount % 25 === 0) {
        process.stdout.write(
            `\r[debug-logger] wierszy: ${rowCount}  iq=${main.iq} cad=${main.cadence} ` +
            `ped=${main.ped} back=${main.back} pwm=${main.pwm} ` +
            `iact=${a.iq_actual ?? '-'} safety=${a.safety ?? '-'}   `);
    }
}

async function onRawFrame(rawFrame) {
    const { idHex, dlc, timestamp, data } = formatRawCanFrameData2(rawFrame);
    if (idHex === 'INVALID' || dlc < 8) return;

    if (idHex.includes(DEBUG_MAIN_ID)) {
        if (pendingMain) await writeCombined(pendingMain, null); // old FW / missing aux frame
        pendingMain = parseMain(timestampMs(timestamp), data);
        return;
    }

    if (idHex.includes(DEBUG_AUX_ID)) {
        lastAux = parseAux(data);
        if (pendingMain) {
            await writeCombined(pendingMain, lastAux);
            pendingMain = null;
        }
    }
}

async function main() {
    const connected = await canbus.init();
    if (!connected) {
        console.error('Nie udalo sie polaczyc z Canable. Sprawdz kabel/urzadzenie.');
        process.exit(1);
    }
    console.log('Canable OK. Loguje ramki debug 0x00010203 + 0x00010204. Ctrl+C konczy.');
    logToFile = await setupLogger('csv', true);
    await logToFile(HEADER);
    canbus.on('raw_frame_received', onRawFrame);
}

async function cleanup() {
    if (pendingMain) {
        await writeCombined(pendingMain, null);
        pendingMain = null;
    }
    console.log(`\nKoniec. Zapisano ${rowCount} wierszy.`);
    canbus.removeListener('raw_frame_received', onRawFrame);
    try { if (canbus.isConnected()) await canbus.close(); } catch { /* already exiting; a failed close changes nothing */ }
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
main();