// can-frame-info.js — ES Module
//
// Central metadata for CAN IDs shown in the Sniffer tab: filter-chip tooltips and the
// eVistDrive DIAG classifier used to label live log lines. Only descriptions actually
// confirmed against this codebase's read/write command tables (bafang-can-read-commands.js,
// bafang-constants.js, bafang-parser.js) are asserted as fact — everything else is marked
// explicitly unconfirmed rather than guessed. See sniffer.js for the server-side twin of the
// decode/classify logic below (kept in sync by hand: the bit layout is fixed protocol, not
// something expected to drift).

// The two system meta-filters (see sniffer.js for the server-side twin of these exact token
// strings — a tile's visible text IS the token sent over the wire, so they must match
// verbatim, space included). Neither is "every currently known tile" — both are live rules
// evaluated per-frame server-side, so an ID this app has never seen before still matches them.
export const ALL_TRAFFIC_TOKEN = 'ALL TRAFFIC';
export const DEFAULT_TRAFFIC_TOKEN = 'DEFAULT TRAFFIC';

const META_FILTER_INFO = {
    [ALL_TRAFFIC_TOKEN]: {
        title: 'All Traffic',
        description: 'Shows every received CAN frame, including unknown and newly discovered CAN IDs.',
    },
    [DEFAULT_TRAFFIC_TOKEN]: {
        title: 'Default Traffic',
        description: 'Shows all CAN traffic except the standard high-frequency 82F83200–82F8320B background frames.\nUnknown/new CAN IDs remain visible.',
    },
};

export const CAN_FRAME_INFO = {
    '82F83200': {
        name: 'Motor Realtime 0',
        description: 'SOC, distance, cadence, torque, range',
    },
    '82F83201': {
        name: 'Motor Realtime 1',
        description: 'Speed, current, voltage, controller/motor temperature',
    },
    '82F83202': {
        name: 'Motor Sync / Status',
        description: 'Cyclic motor status/synchronization frame',
    },
    '82F83205': {
        name: 'Calories',
        description: 'Energy/calorie counter telemetry',
    },
};

// Seen on the bus alongside the confirmed IDs above, same 0x32xx family, but no read/write
// command in this codebase's tables identifies what they carry.
const UNCONFIRMED_0x32XX = new Set([
    '82F83203', '82F83204', '82F83206', '82F83207', '82F83208', '82F83209', '82F8320A', '82F8320B',
]);

// --- eVistDrive Ride Diagnostics dump (0x6029) --------------------------------------------
// Confirmed against bafang-can-read-commands.js (canCommandCode 0x60 / canCommandSubCode
// 0x29) and generateCanFrameId()'s bit layout in bafang-parser.js. REQUEST is
// BESST->DRIVE_UNIT READ_CMD 0x60/0x29 (ID 85116029); the controller answers as a multi-frame
// transfer (DRIVE_UNIT->BESST) whose START repeats 0x60/0x29 (ID 822C6029), while the
// continuation MULTIFRAME/MULTIFRAME_END frames carry canCommandCode 0 with the sequence
// number as canCommandSubCode instead (bafang-serializer.js: "Command code 0, subcode is
// sequence number") — so DATA/END are not one fixed ID but a whole range, expressed below as
// a 'prefix' pattern (822Dxxxx/822Exxxx, 'x' = any hex digit) rather than enumerating every
// possible fragment index — the count of fragments depends on the dump's length.
//
// This is the single canonical definition of the confirmed diag frames: both the filter-chip
// tooltip lookup (getFrameTooltip) and the "Dump Only" preset (tab-sniffer.js
// applyDumpOnlyPreset, which ensures each of these exists as a visible Show Only tile) read
// from DIAG_FRAME_PATTERNS, so the two can never drift apart. sniffer.js's own dump-completion
// tracker (_decodeDiagFrame) uses the same bit layout independently, for a different job
// (knowing whether a dump in flight has finished) that only its live session state can do
// (DATA/END can't be told apart from any other multi-frame transfer by ID alone — see there).
export const DIAG_FRAME_PATTERNS = [
    {
        pattern: '85116029', matchType: 'exact', category: 'DIAG_REQUEST',
        title: 'eVistDrive Diagnostic Request',
        description: 'Requests the Ride Diagnostics dump from the motor controller.',
        direction: 'CANable/HMI → Motor',
    },
    {
        pattern: '822C6029', matchType: 'exact', category: 'DIAG_START',
        title: 'Diagnostic START',
        description: 'Beginning of the Ride Diagnostics multiframe response. Carries the expected payload length.',
        direction: 'Motor → CANable/HMI',
    },
    {
        pattern: '822Dxxxx', matchType: 'prefix', category: 'DIAG_DATA',
        title: 'Diagnostic DATA',
        description: 'Payload fragment of the current eVistDrive diagnostic dump. The last 4 digits are the fragment/sequence number.',
        direction: 'Motor → CANable/HMI',
    },
    {
        pattern: '822Exxxx', matchType: 'prefix', category: 'DIAG_END',
        title: 'Diagnostic END',
        description: 'Final frame of the current eVistDrive diagnostic dump.',
        direction: 'Motor → CANable/HMI',
    },
];

