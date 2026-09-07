const { setupLogger, formatRawCanFrameData, delay,delayu } = require('./utils');
// --- Configuration Constants ---
const CHUNK_SIZE = 8; // Bytes per chunk
const HEADER_SIZE = 16; // The first 16 hex bytes to be excluded from the data transfer
const delayMs = 2; // Delay between steps (milliseconds, adjust if needed)
const delayUs = 300; // Extra delay between chunks (microseconds, adjust if needed)
// Minimum wall-clock period per data frame.
//
// One 29-bit ID + 8 data bytes is ~150 bits after stuffing, i.e. ~600 us on a
// 250 kbit/s bus. The official BESST tool paces its 60 833 frames at ~810 us
// (49.3 s of transfer, measured on a bus sniff of a successful DPC245 flash).
// Sending faster than the wire can carry only grows the adapter's TX FIFO, and
// gs_usb does NOT report that overflow: transferOut returning "ok" says USB
// accepted the frame, not that it reached CAN (echo is disabled, echo_id
// 0xFFFFFFFF). A dropped frame is invisible to this protocol - block ACKs
// (x2A**02) confirm a POSITION, never a gap - so the hole surfaces only at the
// end as a missing final ACK. That is the classic "stops at 99 %".
//
// Hence a floor on the period instead of a hopeful delay: the schedule below is
// absolute, so the average can never come out faster than this.
const MIN_FRAME_PERIOD_US = 810;
// After the last chunk the display programs its own flash. BESST holds the
// session open for ~26 s (00 announce every ~60 ms) and closes it with 01.
const FLASH_WRITE_WINDOW_MS = 26000;
const FLASH_WRITE_KEEPALIVE_MS = 60;
const FLASH_WRITE_LOG_STEP_MS = 5000;

class FwUpdater {

