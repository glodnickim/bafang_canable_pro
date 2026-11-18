// evistdrive/v3-model-protocol.js — the ONE module that speaks the V3 model protocol.
//
// Specification: integration/roadmap/V3_MODEL_CAN_PROTOCOL_PL.md (object 4, transport) with the
// changes of integration/roadmap/V3_PLAN_WDROZENIA_20261114_PL.md ("Kontrakt CAN, zmiany"):
//   object 4 schema_version 2 — 12-byte level record, byte 10 = `range` (0xFF = KEEP),
//   byte 11 reserved = 0 (even lengths 30/42/54/66/78 keep the transport length rule);
//   object 5 "rowerzysta i sprzęt V3" schema_version 1 — 8 data bytes, total_len 26;
//   capability bit 11 = object 5. Since OWNER-DEC-20261115-PRESSURE-HOLD (model podtrzymania,
//   integration/roadmap/V3_NACISK_PODTRZYMANIE_20261115_PL.md) the same 26 bytes carry
//   strength u16 | Iq_min at <= 30 rpm u16 | Iq_min at >= 60 rpm u16 | flags (bit 0 effort map,
//   bit 1 hold model v2) | t_hold in 100 ms (5..40; formerly a reserved zero byte), announced by
//   capability bit 12 (LEAD-DEC-20261115-HOLD-FIX M3). Without bit 12 the firmware has the C1 layout
//   (Iq_off / Iq_on, byte 7 reserved zero): this tool shows it, keeps Iq_off / Iq_on read-only and
//   writes it back unchanged with the strength / effort-map edits.
// Transport of the V3 config (0x6035 CAPS, 0x6036 block, 0x6037 control). No DOM and no imports,
// so the node tests load this file directly.
//
// The model: per HMI level (1..5) one record — a mode (ECO..AUTO), six corrections 0..100
// (50 = the mode default) plus Max Power (W, 65000 = hardware limit) and Max Torque (% of
// allowed Iq). Variant A: multiplier 2^((x-50)/50), so 0 -> x0.5, 50 -> x1, 100 -> x2.

export const LEVEL_COUNT = 5;
export const HW_POWER_W = 65000;
export const KEEP_BYTE = 0xFF;
export const KEEP_POWER = 0xFFFE;
export const OBJECT_MODEL = 4;
export const OBJECT_RIDER = 5;
/** Object 4 version this tool writes. Version 1 (no `range`) is still decoded on read. */
export const SCHEMA_VERSION = 2;
export const SUPPORTED_MODEL_SCHEMAS = Object.freeze([1, 2]);
export const RIDER_SCHEMA_VERSION = 1;
export const RECORD_STRIDE_V1 = 10;
export const RECORD_STRIDE = 12;
/** Effective view adds 10 bytes after the base record (20 B in schema 1, 22 B in schema 2). */
export const EFFECTIVE_EXTRA = 10;
export const EFFECTIVE_STRIDE = RECORD_STRIDE_V1 + EFFECTIVE_EXTRA; // schema 1 value, kept for callers
export const HEADER_LEN = 16;
export const RIDER_STRIDE = 8;
export const RIDER_LEN = HEADER_LEN + RIDER_STRIDE + 2; // 26
export const CAP_MODEL = 1 << 8;
export const CAP_MODEL_EFFECTIVE = 1 << 9;
export const CAP_MODEL_WRITABLE = 1 << 10;
export const CAP_RIDER = 1 << 11;
/** Object 5 in the hold model layout (Iq_min, t_hold). Absent: C1 layout of older firmware. */
export const CAP_RIDER_HOLD = 1 << 12;
/** Object 5 flag bit 2 = effort map v2 (ceiling P, progressive curve), firmware 0.709+. */
export const CAP_RIDER_MAP_V2 = 1 << 13;
/** Firmware 0.709+: Wsparcie (mode ratio x Assist multiplier) capped at ASSIST_MAX_PCT
 *  (OWNER-DEC-20261118-ASSIST-800). Without the bit the controller applies the full x2. */
export const CAP_ASSIST_800 = 1 << 14;
export const ASSIST_MAX_PCT = 800;
let assistCap = true; // factory preview = newest firmware; set from CAPS after a read
export function setAssistCap(on) { assistCap = !!on; }
export const assistCapActive = () => assistCap;
/** Transport declaration: one length byte > 8; the firmware staging buffer holds 90 B. */
export const MAX_OBJECT_LEN = 90;

export const VIEW = Object.freeze({ SAVED: 0, EFFECTIVE: 1, FACTORY: 2, CONFIGURED: 3 });
export const OP = Object.freeze({
    PERSIST: 1, REVERT: 2, RESTORE_ALL_V3: 3, RESTORE_MODE: 4, RESTORE_MODEL: 5, RESTORE_LEVEL: 6,
});
export const REASON_TEXT = Object.freeze({
    0: 'nieznana wersja schematu lub zły nagłówek',
    1: 'zła długość, liczba poziomów albo numer poziomu w rekordzie',
    2: 'zły CRC',
    3: 'wartość poza zakresem',
    4: 'firmware nie obsługuje tego obiektu',
    5: 'kanał zajęty (inny właściciel transferu)',
    6: 'nieaktualna generacja (ktoś zmienił ustawienia w międzyczasie)',
    7: 'zarezerwowane bity',
});

// Per mode: the firmware v3_model_defaults[] (ratio %, attack/release ms of the full scale,
// internal profile values for start/carry) plus the plan defaults of 2026-11-14:
// Max Power / Max Torque, the effort map (`s` = share of full scale at full effort, `eFull` =
// effort at which the output reaches 100 %) and Start `fFullKg` (pedal force for the full
// start target). Firmware stays the source of truth; the panel shows what it reads back.
export const MODES = Object.freeze([
    { id: 0, name: 'ECO', short: 'E', ratio: 95, attackMs: 3500, releaseMs: 2334, start: 40, carry: 20, powerPct: 50, torquePct: 80, s: 0.15, eFull: 1.0, fFullKg: 35 },
    { id: 1, name: 'TRAIL', short: 'T', ratio: 215, attackMs: 2800, releaseMs: 1867, start: 60, carry: 70, powerPct: 75, torquePct: 100, s: 0.33, eFull: 1.0, fFullKg: 28 },
    { id: 2, name: 'SPORT', short: 'S', ratio: 310, attackMs: 2200, releaseMs: 1467, start: 80, carry: 50, powerPct: 100, torquePct: 100, s: 0.47, eFull: 0.9, fFullKg: 24 },
    { id: 3, name: 'SPORT+', short: 'S+', ratio: 525, attackMs: 1100, releaseMs: 734, start: 90, carry: 80, powerPct: 100, torquePct: 100, s: 0.77, eFull: 0.75, fFullKg: 20, progressive: true },
    { id: 4, name: 'BOOST', short: 'B', ratio: 525, attackMs: 1300, releaseMs: 867, start: 80, carry: 50, powerPct: 100, torquePct: 100, s: 1.0, eFull: 0.6, fFullKg: 16 },
    { id: 5, name: 'AUTO', short: 'AUTO', ratio: 215, attackMs: 2800, releaseMs: 1867, start: 60, carry: 60, powerPct: 75, torquePct: 100, s: 0.33, eFull: 1.0, fFullKg: 28 },
]);

