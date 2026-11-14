// v3-config-server.js — server side of the V3 config transport (0x6035 / 0x6036 / 0x6037).
//
// Spec: integration/roadmap/V3_MODEL_CAN_PROTOCOL_PL.md §1, §4 and firmware
// docs/assist-v3/CONFIG_PROTOCOL_V3.md §2. The browser (ui/js/evistdrive/v3-model-protocol.js)
// builds and checks whole objects; this module only moves them over CAN and answers one JSON
// reply per WebSocket command. It reuses the existing CAN plumbing:
//   reads   -> bafang-can-requests.readParameter (READ_CMD + the shared multiframe receiver in
//              canbus.js, which reassembles the firmware's START/DATA/END reply);
//   control -> bafang-can-requests.writeShortParameter (WRITE_CMD 4 B, one result frame);
//   write   -> declaration via writeShortParameter (WRITE_CMD [len], waits for DECL_ACK), then
//              bafang-serializer.sendLongDataFrames (START = frame 0, MULTIFRAME n = n+1,
//              END), then exactly one result frame (NORMAL_ACK [gen] / ERROR_ACK [reason, index]).
//
// WebSocket commands (an optional `#<id>` suffix is echoed in the reply):
//   V3M_CAPS                         -> {ok, hex}                      (30 B CAPS)
//   V3M_READ:<obj>:<index>:<view>    -> {ok, hex} | {ok:false, reason, index}
//   V3M_WRITE:<hex>                  -> {ok, generation} | {ok:false, reason, index}
//   V3M_CONTROL:<op>:<arg>:<gen>     -> {ok, generation} | {ok:false, reason, index}
// Reply: JSON {type:'v3m_reply', id, cmd, ok, ...}. `timeout: true` = no answer from the bike.
//
// Capability guard (also enforced in the browser): no object 4 write and no op 5/6 without
// caps bit 8 (+ bit 10 for writes), no object 5 write without bit 11. The guard uses the CAPS
// this module read last (it reads CAPS itself when it has none), so an old firmware never sees
// a write frame it does not know.
"use strict";

const { CanOperation, DeviceNetworkId } = require('./bafang-constants');

const CMD_CAPS = { canCommandCode: 0x60, canCommandSubCode: 0x35 };
const CMD_BLOCK = { canCommandCode: 0x60, canCommandSubCode: 0x36 };
const CMD_CONTROL = { canCommandCode: 0x60, canCommandSubCode: 0x37 };
const TARGET = DeviceNetworkId.DRIVE_UNIT;
const SOURCE = DeviceNetworkId.BESST; // = 5, the only source the V3 config accepts

const CAP_MODEL = 1 << 8;
const CAP_MODEL_WRITABLE = 1 << 10;
const CAP_RIDER = 1 << 11;
const OBJECTS = new Set([4, 5]);
const MIN_OBJECT_LEN = 18;
const MAX_OBJECT_LEN = 90;
const REASON_CAPABILITY = 4;
const REASON_BUSY = 5;

function crc16(bytes, length) {
    let crc = 0xFFFF;
    for (let i = 0; i < length; i++) {
        crc ^= bytes[i] << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
}

/** caps u32 from a CAPS reply, or null when it is not a valid 30 B format-2 frame. */
function capsBits(bytes) {
    if (!bytes || bytes.length !== 30 || bytes[0] !== 0x42 || bytes[1] !== 0x56) return null;
    if ((bytes[28] | (bytes[29] << 8)) !== crc16(bytes, 28)) return null;
    return (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24)) >>> 0;
}

const toHex = (bytes) => Buffer.from(bytes).toString('hex');

/**
 * @param {object} canbus  CanBusService-like: isConnected(), sendFrame(str), requestManager.
 * @param {object} [deps]  injectable for tests: requests, serializer, timeouts.
 */
