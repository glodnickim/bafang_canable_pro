const { setupLogger, formatRawCanFrameData } = require('./utils');
const { CanOperation, DeviceNetworkId } = require('./bafang-constants');

// eVistDrive Ride Diagnostics dump (0x6029) — confirmed against
// bafang-can-read-commands.js (canCommandCode 0x60 / canCommandSubCode 0x29,
// canbus.js#readDiagnostics) and generateCanFrameId()'s bit layout in
// bafang-parser.js. The REQUEST is BESST->DRIVE_UNIT READ_CMD 0x60/0x29 (ID
// 85116029). The controller answers as a multi-frame transfer (DRIVE_UNIT->BESST):
// START repeats 0x60/0x29 (ID 822C6029) and carries the expected payload length as
// its first data byte (see canbus.js `expectedLength = frameData[0]`), but the
// continuation MULTIFRAME/MULTIFRAME_END frames carry canCommandCode 0 with the
// sequence number as canCommandSubCode (bafang-serializer.js: "Command code 0,
// subcode is sequence number") — so on ID alone they are indistinguishable from any
// OTHER multi-frame transfer between the same two devices. The controller has
// exactly one multi-frame channel (see legacy-params.js), so a DATA/END frame is
// only ever attributed to the diag dump while a diag transfer opened by DIAG_START
// is still tracked open (see diagTransfer below) — never by matching a fixed ID list.
const DIAG_CMD_CODE = 0x60;
const DIAG_SUB_CODE = 0x29;
const DEFAULT_DIAG_TRANSFER_TIMEOUT_MS = 5000;

// Opt-in pipeline trace for diagnosing "RAW file has frames but the live view is empty" —
// set SNIFFER_DEBUG=1 in the environment before starting the server. Off by default: silent,
// zero overhead beyond the one boolean check per call site. Traces exactly the path the live
// view depends on (CAN RX -> active filters -> match result -> WebSocket send), so a real
// disconnect between what the GUI shows and what the running Sniffer instance actually holds
// is visible in the server console instead of being invisible on the wire.
const DEBUG = process.env.SNIFFER_DEBUG === '1' || process.env.SNIFFER_DEBUG === 'true';
function debugLog(...args) {
    if (DEBUG) console.log(...args);
}

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

// An ACTIVE FILTERS entry is either a concrete 8-hex-digit ID or a wildcard pattern using
// 'x'/'X' for an any-digit position (e.g. "822Dxxxx"), always visible in the GUI as the actual
// tile the user sees — never a filter list synthesized elsewhere. A pattern with no 'x' at all
// degrades to a plain exact match, so this one function covers both cases.
function idMatchesPattern(idHex, pattern) {
    if (!pattern || pattern.length !== idHex.length) return false;
    for (let i = 0; i < pattern.length; i++) {
        const p = pattern[i];
        if (p === 'x' || p === 'X') continue;
        if (p.toUpperCase() !== idHex[i].toUpperCase()) return false;
    }
    return true;
}

// The two system meta-filters (see ui/js/can-frame-info.js for the client-side twin of these
// exact token strings — a tile's visible text IS the token, so they must match verbatim).
// ALL_TRAFFIC is a real "match everything" rule, not "every currently known tile" — it must
// keep matching a CAN ID the app has never seen before. DEFAULT_TRAFFIC is "match everything
// EXCEPT this fixed exclusion list" — also not a positive list of known-good IDs, for the same
// reason: an unknown/future ID must stay visible under it.
const ALL_TRAFFIC_TOKEN = 'ALL TRAFFIC';
const DEFAULT_TRAFFIC_TOKEN = 'DEFAULT TRAFFIC';
const DEFAULT_EXCLUDED_IDS = new Set([
    '82F83200', '82F83201', '82F83202', '82F83203', '82F83204', '82F83205',
    '82F83206', '82F83207', '82F83208', '82F83209', '82F8320A', '82F8320B',
]);

class Sniffer {

    logToFile = null;
    // The single source of truth for what the live view shows: a set of exact IDs, wildcard
    // patterns ("822Dxxxx"), and/or the two meta tokens above, combined as a plain logical OR
    // — a frame is visible if it matches ANY entry. This is exactly what the GUI's ACTIVE
    // FILTERS column holds; there is no separate hidden/show-only/preset state anywhere else.
    // Defaults to DEFAULT_TRAFFIC so a bare CLI session (sniffer-cli.js, no UI attached) keeps
    // the same "hide the 0x32xx background spam" behaviour this class has always shipped with.
    activeFilters = new Set([DEFAULT_TRAFFIC_TOKEN]);
    diagTransfer = null;
    diagTransferTimeout = null;
    // Overridable per-instance (tests shrink this instead of waiting out a real 5s timeout).
    diagTransferTimeoutMs = DEFAULT_DIAG_TRANSFER_TIMEOUT_MS;
    frameAccumulator = {};

