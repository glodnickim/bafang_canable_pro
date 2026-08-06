// canbus.js
const { GSUsb } = require('./gsusb');
const { CanFrame } = require('./canframe');
const { EventEmitter } = require('node:events'); // Use Node.js built-in EventEmitter
//const usb = require('usb');

const {
    CanOperation, DeviceNetworkId, charsToString, parseCanFrame,
    BafangCanBatteryParser, BafangCanControllerParser,
    BafangCanDisplayParser, BafangCanSensorParser,
    generateCanFrameId, // Make sure this is exported correctly from parser
    bafangIdArrayTo32Bit // Make sure this is exported correctly from parser
    // CAN_CHANNEL_PREFIX is not needed here as parser handles it
} = require('./bafang-parser');

const bafangSerializer = require('./bafang-serializer');
const { RequestManager } = require('./request-manager');
const requestFunctions = require('./bafang-can-requests');

const CAN_EFF_FLAG = 0x80000000;
const BAFANG_CAN_BITRATE = 250000;
const DISPLAY_DATA_CMD = 0x63; // 99 decimal — display realtime/data command
const TOOL_SOURCE_ID = DeviceNetworkId.BESST; // Define the ID used by this tool for sending


function formatBufferForLog(buffer) {
    // Ensure buffer is an array of numbers before mapping
    if (!buffer || !Array.isArray(buffer)) return "[Invalid Buffer Data]";
    return buffer.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}



// How seriously to take a libusb failure.
//
//   'fatal' — the device is gone. Tear the link down now.
//   'soft'  — the transfer failed but the device may well still be there. Do NOT tear
//             down on the first one: sendRawFrameWithRetry() in fw-updater.js retries by
//             design, and killing a firmware flash over one recoverable error would be
//             far worse than the delay of waiting for a second opinion.
function classifyUsbError(err) {
    const text = `${err?.message || err || ''}`;
    if (text.includes('LIBUSB_ERROR_NO_DEVICE') || text.includes('LIBUSB_ERROR_NOT_FOUND')) return 'fatal';
    if (text.includes('no USB device handle')) return 'fatal';
    if (text.includes('LIBUSB_ERROR_IO') || text.includes('LIBUSB_ERROR_PIPE')
        || text.includes('LIBUSB_ERROR_TIMEOUT') || text.includes('LIBUSB_ERROR_OTHER')
        || text.includes('did not answer in time')) return 'soft';
    return 'soft';
}

class CanBusService extends EventEmitter {
    constructor() {
        super();
        this.canDevice = new GSUsb();
        this.isStarted = false;
        this.frameLength = 20;
        // New multiFrameBuffers structure: keyed by "source-target-cmd-sub"
        this.multiFrameBuffers = {};
        // Still need timeouts, keyed the same way
        this.multiFrameTimeouts = {};
        this.requestManager = new RequestManager(this);
        this.MULTIFRAME_TIMEOUT = 3000; // 3 seconds timeout
		this.connectedDeviceName = null;
		this.cachedParameter0 = null;
        this.cachedParameter1 = null;
        this.cachedParameter2 = null;
        this.cachedSpeedParams = null; // Added for completeness

        // Proof-of-life timestamps for checkAlive(). Frames arriving (or a frame we
        // managed to send) prove the USB link works without asking the adapter anything.
        this.lastRxAt = 0;
        this.lastTxOkAt = 0;
        // Set by a soft libusb error so the next liveness check probes instead of
        // trusting the quiet-bus shortcut. Read and cleared by checkAlive().
        this.probeNowRequested = false;

        // Bound ONCE, here, not in init(). GSUsb.on() only pushes onto an array — it has
        // no off() and close() never clears it — and this.canDevice is never replaced. A
        // per-connect registration would therefore stack a new handler on every reconnect,
        // so after N sleep/wake cycles every frame would be parsed N times and every ACK
        // sent N times. Auto-recovery reconnects on its own, which makes that a loop.
        this.canDevice.on('frame', (frame) => this._handleFrameReceived(frame));
        this.canDevice.on('error', (err) => this._handleCanError(err));
    }

    getConnectedDeviceName() {
        return this.connectedDeviceName;
    }

     async init(knownDeviceName = null) { // Accept knownDeviceName
        if (this.isStarted) {
            console.log('[CanBusService] CAN device already initialized.');
            // If already started, ensure connectedDeviceName is consistent
            if (knownDeviceName && this.connectedDeviceName !== knownDeviceName) {
                // This case is unlikely if logic is correct but good for consistency
                console.warn(`[CanBusService] Init called while started, known name mismatch: ${this.connectedDeviceName} vs ${knownDeviceName}`);
            }
            this.emit('can_status', true, `CAN device already connected (${this.connectedDeviceName || 'Unknown Device'}).`);
            return true;
        }
        console.log('[CanBusService] Attempting to initialize CAN device with candlelightjs...');
        this.connectedDeviceName = knownDeviceName; // Tentatively set name

        try {
            // GSUsb.start() internally finds the device
            const startResult = await this.canDevice.start(BAFANG_CAN_BITRATE, 0);

            if (!startResult || !startResult.ok) {
                this.connectedDeviceName = null; // Clear name on failure
                let reason = startResult?.msg || 'Failed to start CAN device (candlelightjs)';
                // Say what to do about it. This particular failure means the adapter is
                // enumerated but not answering, which no amount of reconnecting fixes —
                // and the plain message sent the user looking in the wrong place.
                if (reason.includes('capabilities')) {
                    reason += ' — the adapter is visible but not responding. Unplug it, wait a few seconds and plug it back in.';
                }
                throw new Error(reason);
            }

            // If GSUsb.start() succeeds, it found a device.
            // Try to get a more descriptive name from the GSUsb instance if not already provided
            if (!this.connectedDeviceName && this.canDevice.gs_usb && this.canDevice.gs_usb.productName) {
                this.connectedDeviceName = this.canDevice.gs_usb.productName;
                if (this.canDevice.gs_usb.manufacturerName) {
                    this.connectedDeviceName += ` (by ${this.canDevice.gs_usb.manufacturerName})`;
                }
            } else if (!this.connectedDeviceName) {
                this.connectedDeviceName = "GS_USB Device"; // Fallback if GSUsb doesn't provide it
            }


            this.frameLength = this.canDevice.frameLength || 20;
            this.isStarted = true;
            console.log(`[CanBusService] CAN device started successfully at ${BAFANG_CAN_BITRATE} bps. Device: ${this.connectedDeviceName}`);
            this.emit('can_status', true, `CAN device connected (${this.connectedDeviceName}).`);

            // 'frame' / 'error' are bound once in the constructor — see the note there.
            // A fresh connection starts with a clean liveness slate.
            this.lastRxAt = Date.now();
            this.lastTxOkAt = 0;
            this.probeNowRequested = false;

            try {
                await this.canDevice.startPolling();
                console.log('[CanBusService] CAN device polling started.');
            } catch (pollErr) {
                console.error('[CanBusService] Failed to start CAN polling:', pollErr);
                await this.close();
                // No need to emit can_status here, close() will do it.
                // this.emit('can_error', `Error starting polling: ${pollErr.message}`);
                return false;
            }
			this.requestManager.startQueueProcessor();
            return true;

        } catch (err) {
            console.error('[CanBusService] Failed to initialize CAN device:', err);
            this.isStarted = false;
            this.connectedDeviceName = null; // Clear name on failure
            // Give the device back. GSUsb.start() has already opened it, reset it and
            // claimed the interface by the time most failures happen, and nothing here
            // used to undo that — so every failed attempt leaked an open, claimed handle,
            // and the next attempt piled another one on top. With auto-connect retrying,
            // that is a device being reopened and reset over and over, which is a good way
            // to keep an adapter from ever settling.
            try { await this._releaseDeadHandle(); } catch { /* best effort, already failing */ }
            this.emit('can_status', false, `Error: Failed to connect to CAN device - ${err.message}`);
            // this.emit('can_error', `Error connecting: ${err.message}`); // can_status covers this
            return false;
        }
    }

    _mapRawFrameToBafangFrame(rawFrame) {
        // ... (mapping logic remains the same) ...
        const canIdNum = rawFrame.can_id; 
        const byte0 = (canIdNum >> 24) & 0xFF; 
        const byte1 = (canIdNum >> 16) & 0xFF; 
        const byte2 = (canIdNum >> 8) & 0xFF; 
        const byte3 = canIdNum & 0xFF; 
        const bafangId = [byte0, byte1, byte2, byte3]; 
        const dataArray = []; 
        const dataView = rawFrame.data; 
        for (let i = 0; i < rawFrame.can_dlc; i++) { 
            if (i < dataView.byteLength) 
                dataArray.push(dataView.getUint8(i)); 
            else { 
                console.warn(`DLC mismatch...`); 
                break; 
            }
        }
        while (dataArray.length < rawFrame.can_dlc) {
             console.warn(`Padding data...`); 
             dataArray.push(0); 
        } if(dataArray.length > rawFrame.can_dlc) 
            dataArray.length = rawFrame.can_dlc; 
        return { id: bafangId, data: dataArray };
    }