// Firmware (05dd914, OWNER-DEC-20261114): a mode's default Max Power is a share of the battery power
// = configured battery current x selected nominal voltage (P1). Before a read the panel previews it with
// the firmware's own fallback 15 A x 48 V; after a read the levels come from the controller.
export const POWER_SOURCE_DEFAULT = Object.freeze({ currentMa: 15000, voltageV: 48 });
let powerSource = { ...POWER_SOURCE_DEFAULT };
export function setPowerSource(currentMa, voltageV) {
    if (currentMa > 0 && voltageV > 0) powerSource = { currentMa, voltageV };
}
export function modeDefaultPowerW(modeId) {
    const mode = MODES[modeId] ?? MODES[0];
    const w = Math.round(powerSource.currentMa * powerSource.voltageV * mode.powerPct / 100000);
    return Math.max(1, Math.min(w, HW_POWER_W));
}

export const CORRECTIONS = Object.freeze(['assist', 'attack', 'release', 'start', 'carry', 'range']);
const LEVEL_KEYS = Object.freeze(['mode', ...CORRECTIONS, 'maxPowerW', 'maxTorquePct']);

/** Factory preset: level i -> mode i (ECO..BOOST), all corrections 50, mode default limits. */
export function factoryLevels() {
    return Array.from({ length: LEVEL_COUNT }, (_, index) => {
        const mode = MODES[index];
        return {
            mode: mode.id, assist: 50, attack: 50, release: 50, start: 50, carry: 50, range: 50,
            maxPowerW: modeDefaultPowerW(mode.id), maxTorquePct: mode.torquePct,
        };
    });
}

export function cloneLevels(levels) {
    return levels.map((level) => ({ ...level }));
}

// ---- rider and hardware (object 5) --------------------------------------------------------

export const RIDER_FLAG_EFFORT_MAP = 0x01;
export const RIDER_FLAG_HOLD_MODEL = 0x02;
export const RIDER_FLAG_MAP_V2 = 0x04;
/** Firmware PH_CURRENT_MAX: the Iq scale the minimum percentages refer to. */
export const PHASE_CURRENT_MAX_IQ = 700;
export const RIDER_LIMITS = Object.freeze({
    strengthMin: 100, strengthMax: 600, iqMinMax: 120, tHoldMin: 5, tHoldMax: 40,
});
/** Hold model cadence points: Iq_min low at <= 30 rpm, high at >= 60 rpm, linear in between. */
export const HOLD_RPM_LOW = 30;
export const HOLD_RPM_HIGH = 60;
export const HOLD_T_CAP_S = 4;

export function factoryRider() {
    return { riderStrengthX10kg: 300, iqMinLow: 28, iqMinHigh: 42, effortMap: true, holdModel: true, tHold100ms: 20, mapV2: true };
}

/** Factory object 5 of firmware before the hold model (C1 layout, no capability bit 12). */
export function factoryLegacyRider() {
    return { legacy: true, riderStrengthX10kg: 300, lowAssistOffIq: 40, lowAssistOnIq: 55, effortMap: true };
}

export function validateRider(rider) {
    const errors = [];
    const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!intIn(rider?.riderStrengthX10kg, RIDER_LIMITS.strengthMin, RIDER_LIMITS.strengthMax)) errors.push('Siła rowerzysty: 10,0..60,0 kg');
    if (rider?.legacy) {
        if (!intIn(rider.lowAssistOffIq, 0, 200) || !intIn(rider.lowAssistOnIq, rider.lowAssistOffIq ?? 0, 250)) errors.push('C1 Iq_off/Iq_on poza zakresem starego firmware');
        if (typeof rider.effortMap !== 'boolean') errors.push('Mapa wysiłku: wł./wył.');
        return errors;
    }
    if (!intIn(rider?.iqMinHigh, 0, RIDER_LIMITS.iqMinMax)) errors.push('Minimum Iq przy ≥60 obr/min: 0..120');
    if (!intIn(rider?.iqMinLow, 0, Number.isInteger(rider?.iqMinHigh) ? Math.min(rider.iqMinHigh, RIDER_LIMITS.iqMinMax) : RIDER_LIMITS.iqMinMax)) errors.push('Minimum Iq przy ≤30 obr/min: 0..120, nie więcej niż przy ≥60 obr/min');
    if (!intIn(rider?.tHold100ms, RIDER_LIMITS.tHoldMin, RIDER_LIMITS.tHoldMax)) errors.push('Czas bez nacisku: 0,5..4,0 s');
    if (typeof rider?.effortMap !== 'boolean') errors.push('Mapa wysiłku: wł./wył.');
    if (typeof rider?.holdModel !== 'boolean') errors.push('Minimum wsparcia: wł./wył.');
    if (rider?.mapV2 !== undefined && typeof rider.mapV2 !== 'boolean') errors.push('Nowa mapa nacisku: wł./wył.');
    return errors;
}

export function ridersEqual(a, b) {
    if (!a || !b || !!a.legacy !== !!b.legacy) return false;
    const keys = a.legacy ? ['riderStrengthX10kg', 'lowAssistOffIq', 'lowAssistOnIq', 'effortMap']
        : ['riderStrengthX10kg', 'iqMinLow', 'iqMinHigh', 'effortMap', 'holdModel', 'tHold100ms', 'mapV2'];
    return keys.every((k) => a[k] === b[k]);
}

// ---- math -------------------------------------------------------------------------------

