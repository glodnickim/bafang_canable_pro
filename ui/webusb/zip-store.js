// One .zip from several Blobs, without compression. A ride log is split into 32 MB parts
// and a browser asks for permission when a page saves many files, so "Save all" hands
// over one file instead. Stored entries keep memory flat: the Blob of the archive only
// refers to the part Blobs, and each part is read once, in slices, for its CRC.
'use strict';
(function (root) {
    const MAX_ZIP_BYTES = 0xFFFFFFFF; // plain zip fields; a larger archive would need zip64
    const SLICE_BYTES = 4 * 1024 * 1024;

    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }

    async function crc32(blob) {
        let crc = 0xFFFFFFFF;
        for (let at = 0; at < blob.size; at += SLICE_BYTES) {
            const bytes = new Uint8Array(await blob.slice(at, at + SLICE_BYTES).arrayBuffer());
            for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function dosTime(date) {
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
            day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        };
    }

    // The fields shared by the local header (from offset 4) and the central directory.
    function commonFields(view, at, entry, stamp) {
        view.setUint16(at, 20, true);          // version needed
        view.setUint16(at + 2, 0x0800, true);  // names are UTF-8
        view.setUint16(at + 4, 0, true);       // stored
        view.setUint16(at + 6, stamp.time, true);
        view.setUint16(at + 8, stamp.day, true);
        view.setUint32(at + 10, entry.crc, true);
        view.setUint32(at + 14, entry.blob.size, true);
        view.setUint32(at + 18, entry.blob.size, true);
        view.setUint16(at + 22, entry.nameBytes.length, true);
    }

    // files: [{ name, blob }]. Resolves to a Blob; rejects when the archive would not fit.
    async function zipStore(files, date = new Date()) {
        const total = files.reduce((n, f) => n + f.blob.size + 2 * f.name.length + 128, 22);
        if (total > MAX_ZIP_BYTES) throw new Error('Logs are too large for one zip file, save the files one by one');
        const stamp = dosTime(date);
        const encoder = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;
        for (const file of files) {
            const entry = { blob: file.blob, nameBytes: encoder.encode(file.name), crc: await crc32(file.blob) };
            const local = new Uint8Array(30 + entry.nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034B50, true);
            commonFields(lv, 4, entry, stamp);
            local.set(entry.nameBytes, 30);
            parts.push(local, entry.blob);

            const record = new Uint8Array(46 + entry.nameBytes.length);
            const cv = new DataView(record.buffer);
            cv.setUint32(0, 0x02014B50, true);
            cv.setUint16(4, 20, true);         // version made by
            commonFields(cv, 6, entry, stamp);
            cv.setUint32(42, offset, true);
            record.set(entry.nameBytes, 46);
            central.push(record);
            offset += local.length + entry.blob.size;
        }
        const centralSize = central.reduce((n, r) => n + r.length, 0);
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054B50, true);
        ev.setUint16(8, files.length, true);
        ev.setUint16(10, files.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end], { type: 'application/zip' });
    }

    root.ZipStore = { zipStore, crc32 };
    if (typeof module !== 'undefined') module.exports = root.ZipStore;
})(typeof self !== 'undefined' ? self : globalThis);