    /**
     * Sends a NORMAL_ACK back to the source device for a specific command.
     * @param {object} originalParsedFrame - The parsed frame of the segment being acknowledged.
     */
    async _sendAck(originalParsedFrame) {
        if (!this.isStarted) return; // Don't send if not connected

        try {
            const ackIdArr = generateCanFrameId(
                TOOL_SOURCE_ID, // Source is this tool
                originalParsedFrame.sourceDeviceCode, // Target is the original sender
                CanOperation.NORMAL_ACK, // Operation is ACK
                originalParsedFrame.canCommandCode, // Command from original request
                originalParsedFrame.canCommandSubCode // Subcommand from original request
            );
            const ackId32 = bafangIdArrayTo32Bit(ackIdArr);
            const ackDataHex = "00"; // Standard ACK payload

            // console.log(`>>> Sending ACK | Target: ${originalParsedFrame.sourceDeviceCode} | Cmd: ${originalParsedFrame.canCommandCode}/${originalParsedFrame.canCommandSubCode} | ID: ${ackId32.toString(16)}`);
            await this.sendFrame(`${ackId32.toString(16).padStart(8, '0')}#${ackDataHex}`);

        } catch (ackError) {
            console.error(`[CanBusService] Failed to send ACK for ${originalParsedFrame.canCommandCode}/${originalParsedFrame.canCommandSubCode} to ${originalParsedFrame.sourceDeviceCode}:`, ackError);
            this.emit('can_error', `Failed to send ACK: ${ackError.message}`);
        }
    }


    _createMultiFrameTimeout(bufferKey) {
        return setTimeout(() => {
            delete this.multiFrameTimeouts[bufferKey];
            if (this.multiFrameBuffers[bufferKey]) {
                console.warn(`[CanBusService] Multi-frame timeout, discarding buffer for key: ${bufferKey}`);
                const originalFrameInfo = this.multiFrameBuffers[bufferKey].originalFrameInfo;
                this.requestManager.resolveRequest({
                    ...originalFrameInfo,
                    canOperationCode: CanOperation.ERROR_ACK,
                    data: []
                });
                delete this.multiFrameBuffers[bufferKey];
            }
        }, this.MULTIFRAME_TIMEOUT);
    }

    async _handleFrameReceived(rawFrame) {
        // Before any parsing: a frame arriving at all — even a malformed one — proves the
        // USB link is alive, which is what checkAlive() needs to know.
        this.lastRxAt = Date.now();
        try {
            this.emit('raw_frame_received', rawFrame);
            const bafangFrame = this._mapRawFrameToBafangFrame(rawFrame);
            const parsedFrame = parseCanFrame(bafangFrame);

            // Ignore Echo Check (remains the same)
            if (parsedFrame.sourceDeviceCode === TOOL_SOURCE_ID) {
				
                return;
            }

            if (parsedFrame.parseError || parsedFrame.sourceDeviceCode < 0) {
                console.warn(`Skipping frame due to mapping/parsing error or invalid logical source. Original ID: 0x${rawFrame.can_id.toString(16)}, Mapped ID: [${bafangFrame.id.map(b=>'0x'+b.toString(16)).join(',')}]`);
                return;
            }

            const opCode = parsedFrame.canOperationCode;
            const sourceId = parsedFrame.sourceDeviceCode;
            const targetId = parsedFrame.targetDeviceCode; // Should be TOOL_SOURCE_ID for responses
            const cmdCode = parsedFrame.canCommandCode;
            const subCode = parsedFrame.canCommandSubCode;
            const frameData = parsedFrame.data;

            // --- Check if target is this tool (essential for multi-frame and ACKs) ---
            if (targetId !== TOOL_SOURCE_ID) {
                // This frame is not directly addressed to us (e.g., broadcast or other device comms)
                // We might still want to parse and emit it, but don't process multi-frame or ACKs for it.
                // console.log(`Ignoring frame not targeted at tool (Target: ${targetId})`);
                this._parseAndEmitCompletedFrame(parsedFrame, rawFrame.timestamp_us);
                // Don't try to resolve requests for frames not meant for us
                // this.requestManager.resolveRequest(parsedFrame); // Maybe remove this?
                return;
            }

            // --- Multi-Frame Handling ---
            const bufferKey = `${sourceId}-${targetId}-${cmdCode}-${subCode}`; // Unique key for the original command
 
            if (opCode === CanOperation.MULTIFRAME_START) {
                const expectedLength = frameData[0];
                console.log(`>>> MF_START | Key: ${bufferKey} | ExpLen: ${expectedLength}`);

                if (this.multiFrameBuffers[bufferKey]) {
                    console.warn(`>>> MF buffer for key ${bufferKey} already exists. skipping.`);
                    return;
                }
                if (this.multiFrameTimeouts[bufferKey]) clearTimeout(this.multiFrameTimeouts[bufferKey]);

                this.multiFrameBuffers[bufferKey] = {
                    expectedLength: expectedLength,
                    //buffer:[],
                    arrBuffer: Array(Math.ceil(expectedLength/8)).fill(null),
                    originalFrameInfo: { ...parsedFrame }, // Store context of START
                    //nextSequence: 0
                };
                this.multiFrameTimeouts[bufferKey] = this._createMultiFrameTimeout(bufferKey);
                await this._sendAck(parsedFrame); // ACK the START
                return;

            } else if (opCode === CanOperation.MULTIFRAME || opCode === CanOperation.MULTIFRAME_END) {
                // --- Find the correct buffer ---
                // We need to find the buffer based on source/target, but the cmd/sub might be 0/sequence#
                // Let's iterate active buffers for this source/target pair
                let activeBufferKey = null;
                //let bufferInfo = null;
                for (const key in this.multiFrameBuffers) {
                    if (key.startsWith(`${sourceId}-${targetId}-`)) {
                         // Assume the first active buffer for this source/target is the one we're continuing
                         // THIS IS A HEURISTIC AND MIGHT FAIL IF MULTIPLE SEQUENCES ARE TRULY INTERLEAVED
                         activeBufferKey = key;
                         //bufferInfo = this.multiFrameBuffers[key];
                         break;
                    }
                }

                if (!activeBufferKey) {
                    console.warn(`>>> ${opCode === CanOperation.MULTIFRAME ? 'MF' : 'MF_END'} | Ignored | Src: ${sourceId} | Seq: ${subCode} (No active buffer found for Src/Tgt ${sourceId}-${targetId})`);
                    return;
                }

                const sequenceNumber = parseInt(parsedFrame.canCommandSubCode,10); // Sequence from MULTI/END frame

                // if (sequenceNumber !== bufferInfo.nextSequence) {
                //     console.error(`>>> ${opCode === CanOperation.MULTIFRAME ? 'MF' : 'MF_END'} Sequence Error | Key: ${activeBufferKey} | Expected: ${bufferInfo.nextSequence}, Got: ${sequenceNumber}. Discarding.`);
                //     if (this.multiFrameTimeouts[activeBufferKey]) clearTimeout(this.multiFrameTimeouts[activeBufferKey]);
                //     delete this.multiFrameBuffers[activeBufferKey];
                //     delete this.multiFrameTimeouts[activeBufferKey];
                //     this.requestManager.resolveRequest({ ...bufferInfo.originalFrameInfo, canOperationCode: CanOperation.ERROR_ACK, data:[] });
                //     return;
                // }

                console.log(`>>> ${opCode === CanOperation.MULTIFRAME ? 'MF' : 'MF_END'} | Key: ${activeBufferKey} | Seq: ${sequenceNumber} | Data: ${formatBufferForLog(frameData)}`);

                // Reset timeout, append data, increment sequence
                if (this.multiFrameTimeouts[activeBufferKey]) clearTimeout(this.multiFrameTimeouts[activeBufferKey]);
                this.multiFrameTimeouts[activeBufferKey] = this._createMultiFrameTimeout(activeBufferKey);

                if(!this.multiFrameBuffers[activeBufferKey].arrBuffer[sequenceNumber])
                    this.multiFrameBuffers[activeBufferKey].arrBuffer[sequenceNumber] = frameData;
                else if(this.multiFrameBuffers[activeBufferKey].arrBuffer[sequenceNumber].length < frameData.length)
                    this.multiFrameBuffers[activeBufferKey].arrBuffer[sequenceNumber] = frameData;
                //bufferInfo.buffer.push(...frameData);
                //bufferInfo.nextSequence++;

                // Send ACK referencing the original command context stored in bufferInfo
                await this._sendAck(this.multiFrameBuffers[activeBufferKey].originalFrameInfo);

                // --- Author's Suggestion: Check for completion after MULTIFRAME too ---
                let isComplete = false;
                if (opCode === CanOperation.MULTIFRAME_END) {
                    isComplete = true; // END frame always triggers final check
                } else if (opCode === CanOperation.MULTIFRAME) {
                    // Check if buffer length now matches expected length
                    // if (bufferInfo.buffer.length >= bufferInfo.expectedLength) {
                    //     console.log(`>>> MF Completion Check Passed | Key: ${activeBufferKey} | Received: ${bufferInfo.buffer.length}, Expected: ${bufferInfo.expectedLength}`);
                    //     isComplete = true;
                    // }
                    if (!this.multiFrameBuffers[activeBufferKey].arrBuffer.filter(x => x === null).length) {
                        //console.log(`>>> MF Completion Check Passed | Key: ${activeBufferKey} | Received: ${bufferInfo.buffer.length}, Expected: ${bufferInfo.expectedLength}`);
                        isComplete = true;
                    }
                }

                if (isComplete) {
                     // --- Assemble and Validate ---
                    if (this.multiFrameTimeouts[activeBufferKey]) clearTimeout(this.multiFrameTimeouts[activeBufferKey]); // Clear timeout on completion
                    delete this.multiFrameTimeouts[activeBufferKey];

                    //const assembledData = bufferInfo.buffer;
                    const assembledData = this.multiFrameBuffers[activeBufferKey].arrBuffer.flat(1);
                    const expected = this.multiFrameBuffers[activeBufferKey].expectedLength;
                    const received = assembledData.length;

                    console.log(`>>> MF Final Check | Key: ${activeBufferKey} | Expected: ${expected} bytes | Received: ${received} bytes`);

                    if (received === expected) {
                       // ***** MODIFICATION HERE *****
                        // Construct the final frame using original context, but ensure
                        // the operation code allows it to pass the ACK filter in the parser.
                        const completedFrame = {
                            canCommandCode: this.multiFrameBuffers[activeBufferKey].originalFrameInfo.canCommandCode,
                            canCommandSubCode: this.multiFrameBuffers[activeBufferKey].originalFrameInfo.canCommandSubCode,
                            sourceDeviceCode: this.multiFrameBuffers[activeBufferKey].originalFrameInfo.sourceDeviceCode,
                            targetDeviceCode: this.multiFrameBuffers[activeBufferKey].originalFrameInfo.targetDeviceCode,
                            // Use an operation code that signifies data, not just ACK
                            // For example, use WRITE_CMD (0x00) or keep the original START op code (0x04)
                            // Using WRITE_CMD is simple and won't be filtered.
                            canOperationCode: CanOperation.WRITE_CMD, // <<< Changed from NORMAL_ACK
                            data: assembledData,
                        };
                        // ***** END MODIFICATION *****

                        console.log(`>>> MF Success | Key: ${activeBufferKey} | Passing data to parser.`);
                        this._parseAndEmitCompletedFrame(completedFrame, rawFrame.timestamp_us);
                        this.requestManager.resolveRequest({
                            ...this.multiFrameBuffers[activeBufferKey].originalFrameInfo, // Original IDs/Cmds
                            canOperationCode: CanOperation.NORMAL_ACK, // Signal success status
                            data: assembledData // Include data in resolution if needed elsewhere
                        });
                    } else {
                        console.error(`>>> MF Length Mismatch | Key: ${activeBufferKey} | Expected: ${expected}, Got: ${received}. Discarding.`);
                        this.requestManager.resolveRequest({ ...this.multiFrameBuffers[activeBufferKey].originalFrameInfo, canOperationCode: CanOperation.ERROR_ACK, data: [] });
                    }
                    // Clean up buffer
                    delete this.multiFrameBuffers[activeBufferKey];
                }
                // If !isComplete, we just sent the ACK and updated the buffer, wait for next frame.
                return; // Handled MULTIFRAME and MULTIFRAME_END

            } else {
                 // --- Single frame or standard ACK/NACK ---
                 this._parseAndEmitCompletedFrame(parsedFrame, rawFrame.timestamp_us);
                 this.requestManager.resolveRequest(parsedFrame);
                 return;
            }
        } catch (parseErr) {
            console.error("[CanBusService] Error handling received CAN frame:", parseErr, "Raw Frame ID:", rawFrame?.can_id?.toString(16));
            // Deliberately NOT 'can_error': that channel means "the link is gone" and now
            // starts an auto-recovery. One frame we could not parse says nothing about the
            // USB link — the adapter is plainly alive, it just handed us something
            // unexpected. Emitting can_error here tore down a perfectly good connection.
            this.emit('frame_error', 'Error processing received frame.');
        }
    }


