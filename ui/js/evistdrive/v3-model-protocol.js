// evistdrive/v3-model-protocol.js — the ONE module that speaks the V3 per-level model protocol.
//
// Specification: integration/roadmap/V3_MODEL_CAN_PROTOCOL_PL.md (a PROPOSAL for firmware
// stage 2e). Object 4 of the V3 config transport (0x6035 CAPS, 0x6036 block, 0x6037 control).
// No DOM and no imports, so the node tests load this file directly.
//
// The model: per HMI level (1..5) one record — a mode (ECO..AUTO) and five corrections
// 0..100 (50 = the mode default) plus Max Power (W, 65000 = hardware limit) and Max Torque
// (% of allowed Iq). Variant A: multiplier 2^((x-50)/50), so 0 -> x0.5, 50 -> x1, 100 -> x2.

export const LEVEL_COUNT = 5;
export const HW_POWER_W = 65000;
export const KEEP_BYTE = 0xFF;
export const KEEP_POWER = 0xFFFE;
export const OBJECT_MODEL = 4;
export const SCHEMA_VERSION = 1;
export const RECORD_STRIDE = 10;
export const EFFECTIVE_STRIDE = 20;
export const HEADER_LEN = 16;
export const CAP_MODEL = 1 << 8;
export const CAP_MODEL_EFFECTIVE = 1 << 9;
export const CAP_MODEL_WRITABLE = 1 << 10;

export const VIEW = Object.freeze({ SAVED: 0, EFFECTIVE: 1, FACTORY: 2, CONFIGURED: 3 });
export const OP = Object.freeze({
    PERSIST: 1, REVERT: 2, RESTORE_ALL_V3: 3, RESTORE_MODE: 4, RESTORE_MODEL: 5, RESTORE_LEVEL: 6,
});
export const REASON_TEXT = Object.freeze({
    0: 'nieznana wersja schematu lub zły nagłówek',
    1: 'zła długość, liczba poziomów albo numer poziomu w rekordzie',
    2: 'zły CRC',
    3: 'wartość poza zakresem',
    4: 'firmware nie obsługuje modelu',
    5: 'kanał zajęty (inny właściciel transferu)',
    6: 'nieaktualna generacja (ktoś zmienił model w międzyczasie)',
    7: 'zarezerwowane bity',
});

// Mirrors v3_model_defaults[] in firmware src/v3_model.c (ratio %, attack/release ms of the
// full scale, internal profile values for start/carry, factory limits). Firmware stays the
// source of truth: the panel cross-checks these numbers against the effective view.
export const MODES = Object.freeze([
    { id: 0, name: 'ECO', ratio: 95, attackMs: 3500, releaseMs: 2334, start: 40, carry: 20, powerW: 350, torquePct: 80 },
    { id: 1, name: 'TRAIL', ratio: 215, attackMs: 2800, releaseMs: 1867, start: 60, carry: 70, powerW: HW_POWER_W, torquePct: 100 },
    { id: 2, name: 'SPORT', ratio: 310, attackMs: 2200, releaseMs: 1467, start: 80, carry: 50, powerW: HW_POWER_W, torquePct: 100 },
    { id: 3, name: 'SPORT+', ratio: 525, attackMs: 1100, releaseMs: 734, start: 90, carry: 80, powerW: HW_POWER_W, torquePct: 100, progressive: true },
    { id: 4, name: 'BOOST', ratio: 525, attackMs: 1300, releaseMs: 867, start: 80, carry: 50, powerW: HW_POWER_W, torquePct: 100 },
    { id: 5, name: 'AUTO', ratio: 215, attackMs: 2800, releaseMs: 1867, start: 60, carry: 60, powerW: HW_POWER_W, torquePct: 100 },
]);

export const CORRECTIONS = Object.freeze(['assist', 'attack', 'release', 'start', 'carry']);