    // FW-117 bridge lifecycle trace: one sample is FIVE frames in strict order (header
    // 0x10234, then fragments 0x10235-0x10238). The per-ID accumulator below compresses a
    // frame away whenever its payload matches the PREVIOUS frame seen for that same ID - but
    // fragments 0x10235-0x10238 carry no running counter of their own (only 0x10235's
    // tick_abs does), so two consecutive samples captured during a quiet/idle stretch can be
    // byte-identical on 0x10236-0x10238. Compressing those away silently drops real samples
    // and, worse, desyncs the fixed 5-frame cadence a decoder relies on to pair each header
    // with its own fragments. These five IDs must never be accumulated.
    fw117TraceIds = new Set(['80010234','80010235','80010236','80010237','80010238']);

    // FW-126 TEST panel tap. The panel must see these frames no matter what the live view is
    // currently filtering out - a preset that hides them is a VIEW choice, and silently
    // starving the measurement panel because of it is exactly the class of defect that cost
    // the FW-121 ride. So this forwarding runs beside _writeRawFrameToFile, before any display
    // filtering, and never touches activeFilters, the presets or frameAccumulator.
    //
    // Two families qualify:
    //   the CH3 sweep aggregate block   0x00010240..0x00010246 (logged prefixed: 8001024x)
    //   any multi-frame reply to Canable (source 2 -> target 5, op START/DATA/END). DATA and
    //   END frames carry a fragment index instead of the command, so on ID alone they cannot
    //   be tied to 0x602D - the panel groups them by the START that opened the transfer, the
    //   same way tools/decode_fw126_cal_dump.ps1 does, and drops transfers opened by anything
    //   other than 0x602D. Forwarding is deliberately dumb; the correlation lives in one place.
    _isFw126PanelFrame(idHex){
        const n = parseInt(idHex, 16);
        if (!Number.isFinite(n)) return false;
        const idv = (n >>> 0) & 0x7FFFFFFF;          // drop the sniffer's 0x80 source prefix
        if (idv >= 0x00010240 && idv <= 0x00010246) return true;
        const op  = (idv >>> 16) & 0x07;
        const tgt = (idv >>> 19) & 0x1F;
        const src = (idv >>> 24) & 0x1F;
        return src === 2 && tgt === 5 && (op === CanOperation.MULTIFRAME_START ||
            op === CanOperation.MULTIFRAME || op === CanOperation.MULTIFRAME_END);
    }

    _forwardFw126Frame(idHex, dlc, dataHex){
        if (!this.ws) return;
        if (!this._isFw126PanelFrame(idHex)) return;
        try {
            this.ws.send(`FW126_FRAME:${idHex}|${dlc}|${dataHex}`);
        } catch (e) {
            // Never let the panel tap break frame handling: the RAW file and the live view are
            // the primary records and both have already been served by the time this runs.
            console.error('[FW-126] panel forward failed:', e.message);
        }
    }

    constructor(canbus, ws=null){
        this.canbus = canbus;
        this.ws = ws;
        this.canbus.on('raw_frame_received',this.rawFrameRecived);
        this.logMessage(`Listeaning for frames...`);
    }

    // writeToFile defaults to true for lifecycle/summary messages (start/stop, the DISPLAY
    // accumulator's periodic "Repeated N times" flushes). Per-frame CAN data must NOT write
    // to file through here — see _writeRawFrameToFile, which runs unconditionally and
    // uncompressed for every received frame regardless of display filters, so callers that
    // format an already-raw-logged frame for DISPLAY pass writeToFile=false to avoid a
    // duplicate (and, for the compressed summaries, non-raw) entry in the log file.
    logMessage(message, type = 'INFO', sendOverWS = true, writeToFile = true) {
        try {
            const timestamp = new Date().toLocaleTimeString();
            if(sendOverWS)
                console.log(`[${timestamp}] [${type}] ${message}`);
            if(writeToFile && this.logToFile)
                this.logToFile(`[${timestamp}]\t[${type}]\t${message}`);
            if(sendOverWS && this.ws){
                this.ws.send(`SNIFFER_ENTRY:[${timestamp}]\t[${type}]\t${message}`);
                if (DEBUG) debugLog(`[CAN UI] websocket sent=true readyState=${this.ws.readyState}`);
            } else if (DEBUG && sendOverWS) {
                debugLog(`[CAN UI] websocket sent=false (this.ws=${!!this.ws})`);
            }
        }catch( e ) {
            // A frame that matched activeFilters but never reached the browser is exactly what
            // makes the live view look silent while RAW file logging (unaffected by this.ws)
            // keeps working — always surface it, not just under SNIFFER_DEBUG.
            console.error('[CAN UI] websocket send failed:', e.message);
        }
    }