// --- QS-1 MEASURE capture (0x6030 / 0x6031, exposure 0x80010250..0x80010256) -------------
// Confirmed against the DIAG firmware build pinned for host tests (commit 7232f9d):
// src/CAN_Display.c (READ/WRITE 0x6030 and 0x6031, send_qs_transition_status,
// sendWriteResult), src/qs_transition_diag.c (state machine) and qs_transition_dump.c
// (export stream layout). These are protocol-transaction frames, not the shared "Dump Only
// diag" family, so they get their own category labels. Included in DIAG_FRAME_PATTERNS so the
// Dump Only preset and the tooltips cover a QS download without anyone hand-editing filters —
// the raw log already captured them all along (sniffer never filters the file).
const QS_FRAME_PATTERNS = [
    {
        pattern: '85116031', matchType: 'exact', category: 'QS_STATUS_REQUEST',
        title: 'QS-1 Status Request',
        description: 'READ 0x6031 from the QS-1 panel (DLC 0). The controller answers 0x822A6031 with an 8-byte status.',
        direction: 'CANable → Motor',
    },
    {
        pattern: '85106031', matchType: 'exact', category: 'QS_NEW_MEASURE',
        title: 'QS-1 New Measure',
        description: 'WRITE 0x6031 (DLC 0). Re-arms the capture ring of a COMPLETE measurement; success is only shown after the STATUS confirms a new generation and ARMED.',
        direction: 'CANable → Motor',
    },
    {
        pattern: '85106030', matchType: 'exact', category: 'QS_DOWNLOAD',
        title: 'QS-1 Download Measure',
        description: 'WRITE 0x6030 (DLC 0). Requests the 48-record export replay of the COMPLETE capture.',
        direction: 'CANable → Motor',
    },
    {
        pattern: '822A6031', matchType: 'exact', category: 'QS_STATUS_REPLY',
        title: 'QS-1 Status / ACK',
        description: 'Reply to 0x6031. DLC 8 = STATUS (schema, state, generation, sample count, flags, trigger info); DLC 0 = NORMAL_ACK of the WRITE.',
        direction: 'Motor → CANable',
    },
    {
        pattern: '822B6031', matchType: 'exact', category: 'QS_NEW_MEASURE_REJECTED',
        title: 'QS-1 New Measure Rejected',
        description: 'ERROR_ACK for WRITE 0x6031 — the capture is not COMPLETE or an export is running.',
        direction: 'Motor → CANable',
    },
    {
        pattern: '822A6030', matchType: 'exact', category: 'QS_DOWNLOAD_OK',
        title: 'QS-1 Download OK',
        description: 'NORMAL_ACK for WRITE 0x6030 — the export replay was accepted.',
        direction: 'Motor → CANable',
    },
    {
        pattern: '822B6030', matchType: 'exact', category: 'QS_DOWNLOAD_REJECTED',
        title: 'QS-1 Download Rejected',
        description: 'ERROR_ACK for WRITE 0x6030 — no COMPLETE capture, or an export is already running.',
        direction: 'Motor → CANable',
    },
];
// The seven export IDs: one header + six fragments per sample (44 bytes over 6 frames).
for (let frag = 0; frag <= 6; frag++) {
    const suffix = (frag).toString(16).padStart(2, '0').toUpperCase();
    QS_FRAME_PATTERNS.push({
        pattern: '8001025' + suffix[0] + suffix[1], matchType: 'exact', category: 'QS_EXPORT',
        title: frag === 0 ? 'QS-1 Export header' : `QS-1 Export data ${frag}`,
        description: frag === 0
            ? 'Export record header: [1, capture id, sample index, trigger index, 44, 6, 48, 0].'
            : `Export data fragment ${frag} (8 bytes of the 44-byte FOC-rate sample record).`,
        direction: 'Motor → CANable',
    });
}