    _parseControllerFrame(frame) {
        let dataType = 'controller';
        let parsedData = { _rawBytes: [...frame.data] };
        const cmdCode = frame.canCommandCode;
        const subCode = frame.canCommandSubCode;

        if (cmdCode === 0x12)
            if (subCode === 0x00) { parsedData = BafangCanControllerParser.state(frame); dataType = 'controller_state'; };
        if (cmdCode === 0x32) {
            if (subCode === 0x00) { parsedData = BafangCanControllerParser.package0(frame); dataType = 'controller_realtime_0'; }
            else if (subCode === 0x01) { parsedData = BafangCanControllerParser.package1(frame); dataType = 'controller_realtime_1'; }
            else if (subCode === 0x03) { parsedData = BafangCanControllerParser.parameter3(frame);
                dataType = 'controller_speed_params';
                this.cachedSpeedParams = { ...parsedData }; // Cache it
                if (!parsedData.parseError) {parsedData._rawBytes = [...frame.data]}; }
            else if (subCode === 0x05) {
                    parsedData = BafangCanControllerParser.parameter5(frame); dataType = 'controller_calories';
                    //console.log(`>>> RX Controller Calories (Raw): ${formatBufferForLog(frame.data)}`);
                    }
            else if (subCode === 0x06) {
                    parsedData = { controller_current_assist_level: frame.data[0] };
                    dataType = 'controller_current_assist_level';
                    //console.log(`>>> RX Controller Current Level (Raw): ${formatBufferForLog(frame.data)}`);
                    }
            else if (subCode === 0x0C) {
                    parsedData = { controller_total_assist_levels: frame.data[0] };
                    dataType = 'controller_total_assist_levels'; parsedData = { raw_data: frame.data };
                    //console.log(`>>> RX Controller Total levels (Raw): ${formatBufferForLog(frame.data)}`);
            }
        }
        else if (cmdCode === 0x60) {
            if (subCode === 0x10) { parsedData = BafangCanControllerParser.parameter0(frame);
                dataType = 'controller_params_0';
                this.cachedParameter0 = { ...parsedData }; // Cache it
                if (!parsedData.parseError) {parsedData._rawBytes = [...frame.data]}; // Add raw bytes!
            }
            else if (subCode === 0x11) { parsedData = BafangCanControllerParser.parameter1(frame);
                dataType = 'controller_params_1';
                this.cachedParameter1 = { ...parsedData }; // Cache it
                if (!parsedData.parseError) {parsedData._rawBytes = [...frame.data]}; // Add raw bytes!
            }
            else if (subCode === 0x12) { parsedData = BafangCanControllerParser.parameter2(frame);
                dataType = 'controller_params_2';
                this.cachedParameter2= { ...parsedData }; // Cache it
                if (!parsedData.parseError) {parsedData._rawBytes = [...frame.data]}; // Add raw bytes
            }
            else if (subCode === 0x20) { //FW-006: profile bank blob
                parsedData = BafangCanControllerParser.bankBlob(frame);
                dataType = 'controller_bank';
                if (!parsedData.parseError) { parsedData._rawBytes = [...frame.data]; }
            }
            else if (subCode === 0x23) { //FW-010: global ride-feel tuning blob
                parsedData = BafangCanControllerParser.tuningBlob(frame);
                dataType = 'controller_tuning';
                if (!parsedData.parseError) { parsedData._rawBytes = [...frame.data]; }
            }
            else if (subCode === 0x25) { //FW-013: torque load telemetry + calibration status
                parsedData = BafangCanControllerParser.torqueTelemetry(frame);
                dataType = 'controller_torque';
                if (!parsedData.parseError) { parsedData._rawBytes = [...frame.data]; }
            }
            else if (subCode === 0x28) { //FW-014: system status (ride engine)
                parsedData = BafangCanControllerParser.systemStatus(frame);
                dataType = 'controller_system';
                if (!parsedData.parseError) { parsedData._rawBytes = [...frame.data]; }
            }
            else if (subCode === 0x29) { //FW-015: ride-core diagnostics
                parsedData = BafangCanControllerParser.rideDiagnostics(frame);
                dataType = 'controller_diag';
                if (!parsedData.parseError) { parsedData._rawBytes = [...frame.data]; }
            }
            else if (subCode === 0x17) {
                dataType = 'controller_params_6017';
                parsedData = { _rawBytes: [...frame.data] };
                console.log(`[CanBusService] Assembled controller_0x6017: ${frame.data.length} bytes`);
            }
            else if (subCode === 0x18) {
                dataType = 'controller_params_6018';
                parsedData = { _rawBytes: [...frame.data] };
                console.log(`[CanBusService] Assembled controller_0x6018: ${frame.data.length} bytes`);
            }
            else if (subCode === 0x00) { parsedData = { hardware_version: charsToString(frame.data) }; dataType = 'controller_hw_version'; }
            else if (subCode === 0x01) { parsedData = { software_version: charsToString(frame.data) }; dataType = 'controller_sw_version'; }
            else if (subCode === 0x03) { parsedData = { serial_number: charsToString(frame.data) }; dataType = 'controller_sn'; }
            else if (subCode === 0x02) { parsedData = { model_number: charsToString(frame.data) }; dataType = 'controller_mn'; }
            else if (subCode === 0x05) { parsedData = { manufacturer: charsToString(frame.data) }; dataType = 'controller_mfg'; }
            else if (subCode === 0x07) { parsedData = { error_codes: BafangCanDisplayParser.errorCodes(frame.data) }; dataType = 'controller_errors'; }
        }
        else if (cmdCode === 0x62) {
            if (subCode === 0xD9) {
                // Handle Startup Angle Read Response
                parsedData = BafangCanControllerParser.parameter4(frame); // Use parameter4 -> startupAngle
                dataType = 'controller_startup_angle';
            }
            else if (subCode === 0x07) { // System AutoOff
                parsedData = { controller_auto_shutdown_time: frame.data[0] };
                dataType = 'controller_system_auto_off';
                //console.log(`>>> RX Controller Auto Off (Raw): ${formatBufferForLog(frame.data)}`);
            }
        }

        return { dataType, parsedData };
    }