/** Variant A multiplier in Q16, rounded like the firmware table (e.g. 0 -> 32768, 100 -> 131072). */
export function multiplierQ16(correction) {
    const x = Math.min(100, Math.max(0, Math.trunc(correction)));
    return Math.round(Math.pow(2, (x - 50) / 50) * 65536);
}

export function multiplier(correction) {
    return multiplierQ16(correction) / 65536;
}

/**
 * What a level resolves to before the hard limits and safety cut-offs (same formulas as the
 * firmware v3_model_effective(); the model is a request, other limiters may slow it down).
 * Attack/Release multiply SPEED, so the time is divided by the multiplier. Start and Carry
 * are internal profile values 0..100-ish (not ms), and 0 switches them off.
 */
export function effectiveValues(level) {
    const mode = MODES[level.mode];
    if (!mode) return null;
    const m = (key) => multiplierQ16(level[key]);
    const q = 65536;
    const ratioQ16 = mode.ratio * m('assist');
    return {
        ratioPct: assistCap ? Math.min(ratioQ16 / q, ASSIST_MAX_PCT) : ratioQ16 / q,
        // S+: the ratio is the ceiling; the progression slope scales the same way.
        slope: mode.progressive ? (524 * m('assist') + 100) / 200 / q : null,
        attackMs: Math.floor((mode.attackMs * q + m('attack') / 2) / m('attack')),
        releaseMs: Math.floor((mode.releaseMs * q + m('release') / 2) / m('release')),
        start: level.start === 0 ? 0 : Math.floor((mode.start * m('start') + 32768) / q),
        carry: level.carry === 0 ? 0 : Math.floor((mode.carry * m('carry') + 32768) / q),
        eFull: effortFull(level),
        maxPowerW: level.maxPowerW,
        maxTorquePct: level.maxTorquePct,
    };
}

// Effort map (plan: "Mapa wysiłku: definicja", LEAD-DEC-20261114-EFFORT-MAP-DEF).
export const EFFORT_KNEE_X = 0.6;
export const EFFORT_KNEE_U = 0.8;
export const EFFORT_CADENCE_CAP = 150;
export const EFFORT_CADENCE_ZERO = 190;

/** T_max(cad) = T0 * (1 - min(cad,150)/190), in CONTROL kg (CLU / 100, what firmware compares). */
export function tMaxKg(cadenceRpm, t0Kg) {
    return t0Kg * (1 - Math.min(Math.max(cadenceRpm, 0), EFFORT_CADENCE_CAP) / EFFORT_CADENCE_ZERO);
}

// ---- control kg (CLU / 100) <-> physical kg ------------------------------------------------
// The firmware never compares kilograms: "Twoja siła" (T0 x 10), the effort full scale and the Kop
// full force are control load units (CLU) of the FROZEN control characteristic
// (torque_input.h TORQUE_CTRL_*: 146 native -> 600 CLU, 1580 -> 8400). What the rider presses is
// read from the measured kg table (TORQUE_CURVE_P*: 20 -> 3 kg, 185 -> 9.5 kg, 780 -> 20 kg,
// extrapolated above). Both meet in the sensor's native delta, as torque_input_centikg_to_ctrl().
// REVIEW-EVD-V3-PRESSURE-AGENT2-20261118: T0 30 = 16.6 kg, 60 = 26.3 kg (= sensor saturation).
const CTRL_BREAK = [146, 600], CTRL_HIGH = [1580, 8400];
const KG_CURVE = [[0, 0], [20, 3], [185, 9.5], [780, 20]];
function cluToNative(clu) {
    if (clu <= CTRL_BREAK[1]) return clu * CTRL_BREAK[0] / CTRL_BREAK[1];
    return CTRL_BREAK[0] + (clu - CTRL_BREAK[1]) * (CTRL_HIGH[0] - CTRL_BREAK[0]) / (CTRL_HIGH[1] - CTRL_BREAK[1]);
}
function nativeToClu(n) {
    if (n <= CTRL_BREAK[0]) return n * CTRL_BREAK[1] / CTRL_BREAK[0];
    return CTRL_BREAK[1] + (n - CTRL_BREAK[0]) * (CTRL_HIGH[1] - CTRL_BREAK[1]) / (CTRL_HIGH[0] - CTRL_BREAK[0]);
}
function piecewise(points, v, from, to) {
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (v <= b[from] || i === points.length - 1) return a[to] + (v - a[from]) * (b[to] - a[to]) / (b[from] - a[from]);
    }
    return 0;
}
/** Control kg (CLU / 100) -> physical kg on the pedal. */
export function ctrlKgToKg(ctrlKg) {
    return ctrlKg > 0 ? piecewise(KG_CURVE, cluToNative(ctrlKg * 100), 0, 1) : 0;
}
/** Physical kg -> control kg (CLU / 100). */
export function kgToCtrlKg(kg) {
    return kg > 0 ? nativeToClu(piecewise(KG_CURVE, kg, 1, 0)) / 100 : 0;
}

/** e_full = e_full(mode) / 2^((range-50)/50): range above 50 -> full output at less effort. */
export function effortFull(level) {
    const mode = MODES[level.mode];
    const range = Number.isInteger(level.range) && level.range <= 100 ? level.range : 50;
    return mode ? mode.eFull / multiplier(range) : null;
}

/** Firmware map v1 output full scale is V3_E2_FULL = 0.65 x P; map v2 (0.709+) reaches P. */
export const MAP_V1_CEILING = 0.65;

/** u(x). v1: linear to the knee (0.6 -> 0.8), then 0.5 slope. v2 (progressive): 0.6x to x = 0.5
 *  (u = 0.3), then 0.3 + 1.4 (x - 0.5). Both 1 from x >= 1. */
export function effortCurve(x, mapV2 = false) {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    if (mapV2) return x <= 0.5 ? 0.6 * x : 0.3 + 1.4 * (x - 0.5);
    if (x <= EFFORT_KNEE_X) return x * (EFFORT_KNEE_U / EFFORT_KNEE_X);
    return EFFORT_KNEE_U + (x - EFFORT_KNEE_X) * 0.5;
}
/** x where the curve changes slope. */
export const effortKneeX = (mapV2 = false) => (mapV2 ? 0.5 : EFFORT_KNEE_X);