function createV3ConfigTransport(canbus, {
    requests = require('./bafang-can-requests'),
    serializer = require('./bafang-serializer'),
    readTimeoutMs = 10000,   // readParameter itself retries 3 x 3 s
    replyTimeoutMs = 3500,   // one ACK / result frame (RequestManager gives up after 3 s)
    frameDelayMs = 20,       // between data frames; 10 frames stay well inside the 1000 ms staging timeout
} = {}) {
    let lastCaps = null;
    let chain = Promise.resolve();
    // One V3 transfer at a time: the firmware has one staging buffer and the RequestManager one
    // pending slot per command, so overlapping calls would steal each other's replies.
    const exclusive = (fn) => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => {});
        return run;
    };
    const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve({ success: false, timedOut: true, error: 'timeout' }), ms)),
    ]);
    const rm = () => canbus.requestManager;
    const notConnected = () => {
        if (canbus.isConnected()) return null;
        lastCaps = null; // another controller may be plugged in next time
        return { ok: false, error: 'CAN device not connected' };
    };
    const ackResult = (res, { decl = false } = {}) => {
        if (res?.success) {
            const d = res.responseData || [];
            return { ok: true, generation: d.length >= 2 ? (d[0] | (d[1] << 8)) : undefined };
        }
        if (res?.timedOut) return { ok: false, timeout: true, error: decl ? 'brak potwierdzenia deklaracji' : 'brak ramki wyniku' };
        const d = res?.responseData || [];
        if (d.length >= 1) return { ok: false, reason: d[0], index: d.length >= 2 ? d[1] : 0 };
        return { ok: false, error: res?.error || 'nieznany błąd' };
    };

    async function readCapsNow() {
        const res = await withTimeout(requests.readParameter(canbus, rm(), TARGET, CMD_CAPS, null), readTimeoutMs);
        if (!res?.success || !res.responseData) {
            lastCaps = null;
            return res?.timedOut ? { ok: false, timeout: true } : ackResult(res);
        }
        const bytes = Uint8Array.from(res.responseData);
        lastCaps = capsBits(bytes);
        return { ok: true, hex: toHex(bytes) };
    }

    async function ensureCaps() {
        if (lastCaps === null) await readCapsNow();
        return lastCaps;
    }

    const refused = (text) => ({ ok: false, reason: REASON_CAPABILITY, index: 0, error: text });

    return {
        get lastCaps() { return lastCaps; },

        caps() { return exclusive(() => notConnected() || readCapsNow()); },

        read(objectId, index, view) {
            return exclusive(async () => {
                const off = notConnected(); if (off) return off;
                if (!OBJECTS.has(objectId) || ![0, 1, 2, 3].includes(view) || !(index >= 0 && index <= 5)) {
                    return { ok: false, error: 'zły obiekt, poziom lub widok' };
                }
                const res = await withTimeout(requests.readParameter(canbus, rm(), TARGET, CMD_BLOCK, [objectId, index, view, 0]), readTimeoutMs);
                if (res?.success && res.responseData && res.responseData.length >= MIN_OBJECT_LEN) {
                    return { ok: true, hex: toHex(res.responseData) };
                }
                if (res?.success) return { ok: false, error: 'odpowiedź nie jest obiektem (za krótka)' };
                return ackResult(res);
            });
        },

        write(bytes) {
            return exclusive(async () => {
                const off = notConnected(); if (off) return off;
                const data = Array.from(bytes);
                if (data.length < MIN_OBJECT_LEN || data.length > MAX_OBJECT_LEN || data[0] !== 0x42 || data[1] !== 0x56 || !OBJECTS.has(data[2])) {
                    return { ok: false, error: 'to nie jest obiekt 4 ani 5 transportu V3' };
                }
                const caps = await ensureCaps();
                if (caps === null) return refused('brak odpowiedzi CAPS: zapis zablokowany');
                if (data[2] === 4 && !((caps & CAP_MODEL) && (caps & CAP_MODEL_WRITABLE))) return refused('firmware nie zgłasza zapisu modelu (bit 8/10): zapis zablokowany');
                if (data[2] === 5 && !(caps & CAP_RIDER)) return refused('firmware nie zgłasza obiektu 5 (bit 11): zapis zablokowany');
                const pending = rm().pendingAckRequests?.[TARGET]?.[CMD_BLOCK.canCommandCode]?.[CMD_BLOCK.canCommandSubCode];
                if (pending) return { ok: false, reason: REASON_BUSY, index: 0, error: 'inne żądanie 0x6036 w toku' };

                // 1. Declaration: WRITE_CMD [len] -> DECL_ACK (NORMAL_ACK) or ERROR_ACK.
                const decl = ackResult(await withTimeout(
                    requests.writeShortParameter(canbus, rm(), TARGET, CMD_BLOCK, [data.length]), replyTimeoutMs), { decl: true });
                if (!decl.ok) return decl;

                // 2. Register for the single result frame BEFORE the first data frame: the firmware
                //    may abort mid-transfer with ERROR_ACK, and then no further frame is sent.
                let resolved = null;
                const result = new Promise((resolve) => {
                    rm().registerForAck(SOURCE, TARGET, CanOperation.WRITE_CMD, CMD_BLOCK.canCommandCode, CMD_BLOCK.canCommandSubCode,
                        { resolve: (r) => { resolved = r; resolve(r); }, reject: () => {} });
                });
                try {
                    await serializer.sendLongDataFrames(canbus, TARGET, CMD_BLOCK, data, { delayMs: frameDelayMs, shouldAbort: () => resolved !== null });
                } catch (error) {
                    return { ok: false, error: `wysyłanie ramek: ${error.message}` };
                }
                // 3. Exactly one result frame: NORMAL_ACK [gen] or ERROR_ACK [reason, index].
                return ackResult(await withTimeout(result, replyTimeoutMs));
            });
        },

        control(op, arg, generation) {
            return exclusive(async () => {
                const off = notConnected(); if (off) return off;
                if (![1, 2, 3, 5, 6].includes(op) || !(arg >= 0 && arg <= 255) || !(generation >= 0 && generation <= 0xFFFF)) {
                    return { ok: false, error: 'zła operacja, argument lub generacja' };
                }
                const caps = await ensureCaps();
                if (caps === null) return refused('brak odpowiedzi CAPS: operacja zablokowana');
                if ((op === 5 || op === 6) && !(caps & CAP_MODEL)) return refused('firmware nie zgłasza modelu (bit 8): operacja zablokowana');
                if ((op === 1 || op === 2 || op === 3) && !(caps & (CAP_MODEL | CAP_RIDER))) return refused('firmware nie zgłasza modelu ani obiektu 5: operacja zablokowana');
                const res = await withTimeout(
                    requests.writeShortParameter(canbus, rm(), TARGET, CMD_CONTROL, [op, arg, generation & 0xFF, (generation >> 8) & 0xFF]), replyTimeoutMs);
                return ackResult(res);
            });
        },
    };
}