    _parseDisplayFrame(frame) {
        let dataType = 'display';
        let parsedData = { _rawBytes: [...frame.data] };
        const cmdCode = frame.canCommandCode;
        const subCode = frame.canCommandSubCode;

        if (cmdCode === 0x63) {
            if (subCode === 0x00) {
                const rawAssistCode = (frame.data && frame.data.length > 1)
                                    ? frame.data[1] // Get raw code from byte 1
                                    : null; // Handle cases where data might be missing/short
                parsedData = BafangCanDisplayParser.package0(frame);
                dataType = 'display_realtime';
                // Add the raw code to the parsed data object if parsing succeeded
                if (parsedData && !parsedData.parseError && rawAssistCode !== null) {
                    parsedData.current_assist_level_code = rawAssistCode;
                } else if (rawAssistCode === null && !(parsedData && parsedData.parseError)) {
                    // Log if raw code couldn't be read but parsing didn't report an error
                    console.warn("Could not extract raw assist code for display_realtime, data length insufficient.");
                }
            }
            else if (subCode === 0x01) { parsedData = BafangCanDisplayParser.package1(frame); dataType = 'display_data_1'; }
            else if (subCode === 0x02) { parsedData = BafangCanDisplayParser.package2(frame); dataType = 'display_data_2'; }
            else if (subCode === 0x03) {
                // Time settings: Bike autoshutdown (0x63/0x03)
                if (frame.data && frame.data.length >= 1) {
                    // Value is minutes, 255 means OFF
                    parsedData = { display_auto_shutdown_time: frame.data[0] };
                    dataType = 'display_autoshutdown_time';
                } else {
                    parsedData = { parseError: true, error: "Invalid data length for Display Auto Shutdown" };
                    dataType = 'display_autoshutdown_time_error';
                }
            } else if (subCode === 0x04) {
                parsedData = BafangCanDisplayParser.package3(frame);
                dataType = 'display_data_lightsensor';  //00 LightSensNum,  01 LightSensLevel,02 BacklightNum, 03 BacklightLevel
                //console.log(`>>> RX Display Data lighsensor (Raw): ${formatBufferForLog(frame.data)}`);
            }
        }
        else if (cmdCode === 0x60) {
            if (subCode === 0x07) { parsedData = { error_codes: BafangCanDisplayParser.errorCodes(frame.data) }; dataType = 'display_errors'; }
            else if (!charsToString(frame.data)) return { dataType: null, parsedData: null };
            else if (subCode === 0x00) { parsedData = { hardware_version: charsToString(frame.data) }; dataType = 'display_hw_version'; }
            else if (subCode === 0x01) { parsedData = { software_version: charsToString(frame.data) }; dataType = 'display_sw_version'; }
            else if (subCode === 0x03) { parsedData = { serial_number: charsToString(frame.data) }; dataType = 'display_sn'; }
            else if (subCode === 0x02) { parsedData = { model_number: charsToString(frame.data) }; dataType = 'display_mn'; }
            else if (subCode === 0x04) { parsedData = { customer_number: charsToString(frame.data) }; dataType = 'display_cn'; }
            else if (subCode === 0x05) { parsedData = { manufacturer: charsToString(frame.data) }; dataType = 'display_mfg'; }
            else if (subCode === 0x08) { parsedData = { bootloader_version: charsToString(frame.data) }; dataType = 'display_bootloader_version'; }
        }
        else if (cmdCode === 0x21 && subCode === 0x64)
            { parsedData = { ack_display_2164: true }; dataType = 'display_ack_2164'; }

        return { dataType, parsedData };
    }

    _parseBatteryFrame(frame) {
        let dataType = 'battery';
        let parsedData = { _rawBytes: [...frame.data] };
        const cmdCode = frame.canCommandCode;
        const subCode = frame.canCommandSubCode;

        if (cmdCode === 0x34) {
            if (subCode === 0x00) { parsedData = BafangCanBatteryParser.capacity(frame); dataType = 'battery_capacity'; }
            else if (subCode === 0x01) { parsedData = BafangCanBatteryParser.state(frame); dataType = 'battery_state'; }
        }
        else if (cmdCode === 0x64) {
            if (subCode === 0x00) { parsedData = BafangCanBatteryParser.design(frame); dataType = 'battery_design'; }
            else if (subCode === 0x01) { parsedData = BafangCanBatteryParser.chargingInfo(frame); dataType = 'battery_charging_info'; }
            else {
                parsedData = { raw_cell_data: frame.data, subcode: subCode }; dataType = 'battery_cells_raw';
            }
        }  //00 BMSSerialNum, 01 BMSParallelNum, 03 BMSDesignCapacity(mAh), 0x640101 BMSCycleCount, 03 BMSMaxChaInterval(h), 05 BMSCurChaInterval(h)"
        else if (cmdCode === 0x60) {
            if (subCode === 0x00) { parsedData = { hardware_version: charsToString(frame.data) }; dataType = 'battery_hw_version'; }
            else if (subCode === 0x01) { parsedData = { software_version: charsToString(frame.data) }; dataType = 'battery_sw_version'; }
            else if (subCode === 0x03) { parsedData = { serial_number: charsToString(frame.data) }; dataType = 'battery_sn'; }
            else if (subCode === 0x02) { parsedData = { model_number: charsToString(frame.data) }; dataType = 'battery_mn'; }
        }

        return { dataType, parsedData };
    }

    _parseSensorFrame(frame) {
        let dataType = 'sensor';
        let parsedData = { _rawBytes: [...frame.data] };
        const cmdCode = frame.canCommandCode;
        const subCode = frame.canCommandSubCode;

        if (cmdCode === 0x31 && subCode === 0x00) { parsedData = BafangCanSensorParser.package0(frame); dataType = 'sensor_realtime'; }
        else if (cmdCode === 0x60) {
            if (subCode === 0x00) { parsedData = { hardware_version: charsToString(frame.data) }; dataType = 'sensor_hw_version'; }
            else if (subCode === 0x01) { parsedData = { software_version: charsToString(frame.data) }; dataType = 'sensor_sw_version'; }
            else if (subCode === 0x03) { parsedData = { serial_number: charsToString(frame.data) }; dataType = 'sensor_sn'; }
            else if (subCode === 0x02) { parsedData = { model_number: charsToString(frame.data) }; dataType = 'sensor_mn'; }
        }

        return { dataType, parsedData };
    }