/** Physical kg at which a level reaches full map output (x = 1) at a cadence. */
export function fullEffortKg(cadenceRpm, level, t0Kg) {
    return ctrlKgToKg(tMaxKg(cadenceRpm, t0Kg) * effortFull(level));
}

/**
 * Effort map output as a share of the allowed phase current P (0..1) for one level:
 *   x = (F / T_max) / e_full in control units (F given in physical kg), base = ceiling * s(mode) * u(x)
 *   (ceiling 0.65 for map v1, 1 for v2), then x Assist multiplier, capped by Max Torque. Max Power
 *   also limits, but it depends on speed and battery voltage, so it is reported separately.
 *   tMax / fullKg / kneeKg are physical kg.
 */
export function effortOutput(forceKg, cadenceRpm, level, t0Kg, mapV2 = false) {
    const mode = MODES[level.mode];
    const tMaxCtrl = tMaxKg(cadenceRpm, t0Kg);
    const eFull = effortFull(level);
    const x = tMaxCtrl > 0 ? (kgToCtrlKg(forceKg) / tMaxCtrl) / eFull : 0;
    const u = effortCurve(x, mapV2);
    const base = (mapV2 ? 1 : MAP_V1_CEILING) * mode.s * u;
    const assisted = base * multiplier(level.assist);
    const cap = level.maxTorquePct / 100;
    return {
        tMax: ctrlKgToKg(tMaxCtrl), fullKg: ctrlKgToKg(tMaxCtrl * eFull),
        kneeKg: ctrlKgToKg(tMaxCtrl * eFull * effortKneeX(mapV2)),
        eFull, x, u, base, assisted, cap, output: Math.min(assisted, cap), capped: assisted > cap,
    };
}

/**
 * Start target (plan step 3): Iq_start = 0.65 P x MaxTorque x min(1, F / F_full), where the Start
 * correction scales F_full (F_full / multiplier) and 0 switches the Start state off. F_full is in
 * control units in firmware (full_force[] CLU); forceKg here is physical. Share of P (0..1).
 */
export function startTarget(forceKg, level) {
    const mode = MODES[level.mode];
    if (!mode || level.start === 0) return 0;
    const fFull = mode.fFullKg / multiplier(level.start);
    return MAP_V1_CEILING * (level.maxTorquePct / 100) * Math.min(1, kgToCtrlKg(Math.max(0, forceKg)) / fFull);
}

/** Physical kg for the full Kop (null when off). */
export function startFullForceKg(level) {
    const mode = MODES[level.mode];
    return mode && level.start !== 0 ? ctrlKgToKg(mode.fFullKg / multiplier(level.start)) : null;
}
/** Start fade with cadence: full up to 25 rpm, 0 at 50 rpm (speed 12 km/h and 4 s also end it). */
export function startFade(cadenceRpm) {
    if (cadenceRpm <= 25) return 1;
    if (cadenceRpm >= 50) return 0;
    return (50 - cadenceRpm) / 25;
}

/**
 * Hold model minimum (replaces C1): Iq_min for a cadence — iqMinLow at <= 30 rpm, iqMinHigh at
 * >= 60 rpm, linear in between (integer division like the firmware). 0 with the hold model off.
 */
export function holdMinimumIq(cadenceRpm, rider) {
    if (!rider.holdModel || !rider.iqMinHigh) return 0;
    if (cadenceRpm <= HOLD_RPM_LOW) return rider.iqMinLow;
    if (cadenceRpm >= HOLD_RPM_HIGH) return rider.iqMinHigh;
    const c = Math.floor(cadenceRpm);
    return rider.iqMinLow + Math.floor((rider.iqMinHigh - rider.iqMinLow) * (c - HOLD_RPM_LOW) / (HOLD_RPM_HIGH - HOLD_RPM_LOW));
}

/** Motor Iq while engaged: max(map request, Iq_min(cadence)); limits still cut it afterwards. */
export function holdOutput(requestIq, cadenceRpm, rider) {
    return Math.max(requestIq, holdMinimumIq(cadenceRpm, rider));
}

/** Seconds without a pressure hit until the hold ends: max(t_hold, one revolution), capped at 4 s. */
export function holdTimeoutS(cadenceRpm, rider) {
    const rev = cadenceRpm > 0 ? 60 / cadenceRpm : HOLD_T_CAP_S;
    return Math.min(HOLD_T_CAP_S, Math.max(rider.tHold100ms / 10, rev));
}

/** Iq as a percentage of PH_CURRENT_MAX (700), one decimal. */
export function iqPercent(iq) {
    return Math.round((iq * 1000) / PHASE_CURRENT_MAX_IQ) / 10;
}

// ---- validation -------------------------------------------------------------------------

/** Same ranges the firmware enforces (reject, never clamp). Returns a list of Polish messages. */
export function validateLevel(level, { allowKeep = false, schemaVersion = SCHEMA_VERSION } = {}) {
    const errors = [];
    const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!intIn(level.mode, 0, MODES.length - 1)) errors.push('tryb poza zakresem 0..5');
    CORRECTIONS.forEach((key) => {
        if (key === 'range' && schemaVersion < 2) return;
        if (allowKeep && level[key] === KEEP_BYTE) return;
        if (!intIn(level[key], 0, 100)) errors.push(`${key}: korekta musi być całkowita 0..100`);
    });
    if (!(allowKeep && level.maxPowerW === KEEP_POWER) && !intIn(level.maxPowerW, 50, HW_POWER_W)) {
        errors.push('Max Power: 50..64999 W albo 65000 (limit sprzętu)');
    }
    if (!(allowKeep && level.maxTorquePct === KEEP_BYTE) && !intIn(level.maxTorquePct, 1, 100)) {
        errors.push('Max Torque: 1..100 %');
    }
    return errors;
}

// ---- wire format ------------------------------------------------------------------------