// --- eVistDrive Ride Diagnostics + QS-1, one library for tiles, tooltips and the Dump Only preset ---
const ALL_DIAG_PATTERNS = [...DIAG_FRAME_PATTERNS, ...QS_FRAME_PATTERNS];

const DIAG_PATTERN_BY_TEXT = new Map(ALL_DIAG_PATTERNS.map((p) => [p.pattern.toUpperCase(), p]));
const DIAG_PATTERN_BY_CATEGORY = new Map(ALL_DIAG_PATTERNS.map((p) => [p.category, p]));
export const DIAG_FRAME_PATTERNS_ALL = ALL_DIAG_PATTERNS; // the full tile library

// --- FW-145 continuous Level-4 ride telemetry (0x10400..0x10407) ---------------------------
// Diagnostic-only OBSERVATION stream: it never controls the motor. Present only in the
// diagnostic firmware build (CAN_DIAGNOSTICS_ENABLE=1); a normal build is silent on these IDs.
// Extended frames reach the bus with CAN_EFF_FLAG set, so the on-the-wire form of the block is
// 800104xx (this is also why the decoder masks the id before matching). Wire schema and timing:
// motor-controller-firmware/protocol/RIDE_TELEMETRY_CAN.md
//
// Deliberately NOT part of ALL_DIAG_PATTERNS, and therefore not part of the Dump Only preset:
// that preset is for request/response dumps, while this is a continuous ~333 frame/s stream
// that would swamp the live view it is meant to focus.
export const RIDE_TELEMETRY_PATTERNS = [
    {
        pattern: '800104XX', matchType: 'wildcard', category: 'FW145_RIDE_TELEMETRY',
        title: 'FW-145 Ride Telemetry (0x10400-0x10407)',
        description: 'Continuous Level-4 observation stream, diagnostic build only.\n'
            + 'Seven data frames share one 16-bit control tick (~47.6 Hz snapshot, ~333 frames/s);\n'
            + '0x10407 META adds schema version, profile bank and the full 32-bit tick.\n'
            + 'Decode a raw capture with tools/decode_canable_ride_log.py.\n'
            + 'Note: RAW file logging captures these frames whether or not this filter is active - '
            + 'filters only gate the live view.',
        direction: 'Motor -> CANable',
    },
];

// Per-frame names, so a concrete id from the block gets its own tooltip rather than the
// block-level one. Order and meaning follow RIDE_TELEMETRY_CAN.md.
const RIDE_TELEMETRY_FRAMES = {
    '80010400': 'CORE - rider load (centikg), FAST/RUN torque deltas',
    '80010401': 'DEMAND - Iq requested / allowed / ref',
    '80010402': 'MOTOR - Iq and Id actual, motor ERPS',
    '80010403': 'BATT - battery voltage/current, displayed SOC',
    '80010404': 'LIMITS - wheel speed, u_abs, limiter and state flags',
    '80010405': 'STATE - ride permission, session, QZERO, raw vs conditioned cadence',
    '80010406': 'ROTOR/PAS - theta, Hall age/state, PAS state snapshot (NOT raw quadrature)',
    '80010407': 'META - schema version, profile bank, full 32-bit tick, failed-frame count',
};

const TELEMETRY_BY_TEXT = new Map(RIDE_TELEMETRY_PATTERNS.map((p) => [p.pattern.toUpperCase(), p]));