    constructor(canbus, ws=null){
        this.canbus = canbus;
        this.ws = ws;
        this.init()
        this.setupCunbus()
        this.delayUs = delayUs;
        this.minFramePeriodUs = MIN_FRAME_PERIOD_US;
        this.flashWriteWindowMs = FLASH_WRITE_WINDOW_MS;
        this.flashWriteKeepaliveMs = FLASH_WRITE_KEEPALIVE_MS;
    }
    init(){
        this.firmwareBuffer = null; // Buffer to hold the firmware file content
        this.FIRMWARE_FILE_SIZE = 0; // Will be set after reading the file
        this.NUM_CHUNKS = 0;         // Will be calculated after reading the file
        this.controllerReady =      false; // Flag to track if controler is ready for update
        this.commnad6008ack =    false; // Flag to track if 6008 ACK was received
        this.updateProcessStarted = false; // Flag to track if the update process has started
        this.lastChunkConfirmed =   false; // Flag to track if the last chunk has been confirmed
        this.lastChunkAckData = null;      // status bytes carried by the final ACK
        this.lastChunkAckDlc = 0;
        this.firstChunkACK =        false;
        this.lastChunkId = null; // Will be set after the last chunk number is calculated
        this.timeout = 15000; // 15 seconds timeout;
        this.startTime = Date.now();
        this.progress = 0; // procentage
        this.end = false;
        this.lastChunkSendIndex = -1;
        this.leadingIdNum = "8"; // The leading number for the ID, e.g., 8 for 82F83200
        this.chunksACKObject = {}; // Object to track ACKs for each 
        this.chunksACKObjectplus1 = {}; //
        this.deviceId = '2'; //Controler
        this.indexAckCheckFct = (i) => (i - 1) % 256 === 0 && i!==2;
        this.doWhileAckCheckFct = (i) => this.chunksACKObjectplus1[i];
        this.startSendChunkIndex = 2;
        this.chunk0Prefix = '4';
        this.chunkNPrefix = '5';
        this.chunkEndPrefix = '6';
    }
    setupForNewMotor(){
        this.readyIdSent =       '5114000'; 
        this.readyIdAck =        '22A4000'; 
        this.firstPackageId =    '5104001'; 
        this.firstPackageIdAck = '22A4001';
        this.id6008 =            '5116008';
    }
    setupForOldMotor(){
        this.readyIdSent =       '5112000';
        this.readyIdAck =        '22A2000';
        this.firstPackageId =    '5142001';
        this.firstPackageIdAck = '22A2001';
        this.startSendChunkIndex = 0;
        this.indexAckCheckFct = (i) => true;
        this.doWhileAckCheckFct = (i) => this.chunksACKObject[i];
    }
    setupForHMI(){
        this.deviceId = '3'; //HMI
        this.indexAckCheckFct = (i) => (i - 1) % 256 === 0 && i!==2;
        this.chunk0Prefix = 'C';
        this.chunkNPrefix = 'D';
        this.chunkEndPrefix = 'E';
        this.readyIdSent =       '5194000'; 
        this.readyIdAck =        '32A4000'; 
        this.firstPackageId =    '5184001'; 
        this.firstPackageIdAck = '32A4001';
        this.id6008 =            '5196008';
    }
    setupForDPC18(){
        this.setupForHMI();
        this.indexAckCheckFct = (i) => (i - 1) % 4096 === 0 && i!==2;
    }
    setupForDPE160(){
        this.setupForHMI();
        this.indexAckCheckFct = (i) => ((i - 1) % 256 === 0 && i!==2) || (i + 127) % 256 === 0;
    }
    setupForHubControler(){
        this.setupForNewMotor();
        this.indexAckCheckFct = (i) => (i % 256 === 0 && i!==2) || (i + 128) % 256 === 0;
        this.doWhileAckCheckFct = (i) => this.chunksACKObject[i];
    }
    overallProgress(){
        let progress = this.progress+this.controllerReady+this.updateProcessStarted+this.lastChunkConfirmed+this.end-4;
        if(progress < 0)
            return 0;
        else 
            return progress;
    }
    logMessage(message, type = 'INFO',sendOverWS = true) {
        try {
            const timestamp = new Date().toLocaleTimeString();
            if(sendOverWS)
                console.log(`[${timestamp}] [${type}] ${message}`);
            this.logToFile(`[${timestamp}]\t[${type}]\t${message}`);
            if(sendOverWS && this.ws){
                this.ws.send(`FW_UPDATE_LOG:[${type}] ${message}`);
            }
        }catch( e ) {
            console.log(e, 'ERROR');
        }
    }
    initFile(fileBuffer){
        this.firmwareBuffer = fileBuffer;
        this.FIRMWARE_FILE_SIZE = this.firmwareBuffer.length;
        const dataLength = Math.max(0, this.FIRMWARE_FILE_SIZE - HEADER_SIZE);
        // const maxValue = (2 ** (3 * 8)) - 1; 
        // if (dataLength < 0 || dataLength > maxValue) { 
        //     throw `File is to big ...`;
        // } 
        this.NUM_CHUNKS = Math.ceil(dataLength / CHUNK_SIZE);
        // The chunk number is four hex digits inside the frame ID, so numbering wraps
        // above 65535 chunks (= 524 288 B of payload) and the tail of the image would
        // silently overwrite its beginning. DPC245 (486 664 B / 60 833 chunks) fits.
        if (this.NUM_CHUNKS > 0xFFFF) {
            throw `Firmware file too large for this protocol: ${this.NUM_CHUNKS} chunks, `
                + `maximum is 65535 (${0xFFFF * CHUNK_SIZE + HEADER_SIZE} bytes).`;
        }
        this.logMessage(`Firmware file loaded. Size: ${this.FIRMWARE_FILE_SIZE} bytes. Data chunks to send: ${this.NUM_CHUNKS}`, 'INFO');
        const fileHeaderData = Array.from(this.firmwareBuffer.slice(0, 15)).map(byte =>byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        this.logMessage(`File header data: ${fileHeaderData}`, 'INFO');
    }
    setupCunbus(){
        // Kept in a field so cleanup() can remove it. As an inline arrow it could never be
        // taken off again, so every flash attempt left another listener on the canbus
        // singleton for the lifetime of the process — after three attempts every CAN frame
        // from the bike ran three dead closures. logger.js, sniffer.js and
        // debug-logger-cli.js all pair on() with removeListener(); this was the exception.
        this.onRawFrame = (rawFrame) => {
            if(this.end)
                return;
            const { idHex, dataHex, dlc, timestamp } = formatRawCanFrameData(rawFrame);
            if (idHex === "INVALID") {
                console.warn("Received invalid frame object, skipping.");
                return;
            }
            //this.logMessage(`RECIVE ID: ${idHex} DLC: ${dlc} Data: ${dataHex} (Timestamp: ${timestamp})`, 'INFO',false);
            if(idHex.includes(this.readyIdAck)){
                this.controllerReady = true;
            }
            if(idHex.includes(this.firstPackageIdAck)){
                this.updateProcessStarted = true;
            }
            if(idHex.includes(`${this.deviceId}2A${this.formatChunkNumber(this.NUM_CHUNKS)}`) || idHex.includes(`${this.deviceId}2A${this.formatChunkNumber(this.NUM_CHUNKS-1)}`)){
                // The final ACK carries status bytes (DLC 4 on DPC245, all zero on a good
                // flash) where the block ACKs carry none. It is the only completeness
                // signal this protocol has, so keep it instead of only raising the flag.
                this.lastChunkAckData = dataHex;
                this.lastChunkAckDlc = dlc;
                this.lastChunkConfirmed = true;
            }
            if(idHex.includes(`${this.deviceId}2A6008`)){
                this.commnad6008ack = true;
            }
            if(this.lastChunkSendIndex >= 0 && idHex.includes(`${this.deviceId}2A${this.formatChunkNumber(this.lastChunkSendIndex)}`)){
                this.chunksACKObject[this.lastChunkSendIndex] = true; // Mark this chunk as acknowledged
            }
            if(this.lastChunkSendIndex >= 0 && idHex.includes(`${this.deviceId}2A${this.formatChunkNumber(this.lastChunkSendIndex+1)}`)){
                this.chunksACKObjectplus1[this.lastChunkSendIndex] = true; // Mark this chunk as acknowledged
            }
            if(idHex.includes(`${this.deviceId}2A0002`)){
                this.firstChunkACK = true;
            }
        };
        this.canbus.on('raw_frame_received', this.onRawFrame);
    }

    // Called when the procedure ends, however it ended. Without this the updater stays
    // attached to the frame stream forever.
    cleanup(){
        if (!this.onRawFrame) return;
        this.canbus.removeListener('raw_frame_received', this.onRawFrame);
        this.onRawFrame = null;
    }
    async sendRawFrameWithRetry(id,data,retries = 3){
        // Every step of the flash funnels through here, so one check covers all of them.
        // Without it a link that dies mid-flash is only noticed at the next ACK checkpoint
        // — up to 255 chunks later — or at a step timeout 15 s on, and the failure reads
        // as a cryptic timeout instead of what actually happened.
        if (!this.canbus.isConnected()) {
            throw new Error('CAN link lost during the firmware update — the adapter stopped responding.');
        }
        let sent = false;
        let tryCount = 0;
        //this.logMessage(`Sending ID:${this.leadingIdNum+id}`, 'SENT');
        do{
            sent = await this.canbus.sendRawFrame(this.leadingIdNum+id,data);
            if (!sent) {
                this.logMessage(`sendFrame returned false for ID${this.leadingIdNum+id}`, 'ERROR');
                await delay(delayMs);
            }
            tryCount++;
        }while(!sent && tryCount < retries);
        // Carrying on silently used to punch a hole in the image: this protocol has no
        // retransmission and no way to report a gap, so a frame that never left the
        // adapter is discovered only at the very end, as a missing final ACK. Better to
        // stop here, with the reason, than to write an incomplete firmware.
        // retries === 0 is the fire-and-forget announce loop; it may miss a beat.
        if (!sent && retries > 0) {
            throw new Error(`Frame ID${this.leadingIdNum+id} could not be sent after ${tryCount} `
                + 'attempt(s) — the update was stopped instead of writing an incomplete image.');
        }
        return sent;
    }
    async emitProgress() {
        do{
            try {
                await delay(1000);
                if(this.ws)
                    this.ws.send(`FW_UPDATE_PROGRESS:${this.overallProgress()}`);
                else
                    console.log(this.overallProgress())
            }
            catch( e ) {
                //this.logMessage(e, 'ERROR',false);
            }
        }while(!this.end);
    }
    async announceHostReady() {
        this.logMessage('Step 1: Announcing host readiness...', 'INFO');
        do{
            await this.sendRawFrameWithRetry("5FF3005","00",0);
            await delay(60);
            // Also stop on a dead link, so this loop cannot keep writing frames into a
            // handle that step 2 already gave up on.
        }while(!this.controllerReady && !this.end && this.canbus.isConnected());
    }
    async checkForControllerReady(){
        this.logMessage('Step 2:Waiting for controler ready state...', 'INFO');
        this.first3bytes = [this.firmwareBuffer[0].toString(16).padStart(2, '0'),this.firmwareBuffer[1].toString(16).padStart(2, '0'),this.deviceId.toString().padStart(2,'0'),this.firmwareBuffer[3].toString(16).padStart(2, '0')]
        do{
            await this.sendRawFrameWithRetry(this.readyIdSent,this.first3bytes.join(''));
            await delay(60);
            // if (Date.now() - this.startTime > (this.timeout-5000) && this.readyIdSent == '5114000') {
            //     this.logMessage('Not responding for this method, trying the old way....', 'INFO');
            //     this.setupForOldMotor();
            // }
            if (Date.now() - this.startTime > this.timeout) {
                // Reworded deliberately: the pre-flight only checks the USB adapter, so a
                // powered-down bike still reaches this point. Say what to look at.
                throw 'Step 2: the controller never announced it was ready. Is the bike switched on and the CAN harness connected?'
            }
        }while(!this.controllerReady);
    }
    async send6008Id(){
        await this.sendRawFrameWithRetry(this.id6008,"");
        this.startTime = Date.now();
        this.logMessage('Step 2.1: Waiting for acknowledgment of the 6008 package...', 'INFO');
        do{
            await delay(20);
            if (Date.now() - this.startTime > this.timeout) {
                throw 'Step 2.1: Timeout reached, exiting loop....'
            }
        }while(!this.commnad6008ack);
    }
    async sendFirstPackage() {
        this.logMessage('Step 3: Sending first package (file length)...', 'INFO');
        const fileLengthMinus16 = this.FIRMWARE_FILE_SIZE - HEADER_SIZE;
        const hexLength = fileLengthMinus16.toString(16).padStart(6, '0').toUpperCase(); // ## ## ## format
        //this.logMessage(`ID:${this.firstPackageId}#${hexLength}`, 'SENT');
        await this.sendRawFrameWithRetry(this.firstPackageId,hexLength);
        this.startTime = Date.now();
        this.logMessage('Step 4: Waiting for acknowledgment of the first package...', 'INFO');
        do{
            await delay(20);
            if (Date.now() - this.startTime > this.timeout) {
                throw 'Step 4: Timeout reached, exiting loop....'
            }
        }while(!this.updateProcessStarted);
    }
    formatChunkNumber(num) {
        const wrappedNum = num % 65536;
        return wrappedNum.toString(16).padStart(4, '0').toUpperCase();
    }
    getFirmwareChunk(chunkNum) {
        const dataStartIndex = HEADER_SIZE + (chunkNum * CHUNK_SIZE);
        const dataEndIndex = Math.min(dataStartIndex + CHUNK_SIZE, this.FIRMWARE_FILE_SIZE);
        const chunkSlice = this.firmwareBuffer.slice(dataStartIndex, dataEndIndex);
        const chunkData = Array.from(chunkSlice).map(byte =>
            byte.toString(16).padStart(2, '0').toUpperCase()
        ).join('');
        return chunkData;
    }
    async sendFirstChunk() {
        const chunkId0 = this.formatChunkNumber(0); // #### incrementing chunk number
        const chunkData0 = this.getFirmwareChunk(0); // XXXXXXXXXXXXXXXX
        await this.sendRawFrameWithRetry(`51${this.chunk0Prefix}${chunkId0}`,chunkData0);
        await delay(delayMs);
        const chunkId1 = this.formatChunkNumber(1); // #### incrementing chunk number
        const chunkData1 = this.getFirmwareChunk(1); // XXXXXXXXXXXXXXXX
        await this.sendRawFrameWithRetry(`51${this.chunkNPrefix}${chunkId1}`,chunkData1);
        this.startTime = Date.now();
        this.logMessage('Step 4.1: Waiting for acknowledgment of the first chunk...', 'INFO');
        do{
            await delay(20);
            if (Date.now() - this.startTime > this.timeout) {
                throw 'Step 4.1: Timeout reached, exiting loop....';
            }
        }while(!this.firstChunkACK);
    }
    // Wall-clock pacing instead of a blind per-frame delay.
    //
    // The schedule is ABSOLUTE - frame n of the current run is due at
    // base + n * period - so a send that takes longer than expected eats its own
    // slack and the average period can never drop below the floor. That is the
    // property that keeps the adapter's TX FIFO from growing; a fixed "sleep X us
    // after each frame" gives period = X + send time, which nobody measured.
    framePeriodUs(){
        return Math.max(this.delayUs, this.minFramePeriodUs);
    }
    async paceFrame(sentCount, baseMs){
        const dueMs = baseMs + (sentCount * this.framePeriodUs()) / 1000;
        const waitMs = dueMs - performance.now();
        if (waitMs > 0) await delayu(Math.round(waitMs * 1000));
    }
    async sendDataChunks() {
        this.logMessage(`Step 5: Sending data chunks (pacing floor ${this.framePeriodUs()} us/frame, `
            + `BESST reference ~${MIN_FRAME_PERIOD_US} us)...`, 'INFO');
        const runStartMs = performance.now();
        // Schedule base. Reset after every ACK checkpoint so the dead time spent
        // waiting is not turned into credit for a catch-up burst - a burst is exactly
        // what overflows the FIFO.
        let baseMs = runStartMs;
        let sentCount = 0;
        let firstChunk = this.startSendChunkIndex;
        let windowChunk = this.startSendChunkIndex;
        let windowMs = runStartMs;
        for (let i = this.startSendChunkIndex; i < this.NUM_CHUNKS - 1; i++) {
            const chunkId = this.formatChunkNumber(i); // #### incrementing chunk number
            const chunkData = this.getFirmwareChunk(i); // XXXXXXXXXXXXXXXX
            this.lastChunkSendIndex = i;
            await this.sendRawFrameWithRetry(`51${this.chunkNPrefix}${chunkId}`,chunkData);
            sentCount++;
            this.progress = Math.round((i/this.NUM_CHUNKS)*100);
            if (this.indexAckCheckFct(i)) {
                this.startTime = Date.now();
                do{
                    await delayu(this.delayUs);
                    if (Date.now() - this.startTime > this.timeout) {
                        throw `Step 5(chunkId:${chunkId}): Timeout reached, exiting loop....`;
                    }
                }while(!this.doWhileAckCheckFct(i));
                baseMs = performance.now();
                sentCount = 0;
            }else
                await this.paceFrame(sentCount, baseMs);
            // Measured cadence, so the floor can be checked against reality instead of
            // assumed. Compare with the ~810 us/frame the official tool achieves.
            if (i - windowChunk >= 8192) {
                const now = performance.now();
                const windowUs = ((now - windowMs) * 1000) / (i - windowChunk);
                const avgUs = ((now - runStartMs) * 1000) / (i - firstChunk);
                this.logMessage(`Chunk ${i}/${this.NUM_CHUNKS}: ${windowUs.toFixed(0)} us/frame `
                    + `(avg ${avgUs.toFixed(0)})`, 'INFO');
                windowChunk = i;
                windowMs = now;
            }
        }
        const totalUs = ((performance.now() - runStartMs) * 1000) / Math.max(1, (this.NUM_CHUNKS - 1 - firstChunk));
        this.logMessage(`All data chunks (except the last) sent — ${totalUs.toFixed(0)} us/frame average.`, 'INFO');
    }
    async sendLastPackageAndEndTransfer() {
        this.logMessage('Step 6: Sending last data package and ending transfer...', 'INFO');
        this.lastChunkId = this.formatChunkNumber(this.NUM_CHUNKS - 1);
        const lastPackageContent = this.getFirmwareChunk(this.NUM_CHUNKS - 1);
        await this.sendRawFrameWithRetry(`51${this.chunkEndPrefix}${this.lastChunkId}`,lastPackageContent);
        this.startTime = Date.now();
        this.logMessage('Step 7: Waiting for acknowledgment of the last package...', 'INFO');
        do{
            await delay(20);
            if (Date.now() - this.startTime > (30000)) {
                throw 'Step 7: Timeout reached, exiting loop....';
            }
        }while(!this.lastChunkConfirmed);
        // Block ACKs have DLC 0; the closing ACK carries a status word (DPC245: four
        // zero bytes on a good transfer). Since the protocol cannot report a gap in the
        // middle, this is the only place a lost frame can still be caught before the
        // display starts writing a broken image.
        if (this.lastChunkAckDlc > 0) {
            this.logMessage(`Final ACK status: ${this.lastChunkAckData}`, 'INFO');
            if (/[^0]/.test((this.lastChunkAckData || '').replace(/\s/g, ''))) {
                throw `Step 7: the device rejected the image (final ACK status `
                    + `${this.lastChunkAckData}). Nothing has been written yet — repeat the update.`;
            }
        }
        
    }
    // Closing sequence, replicated from a bus sniff of the official tool:
    //
    //   ~200 ms after the final ACK   85FF3005#01
    //   ~1 s later                    85FF3005#00      (device answers ..FF3005#01)
    //   then                          85FF3005#00 every ~60 ms for ~26 s
    //   then                          85FF3005#01
    //
    // Those 26 s are the window in which the display programs its own flash. The old
    // implementation was delay(3000) -> 01 -> delay(2000), i.e. it dropped the window
    // entirely and closed the session while the device was still writing.
    //
    // Holding the session open cannot do any harm: command 0x3005 is handled only by
    // the resident bootloader — it does not exist in the application at all (checked on
    // the DPC245 image: the constant appears nowhere in the APP), so once the display
    // reboots into the new firmware every one of these announces is simply ignored.
    async announceFirmwareUpgradeEnd() {
        this.logMessage('Step 8: Announcing firmware upgrade end...', 'INFO');
        await delay(200);
        await this.sendRawFrameWithRetry("5FF3005","01");
        await delay(1000);
        await this.sendRawFrameWithRetry("5FF3005","00");
        this.logMessage(`Step 8.1: the display is now writing its flash. Holding the session open for `
            + `${Math.round(this.flashWriteWindowMs/1000)} s — do NOT disconnect the adapter and do NOT `
            + 'switch the bike off.', 'INFO');
        const windowEnd = Date.now() + this.flashWriteWindowMs;
        let nextLog = Date.now() + FLASH_WRITE_LOG_STEP_MS;
        while (Date.now() < windowEnd && this.canbus.isConnected()) {
            await this.sendRawFrameWithRetry("5FF3005","00",0);
            await delay(this.flashWriteKeepaliveMs);
            if (Date.now() >= nextLog) {
                nextLog = Date.now() + FLASH_WRITE_LOG_STEP_MS;
                this.logMessage(`Step 8.1: ${Math.max(0, Math.round((windowEnd - Date.now())/1000))} s left...`, 'INFO');
            }
        }
        await this.sendRawFrameWithRetry("5FF3005","01");
        await delay(500);
    }
    async announceFirmwareUpgradeEndOld() {
        this.logMessage('Step 8: Announcing firmware upgrade end...', 'INFO');
        await delay(2000);
        for (let i = 0; i < 6; i++) {
            await this.sendRawFrameWithRetry("5FF3005","00");
            await this.sendRawFrameWithRetry(this.readyIdSent,this.first3bytes.join(''));
            await delay(50);
        }
        await delay(2000);
        for (let i = 0; i < 4; i++) {
            await this.sendRawFrameWithRetry("5F83501","00");
            await delay(20);
        }
        await delay(1000);
    }

    // Is the adapter itself responding? Checked before the first byte goes out, because
    // writing firmware into a dead link is the worst way to find out.
    //
    // Deliberately ADAPTER ONLY — it does not ask the controller anything. So "adapter
    // fine, bike switched off" still passes here and fails later, at step 2, with the
    // reworded message that says to check the bike.
    async preflightAdapter() {
        if (!this.canbus.isConnected()) {
            return { ok: false, reason: 'the CANable adapter is not connected' };
        }
        if (typeof this.canbus.checkAlive !== 'function') return { ok: true }; // older canbus
        const alive = await this.canbus.checkAlive({ force: true });
        return alive.ok ? { ok: true } : { ok: false, reason: alive.reason || 'the adapter did not respond' };
    }

    async startUpdateProcedure(fileBuffer,mode="CONTROLER") {
        const startTime = performance.now();
        let ok = false;
        let failureReason = '';
        try {
            this.init();
            if(mode == "HMI")
                this.setupForHMI()
            else if(mode == "DPC18")
                this.setupForDPC18()
            else if (mode == "CONTROLER_OLD")
                this.setupForOldMotor()
            else if (mode == "DPE160")
                this.setupForDPE160()
            else if (mode == "CONTROLER_HUB")
                this.setupForHubControler()
            else
                this.setupForNewMotor()
            this.logToFile = await setupLogger();
            // Placed after setupLogger on purpose: logMessage() calls this.logToFile
            // unconditionally, so anything logged before this line throws internally and
            // never reaches the browser. fw-update-cli.js bypasses the server entirely,
            // which is why the check lives here as well as in the server handler.
            const preflight = await this.preflightAdapter();
            if (!preflight.ok) {
                throw `Firmware update aborted before sending anything: ${preflight.reason}. `
                    + 'Reconnect the adapter and try again. Note this checks the USB adapter only '
                    + '— it cannot tell whether the bike is switched on.';
            }
            this.initFile(fileBuffer);
            // Both loops run until this.end and must NOT be plain-awaited — announceHostReady
            // is meant to run concurrently with checkForControllerReady. Keep the promises so
            // their rejections are handled instead of becoming unhandled, and so they can be
            // drained in finally rather than writing into a torn-down handle afterwards.
            this.progressLoop = this.emitProgress().catch((e) => this.logMessage(`Progress reporting stopped: ${e.message || e}`, 'ERROR', false));
            this.hostReadyLoop = this.announceHostReady().catch((e) => this.logMessage(`Host-ready announce stopped: ${e.message || e}`, 'ERROR'));
            await this.checkForControllerReady();
            await delay(20);
            if(this.readyIdSent.includes('4000')){
                await this.send6008Id();
                await delay(20);
            }
            await this.sendFirstPackage();
            await delay(20);
            if(this.readyIdSent.includes('4000')){
                await this.sendFirstChunk();
                await delayu(this.delayUs);
            }
            await this.sendDataChunks();
            await delayu(this.delayUs);
            await this.sendLastPackageAndEndTransfer();
            await delay(20);
            if(this.readyIdSent.includes('4000'))
                await this.announceFirmwareUpgradeEnd();
            else
                await this.announceFirmwareUpgradeEndOld();
            this.logMessage('Firmware update completed successfully!', 'INFO');
            ok = true;
        } catch (error) {
            failureReason = `${error?.message || error}`;
            this.logMessage(error, 'ERROR');
            this.logMessage('Firmware update failed or was not completed.', 'ERROR');
        } finally {
            this.end = true
            // Drain the concurrent loops before reporting the end, so neither can still be
            // sending frames or progress after we have declared the procedure over.
            try { await this.hostReadyLoop; } catch { /* already reported by its own catch */ }
            try { await this.progressLoop; } catch { /* already reported by its own catch */ }
            const endTime = performance.now();
            const timeInSeconds = (endTime - startTime) / 1000;
            this.cleanup(); // stop listening to the bus, whatever the outcome
            this.logMessage(`Runtime: ${timeInSeconds}s`,'INFO');
            if(this.ws)
                // The outcome travels with the message. It used to be a bare FW_UPDATE_END
                // on both paths, so a failed flash looked exactly like a finished one.
                this.ws.send(ok ? 'FW_UPDATE_END:OK' : `FW_UPDATE_END:FAILED:${failureReason}`);
        }
        return ok;
    }

}

module.exports = FwUpdater;