    // The RAW diagnostic capture: Log to file must contain every single received CAN frame,
    // one line each, in arrival order, completely independent of activeFilters (including
    // whatever a preset put into it) — that is a view-only filter over what the UI shows, not
    // over what gets captured for later analysis. Deliberately bypasses frameAccumulator (the
    // DISPLAY compression for repeated identical frames) entirely.
    _writeRawFrameToFile(idHex, dlc, dataHex, timestamp, diagBadge){
        if (!this.logToFile) return;
        const wallClock = new Date().toLocaleTimeString();
        const line = `${timestamp}\tID:${idHex}\tDLC:${dlc}\tData:${dataHex}${diagBadge}`;
        this.logToFile(`[${wallClock}]\t[INFO]\t${line}`);
    }

    async setupLogger(){
        this.logToFile = await setupLogger()
    }

    // The whole live-view filtering pipeline, in one place: ALL_TRAFFIC short-circuits to
    // "everything visible" (including an ID this app has never seen before); DEFAULT_TRAFFIC
    // is "everything except the fixed spam list" (same: an unknown ID stays visible); any other
    // entry is an exact/wildcard CAN ID match. All active entries combine as OR — an empty
    // activeFilters set therefore means nothing matches anything, i.e. the live view shows
    // nothing (the UI is expected to make that state obvious; RAW file logging is unaffected
    // either way, see _writeRawFrameToFile).
    _isFrameVisible(idHex){
        let result, reason;
        if (this.activeFilters.has(ALL_TRAFFIC_TOKEN)) {
            result = true; reason = 'ALL_TRAFFIC';
        } else if (this.activeFilters.has(DEFAULT_TRAFFIC_TOKEN) && !DEFAULT_EXCLUDED_IDS.has(idHex)) {
            result = true; reason = 'DEFAULT_TRAFFIC';
        } else {
            result = false; reason = 'no match';
            for (const entry of this.activeFilters) {
                if (entry === ALL_TRAFFIC_TOKEN || entry === DEFAULT_TRAFFIC_TOKEN) continue;
                if (idMatchesPattern(idHex, entry)) { result = true; reason = `filter "${entry}"`; break; }
            }
        }
        if (DEBUG) debugLog(`[CAN FILTER] active=${JSON.stringify([...this.activeFilters])} id=${idHex} match=${result} (${reason})`);
        return result;
    }

    // Decodes idHex and, if it matches the diag protocol, classifies it as
    // 'DIAG_REQUEST' | 'DIAG_START' | 'DIAG_DATA' | 'DIAG_END' (else category is null).
    // DATA/END additionally require a diag transfer to currently be open (correlation with
    // an already-seen DIAG_START — see the class-level comment on why ID alone cannot tell
    // them apart from any other multi-frame transfer between the same two devices) — an
    // otherwise-matching frame with no open transfer is deliberately left unclassified rather
    // than assumed to belong to the dump. subCode is returned alongside the category since
    // DATA/END callers need it to check the transfer's frame sequence (see _trackDiagSequence).
    _decodeDiagFrame(idHex){
        const { source, target, opCode, cmdCode, subCode } = decodeBafangId(idHex);
        let category = null;
        if (source === DeviceNetworkId.BESST && target === DeviceNetworkId.DRIVE_UNIT
            && opCode === CanOperation.READ_CMD && cmdCode === DIAG_CMD_CODE && subCode === DIAG_SUB_CODE) {
            category = 'DIAG_REQUEST';
        } else if (source === DeviceNetworkId.DRIVE_UNIT && target === DeviceNetworkId.BESST) {
            if (opCode === CanOperation.MULTIFRAME_START && cmdCode === DIAG_CMD_CODE && subCode === DIAG_SUB_CODE) {
                category = 'DIAG_START';
            } else if (cmdCode === 0x00 && opCode === CanOperation.MULTIFRAME && this.diagTransfer) {
                category = 'DIAG_DATA';
            } else if (cmdCode === 0x00 && opCode === CanOperation.MULTIFRAME_END && this.diagTransfer) {
                category = 'DIAG_END';
            }
        }
        return { category, subCode };
    }