/** Parse one WebSocket message; returns null when it is not a V3M command. */
function parseV3mCommand(message) {
    if (typeof message !== 'string' || !message.startsWith('V3M_')) return null;
    const hash = message.lastIndexOf('#');
    const id = hash > 0 ? Number(message.slice(hash + 1)) : undefined;
    const body = hash > 0 ? message.slice(0, hash) : message;
    const [cmd, ...args] = body.split(':');
    const ints = args.map((a) => (/^\d+$/.test(a) ? Number(a) : NaN));
    switch (cmd) {
        case 'V3M_CAPS': return args.length === 0 ? { id, cmd } : { id, cmd, error: 'V3M_CAPS nie ma argumentów' };
        case 'V3M_READ':
            return args.length === 3 && ints.every(Number.isInteger)
                ? { id, cmd, objectId: ints[0], index: ints[1], view: ints[2] }
                : { id, cmd, error: 'użyj V3M_READ:<obj>:<index>:<view>' };
        case 'V3M_WRITE':
            return args.length === 1 && /^([0-9a-fA-F]{2})+$/.test(args[0])
                ? { id, cmd, bytes: Uint8Array.from(Buffer.from(args[0], 'hex')) }
                : { id, cmd, error: 'użyj V3M_WRITE:<hex>' };
        case 'V3M_CONTROL':
            return args.length === 3 && ints.every(Number.isInteger)
                ? { id, cmd, op: ints[0], arg: ints[1], generation: ints[2] }
                : { id, cmd, error: 'użyj V3M_CONTROL:<op>:<arg>:<gen>' };
        default: return { id, cmd, error: `nieznana komenda ${cmd}` };
    }
}

/**
 * Handle one WebSocket message. Returns false when it is not a V3M command, otherwise sends
 * one JSON reply through `send` and returns true.
 */
async function handleV3mMessage(transport, message, send) {
    const parsed = parseV3mCommand(message);
    if (!parsed) return false;
    const reply = (result) => send(JSON.stringify({ type: 'v3m_reply', id: parsed.id, cmd: parsed.cmd, ...result }));
    if (parsed.error) { reply({ ok: false, error: parsed.error }); return true; }
    let result;
    try {
        switch (parsed.cmd) {
            case 'V3M_CAPS': result = await transport.caps(); break;
            case 'V3M_READ': result = await transport.read(parsed.objectId, parsed.index, parsed.view); break;
            case 'V3M_WRITE': result = await transport.write(parsed.bytes); break;
            case 'V3M_CONTROL': result = await transport.control(parsed.op, parsed.arg, parsed.generation); break;
        }
    } catch (error) {
        result = { ok: false, error: error.message };
    }
    reply(result);
    return true;
}

module.exports = {
    createV3ConfigTransport, parseV3mCommand, handleV3mMessage, capsBits,
    CMD_CAPS, CMD_BLOCK, CMD_CONTROL, CAP_MODEL, CAP_MODEL_WRITABLE, CAP_RIDER,
};
