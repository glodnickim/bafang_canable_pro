// Sniffer ACTIVE FILTERS matching: OR semantics, the two system meta-filters (ALL TRAFFIC /
// DEFAULT TRAFFIC), wildcard patterns, and — critically — that a CAN ID with no tile in the
// filter library is never silently dropped just because nothing describes it.
//
// Run from the Canable project root:  node tests/sniffer_active_filters_matching.js

'use strict';
const path = require('path');
const Sniffer = require(path.join(__dirname, '..', 'sniffer'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`); } };

function makeSniffer() {
    const sniffer = new Sniffer({ on: () => {}, removeListener: () => {} });
    sniffer.logMessage = () => {};
    return sniffer;
}

const UNKNOWN_ID = '81234567'; // never seen before, no tile, no CAN_FRAME_INFO entry

{
    const s = makeSniffer();
    s.activeFilters = new Set(['DEFAULT TRAFFIC']);
    check(s._isFrameVisible('82F83200') === false, 'A1. Default: standard background frame is excluded');
    check(s._isFrameVisible('82F8320B') === false, 'A2. Default: last standard background ID is excluded');
    check(s._isFrameVisible('85116029') === true, 'A3. Default: a known non-background ID stays visible');
    check(s._isFrameVisible(UNKNOWN_ID) === true, 'A4. Default: an UNKNOWN ID stays visible (critical requirement)');
}

{
    const s = makeSniffer();
    s.activeFilters = new Set(['ALL TRAFFIC']);
    check(s._isFrameVisible('82F83200') === true, 'B1. All Traffic: standard background frame is visible');
    check(s._isFrameVisible(UNKNOWN_ID) === true, 'B2. All Traffic: an UNKNOWN ID is visible (critical requirement)');
}

{
    const s = makeSniffer();
    s.activeFilters = new Set(['85116029', '822C6029', '822Dxxxx', '822Exxxx']);
    check(s._isFrameVisible('85116029') === true, 'C1. Dump Only: DIAG REQUEST visible');
    check(s._isFrameVisible('822C6029') === true, 'C2. Dump Only: DIAG START visible');
    check(s._isFrameVisible('822D00AF') === true, 'C3. Dump Only: wildcard DATA fragment visible');
    check(s._isFrameVisible('822E0006') === true, 'C4. Dump Only: wildcard END frame visible');
    check(s._isFrameVisible(UNKNOWN_ID) === false, 'C5. Dump Only: an UNKNOWN ID is NOT visible (positive filtering only)');
    check(s._isFrameVisible('82F83200') === false, 'C6. Dump Only: known background frame is NOT visible');
}

{
    // OR logic: DEFAULT TRAFFIC's exclusion is overridden by an explicitly active exact ID.
    const s = makeSniffer();
    s.activeFilters = new Set(['DEFAULT TRAFFIC', '82F83201']);
    check(s._isFrameVisible('82F83201') === true, 'D1. Default + explicit exact ID: that ID is visible despite the exclusion');
    check(s._isFrameVisible('82F83200') === false, 'D2. Default + explicit exact ID: other background frames stay excluded');
    check(s._isFrameVisible(UNKNOWN_ID) === true, 'D3. Default + explicit exact ID: unknown ID still visible via DEFAULT TRAFFIC');
}

{
    // Empty ACTIVE FILTERS = show nothing, never reinterpreted as "All Traffic".
    const s = makeSniffer();
    s.activeFilters = new Set();
    check(s._isFrameVisible(UNKNOWN_ID) === false, 'F1. Empty active filters: nothing is visible');
    check(s._isFrameVisible('82F83200') === false, 'F2. Empty active filters: even a known ID is not visible');
}

{
    // Custom preset with DEFAULT TRAFFIC included -> unknown ID visible.
    const s = makeSniffer();
    s.activeFilters = new Set(['DEFAULT TRAFFIC', '85116029']);
    check(s._isFrameVisible(UNKNOWN_ID) === true, 'G1. Custom preset with DEFAULT TRAFFIC: unknown ID visible');
    check(s._isFrameVisible('85116029') === true, 'G2. Custom preset with DEFAULT TRAFFIC: the extra exact ID is visible too');
}

{
    // Custom preset WITHOUT a meta-filter (exact-only) -> unknown ID hidden.
    const s = makeSniffer();
    s.activeFilters = new Set(['85116029', '822C6029']);
    check(s._isFrameVisible(UNKNOWN_ID) === false, 'G3. Custom preset without a meta-filter: unknown ID is NOT visible');
}

{
    // Wildcard matching, independent of any meta-filter.
    const s = makeSniffer();
    s.activeFilters = new Set(['822Dxxxx']);
    check(s._isFrameVisible('822D0000') === true, 'H1. Wildcard: 822D0000 matches 822Dxxxx');
    check(s._isFrameVisible('822D0001') === true, 'H2. Wildcard: 822D0001 matches 822Dxxxx');
    check(s._isFrameVisible('822D00AF') === true, 'H3. Wildcard: 822D00AF matches 822Dxxxx');
    check(s._isFrameVisible('822E0000') === false, 'H4. Wildcard: a different prefix does not match');
}

// RAW file logging must be completely unaffected by any of the above — every frame captured
// unconditionally regardless of activeFilters, including the empty-set "show nothing" case.
{
    const fileLines = [];
    const wsMessages = [];
    const s = new Sniffer({ on: () => {}, removeListener: () => {} }, { send: (m) => wsMessages.push(m) });
    s.logToFile = (line) => fileLines.push(line);
    s.activeFilters = new Set(); // show nothing live

    function makeFrame(idHex, bytes) {
        const data = new DataView(new ArrayBuffer(bytes.length));
        bytes.forEach((b, i) => data.setUint8(i, b));
        return { can_id: parseInt(idHex, 16), can_dlc: bytes.length, data, timestamp_us: Date.now() * 1000 };
    }
    s.rawFrameRecived(makeFrame('82F83200', [1, 2, 3, 4, 5, 6, 7, 8]));
    s.rawFrameRecived(makeFrame(UNKNOWN_ID, [9, 9, 9, 9, 9, 9, 9, 9]));

    check(fileLines.length === 2, `M1. RAW file still captures all frames even with empty activeFilters (got ${fileLines.length})`);
    const wsLog = wsMessages.filter((m) => m.startsWith('SNIFFER_ENTRY:') && !m.includes('Listeaning'));
    check(wsLog.length === 0, `M2. Live view shows nothing with empty activeFilters (got ${wsLog.length})`);
}

console.log(failures === 0
    ? 'Sniffer active filters matching: PASS'
    : `Sniffer active filters matching: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