    _sendDiagStatus(status){
        if (this.ws) {
            try { this.ws.send(`SNIFFER_DIAG_STATUS:${JSON.stringify(status)}`); } catch(e) { /* connection may already be gone */ }
        }
    }

    _armDiagTimeout(){
        if (this.diagTransferTimeout) clearTimeout(this.diagTransferTimeout);
        this.diagTransferTimeout = setTimeout(() => {
            const t = this.diagTransfer;
            this.diagTransfer = null;
            this.diagTransferTimeout = null;
            this._sendDiagStatus(this._diagStatusPayload('incomplete', t));
        }, this.diagTransferTimeoutMs);
    }

    _diagStatusPayload(state, transfer = this.diagTransfer){
        return {
            state,
            expectedLength: transfer?.expectedLength ?? null,
            dataFrameCount: transfer?.dataFrameCount ?? 0,
            hasEnd: transfer?.hasEnd ?? false,
            receivedBytes: transfer?.receivedBytes ?? 0,
            suspicious: transfer?.suspicious ?? false,
        };
    }

    // The protocol numbers DATA/END frames with a running sequence in the ID's last byte
    // (see the class-level comment); canbus.js's own generic multi-frame handling treats END
    // as simply the next frame in that same numbering, so END is checked the same way DATA
    // is. A gap or a repeat never throws — it only flags the transfer so COMPLETE is never
    // reported over data we can't vouch for; the frame itself is still captured unconditionally
    // by _writeRawFrameToFile regardless of this flag.
    _trackDiagSequence(subCode){
        const t = this.diagTransfer;
        if (subCode === t.nextSequence) {
            t.nextSequence++;
        } else {
            t.suspicious = true;
            if (subCode >= t.nextSequence) t.nextSequence = subCode + 1;
        }
    }

    // Tracks whether a Ride Diagnostics dump (see class-level comment) currently in flight
    // completes. Runs on EVERY frame regardless of the active hidden/show-only/preset view,
    // so the status is accurate even while diag traffic is filtered out of the visible log.
    // dataFrameCount and hasEnd are kept separate (never summed into one ambiguous "frames"
    // figure) so the reported counts describe exactly what was seen.
    _updateDiagTransfer(category, subCode, dlc, dataHex){
        if (category === 'DIAG_START') {
            // START's own payload carries the expected length as its first byte (see the
            // class-level comment) — read from THAT, never a hardcoded constant, so a future
            // firmware revision with a different dump size still reports correctly.
            const firstByteHex = dataHex ? dataHex.split(' ')[0] : null;
            const expectedLength = firstByteHex ? parseInt(firstByteHex, 16) : null;
            this.diagTransfer = {
                expectedLength,
                dataFrameCount: 0,
                hasEnd: false,
                receivedBytes: 0,
                nextSequence: 0,
                suspicious: false,
            };
            this._armDiagTimeout();
            this._sendDiagStatus(this._diagStatusPayload('active'));
        } else if (category === 'DIAG_DATA' && this.diagTransfer) {
            this._trackDiagSequence(subCode);
            this.diagTransfer.dataFrameCount++;
            this.diagTransfer.receivedBytes += dlc;
            this._armDiagTimeout();
        } else if (category === 'DIAG_END' && this.diagTransfer) {
            this._trackDiagSequence(subCode);
            this.diagTransfer.hasEnd = true;
            this.diagTransfer.receivedBytes += dlc; // END carries the final payload chunk too
            if (this.diagTransferTimeout) { clearTimeout(this.diagTransferTimeout); this.diagTransferTimeout = null; }
            const finished = this.diagTransfer;
            this.diagTransfer = null;
            this._sendDiagStatus(this._diagStatusPayload(finished.suspicious ? 'incomplete' : 'complete', finished));
        }
    }