    _parseBESSTFrame(frame) {
        let dataType = 'besst';
        let parsedData = { _rawBytes: [...frame.data] };
        const cmdCode = frame.canCommandCode;
        const subCode = frame.canCommandSubCode;

        if (cmdCode === 0x35 && subCode === 0x01)
            { parsedData = { besst_status_3501: frame.data };
            dataType = 'besst_status_3501'; }

        return { dataType, parsedData };
    }

    _parseAndEmitCompletedFrame(completedParsedFrame, timestamp_us) {
        const sourceId = completedParsedFrame.sourceDeviceCode;
        const cmdCode = completedParsedFrame.canCommandCode;
        const subCode = completedParsedFrame.canCommandSubCode;

        // Early exit for simple ACKs
        if (completedParsedFrame.canOperationCode === CanOperation.ERROR_ACK &&
            (!completedParsedFrame.data || completedParsedFrame.data.length === 0 ||
             (completedParsedFrame.data.length === 1 && completedParsedFrame.data[0] === 0))) {
            this.emit('bafang_data_received', { type: 'error_ack', source: sourceId, cmdCode, subCode, data: "ERROR ACK", timestamp_us: timestamp_us || Date.now() * 1000 });
            return;
        }
        if (completedParsedFrame.canOperationCode === CanOperation.NORMAL_ACK && cmdCode !== DISPLAY_DATA_CMD &&
            (!completedParsedFrame.data || completedParsedFrame.data.length === 0 ||
             (completedParsedFrame.data.length === 1 && completedParsedFrame.data[0] === 0))) {
            this.emit('bafang_data_received', { type: 'normal_ack', source: sourceId, cmdCode, subCode, data: "NORMAL ACK", timestamp_us: timestamp_us || Date.now() * 1000 });
            return;
        }

        let dataType = 'unknown';
        let parsedData = null;

        switch (sourceId) {
            case DeviceNetworkId.DRIVE_UNIT:    ({ dataType, parsedData } = this._parseControllerFrame(completedParsedFrame)); break;
            case DeviceNetworkId.DISPLAY:       ({ dataType, parsedData } = this._parseDisplayFrame(completedParsedFrame)); break;
            case DeviceNetworkId.BATTERY:       ({ dataType, parsedData } = this._parseBatteryFrame(completedParsedFrame)); break;
            case DeviceNetworkId.TORQUE_SENSOR: ({ dataType, parsedData } = this._parseSensorFrame(completedParsedFrame)); break;
            case DeviceNetworkId.BESST:         ({ dataType, parsedData } = this._parseBESSTFrame(completedParsedFrame)); break;
            default:
                dataType = `unknown_source_0x${sourceId.toString(16)}`;
                parsedData = { original_frame: completedParsedFrame };
        }

        if (parsedData && !parsedData.parseError) {
            if (!parsedData._rawBytes)
                parsedData._rawBytes = [...completedParsedFrame.data];
            this.emit('bafang_data_received', { type: dataType, source: sourceId, cmdCode, subCode, data: parsedData, timestamp_us: timestamp_us || Date.now() * 1000 });
        } else if (dataType !== 'unknown' && parsedData && parsedData.parseError) {
            console.warn(`Parsing error for ${dataType}:`, parsedData.error || "Unknown error", "Original Frame:", completedParsedFrame);
        }
    }

    _handleCanError(err) {
        console.error('[CanBusService] CAN device error (candlelightjs):', err);
        const wasStarted = this.isStarted;
        this.isStarted = false;
        // this.connectedDeviceName = null; // Keep last known name for potential "disconnected from X" message
        this.requestManager.clearAllRequests();
        Object.keys(this.multiFrameTimeouts).forEach(key => {
           clearTimeout(this.multiFrameTimeouts[key]);
           delete this.multiFrameTimeouts[key];
        });
        this.multiFrameBuffers = {};

        // Only emit 'can_error' if it was previously started.
        // The 'can_status' event from close() or init() failure will handle other cases.
        if (wasStarted) {
            this.emit('can_error', `CAN Error: ${err.message || err}`);
            this.emit('can_status', false, `CAN device error: ${err.message || err}`);
            // Emits first so the UI turns red immediately, then release the handle:
            // clearing isStarted alone leaves an open zombie handle behind, and the
            // reconnect that follows can then fail with LIBUSB_ERROR_BUSY.
            this._releaseDeadHandle();
        }
     }

    // Best-effort teardown after a link failure. Every step is optional and raced
    // against a timer, because closing a handle whose device stopped answering can
    // block inside libusb — and this runs on the path that is supposed to make the
    // app responsive again, so it must never be the thing that hangs.
    async _releaseDeadHandle(timeoutMs = 5000) {
        // Serialised, because two teardowns of the same USB handle at once leave the
        // adapter half-configured: _handleCanError releases the handle while the server's
        // recovery calls close(), both reach GSUsb.stop(), and the result was
        // "Failed to disable CAN Hardware" followed by a stall on the next control
        // transfer — so reopening then failed and recovery span in circles.
        if (this._teardownInFlight) return this._teardownInFlight;
        const teardown = (async () => {
            try { await this.canDevice.stopPolling(); } catch (e) { console.warn('[CanBusService] stopPolling after error failed:', e.message); }
            try { await this.canDevice.stop(); } catch (e) { console.warn('[CanBusService] stop after error failed:', e.message); }
        })();
        this._teardownInFlight = teardown.finally(() => { this._teardownInFlight = null; });
        await Promise.race([
            teardown,
            new Promise((resolve) => setTimeout(() => {
                console.warn('[CanBusService] Releasing the dead USB handle timed out; carrying on.');
                resolve();
            }, timeoutMs)),
        ]);
     }

    // --- Public Methods using Request Manager (remain the same) ---
    async readParameter(target, can_command, data = null){ 
         if (!this.isStarted) return { success: false, error: 'CAN device not started', timedOut: false };
         const dataLog = data ? ` Data=[${data.map(b => b.toString(16).padStart(2,'0')).join(',')}]` : "";
         console.log(`Initiating read: Target=0x${target.toString(16)}, Cmd=0x${can_command.canCommandCode.toString(16)}, Sub=0x${can_command.canCommandSubCode.toString(16)}${dataLog}`);
         return requestFunctions.readParameter(this, this.requestManager, target, can_command, data); 
    }
    async writeShortParameterWithAck(target, can_command, data) { 
         if (!this.isStarted) return { success: false, error: 'CAN device not started', timedOut: false };
          console.log(`Initiating short write: Target=0x${target.toString(16)}, Cmd=0x${can_command.canCommandCode.toString(16)}, Sub=0x${can_command.canCommandSubCode.toString(16)}`);
         return requestFunctions.writeShortParameter(this, this.requestManager, target, can_command, data);
    }
    async writeLongParameterWithAck(target, can_command, value) { 
         if (!this.isStarted) return { success: false, error: 'CAN device not started', timedOut: false };
         console.log(`Initiating long write: Target=0x${target.toString(16)}, Cmd=0x${can_command.canCommandCode.toString(16)}, Sub=0x${can_command.canCommandSubCode.toString(16)}`);
         return requestFunctions.writeLongParameter(this, this.requestManager, target, can_command, value);
    }

    // --- Public Write Methods (using Serializers - remain the same) ---
    saveControllerParams0 = async (partialParams0Data) => {
        if (!this.cachedParameter0) {
            console.error("[CanBusService] Cannot save Parameter0: No cached data available. Please read parameters first.");
            this.emit('can_error', 'Save P0 failed: Cache empty. Read first.');
            return;
        }
        // Deep merge might be better if params0Data has nested objects that are partially updated
        const mergedParams0Data = { ...this.cachedParameter0, ...partialParams0Data };
        if (partialParams0Data.acceleration_levels) mergedParams0Data.acceleration_levels = partialParams0Data.acceleration_levels;
        if (partialParams0Data.assist_ratio_levels) mergedParams0Data.assist_ratio_levels = partialParams0Data.assist_ratio_levels;

        bafangSerializer.prepareParameter0WriteData(this, mergedParams0Data);
    }

    saveControllerParams1 = async (partialParams1Data) => {
        if (!this.cachedParameter1) {
            console.error("[CanBusService] Cannot save Parameter1: No cached data available. Please read parameters first.");
            this.emit('can_error', 'Save P1 failed: Cache empty. Read first.');
            return;
        }
        const mergedParams1Data = { ...this.cachedParameter1, ...partialParams1Data };
        // Handle assist_levels specifically if it's in the partial data
        if (partialParams1Data.assist_levels) {
            mergedParams1Data.assist_levels = partialParams1Data.assist_levels;
        }
        bafangSerializer.prepareParameter1WriteData(this, mergedParams1Data);
    }