/** CRC16-CCITT, poly 0x1021, init 0xFFFF — identical to firmware assist_v3_crc16(). */
export function crc16(bytes, length = bytes.length) {
    let crc = 0xFFFF;
    for (let i = 0; i < length; i++) {
        crc ^= bytes[i] << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
}

function header(totalLen, { objectId, schemaVersion, index, count, stride, flags, caps, generation }) {
    const out = new Uint8Array(totalLen);
    out[0] = 0x42; out[1] = 0x56; // 'B','V'
    out[2] = objectId; out[3] = schemaVersion;
    out[4] = totalLen & 0xFF; out[5] = totalLen >> 8;
    out[6] = index; out[7] = count; out[8] = stride; out[9] = flags;
    for (let i = 0; i < 4; i++) out[10 + i] = (caps >>> (8 * i)) & 0xFF;
    out[14] = generation & 0xFF; out[15] = (generation >> 8) & 0xFF;
    return out;
}

function sealCrc(out) {
    const crc = crc16(out, out.length - 2);
    out[out.length - 2] = crc & 0xFF; out[out.length - 1] = crc >> 8;
    return out;
}

export const modelRecordStride = (schemaVersion) => (schemaVersion >= 2 ? RECORD_STRIDE : RECORD_STRIDE_V1);
export const modelObjectLength = (count, schemaVersion = SCHEMA_VERSION) => HEADER_LEN + modelRecordStride(schemaVersion) * count + 2;

/**
 * Build the write object for levels firstLevel..firstLevel+levels.length-1 (1-based).
 * baseGeneration 0xFFFF = no generation check. Throws on any invalid value: nothing is sent
 * that the firmware would have to reject. schemaVersion 2 (default) carries `range`; 1 is
 * only for a firmware that answered reads with version 1.
 */
export function encodeModelWrite(firstLevel, levels, {
    baseGeneration = 0xFFFF, requiredCaps = CAP_MODEL, allowKeep = false, schemaVersion = SCHEMA_VERSION,
} = {}) {
    if (!SUPPORTED_MODEL_SCHEMAS.includes(schemaVersion)) throw new Error(`nieobsługiwana wersja obiektu 4: ${schemaVersion}`);
    if (!Number.isInteger(firstLevel) || firstLevel < 1 || levels.length < 1 || firstLevel + levels.length - 1 > LEVEL_COUNT) {
        throw new Error('zły zakres poziomów');
    }
    levels.forEach((level, i) => {
        const errors = validateLevel(level, { allowKeep, schemaVersion });
        if (errors.length) throw new Error(`Poziom ${firstLevel + i}: ${errors.join('; ')}`);
    });
    const stride = modelRecordStride(schemaVersion);
    const total = modelObjectLength(levels.length, schemaVersion);
    const out = header(total, {
        objectId: OBJECT_MODEL, schemaVersion, index: firstLevel, count: levels.length, stride, flags: 0, caps: requiredCaps, generation: baseGeneration,
    });
    levels.forEach((level, i) => {
        const o = HEADER_LEN + stride * i;
        out[o] = firstLevel + i; out[o + 1] = level.mode;
        out[o + 2] = level.assist; out[o + 3] = level.attack; out[o + 4] = level.release;
        out[o + 5] = level.start; out[o + 6] = level.carry;
        out[o + 7] = level.maxPowerW & 0xFF; out[o + 8] = level.maxPowerW >> 8;
        out[o + 9] = level.maxTorquePct;
        if (schemaVersion >= 2) { out[o + 10] = level.range; out[o + 11] = 0; }
    });
    return sealCrc(out);
}

/** Object 5 write (header index 0, count 1, stride 8, total_len 26). The hold layout requires
 *  capability bit 12, so a firmware without it refuses the write (reason 4) instead of misreading it;
 *  a legacy (C1) rider is written in the old layout with bit 11 only. */
export function encodeRiderWrite(rider, { baseGeneration = 0xFFFF, requiredCaps } = {}) {
    const errors = validateRider(rider);
    if (errors.length) throw new Error(`Rowerzysta i sprzęt: ${errors.join('; ')}`);
    // Bit 2 (map v2) only for a firmware that announced it (rider.mapV2 defined): older firmware
    // rejects unknown flag bits and the capability, so the write stays acceptable there.
    const caps = requiredCaps ?? (rider.legacy ? CAP_RIDER
        : (CAP_RIDER | CAP_RIDER_HOLD | (rider.mapV2 !== undefined ? CAP_RIDER_MAP_V2 : 0)));
    const out = header(RIDER_LEN, {
        objectId: OBJECT_RIDER, schemaVersion: RIDER_SCHEMA_VERSION, index: 0, count: 1, stride: RIDER_STRIDE, flags: 0, caps, generation: baseGeneration,
    });
    const o = HEADER_LEN;
    out[o] = rider.riderStrengthX10kg & 0xFF; out[o + 1] = rider.riderStrengthX10kg >> 8;
    if (rider.legacy) {
        out[o + 2] = rider.lowAssistOffIq & 0xFF; out[o + 3] = rider.lowAssistOffIq >> 8;
        out[o + 4] = rider.lowAssistOnIq & 0xFF; out[o + 5] = rider.lowAssistOnIq >> 8;
        out[o + 6] = rider.effortMap ? RIDER_FLAG_EFFORT_MAP : 0;
        out[o + 7] = 0;
        return sealCrc(out);
    }
    out[o + 2] = rider.iqMinLow & 0xFF; out[o + 3] = rider.iqMinLow >> 8;
    out[o + 4] = rider.iqMinHigh & 0xFF; out[o + 5] = rider.iqMinHigh >> 8;
    out[o + 6] = (rider.effortMap ? RIDER_FLAG_EFFORT_MAP : 0) | (rider.holdModel ? RIDER_FLAG_HOLD_MODEL : 0)
        | (rider.mapV2 ? RIDER_FLAG_MAP_V2 : 0);
    out[o + 7] = rider.tHold100ms;
    return sealCrc(out);
}

/** 4 data bytes of the 0x6036 READ request: [object, index, view, 0]. Object 4: index 0 = all levels. */
export function buildReadRequest(index, view, objectId = OBJECT_MODEL) {
    if (!Object.values(VIEW).includes(view)) throw new Error('zły widok');
    if (objectId === OBJECT_RIDER) {
        if (index !== 0) throw new Error('obiekt 5 ma tylko index 0');
        if (view === VIEW.EFFECTIVE) throw new Error('obiekt 5 nie ma widoku efektywnego');
        return new Uint8Array([OBJECT_RIDER, 0, view, 0]);
    }
    if (objectId !== OBJECT_MODEL) throw new Error('nieobsługiwany obiekt');
    if (!Number.isInteger(index) || index < 0 || index > LEVEL_COUNT) throw new Error('zły numer poziomu');
    if (view === VIEW.EFFECTIVE && index === 0) throw new Error('widok efektywny tylko dla jednego poziomu');
    return new Uint8Array([OBJECT_MODEL, index, view, 0]);
}

/** 4 data bytes of 0x6037: [op, arg, gen_lo, gen_hi]; expectedGeneration 0xFFFF = none. */
export function buildControl(op, arg = 0, expectedGeneration = 0xFFFF) {
    if (op === OP.RESTORE_LEVEL && !(arg >= 1 && arg <= LEVEL_COUNT)) throw new Error('zły numer poziomu');
    if (op !== OP.RESTORE_LEVEL && arg !== 0) throw new Error('argument operacji musi być 0');
    if (![OP.PERSIST, OP.REVERT, OP.RESTORE_ALL_V3, OP.RESTORE_MODEL, OP.RESTORE_LEVEL].includes(op)) throw new Error('nieobsługiwana operacja');
    return new Uint8Array([op, arg, expectedGeneration & 0xFF, (expectedGeneration >> 8) & 0xFF]);
}

/** Split an object into the multiframe transfer: 1-byte length declaration + 8-byte frames. */
export function splitIntoFrames(bytes) {
    if (bytes.length <= 8 || bytes.length > MAX_OBJECT_LEN) throw new Error('długość obiektu poza zakresem transportu');
    const frames = [];
    for (let off = 0, no = 0; off < bytes.length; off += 8, no++) {
        const data = bytes.slice(off, Math.min(off + 8, bytes.length));
        frames.push({ frameNo: no, isEnd: off + 8 >= bytes.length, data });
    }
    return { declaredLength: bytes.length, frames };
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function checkHeader(bytes, objectId, name) {
    if (!bytes || bytes.length < HEADER_LEN + 2) throw new Error('odpowiedź za krótka');
    if (bytes[0] !== 0x42 || bytes[1] !== 0x56) throw new Error('zły magic odpowiedzi');
    if (bytes[2] !== objectId) throw new Error(`to nie jest obiekt ${name}`);
    const totalLen = u16(bytes, 4);
    if (totalLen !== bytes.length) throw new Error('długość w nagłówku różna od odebranej');
    if (u16(bytes, totalLen - 2) !== crc16(bytes, totalLen - 2)) throw new Error('zły CRC odpowiedzi');
    return totalLen;
}

/**
 * Decode a model object reply. Schema 2: stride 12 (views 0/2/3) or 22 (view 1); schema 1:
 * stride 10 / 20, and `range` is unknown (reported as 50 with rangeKnown = false). Throws on
 * any defect, including a schema version this tool does not know.
 */
export function decodeModelObject(bytes) {
    if (bytes && bytes.length >= 4 && bytes[2] === OBJECT_MODEL && !SUPPORTED_MODEL_SCHEMAS.includes(bytes[3])) {
        throw new Error(`nieznana wersja schematu modelu: ${bytes[3]}`);
    }
    const totalLen = checkHeader(bytes, OBJECT_MODEL, 'modelu');
    const schemaVersion = bytes[3];
    const [index, count, stride, view] = [bytes[6], bytes[7], bytes[8], bytes[9]];
    if (!(count >= 1 && count <= LEVEL_COUNT)) throw new Error('zła liczba poziomów');
    const base = modelRecordStride(schemaVersion);
    const expectStride = view === VIEW.EFFECTIVE ? base + EFFECTIVE_EXTRA : base;
    if (stride !== expectStride || totalLen !== HEADER_LEN + stride * count + 2) throw new Error('zły stride lub długość');
    const first = index === 0 ? 1 : index;
    if (first + count - 1 > LEVEL_COUNT) throw new Error('poziomy poza zakresem');
    const levels = [];
    const effective = [];
    for (let i = 0; i < count; i++) {
        const o = HEADER_LEN + stride * i;
        if (bytes[o] !== first + i) throw new Error(`rekord ${i} ma numer poziomu ${bytes[o]}`);
        if (schemaVersion >= 2 && bytes[o + 11] !== 0) throw new Error(`rekord ${i}: ustawiony bajt zarezerwowany`);
        levels.push({
            mode: bytes[o + 1], assist: bytes[o + 2], attack: bytes[o + 3], release: bytes[o + 4],
            start: bytes[o + 5], carry: bytes[o + 6], range: schemaVersion >= 2 ? bytes[o + 10] : 50,
            maxPowerW: u16(bytes, o + 7), maxTorquePct: bytes[o + 9],
        });
        if (view === VIEW.EFFECTIVE) {
            const e = o + base;
            effective.push({
                ratioPct: u16(bytes, e) / 10, slope: u16(bytes, e + 2) / 1000,
                attackMs: u16(bytes, e + 4), releaseMs: u16(bytes, e + 6), start: bytes[e + 8], carry: bytes[e + 9],
            });
        }
    }
    levels.forEach((level, i) => {
        const errors = validateLevel(level, { schemaVersion });
        if (errors.length) throw new Error(`Poziom ${first + i} w odpowiedzi jest niepoprawny: ${errors.join('; ')}`);
    });
    return {
        schemaVersion, rangeKnown: schemaVersion >= 2,
        view, firstLevel: first, count, levels, effective,
        caps: u32(bytes, 10),
        generation: u16(bytes, 14),
    };
}

/** Decode an object 5 reply (26 B). holdLayout = the firmware announced capability bit 12; without
 *  it the reply is the C1 layout (legacy rider). Reserved bits / bytes set = defect. */
export function decodeRiderObject(bytes, { holdLayout = true } = {}) {
    const totalLen = checkHeader(bytes, OBJECT_RIDER, 'rowerzysty');
    if (bytes[3] !== RIDER_SCHEMA_VERSION) throw new Error(`nieznana wersja obiektu 5: ${bytes[3]}`);
    if (totalLen !== RIDER_LEN || bytes[6] !== 0 || bytes[7] !== 1 || bytes[8] !== RIDER_STRIDE) throw new Error('zły nagłówek obiektu 5');
    const o = HEADER_LEN;
    const flags = bytes[o + 6];
    if (!holdLayout) {
        if ((flags & ~RIDER_FLAG_EFFORT_MAP) !== 0 || bytes[o + 7] !== 0) throw new Error('obiekt 5: ustawione zarezerwowane bity');
        const legacy = {
            legacy: true, riderStrengthX10kg: u16(bytes, o), lowAssistOffIq: u16(bytes, o + 2), lowAssistOnIq: u16(bytes, o + 4),
            effortMap: (flags & RIDER_FLAG_EFFORT_MAP) !== 0,
        };
        const legacyErrors = validateRider(legacy);
        if (legacyErrors.length) throw new Error(`Obiekt 5 w odpowiedzi jest niepoprawny: ${legacyErrors.join('; ')}`);
        return { view: bytes[9], rider: legacy, caps: u32(bytes, 10), generation: u16(bytes, 14) };
    }
    if ((flags & ~(RIDER_FLAG_EFFORT_MAP | RIDER_FLAG_HOLD_MODEL | RIDER_FLAG_MAP_V2)) !== 0) throw new Error('obiekt 5: ustawione zarezerwowane bity');
    const caps = u32(bytes, 10);
    const rider = {
        riderStrengthX10kg: u16(bytes, o), iqMinLow: u16(bytes, o + 2), iqMinHigh: u16(bytes, o + 4),
        effortMap: (flags & RIDER_FLAG_EFFORT_MAP) !== 0, holdModel: (flags & RIDER_FLAG_HOLD_MODEL) !== 0,
        tHold100ms: bytes[o + 7],
    };
    // Map v2 exists only on firmware announcing capability bit 13 (or reporting the bit itself).
    if ((caps & CAP_RIDER_MAP_V2) !== 0 || (flags & RIDER_FLAG_MAP_V2) !== 0) rider.mapV2 = (flags & RIDER_FLAG_MAP_V2) !== 0;
    const errors = validateRider(rider);
    if (errors.length) throw new Error(`Obiekt 5 w odpowiedzi jest niepoprawny: ${errors.join('; ')}`);
    return { view: bytes[9], rider, caps, generation: u16(bytes, 14) };
}

/** CAPS (0x6035, 30 B format 2). Returns null for anything that is not a valid CAPS frame. */
export function parseCaps(bytes) {
    if (!bytes || bytes.length !== 30 || bytes[0] !== 0x42 || bytes[1] !== 0x56) return null;
    if (u16(bytes, 28) !== crc16(bytes, 28)) return null;
    const caps = u32(bytes, 12);
    return {
        format: bytes[2], protocolVersion: bytes[3], caps,
        generation: u16(bytes, 20), persistState: bytes[22], flashRecordState: bytes[23],
        engineActive: bytes[24], maxPowerHwW: u16(bytes, 26),
        model: (caps & CAP_MODEL) !== 0,
        modelEffective: (caps & CAP_MODEL_EFFECTIVE) !== 0,
        modelWritable: (caps & CAP_MODEL_WRITABLE) !== 0,
        rider: (caps & CAP_RIDER) !== 0,
        riderHold: (caps & CAP_RIDER_HOLD) !== 0,
        riderMapV2: (caps & CAP_RIDER_MAP_V2) !== 0,
        assistCap800: (caps & CAP_ASSIST_800) !== 0,
    };
}

export const PERSIST_TEXT = Object.freeze({
    0: 'zapisane', 1: 'zmiany w RAM, niezapisane', 2: 'zapis czeka na postój', 3: 'błąd zapisu we flash', 4: 'odrzucone: nieaktualna generacja',
});

// ---- preset file --------------------------------------------------------------------------

export const PRESET_KIND = 'evd-v3-model-preset';

/** The shareable file: modes and corrections only — never hardware settings of one bike. */
export function buildPreset(levels, name = '', note = '') {
    return { kind: PRESET_KIND, version: 2, name, note, levels: cloneLevels(levels) };
}

/** Parse and validate a preset file; throws a Polish message on anything out of range (no clamping). */
export function parsePreset(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('To nie jest poprawny plik JSON.'); }
    if (data?.kind !== PRESET_KIND) throw new Error('To nie jest preset modelu V3.');
    if (data.version !== 1 && data.version !== 2) throw new Error(`Nieznana wersja presetu: ${data.version}`);
    if (!Array.isArray(data.levels) || data.levels.length !== LEVEL_COUNT) throw new Error('Preset musi mieć dokładnie 5 poziomów.');
    const levels = data.levels.map((raw) => ({
        mode: raw?.mode, assist: raw?.assist, attack: raw?.attack, release: raw?.release,
        start: raw?.start, carry: raw?.carry,
        // Version 1 files predate `range`: they mean the mode default.
        range: data.version === 1 && raw?.range === undefined ? 50 : raw?.range,
        maxPowerW: raw?.maxPowerW, maxTorquePct: raw?.maxTorquePct,
    }));
    levels.forEach((level, i) => {
        const errors = validateLevel(level);
        if (errors.length) throw new Error(`Poziom ${i + 1}: ${errors.join('; ')}`);
    });
    return { name: String(data.name || ''), note: String(data.note || ''), levels };
}

// ---- client -----------------------------------------------------------------------------

/** Compare levels; schema 1 carries no `range`, so it is left out of that comparison. */
export function levelsEqual(a, b, { schemaVersion = SCHEMA_VERSION } = {}) {
    const keys = schemaVersion >= 2 ? LEVEL_KEYS : LEVEL_KEYS.filter((k) => k !== 'range');
    return a.length === b.length && a.every((x, i) => keys.every((k) => x[k] === b[i][k]));
}

/**
 * The model client. `transport` implements four async methods that move whole objects
 * (bytes in/out; the multiframe split lives on the server side of the transport):
 *   caps() -> Uint8Array|null        read 0x6035; null when there is no reply
 *   read(requestBytes) -> Uint8Array read 0x6036 ([object, index, view, 0])
 *   write(objectBytes) -> {ok, generation?, reason?, index?}
 *   control(requestBytes) -> {ok, generation?, reason?, index?}
 * Writes are refused unless discover() has seen the matching capability (bit 8 + 10 for
 * object 4, bit 11 for object 5): an old firmware is never sent a command it does not know.
 */
export function createModelClient(transport) {
    let caps = null;
    let modelSchema = SCHEMA_VERSION;
    const blockedModel = () => {
        if (!caps?.model) return { ok: false, reason: 4, text: 'Firmware nie zgłasza obsługi modelu V3 — zapis zablokowany.' };
        if (!caps.modelWritable) return { ok: false, reason: 4, text: 'Firmware zgłasza model tylko do odczytu.' };
        return null;
    };
    const blockedRider = () => (caps?.rider ? null
        : { ok: false, reason: 4, text: 'Firmware nie zgłasza obsługi ustawień rowerzysty (bit 11) — zapis zablokowany.' });
    const failure = (result) => ({
        ok: false, reason: result.reason, index: result.index,
        text: result.text && result.reason === undefined ? result.text
            : `${REASON_TEXT[result.reason] ?? 'błąd'}${result.index ? ` (poziom/indeks ${result.index})` : ''}`,
    });
    return {
        get capabilities() { return caps; },
        get modelSchema() { return modelSchema; },
        async discover() {
            let bytes = null;
            try { bytes = await transport.caps(); } catch { bytes = null; }
            caps = parseCaps(bytes);
            return caps;
        },
        async read(index, view) {
            if (!caps?.model) throw new Error('Firmware nie obsługuje modelu V3');
            if (view === VIEW.EFFECTIVE && !caps.modelEffective) throw new Error('Firmware nie obsługuje widoku efektywnego');
            const decoded = decodeModelObject(await transport.read(buildReadRequest(index, view)));
            modelSchema = decoded.schemaVersion;
            return decoded;
        },
        /** Write levels from firstLevel; reads back the RAM view and compares byte for byte. */
        async write(firstLevel, levels, { baseGeneration = 0xFFFF } = {}) {
            const blocked = blockedModel();
            if (blocked) return blocked;
            const schemaVersion = modelSchema;
            const object = encodeModelWrite(firstLevel, levels, { baseGeneration, schemaVersion });
            const result = await transport.write(object);
            if (!result.ok) return failure(result);
            // index 1..5 reads one level, index 0 all five (spec §4): compare only what was written.
            const back = await this.read(levels.length === 1 ? firstLevel : 0, VIEW.CONFIGURED).catch((error) => ({ error }));
            if (back.error) return { ok: false, text: `Zapis przyjęty, ale odczyt kontrolny się nie udał: ${back.error.message}` };
            const mine = back.count === levels.length ? back.levels : back.levels.slice(firstLevel - 1, firstLevel - 1 + levels.length);
            if (!levelsEqual(mine, levels, { schemaVersion })) return { ok: false, text: 'Odczyt kontrolny różni się od wysłanych wartości.', readback: back };
            return { ok: true, generation: back.generation, schemaVersion };
        },
        async readRider(view = VIEW.CONFIGURED) {
            if (!caps?.rider) throw new Error('Firmware nie obsługuje ustawień rowerzysty (obiekt 5)');
            return decodeRiderObject(await transport.read(buildReadRequest(0, view, OBJECT_RIDER)), { holdLayout: !!caps.riderHold });
        },
        async writeRider(rider, { baseGeneration = 0xFFFF } = {}) {
            const blocked = blockedRider();
            if (blocked) return blocked;
            if (!!rider.legacy === !!caps.riderHold) {
                return { ok: false, reason: 4, text: caps.riderHold ? 'Firmware ma minimum wsparcia (bit 12): odczytaj ustawienia ponownie.' : 'Firmware bez minimum wsparcia (brak bitu 12): wgraj nowe firmware, aby ustawić minimum i czas bez nacisku.' };
            }
            const result = await transport.write(encodeRiderWrite(rider, { baseGeneration }));
            if (!result.ok) return failure(result);
            const back = await this.readRider(VIEW.CONFIGURED).catch((error) => ({ error }));
            if (back.error) return { ok: false, text: `Zapis przyjęty, ale odczyt kontrolny się nie udał: ${back.error.message}` };
            if (!ridersEqual(back.rider, rider)) return { ok: false, text: 'Odczyt kontrolny różni się od wysłanych wartości.', readback: back };
            return { ok: true, generation: back.generation };
        },
        async control(op, arg = 0, expectedGeneration = 0xFFFF) {
            // Persist/revert serve both objects; model presets need the model capability.
            const blocked = (op === OP.PERSIST || op === OP.REVERT)
                ? (blockedModel() && blockedRider() ? blockedModel() : null)
                : blockedModel();
            if (blocked) return blocked;
            const result = await transport.control(buildControl(op, arg, expectedGeneration));
            return result.ok ? { ok: true, generation: result.generation } : failure(result);
        },
        persist(expectedGeneration) { return this.control(OP.PERSIST, 0, expectedGeneration); },
        restoreFactory() { return this.control(OP.RESTORE_MODEL); },
        restoreLevel(level) { return this.control(OP.RESTORE_LEVEL, level); },
    };
}

// ---- WebSocket transport (CANable server) ------------------------------------------------

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

/**
 * Talks to the CANable server (v3-config-server.js) with
 *   V3M_CAPS#<id>   V3M_READ:<obj>:<index>:<view>#<id>   V3M_WRITE:<hex>#<id>
 *   V3M_CONTROL:<op>:<arg>:<gen>#<id>
 * and waits for the JSON `{type:'v3m_reply', id, ok, hex, generation, reason, index}`.
 * The `#<id>` suffix pairs a reply with its request.
 */
export function createSocketTransport(socket, { timeoutMs = 12000 } = {}) {
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string' || !event.data.includes('v3m_reply')) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type !== 'v3m_reply' || !pending.has(message.id)) return;
        const done = pending.get(message.id);
        pending.delete(message.id);
        done(message);
    });
    const call = (command) => new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, timeout: true }); }, timeoutMs);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        socket.send(`${command}#${id}`);
    });
    const failed = (reply) => (reply.timeout ? { ok: false, text: 'brak odpowiedzi serwera lub sterownika' } : reply);
    return {
        async caps() {
            const reply = await call('V3M_CAPS');
            return reply.ok && reply.hex ? fromHex(reply.hex) : null;
        },
        async read(request) {
            const reply = await call(`V3M_READ:${request[0]}:${request[1]}:${request[2]}`);
            if (!reply.ok || !reply.hex) {
                throw new Error(reply.timeout ? 'brak odpowiedzi sterownika'
                    : reply.reason !== undefined ? `odczyt odrzucony: ${REASON_TEXT[reply.reason] ?? `powód ${reply.reason}`}`
                        : `odczyt nieudany: ${reply.error || 'nieznany błąd'}`);
            }
            return fromHex(reply.hex);
        },
        async write(object) { return failed(await call(`V3M_WRITE:${toHex(object)}`)); },
        async control(request) {
            const gen = request[2] | (request[3] << 8);
            return failed(await call(`V3M_CONTROL:${request[0]}:${request[1]}:${gen}`));
        },
    };
}