/** Factory preset: level i -> mode i (ECO..BOOST), all corrections 50, mode default limits. */
export function factoryLevels() {
    return Array.from({ length: LEVEL_COUNT }, (_, index) => {
        const mode = MODES[index];
        return {
            mode: mode.id, assist: 50, attack: 50, release: 50, start: 50, carry: 50,
            maxPowerW: mode.powerW, maxTorquePct: mode.torquePct,
        };
    });
}

export function cloneLevels(levels) {
    return levels.map((level) => ({ ...level }));
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
        ratioPct: ratioQ16 / q,
        // S+: the ratio is the ceiling; the progression slope scales the same way.
        slope: mode.progressive ? (524 * m('assist') + 100) / 200 / q : null,
        attackMs: Math.floor((mode.attackMs * q + m('attack') / 2) / m('attack')),
        releaseMs: Math.floor((mode.releaseMs * q + m('release') / 2) / m('release')),
        start: level.start === 0 ? 0 : Math.floor((mode.start * m('start') + 32768) / q),
        carry: level.carry === 0 ? 0 : Math.floor((mode.carry * m('carry') + 32768) / q),
        maxPowerW: level.maxPowerW,
        maxTorquePct: level.maxTorquePct,
    };
}

// ---- validation -------------------------------------------------------------------------