    saveControllerParams2 = async (partialParams2Data) => {
        if (!this.cachedParameter2) {
            console.error("[CanBusService] Cannot save Parameter2: No cached data available. Please read parameters first.");
            this.emit('can_error', 'Save P2 failed: Cache empty. Read first.');
            return;
        }
        const mergedParams2Data = { ...this.cachedParameter2, ...partialParams2Data };
        // Handle torque_profiles specifically
        if (partialParams2Data.torque_profiles) {
            mergedParams2Data.torque_profiles = partialParams2Data.torque_profiles;
        }
        bafangSerializer.prepareParameter2WriteData(this, mergedParams2Data);
    }

    async saveControllerSpeedParams(partialSpeedParamsData) {
        if (!this.cachedSpeedParams) {
            console.error("[CanBusService] Cannot save SpeedParams: No cached data available. Please read parameters first.");
            this.emit('can_error', 'Save SpeedParams failed: Cache empty. Read first.');
            return;
        }
        const mergedSpeedParams = { ...this.cachedSpeedParams, ...partialSpeedParamsData };
        // Ensure wheel_diameter.code is handled correctly if partially updated
        if (partialSpeedParamsData.wheel_diameter && partialSpeedParamsData.wheel_diameter.code) {
            mergedSpeedParams.wheel_diameter = { ...this.cachedSpeedParams.wheel_diameter, ...partialSpeedParamsData.wheel_diameter };
        } else if (partialSpeedParamsData.wheel_diameter) { // if only description changes
             mergedSpeedParams.wheel_diameter = { ...this.cachedSpeedParams.wheel_diameter, description: partialSpeedParamsData.wheel_diameter.description };
        }


        bafangSerializer.prepareSpeedPackageWriteData(this, mergedSpeedParams);
    }

    async saveDisplayTotalMileage(mileage) { bafangSerializer.prepareTotalMileageWriteData(this, mileage); }
    async saveDisplaySingleMileage(mileage) { bafangSerializer.prepareSingleMileageWriteData(this, mileage); }
    async saveDisplayTime(hours, minutes, seconds) { bafangSerializer.prepareTimeWriteData(this, hours, minutes, seconds); }
	async setDisplayServiceThreshold(thresholdKm) {bafangSerializer.prepareSetServiceThresholdWriteData(this, thresholdKm); }
    async cleanDisplayServiceMileage() { bafangSerializer.prepareCleanServiceMileageWriteData(this); }
    async saveStringParameter(targetDeviceId, commandInfo, value) { bafangSerializer.prepareStringWriteData(this, value, targetDeviceId, commandInfo); }
    async saveControllerStartupAngle(angle) {bafangSerializer.prepareStartupAngleWriteData(this, angle); }

 
     
     /* @param {DeviceNetworkId} targetDeviceId - The target device (e.g., DeviceNetworkId.DRIVE_UNIT).
     * @param {object} commandInfo - From CanWriteCommandsList (e.g., CanWriteCommandsList.Parameter1).
     * @param {number[]} byteArray - The raw byte array (e.g., 64 bytes for P0/P1/P2).
     * @returns {Promise<boolean>} True if the send sequence was initiated, false otherwise.
     */
    async writeRawBytesParameter(targetDeviceId, commandInfo, byteArray) {
        if (!this.isStarted) {
            console.warn('[CanBusService] Attempted writeRawBytesParameter while disconnected.');
            this.emit('can_error', `Raw Write attempt failed: Disconnected (Cmd ${commandInfo.canCommandCode}/${commandInfo.canCommandSubCode})`);
            return false;
        }
        if (!commandInfo || typeof commandInfo.canCommandCode === 'undefined' || typeof commandInfo.canCommandSubCode === 'undefined') {
            console.error('[CanBusService] Invalid commandInfo for writeRawBytesParameter.');
            this.emit('can_error', `Invalid command for raw write.`);
            return false;
        }
        if (!Array.isArray(byteArray) || !byteArray.every(b => typeof b === 'number' && b >= 0 && b <= 255)) {
            console.error('[CanBusService] Invalid byteArray for writeRawBytesParameter.');
            this.emit('can_error', `Invalid byte array for raw write (Cmd ${commandInfo.canCommandCode}/${commandInfo.canCommandSubCode})`);
            return false;
        }

        console.log(`[CanBusService] Initiating raw byte write: Target=0x${targetDeviceId.toString(16)}, Cmd=0x${commandInfo.canCommandCode.toString(16)}/${commandInfo.canCommandSubCode.toString(16)}, Len=${byteArray.length}`);

        try {
            // Directly call the serializer's writeLongParameter function,
            // which is designed to take a raw byte array for the 'value'.
            await bafangSerializer.writeLongParameter(this, targetDeviceId, commandInfo, byteArray);
            // writeLongParameter in serializer is async but doesn't return a success boolean itself.
            // We assume if it doesn't throw, the sequence started.
            return true;
        } catch (error) {
            console.error(`[CanBusService] Error during writeRawBytesParameter (Cmd ${commandInfo.canCommandCode}/${commandInfo.canCommandSubCode}):`, error);
            this.emit('can_error', `Error sending raw write: ${error.message} (Cmd ${commandInfo.canCommandCode}/${commandInfo.canCommandSubCode})`);
            return false;
        }
    }
	
	async calibrateControllerPositionSensor() {
        const cmd = { canCommandCode: 0x62, canCommandSubCode: 0x00 }; // CalibratePositionSensor command
        const data = [0x00, 0x00, 0x00, 0x00, 0x00]; // Standard payload
        console.log(`Initiating Calibrate Position Sensor command...`);
        // Use the method that tracks ACKs
        return this.writeShortParameterWithAck(DeviceNetworkId.DRIVE_UNIT, cmd, data);
    }