    rawFrameRecived = (rawFrame)=>{
        const { idHex, dataHex, dlc, timestamp } = formatRawCanFrameData(rawFrame);
        if (idHex === "INVALID") {
            console.warn("Received invalid frame object, skipping.");
            return;
        }
        if (DEBUG) debugLog(`[CAN RX] id=${idHex} dlc=${dlc}`);

        // Diag classification/tracking always runs, independent of what the current view
        // filters out, so "did the dump complete" stays accurate no matter which frames are
        // hidden from the log (see _updateDiagTransfer).
        const { category: diagCategory, subCode: diagSubCode } = this._decodeDiagFrame(idHex);
        this._updateDiagTransfer(diagCategory, diagSubCode, dlc, dataHex);

        // Presentation-only label appended to the log line; the raw CAN data above is untouched.
        const diagBadge = diagCategory ? ` [${diagCategory.replace('DIAG_', 'DIAG ')}]` : '';

        // RAW FILE LOGGING — every received frame, unconditionally, before any display
        // filtering below. Hidden Frames / Show Only / the DIAG presets only ever change what
        // the live view shows; the file is always the full, uncompressed capture.
        this._writeRawFrameToFile(idHex, dlc, dataHex, timestamp, diagBadge);

        // FW-126 TEST panel: same position in the pipeline as the raw file write, and for the
        // same reason - it is a capture, not a view. See _isFw126PanelFrame.
        this._forwardFw126Frame(idHex, dlc, dataHex);

        // <<< --- DISPLAY FILTERING LOGIC (gates the live view only, never file logging) --- >>>
        if (!this._isFrameVisible(idHex)) {
            return; // Exit the handler: not shown live. Already captured raw above if logging is on.
        }
        // <<< --- END DISPLAY FILTERING LOGIC --- >>>

        // <<< --- FW-117 BYPASS: never accumulate for DISPLAY, always show immediately, in order --- >>>
        if (this.fw117TraceIds.has(idHex)) {
            const logMessage = `${timestamp}\tID:${idHex}\tDLC:${dlc}\tData:${dataHex}${diagBadge}`;
            this.logMessage(logMessage, 'INFO', true, false); // already raw-logged above
            return; // Exit the handler - this ID never touches frameAccumulator.
        }
        // <<< --- END FW-117 BYPASS --- >>>

        const currentEntry = this.frameAccumulator[idHex];

        if (currentEntry) {
            // Frame ID exists in accumulator
            if (dataHex === currentEntry.lastDataHex) {
                // Data is the same as the last one for this ID, increment count
                currentEntry.count++;
                currentEntry.lastTimestamp = timestamp; // Update timestamp of last seen identical frame
                // Log the every 100 repeat same data (display-only summary; every individual
                // frame is already in the file via _writeRawFrameToFile above)
                if (currentEntry.count % 100 == 0) {
                    const logMessage = `${currentEntry.lastTimestamp}\tID:${idHex}\tDLC:${currentEntry.dlc}\tData:${currentEntry.lastDataHex}\t(Repeated ${currentEntry.count} times - same data)${diagBadge}`;
                    this.logMessage(logMessage, 'INFO', true, false);
                }
            } else {
                // Data has changed for this ID
                // Log the summary of the previous sequence if it repeated (display-only)
                if (currentEntry.count > 1) {
                    const logMessage = `${currentEntry.lastTimestamp}\tID:${idHex}\tDLC:${currentEntry.dlc}\tData:${currentEntry.lastDataHex}\t(Repeated ${currentEntry.count} times)${diagBadge}`;
                    this.logMessage(logMessage, 'INFO', true, false);
                }
                // Show the new, different frame (already raw-logged above)
                const logMessage = `${timestamp}\tID:${idHex}\tDLC:${dlc}\tData:${dataHex}${diagBadge}`
                this.logMessage(logMessage, 'INFO', true, false)
                // Update the accumulator with the new data and reset count
                currentEntry.lastDataHex = dataHex;
                currentEntry.count = 1;
                currentEntry.dlc = dlc; // Update DLC in case it changed
                currentEntry.lastTimestamp = timestamp;
            }
        } else {
            // First time seeing this non-filtered frame ID (since last change or startup)
            // Show the new frame (already raw-logged above)
            const logMessage = `${timestamp}\tID:${idHex}\tDLC:${dlc}\tData:${dataHex}${diagBadge}`
            this.logMessage(logMessage, 'INFO', true, false)
            // Create the entry in the accumulator
            this.frameAccumulator[idHex] = {
                lastDataHex: dataHex,
                count: 1,
                dlc: dlc, // Store DLC
                lastTimestamp: timestamp
            };
        }
    }

    cleanup(){
        this.canbus.removeListener('raw_frame_received', this.rawFrameRecived);
        if (this.diagTransferTimeout) { clearTimeout(this.diagTransferTimeout); this.diagTransferTimeout = null; }
        for (const idHex in this.frameAccumulator) {
            // No need to re-check activeFilters here — a filtered-out frame never reaches the accumulator
            const entry = this.frameAccumulator[idHex];
            if (entry.count > 1) {
                // Display-only summary — every individual frame is already in the file.
                const logMessage = `${entry.lastTimestamp}\tID:${idHex}\tDLC:${entry.dlc}\tData:${entry.lastDataHex}\t(Repeated ${entry.count} times)`;
                this.logMessage(logMessage, 'INFO', true, false)
            }
        }
        this.logMessage(`Stoping sniffer...`);
    }
}

module.exports = Sniffer;