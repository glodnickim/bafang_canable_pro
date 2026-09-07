'use strict';

// STOP-TRACE schema 1: BAFANG_GD32F303RCT6/protocol/STOP_TRACE.md.
const COMMAND = Object.freeze({ status: '05116033', arm: '05106033', dump: '05106034' });
const BASE = [0, 384, 480, 576];
const CAPACITY = [384, 96, 96, 96];

function decodeStatus(d) {
    if (d.length !== 8 || d[0] !== 1 || d[1] > 3 || d[6] > 4 || d.readUInt16LE(4) > 384) return null;
    return { state: d[1], generation: d[2], available: !!(d[3] & 4), pending: !!(d[3] & 8),
        frozen: !!(d[3] & 16), exporting: !!(d[3] & 1), failed: !!(d[3] & 2),
        count: d.readUInt16LE(4), reason: d[6], fastMask: d[7], overrun: !!(d[3] & 32) };
}

function crc32(buffers) {
    let crc = 0xffffffff;
    for (const b of buffers) for (const value of b) {
        crc ^= value;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

class Download {
    constructor(generation) { this.generation = generation; this.parts = new Map(); this.meta = null; this.expected = null; }
    block(index) {
        const parts = Array.from({ length: 8 }, (_, f) => this.parts.get(index * 8 + f));
        return parts.every(Boolean) ? Buffer.concat(parts) : null;
    }
    feed(id, d) {
        if (id < 0x10300 || id > 0x10307) return null;
        if (d.length !== 8) throw new Error('Niepełna ramka zapisu.');
        const fragment = id - 0x10300, index = d.readUInt16LE(1);
        if (d[0] !== this.generation) throw new Error('Pomieszane numery pomiarów.');
        if (index !== 65535 && index !== 65534 && index >= 672) throw new Error('Nieprawidłowy numer rekordu.');
        if (!this.parts.size && (index !== 65535 || fragment !== 0)) return null;
        if (index === 65535 && fragment === 0 && this.parts.size > 1) {
            // A replay starts afresh: never fill holes using a previous replay.
            this.parts.clear(); this.meta = null; this.expected = null;
        }
        const key = index * 8 + fragment, part = Buffer.from(d.subarray(3));
        if (this.parts.has(key) && !this.parts.get(key).equals(part)) throw new Error('Sprzeczne fragmenty zapisu.');
        this.parts.set(key, part);
        if (!this.meta && this.block(65535)) {
            const m = this.block(65535);
            if (m[0] !== 1 || m[1] !== this.generation || m[3] > 4 || m.readUInt32LE(4) !== 16000 || m.readUInt16LE(10) !== 40) {
                throw new Error('Nieobsługiwany format pomiaru.');
            }
            this.counts = BASE.map((_, s) => m.readUInt16LE(12 + 2 * s));
            this.counts.forEach((count, s) => {
                const trigger = m.readUInt16LE(24 + 2 * s);
                if (count > CAPACITY[s] || (count && trigger !== 65535 && trigger >= count)) throw new Error('Nieprawidłowa długość pomiaru.');
            });
            this.meta = m;
            this.expected = 16 + 8 * this.counts.reduce((a, b) => a + b, 0);
        }
        const trailer = this.block(65534);
        if (!trailer) return null;
        if (!this.meta) throw new Error('Brakuje nagłówka pomiaru.');
        const blocks = [this.meta];
        this.counts.forEach((count, s) => {
            let previous = null;
            for (let i = 0; i < count; i++) {
                const b = this.block(BASE[s] + i);
                if (!b) throw new Error('Brakuje fragmentów pomiaru.');
                const tick = b.readUInt32LE(0), step = (tick - previous) >>> 0;
                if (previous !== null && (!step || step > 480000 || (s > 0 && step !== 1))) throw new Error('Luka lub nieprawidłowa kolejność próbek.');
                previous = tick; blocks.push(b);
            }
        });
        if (this.parts.size !== this.expected) throw new Error('Nadmiarowe fragmenty pomiaru.');
        const crc = crc32(blocks);
        if (trailer.toString('ascii', 0, 4) !== 'DONE' || trailer.readUInt32LE(4) !== crc) throw new Error('Zapis uszkodzony: suma kontrolna CRC nie zgadza się.');
        return { schema: 1, generation: this.generation, transport: 'COMPLETE_CRC_OK',
            irq_timing_present: !!(this.meta[2] & 4),
            irq_body_max_us: (this.meta[2] & 4) ? this.meta.readUInt16LE(34) : null,
            irq_body_over_budget: !!(this.meta[2] & 8),
            counts: this.counts, reason: ['NONE', 'STOPPED', 'TIMEOUT', 'FULL', 'NO_TRIGGER'][this.meta[3]],
            crc32: crc.toString(16).toUpperCase().padStart(8, '0') };
    }
}
module.exports = { COMMAND, decodeStatus, crc32, Download };
