// Bounded in-memory view of frames; recording remains independent.
'use strict';
(function (root) {
    function createLiveFrames({ recent = 40 } = {}) {
        let frames, ids, total, droppedIds, firstAt, previousAt, previousTotal;
        function reset() {
            frames = [];
            ids = new Map();
            total = 0;
            droppedIds = 0;
            firstAt = null;
            previousAt = null;
            previousTotal = 0;
        }
        function add(dir, id, dlc, dataHex, nowMs) {
            if (firstAt === null) firstAt = nowMs;
            total++;
            if (recent > 0) {
                frames.push({ t: nowMs - firstAt, dir, id, dlc, data: dataHex });
                if (frames.length > recent) frames.shift();
            }
            let row = ids.get(id);
            if (!row) {
                if (ids.size >= 512) { droppedIds++; return; }
                row = { id, count: 0, dlc, data: dataHex, at: nowMs, changed: false };
                ids.set(id, row);
            } else if (row.data !== dataHex) {
                row.changed = true;
            }
            row.count++;
            row.dlc = dlc;
            row.data = dataHex;
            row.at = nowMs;
        }
        function snapshot(nowMs) {
            const rate = previousAt === null || nowMs <= previousAt ? 0 :
                (total - previousTotal) * 1000 / (nowMs - previousAt);
            previousAt = nowMs;
            previousTotal = total;
            const rows = Array.from(ids.values(), (row) => {
                const result = { id: row.id, count: row.count, dlc: row.dlc, data: row.data,
                    ageMs: Math.max(0, nowMs - row.at), changed: row.changed };
                row.changed = false;
                return result;
            }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            return { recent: frames.slice().reverse(), ids: rows, rate, total, droppedIds };
        }
        reset();
        return { add, snapshot, reset };
    }
    root.LiveFrames = { createLiveFrames };
    if (typeof module !== 'undefined') module.exports = root.LiveFrames;
})(typeof self !== 'undefined' ? self : globalThis);