/** Same ranges the firmware enforces (reject, never clamp). Returns a list of Polish messages. */
export function validateLevel(level, { allowKeep = false } = {}) {
    const errors = [];
    const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!intIn(level.mode, 0, MODES.length - 1)) errors.push('tryb poza zakresem 0..5');
    CORRECTIONS.forEach((key) => {
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

function header(totalLen, { index, count, stride, flags, caps, generation }) {
    const out = new Uint8Array(totalLen);
    out[0] = 0x42; out[1] = 0x56; // 'B','V'
    out[2] = OBJECT_MODEL; out[3] = SCHEMA_VERSION;
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

/**
 * Build the write object for levels firstLevel..firstLevel+levels.length-1 (1-based).
 * baseGeneration 0xFFFF = no generation check. Throws on any invalid value: nothing is sent
 * that the firmware would have to reject.
 */
export function encodeModelWrite(firstLevel, levels, { baseGeneration = 0xFFFF, requiredCaps = CAP_MODEL, allowKeep = false } = {}) {
    if (!Number.isInteger(firstLevel) || firstLevel < 1 || levels.length < 1 || firstLevel + levels.length - 1 > LEVEL_COUNT) {
        throw new Error('zły zakres poziomów');
    }
    levels.forEach((level, i) => {
        const errors = validateLevel(level, { allowKeep });
        if (errors.length) throw new Error(`Poziom ${firstLevel + i}: ${errors.join('; ')}`);
    });
    const total = HEADER_LEN + RECORD_STRIDE * levels.length + 2;
    const out = header(total, {
        index: firstLevel, count: levels.length, stride: RECORD_STRIDE, flags: 0, caps: requiredCaps, generation: baseGeneration,
    });
    levels.forEach((level, i) => {
        const o = HEADER_LEN + RECORD_STRIDE * i;
        out[o] = firstLevel + i; out[o + 1] = level.mode;
        out[o + 2] = level.assist; out[o + 3] = level.attack; out[o + 4] = level.release;
        out[o + 5] = level.start; out[o + 6] = level.carry;
        out[o + 7] = level.maxPowerW & 0xFF; out[o + 8] = level.maxPowerW >> 8;
        out[o + 9] = level.maxTorquePct;
    });
    return sealCrc(out);
}

/** 4 data bytes of the 0x6036 READ request: [object, index, view, 0]. index 0 = all levels. */
export function buildReadRequest(index, view) {
    if (!Number.isInteger(index) || index < 0 || index > LEVEL_COUNT) throw new Error('zły numer poziomu');
    if (!Object.values(VIEW).includes(view)) throw new Error('zły widok');
    if (view === VIEW.EFFECTIVE && index === 0) throw new Error('widok efektywny tylko dla jednego poziomu');
    return new Uint8Array([OBJECT_MODEL, index, view, 0]);
}

/** 4 data bytes of 0x6037: [op, arg, gen_lo, gen_hi]; expectedGeneration 0xFFFF = none. */
export function buildControl(op, arg = 0, expectedGeneration = 0xFFFF) {
    if (op === OP.RESTORE_LEVEL && !(arg >= 1 && arg <= LEVEL_COUNT)) throw new Error('zły numer poziomu');
    if (![OP.PERSIST, OP.REVERT, OP.RESTORE_ALL_V3, OP.RESTORE_MODEL, OP.RESTORE_LEVEL].includes(op)) throw new Error('nieobsługiwana operacja');
    return new Uint8Array([op, arg, expectedGeneration & 0xFF, (expectedGeneration >> 8) & 0xFF]);
}

/** Split an object into the multiframe transfer: 1-byte length declaration + 8-byte frames. */
export function splitIntoFrames(bytes) {
    if (bytes.length <= 8 || bytes.length > 90) throw new Error('długość obiektu poza zakresem transportu');
    const frames = [];
    for (let off = 0, no = 0; off < bytes.length; off += 8, no++) {
        const data = bytes.slice(off, Math.min(off + 8, bytes.length));
        frames.push({ frameNo: no, isEnd: off + 8 >= bytes.length, data });
    }
    return { declaredLength: bytes.length, frames };
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);

/** Decode a model object reply (views 0/2/3 stride 10, view 1 stride 20). Throws on any defect. */
export function decodeModelObject(bytes) {
    if (!bytes || bytes.length < HEADER_LEN + 2) throw new Error('odpowiedź za krótka');
    if (bytes[0] !== 0x42 || bytes[1] !== 0x56) throw new Error('zły magic odpowiedzi');
    if (bytes[2] !== OBJECT_MODEL) throw new Error('to nie jest obiekt modelu');
    if (bytes[3] !== SCHEMA_VERSION) throw new Error(`nieznana wersja schematu modelu: ${bytes[3]}`);
    const totalLen = u16(bytes, 4);
    const [index, count, stride, view] = [bytes[6], bytes[7], bytes[8], bytes[9]];
    if (totalLen !== bytes.length) throw new Error('długość w nagłówku różna od odebranej');
    if (!(count >= 1 && count <= LEVEL_COUNT)) throw new Error('zła liczba poziomów');
    const expectStride = view === VIEW.EFFECTIVE ? EFFECTIVE_STRIDE : RECORD_STRIDE;
    if (stride !== expectStride || totalLen !== HEADER_LEN + stride * count + 2) throw new Error('zły stride lub długość');
    if (u16(bytes, totalLen - 2) !== crc16(bytes, totalLen - 2)) throw new Error('zły CRC odpowiedzi');
    const first = index === 0 ? 1 : index;
    if (first + count - 1 > LEVEL_COUNT) throw new Error('poziomy poza zakresem');
    const levels = [];
    const effective = [];
    for (let i = 0; i < count; i++) {
        const o = HEADER_LEN + stride * i;
        if (bytes[o] !== first + i) throw new Error(`rekord ${i} ma numer poziomu ${bytes[o]}`);
        levels.push({
            mode: bytes[o + 1], assist: bytes[o + 2], attack: bytes[o + 3], release: bytes[o + 4],
            start: bytes[o + 5], carry: bytes[o + 6], maxPowerW: u16(bytes, o + 7), maxTorquePct: bytes[o + 9],
        });
        if (view === VIEW.EFFECTIVE) {
            effective.push({
                ratioPct: u16(bytes, o + 10) / 10, slope: u16(bytes, o + 12) / 1000,
                attackMs: u16(bytes, o + 14), releaseMs: u16(bytes, o + 16), start: bytes[o + 18], carry: bytes[o + 19],
            });
        }
    }
    levels.forEach((level, i) => {
        const errors = validateLevel(level);
        if (errors.length) throw new Error(`Poziom ${first + i} w odpowiedzi jest niepoprawny: ${errors.join('; ')}`);
    });
    return {
        view, firstLevel: first, count, levels, effective,
        caps: (bytes[10] | (bytes[11] << 8) | (bytes[12] << 16) | (bytes[13] << 24)) >>> 0,
        generation: u16(bytes, 14),
    };
}

/** CAPS (0x6035, 30 B format 2). Returns null for anything that is not a valid CAPS frame. */
export function parseCaps(bytes) {
    if (!bytes || bytes.length !== 30 || bytes[0] !== 0x42 || bytes[1] !== 0x56) return null;
    if (u16(bytes, 28) !== crc16(bytes, 28)) return null;
    const caps = (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24)) >>> 0;
    return {
        format: bytes[2], protocolVersion: bytes[3], caps,
        generation: u16(bytes, 20), persistState: bytes[22], flashRecordState: bytes[23],
        engineActive: bytes[24], maxPowerHwW: u16(bytes, 26),
        model: (caps & CAP_MODEL) !== 0,
        modelEffective: (caps & CAP_MODEL_EFFECTIVE) !== 0,
        modelWritable: (caps & CAP_MODEL_WRITABLE) !== 0,
    };
}

export const PERSIST_TEXT = Object.freeze({
    0: 'zapisane', 1: 'zmiany w RAM, niezapisane', 2: 'zapis czeka na postój', 3: 'błąd zapisu we flash', 4: 'odrzucone: nieaktualna generacja',
});

// ---- preset file --------------------------------------------------------------------------

export const PRESET_KIND = 'evd-v3-model-preset';

/** The shareable file: modes and corrections only — never hardware settings of one bike. */
export function buildPreset(levels, name = '', note = '') {
    return { kind: PRESET_KIND, version: 1, name, note, levels: cloneLevels(levels) };
}

/** Parse and validate a preset file; throws a Polish message on anything out of range (no clamping). */
export function parsePreset(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('To nie jest poprawny plik JSON.'); }
    if (data?.kind !== PRESET_KIND) throw new Error('To nie jest preset modelu V3.');
    if (data.version !== 1) throw new Error(`Nieznana wersja presetu: ${data.version}`);
    if (!Array.isArray(data.levels) || data.levels.length !== LEVEL_COUNT) throw new Error('Preset musi mieć dokładnie 5 poziomów.');
    const levels = data.levels.map((raw) => ({
        mode: raw?.mode, assist: raw?.assist, attack: raw?.attack, release: raw?.release,
        start: raw?.start, carry: raw?.carry, maxPowerW: raw?.maxPowerW, maxTorquePct: raw?.maxTorquePct,
    }));
    levels.forEach((level, i) => {
        const errors = validateLevel(level);
        if (errors.length) throw new Error(`Poziom ${i + 1}: ${errors.join('; ')}`);
    });
    return { name: String(data.name || ''), note: String(data.note || ''), levels };
}

// ---- client -----------------------------------------------------------------------------

export function levelsEqual(a, b) {
    return a.length === b.length && a.every((x, i) => ['mode', ...CORRECTIONS, 'maxPowerW', 'maxTorquePct'].every((k) => x[k] === b[i][k]));
}

/**
 * The model client. `transport` implements four async methods that move whole objects
 * (hex-bytes in/out; the multiframe split lives on the other side of the transport):
 *   caps() -> Uint8Array|null        read 0x6035; null when there is no reply
 *   read(requestBytes) -> Uint8Array read 0x6036
 *   write(objectBytes) -> {ok, generation?, reason?, index?}
 *   control(requestBytes) -> {ok, generation?, reason?, index?}
 * Writes are refused unless discover() has seen the model capability: an old firmware is never
 * sent a command it does not know.
 */
export function createModelClient(transport) {
    let caps = null;
    const requireWritable = () => {
        if (!caps?.model) return { ok: false, reason: 4, text: 'Firmware nie zgłasza obsługi modelu V3 — zapis zablokowany.' };
        if (!caps.modelWritable) return { ok: false, reason: 4, text: 'Firmware zgłasza model tylko do odczytu.' };
        return null;
    };
    const failure = (result) => ({
        ok: false, reason: result.reason, index: result.index,
        text: `${REASON_TEXT[result.reason] ?? 'błąd'}${result.index ? ` (poziom/indeks ${result.index})` : ''}`,
    });
    return {
        get capabilities() { return caps; },
        async discover() {
            let bytes = null;
            try { bytes = await transport.caps(); } catch { bytes = null; }
            caps = parseCaps(bytes);
            return caps;
        },
        async read(index, view) {
            if (!caps?.model) throw new Error('Firmware nie obsługuje modelu V3');
            if (view === VIEW.EFFECTIVE && !caps.modelEffective) throw new Error('Firmware nie obsługuje widoku efektywnego');
            return decodeModelObject(await transport.read(buildReadRequest(index, view)));
        },
        /** Write levels from firstLevel; reads back the RAM view and compares byte for byte. */
        async write(firstLevel, levels, { baseGeneration = 0xFFFF } = {}) {
            const blocked = requireWritable();
            if (blocked) return blocked;
            const object = encodeModelWrite(firstLevel, levels, { baseGeneration });
            const result = await transport.write(object);
            if (!result.ok) return failure(result);
            // index 1..5 reads one level, index 0 all five (spec §4): compare only what was written.
            const back = await this.read(levels.length === 1 ? firstLevel : 0, VIEW.CONFIGURED).catch((error) => ({ error }));
            if (back.error) return { ok: false, text: `Zapis przyjęty, ale odczyt kontrolny się nie udał: ${back.error.message}` };
            const mine = back.count === levels.length ? back.levels : back.levels.slice(firstLevel - 1, firstLevel - 1 + levels.length);
            if (!levelsEqual(mine, levels)) return { ok: false, text: 'Odczyt kontrolny różni się od wysłanych wartości.', readback: back };
            return { ok: true, generation: back.generation };
        },
        async control(op, arg = 0, expectedGeneration = 0xFFFF) {
            const blocked = requireWritable();
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

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

/**
 * Talks to the CANable server with `V3M:<id>:<CMD>[:<hex>]` messages and waits for a JSON
 * `{type:'v3m_reply', id, ok, hex, generation, reason, index}`. THE SERVER SIDE DOES NOT EXIST
 * YET (spec §6): until it does and the firmware answers 0x6035 with the model bit, discover()
 * times out -> capabilities null -> the panel is read-only.
 */
export function createSocketTransport(socket, { timeoutMs = 2500 } = {}) {
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
    const call = (command, bytes) => new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, timeout: true }); }, timeoutMs);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        socket.send(`V3M:${id}:${command}${bytes ? `:${toHex(bytes)}` : ''}`);
    });
    return {
        async caps() {
            const reply = await call('CAPS');
            return reply.ok && reply.hex ? fromHex(reply.hex) : null;
        },
        async read(request) {
            const reply = await call('READ', request);
            if (!reply.ok || !reply.hex) throw new Error(reply.timeout ? 'brak odpowiedzi sterownika' : `odczyt odrzucony (powód ${reply.reason})`);
            return fromHex(reply.hex);
        },
        async write(object) {
            const reply = await call('WRITE', object);
            return reply.timeout ? { ok: false, reason: 5, text: 'brak odpowiedzi' } : reply;
        },
        async control(request) {
            const reply = await call('CONTROL', request);
            return reply.timeout ? { ok: false, reason: 5, text: 'brak odpowiedzi' } : reply;
        },
    };
}