    // --- FW-006: profile banks (0x6020 read / 0x6021 RAM write / 0x6022 persist) ---
    static serializeBankBlob(bankObj) {
        // FW-056: only echo v4 back to a controller that reported v4 (i.e. one that
        // understands Power Curve) — same layout and length as v3 either way.
        // FW-057: v5 adds header byte 12, so the blob grows to 190 B. Never send a
        // version the controller did not report itself.
        // FW-068/069: v6 is the first version with a LONGER record (46 B): the per-level start
        // condition and the four Iq ramps. 13 + 5*46 + 2 = 245 B, which has to stay under the
        // 255 B ceiling of the multiframe protocol (the length travels in a single byte).
        // FW-077: v7 keeps the geometry and exposes only two kg thresholds;
        // the removed rise-detector slots remain reserved.
        // FW-084: v8 grows the record to 48 B for Extended Boost — 13 + 5*48 + 2 = 255 B,
        // exactly the ceiling. A v7 controller must keep receiving its own 46 B/245 B
        // format, or the write is rejected and the rider loses the whole bank.
        const version = bankObj.bank_schema_version >= 8 ? 8
            : (bankObj.bank_schema_version >= 7 ? 7
            : (bankObj.bank_schema_version >= 6 ? 6
            : (bankObj.bank_schema_version >= 5 ? 5
                : (bankObj.bank_schema_version >= 4 ? 4 : 3))));
        const HEADER = version >= 5 ? 13 : 12;
        const RECORD = version >= 8 ? 48 : (version >= 6 ? 46 : 35), LEVELS = 5;
        const BLOB_LEN = HEADER + LEVELS * RECORD + 2;
        const d = new Array(BLOB_LEN).fill(0);
        d[0] = 0x45; d[1] = 0x42; d[2] = version;
        d[3] = bankObj.bank_index & 1; d[4] = LEVELS; d[5] = RECORD;
        d[6] = bankObj.active_bank ?? 0;
        d[7] = Math.round(Math.max(10, Math.min(255, (bankObj.wa_cutoff_kmh ?? 7) * 10)));
        d[8] = Math.round(Math.max(1, Math.min(100, bankObj.wa_current_pct ?? 30)));
        d[9] = Math.round(Math.max(18, Math.min(60, bankObj.wa_target_rpm ?? 18)));
        d[10] = bankObj.wa_latch_after_release ? 1 : 0;
        d[11] = Math.round(Math.max(1, Math.min(120, bankObj.wa_latch_timeout_s ?? 30)));
        if (version >= 5) d[12] = bankObj.cadence_comp_enabled ? 1 : 0; // FW-057
        const u16 = (o, v) => { d[o] = v & 0xFF; d[o + 1] = (v >> 8) & 0xFF; };
        const kgWithOneDecimal = (value, maximum, fallback) =>
            Math.round(Math.max(0, Math.min(maximum, value ?? fallback)) * 10) / 10;
        (bankObj.levels || []).slice(0, LEVELS).forEach((lv, i) => {
            const r = HEADER + i * RECORD;
            d[r] = lv.mode_type & 0xFF;
            // FW-056: Power Curve puts its upper-half exponent in the support_ratio bytes.
            if (lv.mode_type === 6) {
                d[r + 1] = (lv.curve_exponent_high_x10 ?? 15) & 0xFF;
                d[r + 2] = 0;
            } else {
                u16(r + 1, lv.support_ratio_pct);
            }
            u16(r + 3, lv.support_min_pct);
            u16(r + 5, lv.support_max_pct); u16(r + 7, lv.reference_power_w);
            // FW-056: shape byte — gamma for Power Curve, progression otherwise.
            d[r + 9] = (lv.mode_type === 6 ? (lv.curve_exponent_x10 ?? 15) : lv.progression_pct) & 0xFF;
            d[r + 10] = lv.emtb_parameter & 0xFF;
            d[r + 11] = lv.emtb_based_on_power ? 1 : 0;
            u16(r + 12, lv.emtb_reference_voltage_mv); d[r + 14] = lv.torque_assist_factor & 0xFF;
            u16(r + 15, lv.max_motor_power_w); d[r + 17] = lv.max_iq_pct & 0xFF;
            d[r + 18] = lv.assist_without_rotation ? 1 : 0;
            const LEGACY_START_MV_PER_KG = 27;
            const minimumLoadKg = kgWithOneDecimal(
                lv.minimum_pedal_load_kg, 22.5, 0.7);
            const legacyMinimumMv = Math.round(Math.min(300,
                minimumLoadKg * LEGACY_START_MV_PER_KG));
            if (version >= 7) {
                u16(r + 19, Math.round(minimumLoadKg * 100)); // centikg
            } else {
                u16(r + 19, legacyMinimumMv);
            }
            d[r + 21] = lv.startup_boost_enabled ? 1 : 0; d[r + 22] = lv.startup_boost_mode & 0xFF;
            u16(r + 23, lv.startup_boost_strength_pct); d[r + 25] = lv.startup_boost_end_rpm & 0xFF;
            d[r + 26] = lv.smooth_start_enabled ? 1 : 0; u16(r + 27, lv.smooth_start_ms);
            u16(r + 29, lv.release_ms); u16(r + 31, lv.power_rise_filter_ms);
            u16(r + 33, lv.power_fall_filter_ms);
            if (version >= 6) {
                const clamp8 = (v, max) => Math.round(Math.max(0, Math.min(max, v ?? 0)));
                const ridingLoadKg = kgWithOneDecimal(
                    lv.riding_minimum_pedal_load_kg, 22.5, minimumLoadKg);
                if (version >= 7) {
                    // FW-077: direct rolling threshold in 0.1 kg.
                    d[r + 35] = clamp8(ridingLoadKg * 10, 225);
                } else {
                    // Negotiate down for v6: convert the kg UI back to the historical
                    // minimum-minus-reduction representation in native mV.
                    const ridingMv = Math.round(Math.min(legacyMinimumMv,
                        ridingLoadKg * LEGACY_START_MV_PER_KG));
                    d[r + 35] = clamp8(Math.max(0, legacyMinimumMv - ridingMv), 100);
                }
                // FW-084: from v8 these two bytes carry Extended Boost; for v6/v7 they stay
                // the reserved zeros of the removed rise detector.
                if (version >= 8) {
                    // 0.5 kg per unit, NOT the 0.1 kg the other kg fields use: that step
                    // is what fits the whole 60 kg sensor range into one byte at one exact decimal, and there
                    // was no second byte to be had — the blob is at the 255 B ceiling.
                    // 2 = 1.0 kg (the floor; 0 would arm on any touch), 120 = 60.0 kg.
                    const triggerKg = Math.max(0, Math.min(60,
                        lv.extended_boost_trigger_load_kg ?? 8));
                    d[r + 36] = clamp8(Math.max(2, Math.round(triggerKg * 2)), 120);
                    // 255 is a legal value here (2.55x), so it must never be treated as a
                    // signed byte or clipped back to 0.
                    d[r + 37] = clamp8(lv.extended_boost_strength_pct ?? 100, 255);
                } else {
                    d[r + 36] = 0;
                    d[r + 37] = 0;
                }
                // FW-069: Iq ramps, per level (they used to be global in the tuning blob).
                const ramp = (v, fallback) =>
                    Math.round(Math.max(20, Math.min(5000, v ?? fallback)));
                u16(r + 38, ramp(lv.iq_rise_slow_ms, 600));
                u16(r + 40, ramp(lv.iq_rise_fast_ms, 300));
                u16(r + 42, ramp(lv.iq_fall_slow_ms, 1000));
                u16(r + 44, ramp(lv.iq_fall_fast_ms, 140));
                if (version >= 8) { // FW-084: 0 = Extended Boost off
                    u16(r + 46, Math.round(Math.max(0, Math.min(1000,
                        lv.extended_boost_duration_ms ?? 0))));
                }
            }
        });
        let crc = 0xFFFF;
        const crcAt = HEADER + LEVELS * RECORD;
        for (let i = 0; i < crcAt; i++) {
            crc ^= d[i] << 8;
            for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
        }
        u16(crcAt, crc);
        return d;
    }