const CanOperation = { READ_CMD: 0x01, MULTIFRAME_START: 0x04, MULTIFRAME: 0x05, MULTIFRAME_END: 0x06 };
const DeviceNetworkId = { DRIVE_UNIT: 0x02, BESST: 0x05 };
const DIAG_CMD_CODE = 0x60;
const DIAG_SUB_CODE = 0x29;

function decodeBafangId(idHex) {
    const n = parseInt(idHex, 16);
    const byte0 = (n >>> 24) & 0xFF;
    const byte1 = (n >>> 16) & 0xFF;
    return {
        source: byte0 & 0x0F,
        target: (byte1 & 0xF8) >> 3,
        opCode: byte1 & 0x07,
        cmdCode: (n >>> 8) & 0xFF,
        subCode: n & 0xFF,
    };
}

// Bit-decode fallback for a concrete diag-shaped ID that isn't literally one of
// DIAG_FRAME_PATTERNS' own pattern strings (e.g. a user typed "822D0005" instead of using the
// "822Dxxxx" tile) — no open-transfer state here, so DATA/END can at best be labelled "looks
// like a diag continuation frame", not confirmed as one.
function classifyDiagId(idHex) {
    const { source, target, opCode, cmdCode, subCode } = decodeBafangId(idHex);
    if (source === DeviceNetworkId.BESST && target === DeviceNetworkId.DRIVE_UNIT
        && opCode === CanOperation.READ_CMD && cmdCode === DIAG_CMD_CODE && subCode === DIAG_SUB_CODE) {
        return 'DIAG_REQUEST';
    }
    if (source === DeviceNetworkId.DRIVE_UNIT && target === DeviceNetworkId.BESST) {
        if (opCode === CanOperation.MULTIFRAME_START && cmdCode === DIAG_CMD_CODE && subCode === DIAG_SUB_CODE) {
            return 'DIAG_START';
        }
        if (cmdCode === 0x00 && opCode === CanOperation.MULTIFRAME) return 'DIAG_DATA';
        if (cmdCode === 0x00 && opCode === CanOperation.MULTIFRAME_END) return 'DIAG_END';
    }
    return null;
}

// Multi-line tooltip text for a filter-chip ID/pattern. Never touches the chip's own text/span
// — this is meant for a separate tooltip attribute (see createFilteredIdItem in tab-sniffer.js).
export function getFrameTooltip(idHex) {
    const id = (idHex || '').toUpperCase();
    const meta = META_FILTER_INFO[id];
    if (meta) {
        return `${meta.title}\n\n${meta.description}`;
    }
    const known = CAN_FRAME_INFO[id];
    if (known) {
        return `${known.name}\n${known.description}\nBackground telemetry — normally hidden`;
    }
    if (UNCONFIRMED_0x32XX.has(id)) {
        return 'Bafang 0x32xx background frame\nExact function not confirmed yet';
    }
    const direct = DIAG_PATTERN_BY_TEXT.get(id);
    if (direct) {
        return `${direct.title}\n${direct.description}\nDirection: ${direct.direction}`;
    }
    const diagCategory = classifyDiagId(id);
    const info = diagCategory && DIAG_PATTERN_BY_CATEGORY.get(diagCategory);
    if (info) {
        return `${info.title}\n${info.description}\nDirection: ${info.direction}`;
    }
    // FW-145 telemetry: the block tile itself, or any single id inside 0x10400..0x10407.
    const telemetryTile = TELEMETRY_BY_TEXT.get(id);
    if (telemetryTile) {
        return `${telemetryTile.title}\n${telemetryTile.description}\nDirection: ${telemetryTile.direction}`;
    }
    const telemetryFrame = RIDE_TELEMETRY_FRAMES[id];
    if (telemetryFrame) {
        return `FW-145 Ride Telemetry\n${telemetryFrame}\n`
            + 'Diagnostic build only; part of the ~47.6 Hz snapshot block 0x10400-0x10407.\n'
            + 'Direction: Motor -> CANable';
    }
    // Per spec: never present an unconfirmed guess as fact. A filter with no library entry and
    // no user-supplied name/description (see tab-sniffer.js's customFilterMeta layer, checked
    // BEFORE this function is even called) is honestly "we don't know what this does".
    return 'Custom CAN Filter\nUser-defined rule\nFunction not described.';
}