    async readBank(bankIndex) {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x20 };
        return this.readParameter(DeviceNetworkId.DRIVE_UNIT, cmd, [bankIndex & 1]);
    }

    async writeBank(bankObj) {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x21 };
        const bytes = CanBusService.serializeBankBlob(bankObj);
        return this.writeLongParameterWithAck(DeviceNetworkId.DRIVE_UNIT, cmd, bytes);
    }

    async saveBanks() {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x22 };
        return this.writeShortParameterWithAck(DeviceNetworkId.DRIVE_UNIT, cmd, [0x01]);
    }

    // --- FW-010: global ride-feel tuning (0x6023 read / 0x6024 RAM write; persisted by saveBanks() 0x6022) ---
    static serializeTuningBlob(t) {
        // FW-068: v6 = 32 B. Adds start_steps at offset 22 and leaves three reserved u16.
        // Offsets 4..11 still carry the four Iq ramps for wire compatibility, but FW-069
        // moved those per level into the bank blob and the firmware ignores them here.
        //
        // The version is NEGOTIATED, like the bank blob: firmware rejects a blob whose
        // version byte it does not know, so sending v6 to a pre-FW-068 controller would
        // make the whole Dynamics write fail. Fall back to the v5 layout in that case —
        // "Crank movement to start" simply has nowhere to go on that firmware.
        // FW-085: v7 is v6's layout with offset 20 reinterpreted from ms to crank degrees.
        const version = t.tuning_schema_version >= 7 ? 7 : (t.tuning_schema_version >= 6 ? 6 : 5);
        const BLOB_LEN = version >= 6 ? 32 : 24;
        const bodyLen = BLOB_LEN - 2;
        const d = new Array(BLOB_LEN).fill(0);
        d[0] = 0x54; d[1] = 0x55; d[2] = version; d[3] = 0;
        const u16 = (o, v) => { d[o] = v & 0xFF; d[o + 1] = (v >> 8) & 0xFF; };
        u16(4, t.iq_rise_slow_ms ?? 600); u16(6, t.iq_rise_fast_ms ?? 300);
        u16(8, t.iq_fall_slow_ms ?? 1000); u16(10, t.iq_fall_fast_ms ?? 140);
        u16(12, t.startup_boost_cadence_step);
        u16(14, t.assist_run_deadband_mv);
        u16(16, t.assist_hold_ms);
        u16(18, t.assist_min_iq_pct);
        // FW-085: offset 20 is crank degrees on v7. On an older controller it is still
        // milliseconds, and the degrees value has no honest millisecond equivalent — so
        // send that firmware's own default instead of a number that would silently mean
        // something else. The window setting simply has nowhere to go on pre-FW-085
        // firmware, the same way "Crank movement to start" has nowhere to go below v6.
        u16(20, version >= 7 ? Math.min(t.assist_torque_run_window_deg ?? 180, 360) : 300);
        if (version >= 6) {
            u16(22, Math.round(Math.max(1, Math.min(20, t.assist_start_steps ?? 4))));
        }
        let crc = 0xFFFF;
        for (let i = 0; i < bodyLen; i++) {
            crc ^= d[i] << 8;
            for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
        }
        u16(bodyLen, crc);
        return d;
    }

    async readTuning() {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x23 };
        return this.readParameter(DeviceNetworkId.DRIVE_UNIT, cmd);
    }

    async writeTuning(tuningObj) {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x24 };
        const bytes = CanBusService.serializeTuningBlob(tuningObj);
        return this.writeLongParameterWithAck(DeviceNetworkId.DRIVE_UNIT, cmd, bytes);
    }

    // --- FW-013: torque load telemetry (0x6025 read) + calibration ops (0x6026 short write) ---
    async readTorque() {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x25 };
        return this.readParameter(DeviceNetworkId.DRIVE_UNIT, cmd);
    }

    async torqueCalOp(op, referenceCentikg = 0) {
        // op: 1 start, 2 capture-load(+ref), 3 commit, 4 cancel, 5 restore-default
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x26 };
        const data = [op & 0xFF, referenceCentikg & 0xFF, (referenceCentikg >> 8) & 0xFF, 0, 0];
        return this.writeShortParameterWithAck(DeviceNetworkId.DRIVE_UNIT, cmd, data);
    }

    // FW-030: single engine (ride core). setEngine (0x6027) removed. readSystem (0x6028)
    // kept for the FW-018 full-charge SOC threshold.
    async readSystem() {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x28 };
        return this.readParameter(DeviceNetworkId.DRIVE_UNIT, cmd);
    }

    // --- FW-018: set full-charge PACK-voltage threshold (0x602B short write) ---
    // pack10mv = full-charge pack voltage in units of 10 mV (e.g. 45.87 V -> 4587). Firmware validates 20..90 V.
    async setSocFull(pack10mv) {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x2B };
        const v = Math.max(0, Math.min(0xFFFF, Math.round(pack10mv)));
        const f = [1, v & 0xFF, (v >> 8) & 0xFF, 0, 0, 0, 0]; // ver=1, pack10mv LE, reserved
        let crc = 0; // CRC-8/SMBUS poly 0x07 init 0x00 (must match firmware CAN_Display.c 0x602B)
        for (const b of f) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF; }
        f.push(crc);
        return this.writeShortParameterWithAck(DeviceNetworkId.DRIVE_UNIT, cmd, f);
    }

    async readDiagnostics() {
        const cmd = { canCommandCode: 0x60, canCommandSubCode: 0x29 };
        return this.readParameter(DeviceNetworkId.DRIVE_UNIT, cmd);
    }
    async sendRawFrame(idHexString, dataHexString) { const commandString = `${idHexString}#${dataHexString}`; return await this.sendFrame(commandString); }

    // --- sendFrame (Low-level sender - Unchanged) ---
    async sendFrame(commandString) { /* ... */
        if (!this.isStarted) throw new Error('CAN device not connected/started.'); 
        try { 
            const parts = commandString.split('#'); 
            if (parts.length !== 2) 
                throw new Error('Invalid command format.'); 
            const idHex = parts[0]; const dataHex = parts[1]; const canId = parseInt(idHex, 16); 
            if (isNaN(canId)) 
                throw new Error('Invalid CAN ID format.'); 
            const dataBytes = []; 
            if (dataHex) { 
                if (dataHex.length % 2 !== 0) 
                    throw new Error('Invalid Data Hex.'); 
                for (let i = 0; i < dataHex.length; i += 2) { 
                    const byte = parseInt(dataHex.substring(i, i + 2), 16); 
                    if (isNaN(byte)) throw new Error('Invalid Data Hex.'); 
                    dataBytes.push(byte); 
                } 
                if (dataBytes.length > 8) 
                    throw new Error('CAN data payload too long.'); 
            } 
            const frameToSend = new CanFrame(this.frameLength); 
            frameToSend.can_id = canId | CAN_EFF_FLAG; 
            /* Ensure Extended ID flag is set */; 
            frameToSend.can_dlc = dataBytes.length; 
            for (let i = 0; i < dataBytes.length; i++) 
                frameToSend.data.setUint8(i, dataBytes[i]); 
            frameToSend.echo_id = 0xFFFFFFFF; frameToSend.channel = 0; frameToSend.flags = 0; frameToSend.reserved = 0; 
            //console.log(`Sending CAN frame: ID=${idHex}, Data=[${dataBytes.map(b => b.toString(16).padStart(2,'0')).join(',')}]`);
            const success = await this.canDevice.writeCANFrame(frameToSend);
            if (!success) {
                console.error('CAN -> Failed send');
                // A refused write is a hint, not a verdict — let the next liveness check
                // decide, instead of guessing from one failed frame.
                this.probeNowRequested = true;
                return false; }
            this.lastTxOkAt = Date.now(); // a frame got out: the link works
            return true;
            } catch (err) {
                console.error('Error sending CAN frame:', err);
                if (classifyUsbError(err) === 'fatal') {
                    this._handleCanError(err);
                } else {
                    // Soft error: do not tear the link down over one transfer. Ask the
                    // next liveness check to probe rather than trust recent traffic.
                    this.probeNowRequested = true;
                }
                throw err;
            }
    }

    isConnected() { return this.isStarted; }

    // How long recent traffic counts as proof of life before we bother the adapter.
    static LIVENESS_QUIET_MS = 4000;

    /**
     * Is the link to the adapter actually alive?
     *
     * isConnected() only reports a flag set once at open time, which is why a link that
     * died while the host slept still read as "connected". This answers the question for
     * real, in two stages:
     *
     *   1. Passive — if frames arrived (or we sent one) in the last few seconds, the link
     *      demonstrably works. Free, instant, and true whenever the bike is running.
     *   2. Active — only once it goes quiet, ask the adapter over USB. Never touches the
     *      CAN bus, so a parked bike stays "alive" instead of looking dead.
     *
     * A failure here reports through _handleCanError, so callers do not have to.
     */
    async checkAlive({ force = false } = {}) {
        if (!this.isStarted) return { ok: false, reason: 'not connected' };

        const probeRequested = force || this.probeNowRequested;
        this.probeNowRequested = false;
        const quietFor = Date.now() - Math.max(this.lastRxAt, this.lastTxOkAt);
        if (!probeRequested && quietFor < CanBusService.LIVENESS_QUIET_MS) {
            return { ok: true, via: 'traffic' };
        }

        const probe = await this.canDevice.probeAlive();
        if (probe.ok) return { ok: true, via: probe.skipped ? 'probe in flight' : 'probe' };

        const severity = classifyUsbError(probe.error);
        if (severity === 'soft') {
            // One soft failure is not proof. Say so, and make the next check probe again
            // rather than trusting the quiet-bus shortcut — the caller counts the strikes.
            this.probeNowRequested = true;
            return { ok: false, soft: true, reason: probe.error };
        }
        this._handleCanError(new Error(probe.error));
        return { ok: false, reason: probe.error };
    }

    async close() {
        // If _handleCanError is already releasing the handle, let it finish first. Two
        // teardowns overlapping on the same device is what left the adapter unable to
        // answer a control transfer afterwards.
        if (this._teardownInFlight) {
            try { await this._teardownInFlight; } catch { /* it reports its own failures */ }
        }
        if (!this.canDevice) {
            console.log('[CanBusService] No CAN device instance to close.');
            this.isStarted = false; // Ensure state is consistent
            // this.emit('can_status', false, 'CAN device was not initialized.'); // Avoid if not needed
            return;
        }
        if (!this.isStarted && !this.canDevice.gs_usb) { // Check if gs_usb object exists (meaning open was attempted)
            console.log('[CanBusService] CAN device already stopped or never fully started.');
            this.isStarted = false;
            // this.emit('can_status', false, 'CAN device already stopped.'); // Avoid redundant emits
            return;
        }

        console.log('[CanBusService] Stopping CAN device...');
        this.requestManager.clearAllRequests();

        Object.keys(this.multiFrameTimeouts).forEach(key => {
           clearTimeout(this.multiFrameTimeouts[key]);
           delete this.multiFrameTimeouts[key];
        });
        this.multiFrameBuffers = {};
        const previouslyConnectedDeviceName = this.connectedDeviceName; // Store before clearing

        try {
            if (this.canDevice.pollCanFrames) { // Check if polling was active
                 await this.canDevice.stopPolling();
            }
            if (this.canDevice.gs_usb) { // Check if gs_usb (the usb.Device object) exists
                await this.canDevice.stop(); // This calls _disableCanHardware and then gs_usb.close()
            }
            this.isStarted = false;
            this.connectedDeviceName = null; // Clear the name on successful close
            console.log('[CanBusService] CAN device stopped.');
            this.emit('can_status', false, `CAN device disconnected (${previouslyConnectedDeviceName || 'Unknown Device'}).`);
        }
        catch (err) {
            console.error('[CanBusService] Error stopping CAN device:', err);
            this.isStarted = false; // Ensure state reflects stop attempt
            this.connectedDeviceName = null; // Clear name on error too
            this.emit('can_status', false, `Error stopping CAN device: ${err.message}`);
         }
    }
}

module.exports = new CanBusService();
