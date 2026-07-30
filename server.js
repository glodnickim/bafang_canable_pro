/// server.js
"use strict";

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const usb = require('usb');

// Import Bafang-specific modules
const canbus = require('./canbus'); // The main CanBusService instance
const { DeviceNetworkId, CanOperation } = require('./bafang-constants'); // Added CanOperation
const { CanReadCommandsList } = require('./bafang-can-read-commands');
const { CanWriteCommandsList } = require('./bafang-can-write-commands');

const { generateCanFrameId, bafangIdArrayTo32Bit } = require('./bafang-parser');
const FwUpdater = require('./fw-updater');
const Sniffer = require('./sniffer');
const RideLogger = require('./logger');

// --- Globals ---
let clients = [];
let canDevicePresenceInterval = null;
const CANABLE_VID = 0x1D50; // Common VID for CANable/OpenMoko
const CANABLE_PID = 0x606F; // Common PID for CANable/Gespeaker (gs_usb firmware)
let detectedCanDeviceName = null; // Store name of the detected device
let isCheckingPresence = false; // Mutex flag for presence check
let manualDisconnect = false; // user clicked Disconnect: suppress auto-connect until the device is physically re-plugged
let autoConnectInProgress = false; // guard against overlapping auto-connect attempts

// CB-010: recovery from a link that died without the device leaving the USB bus —
// the sleep/wake case. 'recovering' and 'failed' are broadcast to the browser so the
// user sees the link is gone instead of a green pill over a dead connection.
let recoveryState = 'idle'; // 'idle' | 'recovering' | 'failed'
let recoveryReason = null;
let recoveryAttempt = 0;
let recoveryTimer = null;
let fwUpdateInProgress = false; // a flash is delay-sensitive: no probing, no reconnecting under it
let lastProbeAt = 0;
let probeMissCount = 0;
let lastTickAt = Date.now();
const PROBE_INTERVAL_MS = 5000;
const RECOVERY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

// --- HTTP Server setup (Serves the index.html UI) ---
const server = http.createServer((req, res) => {
    // Determine file path, default to index.html
    const filePath = path.join(__dirname, 'ui', req.url === '/' ? 'index.html' : req.url);
	let requestedUrl = req.url;
    if (requestedUrl === '/') {
        requestedUrl = '/index.html'; // Explicitly serve index.html for root
    }

    // Basic security: prevent directory traversal
    const baseDir = path.resolve(__dirname);
    if (!filePath.startsWith(baseDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
	
	if (requestedUrl.includes('.well-known/appspecific/com.chrome.devtools.json')) {
        console.log(`Ignoring DevTools request: ${requestedUrl}`);
        res.writeHead(404);
        res.end('Not Found');
        return; // Stop processing this request early
    }

    // Read and serve the file
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(`Error reading file ${filePath}: ${err.code}`);
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            // Determine content type (basic)
            let contentType = 'text/html';
            if (filePath.endsWith('.js')) {
                contentType = 'text/javascript';
            } else if (filePath.endsWith('.css')) {
                contentType = 'text/css';
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
});

async function getStringDescriptorAsync(device, index) {
    return new Promise((resolve, reject) => {
        if (!index) {
            resolve(""); // No descriptor to get
            return;
        }
        device.getStringDescriptor(index, (error, data) => {
            if (error) {
                // Don't reject, just resolve with empty or error string
                // console.warn(`Error getting string descriptor ${index}:`, error.message);
                resolve("");
            } else {
                resolve(data);
            }
        });
    });
}

async function checkCanDevicePresenceAndUpdateGlobal() {
    if (isCheckingPresence) {
        // console.log("Presence check already in progress, skipping.");
        return detectedCanDeviceName; // Return last known state
    }
    isCheckingPresence = true;

    let deviceToClose = null; // Keep track of the device if we open it

    try {
        const devices = usb.getDeviceList();
        const canableDevice = devices.find(device =>
            device.deviceDescriptor.idVendor === CANABLE_VID &&
            device.deviceDescriptor.idProduct === CANABLE_PID
        );

        if (canableDevice) {
            let nameToSet = `CANable Device (VID:${CANABLE_VID.toString(16)}, PID:${CANABLE_PID.toString(16)})`; // Fallback
            deviceToClose = canableDevice; // Mark that we might open this
            let wasOpened = false;

            try {
                canableDevice.open();
                wasOpened = true;

                // Ensure these are awaited
                const manufacturer = await getStringDescriptorAsync(canableDevice, canableDevice.deviceDescriptor.iManufacturer);
                const product = await getStringDescriptorAsync(canableDevice, canableDevice.deviceDescriptor.iProduct);

                if (product) {
                    nameToSet = manufacturer ? `${product} (by ${manufacturer})` : product;
                }
                // Note: device is closed in the finally block if it was opened
            } catch (e) {
                console.warn(`Could not fully query device ${CANABLE_VID.toString(16)}:${CANABLE_PID.toString(16)}: ${e.message}. Using generic name.`);
                if (e.message.includes("LIBUSB_ERROR_ACCESS")) {
                    nameToSet += " - Access Denied (check udev rules/permissions)";
                    console.error("LIBUSB_ERROR_ACCESS: Ensure you have correct udev rules or run with sudo (not recommended for long term).");
                } else if (e.message.includes("LIBUSB_ERROR_NOT_FOUND") || e.message.includes("LIBUSB_ERROR_NO_DEVICE") || e.message.includes("LIBUSB_ERROR_BUSY")) {
                    // Device disappeared, or is busy (perhaps canbus.js has it)
                    detectedCanDeviceName = null;
                    deviceToClose = null; // Don't try to close it if it's gone or busy
                    if (wasOpened) { // If we did manage to open it before it vanished/got busy
                        try {
                            canableDevice.close(); // Attempt to close it
                        } catch (closeErr) {
                            // console.warn("Error closing device that vanished/got busy:", closeErr.message);
                        }
                    }
                    isCheckingPresence = false;
                    return null;
                }
                // If open failed, wasOpened remains false, deviceToClose might still be canableDevice
                // but the finally block will only close if wasOpened is true.
            }
            detectedCanDeviceName = nameToSet;
            isCheckingPresence = false;
            return detectedCanDeviceName;
        } else {
            detectedCanDeviceName = null;
            isCheckingPresence = false;
            return null;
        }
    } catch (err) {
        console.error("Error checking USB devices:", err);
        detectedCanDeviceName = null;
        isCheckingPresence = false;
        return null;
    } finally {
        if (deviceToClose && deviceToClose.interfaces && deviceToClose.deviceDescriptor.bNumConfigurations > 0) { // Check if it's a valid, opened device object
            try {
                // console.log("Closing device in finally block of presence check");
                deviceToClose.close();
            } catch (closeError) {
                // This is the "Can't close device with a pending request" error source
                // Or "The device has no langid" if not opened successfully
                // Or "Device is not open" if it was never opened or closed already
                // console.warn(`Error closing device in finally: ${closeError.message}`);
            }
        }
        isCheckingPresence = false;
    }
}


// libusb messages contain ':' and the browser splits the status line on it
// (websocket.js takes parts[1] as the device name), so a raw reason would break the parse.
function sanitiseReason(reason) {
    return `${reason || 'unknown reason'}`.replace(/:/g, ' -').replace(/\s+/g, ' ').trim();
}

function broadcastCanDeviceStatus() {
    let messageToSend = ''; // Determine the message based on state
    // Recovery outranks everything else. Without this, the can_status(false) that
    // accompanies a link error would re-run presence detection, find the adapter still
    // enumerated (it is — that is the whole problem after a resume) and broadcast FOUND
    // over the top of the real message. One function decides, so nothing races.
    if (recoveryState === 'recovering') {
        messageToSend = `CAN_DEVICE_STATUS:RECOVERING:${detectedCanDeviceName || 'Adapter'}:${sanitiseReason(recoveryReason)}`;
    } else if (recoveryState === 'failed') {
        messageToSend = `CAN_DEVICE_STATUS:LINK_LOST:${detectedCanDeviceName || 'Adapter'}:${sanitiseReason(recoveryReason)}`;
    } else if (canbus.isConnected()) {
        messageToSend = `CAN_DEVICE_STATUS:CONNECTED:${detectedCanDeviceName || "Connected Device"}`;
    } else {
        if (detectedCanDeviceName) {
            messageToSend = `CAN_DEVICE_STATUS:FOUND:${detectedCanDeviceName}`;
        } else {
            messageToSend = 'CAN_DEVICE_STATUS:NOT_FOUND';
        }
    }
    console.log(`Broadcasting: ${messageToSend}`); 
    broadcastToClients(messageToSend);
}

// --- WebSocket Server ---
const wss = new WebSocket.Server({ server });

	function withCanTimeout(promise, label, timeoutMs = 10000) {
		return Promise.race([
			promise,
			new Promise((resolve) => setTimeout(() => resolve({
				success: false,
				error: `${label} did not finish`,
				timedOut: true,
			}), timeoutMs)),
		]);
	}

	async function handleConnectionCommands(ws, messageString) {
		if (messageString === 'GET_CAN_INTERFACE_STATUS') {
			await checkCanDevicePresenceAndUpdateGlobal();
			broadcastCanDeviceStatus();
			return true;
		}
		if (messageString === 'CONNECT_CAN') {
			manualDisconnect = false; // explicit user intent to be connected
			clearRecoveryState(); // a manual Reconnect wipes the failed state and its backoff
			if (canbus.isConnected()) {
				ws.send('INFO: Already connected.');
				broadcastCanDeviceStatus();
				return true;
			}
			await checkCanDevicePresenceAndUpdateGlobal();
			if (detectedCanDeviceName) {
				broadcastToClients(`CAN_DEVICE_STATUS:CONNECTING:${detectedCanDeviceName}`);
				await canbus.init(detectedCanDeviceName);
			} else {
				broadcastToClients('CAN_DEVICE_STATUS:NOT_FOUND');
				ws.send('CAN_ERROR: No CAN device found to connect.');
			}
			return true;
		}
		if (messageString === 'DISCONNECT_CAN') {
			manualDisconnect = true; // suppress auto-connect until the device is re-plugged or user reconnects
			clearRecoveryState(); // stop any pending retry; the user asked to be disconnected
			if (!canbus.isConnected()) {
				ws.send('INFO: Already disconnected.');
				broadcastCanDeviceStatus();
				return true;
			}
			broadcastToClients(`CAN_DEVICE_STATUS:DISCONNECTING:${detectedCanDeviceName || "Device"}`);
			await canbus.close();
			return true;
		}
		return false; // Not a connection command
	}

	async function handleReadCommands(ws, messageString, sendResult) {
		if (!messageString.startsWith('READ:')) return false;

		const parts = messageString.substring('READ:'.length).split(':');
		if (parts.length !== 3) {
			ws.send('ERROR: Invalid READ format. Use READ:TARGET:CMD:SUB');
			return true;
		}
		const targetId = parseInt(parts[0], 10);
		const cmdCode = parseInt(parts[1], 10);
		const subCode = parseInt(parts[2], 10);
		let cmdInfo = null;
		let cmdKey = `${cmdCode}/${subCode}`;
		let parseError = false;
		const validTargets = Object.values(DeviceNetworkId);

		if (isNaN(targetId) || !validTargets.includes(targetId)) { ws.send(`ERROR: Invalid Target ID ${parts[0]}.`); parseError = true; }

		if (!parseError) {
			for (const key in CanReadCommandsList) {
				const cmd = CanReadCommandsList[key];
				if (cmd.canCommandCode === cmdCode && cmd.canCommandSubCode === subCode) { cmdInfo = cmd; cmdKey = key; break; }
			}
			if (!cmdInfo) { ws.send(`ERROR: Command ${cmdCode}/${subCode} not found in read list.`); parseError = true; }
		}
		if (cmdInfo && !parseError && (!cmdInfo.applicableDevices || !cmdInfo.applicableDevices.includes(targetId))) {
			ws.send(`ERROR: Command ${cmdKey} is not applicable to target device ${targetId}.`); parseError = true;
		}
		if (!parseError) {
			const source = DeviceNetworkId.BESST;
			const bafangIdArr = generateCanFrameId(source, targetId, CanOperation.READ_CMD, cmdCode, subCode);
			const canId32bit = bafangIdArrayTo32Bit(bafangIdArr);
			console.log(`>>> Initiating Read ${cmdKey} | Target: ${targetId} | 32bit ID: ${canId32bit.toString(16).toUpperCase().padStart(8, '0')}`);
			ws.send(`INFO: Initiating Read ${cmdKey} from ${targetId}...`);
			const result = await withCanTimeout(canbus.readParameter(targetId, cmdInfo), `Read ${cmdKey}`);
			sendResult(`Read ${cmdKey}`, result);
		}
		return true; // Command was handled (or failed validation within this handler)
	}

	// --- FW-006: profile bank commands ---
	async function handleBankCommands(ws, messageString) {
		if (messageString.startsWith('READ_BANK:')) {
			const idx = parseInt(messageString.substring('READ_BANK:'.length), 10);
			if (isNaN(idx) || idx < 0 || idx > 1) { ws.send('ERROR: READ_BANK expects 0 or 1'); return true; }
			try {
				const result = await withCanTimeout(canbus.readBank(idx), `Read Bank ${idx + 1}`);
				if (result?.success) {
					ws.send(`ACK: Read Bank ${idx + 1} successful.`);
				} else {
					ws.send(`NACK: Read Bank ${idx + 1} failed. Reason: ${result?.error || 'No response'}${result?.timedOut ? ' (Timeout)' : ''}`);
				}
			} catch (e) { ws.send(`ERROR: READ_BANK failed: ${e.message}`); }
			return true;
		}
		if (messageString.startsWith('WRITE_BANK:')) {
			try {
				const bankObj = JSON.parse(messageString.substring('WRITE_BANK:'.length));
				const result = await canbus.writeBank(bankObj);
				ws.send(JSON.stringify({ type: 'bank_write_result', data: result }));
			} catch (e) { ws.send(`ERROR: WRITE_BANK failed: ${e.message}`); }
			return true;
		}
		if (messageString === 'SAVE_BANKS') {
			try {
				const result = await canbus.saveBanks();
				ws.send(JSON.stringify({ type: 'bank_save_result', data: result }));
			} catch (e) { ws.send(`ERROR: SAVE_BANKS failed: ${e.message}`); }
			return true;
		}
		if (messageString === 'READ_TUNING') {
			try {
				const result = await withCanTimeout(canbus.readTuning(), 'Read Tuning');
				if (result?.success) ws.send('ACK: Read Tuning successful.');
				else ws.send(`NACK: Read Tuning failed. Reason: ${result?.error || 'No response'}${result?.timedOut ? ' (Timeout)' : ''}`);
			} catch (e) { ws.send(`ERROR: READ_TUNING failed: ${e.message}`); }
			return true;
		}
		if (messageString.startsWith('WRITE_TUNING:')) {
			try {
				const tuningObj = JSON.parse(messageString.substring('WRITE_TUNING:'.length));
				const result = await canbus.writeTuning(tuningObj);
				ws.send(JSON.stringify({ type: 'tuning_write_result', data: result }));
			} catch (e) { ws.send(`ERROR: WRITE_TUNING failed: ${e.message}`); }
			return true;
		}
		if (messageString === 'READ_TORQUE') {
			try {
				const result = await withCanTimeout(canbus.readTorque(), 'Read Torque');
				if (result?.success) ws.send('ACK: Read Torque successful.');
				else ws.send(`NACK: Read Torque failed. Reason: ${result?.error || 'No response'}${result?.timedOut ? ' (Timeout)' : ''}`);
			} catch (e) { ws.send(`ERROR: READ_TORQUE failed: ${e.message}`); }
			return true;
		}
		if (messageString.startsWith('TORQUE_CAL:')) {
			try {
				const parts = messageString.substring('TORQUE_CAL:'.length).split(':');
				const op = parseInt(parts[0], 10);
				const refCentikg = parts.length > 1 ? parseInt(parts[1], 10) : 0;
				const result = await canbus.torqueCalOp(op, refCentikg);
				ws.send(JSON.stringify({ type: 'torque_cal_result', data: result }));
			} catch (e) { ws.send(`ERROR: TORQUE_CAL failed: ${e.message}`); }
			return true;
		}
		if (messageString === 'READ_SYSTEM') {
			try {
				const result = await withCanTimeout(canbus.readSystem(), 'Read System');
				if (result?.success) ws.send('ACK: Read System successful.');
				else ws.send(`NACK: Read System failed. Reason: ${result?.error || 'No response'}${result?.timedOut ? ' (Timeout)' : ''}`);
			} catch (e) { ws.send(`ERROR: READ_SYSTEM failed: ${e.message}`); }
			return true;
		}
		if (messageString === 'READ_DIAG') {
			try {
				const result = await withCanTimeout(canbus.readDiagnostics(), 'Read Diagnostics');
				if (result?.success) ws.send('ACK: Read Diagnostics successful.');
				else ws.send(`NACK: Read Diagnostics failed. Reason: ${result?.error || 'No response'}${result?.timedOut ? ' (Timeout)' : ''}`);
			} catch (e) { ws.send(`ERROR: READ_DIAG failed: ${e.message}`); }
			return true;
		}
		// FW-030: SET_ENGINE removed (single TSDZ engine).
		if (messageString.startsWith('SET_SOC_FULL:')) { // FW-018: full-charge pack voltage; arg = pack10mv (10 mV units)
			try {
				const pack10mv = parseInt(messageString.substring('SET_SOC_FULL:'.length), 10);
				const result = await canbus.setSocFull(pack10mv);
				ws.send(JSON.stringify({ type: 'soc_full_set_result', data: result }));
			} catch (e) { ws.send(`ERROR: SET_SOC_FULL failed: ${e.message}`); }
			return true;
		}
		return false;
	}

	async function handleReadRawCommand(ws, messageString, sendResult) {
		if (!messageString.startsWith('READ_RAW:')) return false;

		const parts = messageString.substring('READ_RAW:'.length).split(':');
		if (parts.length !== 3) {
			ws.send('ERROR: Invalid READ format. Use READ_RAW:TARGET:CMD:SUB');
			return true;
		}
		const targetId = parseInt(parts[0], 10);
		const cmdCode = parseInt(parts[1], 10);
		const subCode = parseInt(parts[2], 10);
		let cmdInfo = { 
			canCommandCode: cmdCode,
			canCommandSubCode: subCode,
			applicableDevices: [targetId],
		};
		let cmdKey = `${cmdCode}/${subCode}`;
		let parseError = false;
		const validTargets = Object.values(DeviceNetworkId);

		if (isNaN(targetId) || !validTargets.includes(targetId)) { ws.send(`ERROR: Invalid Target ID ${parts[0]}.`); parseError = true; }

		if (!parseError) {
			const source = DeviceNetworkId.BESST;
			const bafangIdArr = generateCanFrameId(source, targetId, CanOperation.READ_CMD, cmdCode, subCode);
			const canId32bit = bafangIdArrayTo32Bit(bafangIdArr);
			console.log(`>>> Initiating Read ${cmdKey} | Target: ${targetId} | 32bit ID: ${canId32bit.toString(16).toUpperCase().padStart(8, '0')}`);
			ws.send(`INFO: Initiating Read ${cmdKey} from ${targetId}...`);
			const result = await canbus.readParameter(targetId, cmdInfo);
			sendResult(`Read ${cmdKey}`, result);
		}
		return true; // Command was handled (or failed validation within this handler)
	}

	async function handleWriteShortCommands(ws, messageString, sendResult) {
		if (!messageString.startsWith('WRITE_SHORT:')) return false;

		const parts = messageString.substring('WRITE_SHORT:'.length).split(':', 4);
		if (parts.length < 3) {
			ws.send('ERROR: Invalid WRITE_SHORT format. Use WRITE_SHORT:TARGET:CMD:SUB[:DATAHEX]');
			return true;
		}
		const targetId = parseInt(parts[0], 10);
		const cmdCode = parseInt(parts[1], 10);
		const subCode = parseInt(parts[2], 10);
		const dataHex = (parts.length === 4) ? (parts[3] || "") : "";
		const dataBytes = [];
		let parseError = false;
		let cmdInfo = null;
		let cmdKey = `${cmdCode}/${subCode}`;
		const validTargets = Object.values(DeviceNetworkId);

		if (dataHex) {
			if (dataHex.length % 2 !== 0) { ws.send('ERROR: Data Hex must have even length.'); parseError = true; }
			if (!parseError) {
				for (let i = 0; i < dataHex.length; i += 2) {
					const byte = parseInt(dataHex.substring(i, i + 2), 16);
					if (isNaN(byte)) { ws.send('ERROR: Data Hex contains invalid characters.'); parseError = true; break; }
					dataBytes.push(byte);
				}
			}
			if (!parseError && dataBytes.length > 8) { ws.send('ERROR: Data payload too long (max 8 bytes).'); parseError = true; }
		}
		if (!parseError && (isNaN(targetId) || !validTargets.includes(targetId))) { ws.send(`ERROR: Invalid Target ID ${parts[0]}.`); parseError = true; }
		if (!parseError) {
			for (const key in CanWriteCommandsList) {
				const cmd = CanWriteCommandsList[key];
				if (cmd.canCommandCode === cmdCode && cmd.canCommandSubCode === subCode) { cmdInfo = cmd; cmdKey = key; break; }
			}
			if (!cmdInfo) { ws.send(`ERROR: Command ${cmdCode}/${subCode} not found in write list.`); parseError = true; }
		}
		if (cmdInfo && !parseError && (!cmdInfo.applicableDevices || !cmdInfo.applicableDevices.includes(targetId))) {
			ws.send(`ERROR: Command ${cmdKey} is not applicable to target device ${targetId}.`); parseError = true;
		}
		if (!parseError) {
			console.log(`>>> Initiating Short Write ${cmdKey} | Target: ${targetId} | Data: ${dataHex}`);
			ws.send(`INFO: Initiating Short Write ${cmdKey} to ${targetId}...`);
			const result = await canbus.writeShortParameterWithAck(targetId, cmdInfo, dataBytes);
			sendResult(`Short Write ${cmdKey}`, result);
		}
		return true;
	}

	async function handleWriteShortRawCommand(ws, messageString, sendResult) {
		if (!messageString.startsWith('WRITE_SHORT_RAW:')) return false;

		const parts = messageString.substring('WRITE_SHORT_RAW:'.length).split(':', 4);
		if (parts.length < 3) {
			ws.send('ERROR: Invalid WRITE_SHORT_RAW format. Use WRITE_SHORT_RAW:TARGET:CMD:SUB[:DATAHEX]');
			return true;
		}
		const targetId = parseInt(parts[0], 10);
		const cmdCode = parseInt(parts[1], 10);
		const subCode = parseInt(parts[2], 10);
		const dataHex = (parts.length === 4) ? (parts[3] || "") : "";
		const dataBytes = [];
		let parseError = false;
		let cmdInfo = {
			canCommandCode: cmdCode,
			canCommandSubCode: subCode, // 
			applicableDevices: [targetId],
		};
		let cmdKey = `${cmdCode}/${subCode}`;
		const validTargets = Object.values(DeviceNetworkId);

		if (dataHex) {
			if (dataHex.length % 2 !== 0) { ws.send('ERROR: Data Hex must have even length.'); parseError = true; }
			if (!parseError) {
				for (let i = 0; i < dataHex.length; i += 2) {
					const byte = parseInt(dataHex.substring(i, i + 2), 16);
					if (isNaN(byte)) { ws.send('ERROR: Data Hex contains invalid characters.'); parseError = true; break; }
					dataBytes.push(byte);
				}
			}
			if (!parseError && dataBytes.length > 8) { ws.send('ERROR: Data payload too long (max 8 bytes).'); parseError = true; }
		}
		if (!parseError && (isNaN(targetId) || !validTargets.includes(targetId))) { ws.send(`ERROR: Invalid Target ID ${parts[0]}.`); parseError = true; }
		if (cmdInfo && !parseError && (!cmdInfo.applicableDevices || !cmdInfo.applicableDevices.includes(targetId))) {
			ws.send(`ERROR: Command ${cmdKey} is not applicable to target device ${targetId}.`); parseError = true;
		}
		if (!parseError) {
			console.log(`>>> Initiating Short Write ${cmdKey} | Target: ${targetId} | Data: ${dataHex}`);
			ws.send(`INFO: Initiating Short Write ${cmdKey} to ${targetId}...`);
			const result = await canbus.writeShortParameterWithAck(targetId, cmdInfo, dataBytes);
			sendResult(`Short Write ${cmdKey}`, result);
		}
		return true;
	}

	async function handleWriteLongParsedParams(ws, messageString) {
		if (!(messageString.startsWith('WRITE_LONG_P') && !messageString.includes('_RAW:'))) return false;

		const paramMatch = messageString.match(/^WRITE_LONG_(P[0-2]):(\{.*\})$/);
		if (!paramMatch || !paramMatch[1] || !paramMatch[2]) {
			ws.send('ERROR: Invalid WRITE_LONG_P format. Expected P0, P1, or P2 followed by :{json_object}.');
			return true;
		}
		const paramBlockKey = paramMatch[1];
		const jsonData = paramMatch[2];
		let saveFunction;
		let paramName = `Parameter ${paramBlockKey.substring(1)}`;

		switch (paramBlockKey) {
			case 'P0': saveFunction = canbus.saveControllerParams0; break;
			case 'P1': saveFunction = canbus.saveControllerParams1; break;
			case 'P2': saveFunction = canbus.saveControllerParams2; break;
			default: ws.send(`ERROR: Invalid parameter key for WRITE_LONG_P: ${paramBlockKey}`); return true;
		}
		try {
			const params = JSON.parse(jsonData);
			if (typeof params === 'object' && params !== null) {
				ws.send(`INFO: Initiating Long Write ${paramName} to Controller (No ACK Tracked by UI)...`);
				await saveFunction(params);
				ws.send(`INFO: Controller ${paramName} write sequence sent.`);
			} else { ws.send(`ERROR: Invalid JSON for ${paramName}. Expected an object.`); }
		} catch (e) { ws.send(`ERROR: Failed to parse JSON for ${paramName}: ${e.message}`); }
		return true;
	}

	async function handleWriteLongRawParams(ws, messageString, sendRawWriteStatus) {
		if (!(messageString.startsWith('WRITE_LONG_P') && messageString.includes('_RAW:'))) return false;

		const [commandPart, jsonData] = messageString.split('_RAW:');
		const paramTypeMatch = commandPart.match(/WRITE_LONG_(P[0-2])$/);
		if (!paramTypeMatch || !paramTypeMatch[1] || !jsonData) {
			ws.send('ERROR: Invalid RAW parameter write format. Could not extract P-number or JSON data.');
			return true;
		}
		const paramBlockKey = paramTypeMatch[1];
		let targetCommandInfo = null;
		let descriptiveName = '';

		switch (paramBlockKey) {
			case 'P0': targetCommandInfo = CanWriteCommandsList.Parameter0; descriptiveName = 'Controller Parameter 0'; break;
			case 'P1': targetCommandInfo = CanWriteCommandsList.Parameter1; descriptiveName = 'Controller Parameter 1'; break;
			case 'P2': targetCommandInfo = CanWriteCommandsList.Parameter2; descriptiveName = 'Controller Parameter 2'; break;
			default: ws.send(`ERROR: Unknown raw parameter block key: ${paramBlockKey}`); return true;
		}
		if (!targetCommandInfo) { ws.send(`ERROR: Write command info not found for ${descriptiveName}.`); return true; }
		try {
			const bytesArray = JSON.parse(jsonData);
			if (Array.isArray(bytesArray) && bytesArray.length === 64 && bytesArray.every(b => typeof b === 'number' && b >= 0 && b <= 255)) {
				ws.send(`INFO: Writing raw ${descriptiveName} to Controller...`);
				const success = await canbus.writeRawBytesParameter(DeviceNetworkId.DRIVE_UNIT, targetCommandInfo, bytesArray);
				sendRawWriteStatus(descriptiveName, success);
			} else { ws.send(`ERROR: Invalid byte array for raw ${descriptiveName}.`); }
		} catch (e) { ws.send(`ERROR: Failed to parse JSON byte array for raw ${descriptiveName}: ${e.message}`); }
		return true;
	}

	async function handleWriteLongRawCustomParams(ws, messageString, sendRawWriteStatus) {
		if (!messageString.startsWith('WRITE_LONG_RAW:')) return false;
		const parts = messageString.substring('WRITE_LONG_RAW:'.length).split(':', 4);
		if (parts.length < 4) {
			ws.send('ERROR: Invalid WRITE_LONG_RAW: format. Use WRITE_LONG_RAW:TARGET:CMD:SUB:DATAHEX');
			return true;
		}
		const targetId = parseInt(parts[0], 10);
		const cmdCode = parseInt(parts[1], 10);
		const subCode = parseInt(parts[2], 10);
		const jsonData = parts[3];
		let targetCommandInfo = {
			canCommandCode: cmdCode,
			canCommandSubCode: subCode,
			applicableDevices: [targetId]
		};
		try {
			const bytesArray = JSON.parse(jsonData);
			if (Array.isArray(bytesArray) && bytesArray.every(b => typeof b === 'number' && b >= 0 && b <= 255)) {
				ws.send(`INFO: Writing raw long custom...`);
				const success = await canbus.writeRawBytesParameter(targetId, targetCommandInfo, bytesArray);
				sendRawWriteStatus('raw long custom', success);
			} else { ws.send(`ERROR: Invalid byte array for raw long custom.`); }
		} catch (e) { ws.send(`ERROR: Failed to parse JSON byte array for raw long custom: ${e.message}`); }
		return true;
	}

	async function handleWriteLongSpeedParams(ws, messageString) {
		if (!messageString.startsWith('WRITE_LONG_SPEED:')) return false;

		const jsonData = messageString.substring('WRITE_LONG_SPEED:'.length);
		try {
			const speedParams = JSON.parse(jsonData);
			if (speedParams && typeof speedParams.speed_limit === 'number' &&
				speedParams.wheel_diameter && Array.isArray(speedParams.wheel_diameter.code) && speedParams.wheel_diameter.code.length === 2 &&
				typeof speedParams.circumference === 'number') { // Assuming circumference is now always sent
				ws.send(`INFO: Initiating Write Speed Parameters to Controller (No ACK Tracked by UI)...`);
				await canbus.saveControllerSpeedParams(speedParams);
				ws.send(`INFO: Controller Speed Parameters write sequence sent.`);
			} else {
				ws.send('ERROR: Invalid JSON data structure for WRITE_LONG_SPEED.');
				console.error("Invalid speedParams structure for WRITE_LONG_SPEED:", speedParams);
			}
		} catch (e) {
			ws.send(`ERROR: Failed to parse JSON for WRITE_LONG_SPEED: ${e.message}`);
			console.error("JSON Parse Error for WRITE_LONG_SPEED:", e);
		}
		return true;
	}

	async function handleWriteLongStringParams(ws, messageString) {
		if (!messageString.startsWith('WRITE_LONG_STRING:')) return false;

		const parts = messageString.substring('WRITE_LONG_STRING:'.length).split(':', 4);
		if (parts.length < 3) {
			ws.send('ERROR: Invalid WRITE_LONG_STRING format.');
			return true;
		}
		const targetId = parseInt(parts[0], 10);
		const cmdCode = parseInt(parts[1], 10);
		const subCode = parseInt(parts[2], 10);
		const value = (parts.length === 4) ? (parts[3] || "") : "";
		let parseError = false;
		let cmdInfo = null;
		let cmdKey = `${cmdCode}/${subCode}`;
		const validTargets = Object.values(DeviceNetworkId);

		if (isNaN(targetId) || !validTargets.includes(targetId)) { ws.send(`ERROR: Invalid Target ID ${parts[0]}.`); parseError = true; }
		if (!parseError) {
			for (const key in CanWriteCommandsList) {
				const cmd = CanWriteCommandsList[key];
				if (cmd.canCommandCode === cmdCode && cmd.canCommandSubCode === subCode) { cmdInfo = cmd; cmdKey = key; break; }
			}
			if (!cmdInfo) { ws.send(`ERROR: Command ${cmdCode}/${subCode} not found in write list.`); parseError = true; }
		}
		if (cmdInfo && !parseError && (!cmdInfo.applicableDevices || !cmdInfo.applicableDevices.includes(targetId))) {
			ws.send(`ERROR: Command ${cmdKey} is not applicable to target device ${targetId}.`); parseError = true;
		}
		if (!parseError && value === "") { ws.send(`ERROR: Value string is required for WRITE_LONG_STRING.`); parseError = true; }
		if (!parseError) {
			ws.send(`INFO: Initiating Long Write String ${cmdKey} to ${targetId} (No ACK Tracked by UI)...`);
			await canbus.saveStringParameter(targetId, cmdInfo, value);
			ws.send(`INFO: String Parameter ${cmdKey} write sequence sent.`);
		}
		return true;
	}

	async function handleDisplaySpecificWrites(ws, messageString,sendResult) {
		if (messageString.startsWith('WRITE_DISP_TIME:')) {
			const parts = messageString.substring('WRITE_DISP_TIME:'.length).split(':', 3);
			await canbus.saveDisplayTime(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2])); 
			ws.send(`INFO: Time changed.`);
			return true;
		}
		if (messageString.startsWith('WRITE_DISP_TOTAL_MILEAGE:')) {
			const value = parseFloat(messageString.substring('WRITE_DISP_TOTAL_MILEAGE:'.length));
			if (!isNaN(value)) {
				ws.send(`INFO: Initiating Write Total Mileage to Display (No ACK Tracked by UI)...`);
				await canbus.saveDisplayTotalMileage(value); ws.send(`INFO: Total Mileage write sequence sent.`);
			} else { ws.send('ERROR: Invalid mileage value.'); }
			return true;
		}
		if (messageString.startsWith('WRITE_DISP_SINGLE_MILEAGE:')) {
			const value = parseFloat(messageString.substring('WRITE_DISP_SINGLE_MILEAGE:'.length));
			if (!isNaN(value)) {
				ws.send(`INFO: Initiating Write Single Mileage to Display (No ACK Tracked by UI)...`);
				await canbus.saveDisplaySingleMileage(value); ws.send(`INFO: Single Mileage write sequence sent.`);
			} else { ws.send('ERROR: Invalid mileage value.'); }
			return true;
		}
		if (messageString.startsWith('SET_AND_CLEAN_SERVICE_MILEAGE:')) {
            // Expected format: SET_AND_CLEAN_SERVICE_MILEAGE:threshold_in_km
            const thresholdStr = messageString.substring('SET_AND_CLEAN_SERVICE_MILEAGE:'.length);
            const thresholdKm = parseInt(thresholdStr, 10);

            if (isNaN(thresholdKm) || thresholdKm < 0) {
                ws.send('ERROR: Invalid threshold value for service mileage. Must be a non-negative number.');
                return true;
            }

            ws.send(`INFO: Setting service threshold to ${thresholdKm}km and then clearing current service counter...`);

            try {

                const setResult = await canbus.setDisplayServiceThreshold(thresholdKm);
                if (!setResult || !setResult.success) {
                    sendResult(`SetServiceThreshold (${thresholdKm}km)`, setResult || { success: false, error: "Failed to set threshold." });
                    return; // Stop if setting threshold fails
                }
                ws.send(`ACK: Service threshold set to ${thresholdKm}km.`);
                
				await new Promise(resolve => setTimeout(resolve, 200)); 

                // Step 2: Clear the current service counter
                const cleanResult = await canbus.cleanDisplayServiceMileage();
                sendResult('CleanServiceMileage', cleanResult);

            } catch (e) {
                console.error('Error during set/clear service mileage:', e);
                ws.send(`ERROR: Operation failed: ${e.message}`);
            }
			return true;
		}

		return false;
	}

	async function handleStartupAngleCommands(ws, messageString, sendResult) {
		if (messageString === 'READ_STARTUP_ANGLE') {
			const targetId = DeviceNetworkId.DRIVE_UNIT;
			const cmdInfo = CanReadCommandsList.ControllerStartupAngle;
			if (!cmdInfo) { ws.send(`ERROR: Startup Angle read command not defined.`); }
			else {
				ws.send(`INFO: Initiating Read Startup Angle from Controller...`);
				const result = await canbus.readParameter(targetId, cmdInfo, [0x00]);
				sendResult(`Read Startup Angle`, result);
			}
			return true;
		}
		if (messageString.startsWith('WRITE_STARTUP_ANGLE:')) {
			const valueStr = messageString.substring('WRITE_STARTUP_ANGLE:'.length);
			const angle = parseInt(valueStr, 10);
			if (!isNaN(angle)) {
				ws.send(`INFO: Initiating Write Startup Angle (${angle}) to Controller (No ACK Tracked by UI)...`);
				await canbus.saveControllerStartupAngle(angle); ws.send(`INFO: Startup Angle write command sent.`);
			} else { ws.send(`ERROR: Invalid angle value for WRITE_STARTUP_ANGLE: ${valueStr}`); }
			return true;
		}
		return false;
	}

	async function handleRawCanFrame(ws, messageString) {
		if (!messageString.includes('#')) return false; // Not a raw frame command if no '#'

		const parts = messageString.split('#');
		const idHex = parts[0]; const dataHex = parts[1] || "";
		if (!/^[0-9a-fA-F]+$/.test(idHex) || (dataHex && !/^[0-9a-fA-F]*$/.test(dataHex)) || dataHex.length % 2 !== 0 || dataHex.length > 16) {
			ws.send(`ERROR: Invalid raw frame format or data: ${messageString}`);
		} else {
			const success = await canbus.sendRawFrame(idHex, dataHex);
			ws.send(success ? `INFO: Sent Raw: ${messageString}` : `ERROR: Failed to send raw frame ${messageString}`);
		}
		return true;
	}

	async function handleStartFwUpload(ws, messageString) {
		if (messageString.startsWith('FW_UPDATE_START:')) {
			const messageParts = messageString.split(':');
			const modePart = messageParts[1];
			const delayPart = messageParts[2];
			const base64Content = messageParts[3];
			const buffer = Buffer.from(base64Content, 'base64');

			// Refuse before a single byte goes out. Previously the flash started
			// regardless, wrote into a dead link and failed 15 s later with a timeout
			// that said nothing about the real cause.
			if (!canbus.isConnected()) {
				const reason = 'the CANable adapter is not connected';
				ws.send(`FW_UPDATE_LOG:[ERROR] Firmware update aborted: ${reason}.`);
				ws.send(`FW_UPDATE_END:FAILED:${reason}`);
				return true;
			}
			const alive = await canbus.checkAlive({ force: true });
			if (!alive.ok) {
				const reason = alive.reason || 'the adapter did not respond';
				ws.send(`FW_UPDATE_LOG:[ERROR] Firmware update aborted: ${reason}. Reconnect the adapter and try again. This checks the USB adapter only — it cannot tell whether the bike is switched on.`);
				ws.send(`FW_UPDATE_END:FAILED:${reason}`);
				return true;
			}

			const fwUpdater = new FwUpdater(canbus,ws);
			fwUpdater.delayUs = parseInt(delayPart) || 300;
			// Awaited so the flag covers the whole flash: liveness probing and auto-recovery
			// both stand down while it is set, and a flash is too delay-sensitive to have the
			// handle pulled out from under it. startUpdateProcedure swallows its own errors.
			fwUpdateInProgress = true;
			try {
				await fwUpdater.startUpdateProcedure(buffer,modePart);
			} finally {
				fwUpdateInProgress = false;
			}
			return true
		}
		return false;
	}

	let rideLogger;
	async function handleStartRideLogger(ws,messageString) {
		if (messageString.startsWith('RIDE_LOGGER_START')) {
			const messageParts = messageString.split(':');
			const logToFileEnabled = messageParts[1] === 'true'
			const liveDashboardEnabled = messageParts[2] === 'true'
			const intervalTime = parseInt(messageParts[3])
			if (isNaN(intervalTime) || intervalTime < 50 || (!logToFileEnabled && !liveDashboardEnabled)) {
				ws.send('ERROR: Invalid RIDE_LOGGER_START parameters.');
				return true;
			}
			rideLogger = new RideLogger(canbus,liveDashboardEnabled ? ws: null);
			rideLogger.intervalTime = intervalTime;
			if(logToFileEnabled){
				await rideLogger.setupLogger()
				await rideLogger.setupHeader()
			}
			rideLogger.startLogging()
			return true
		}
		return false;
	}
	async function handleStopRideLogger(messageString) {
		if (messageString.startsWith('RIDE_LOGGER_STOP') && rideLogger) {
			rideLogger.cleanup()
			rideLogger = null;
			return true
		}
		return false;
	}

	let sniffer;
	async function handleStartSniffer(ws,messageString) {
		if (messageString.startsWith('SNIFFER_START')) {
			const messageParts = messageString.split(':');
			const loggerEnabled = messageParts[1] === 'true'
			const filteredIds = messageParts[2].split(';');
			sniffer = new Sniffer(canbus,ws);
			if(loggerEnabled)
				await sniffer.setupLogger()
			if(filteredIds.length)
				sniffer.filteredIds = new Set(filteredIds)
			return true
		}
		return false;
	}
	async function handleStopSniffer(messageString) {
		if (messageString.startsWith('SNIFFER_STOP') && sniffer) {
			sniffer.cleanup()
			sniffer = null;
			return true
		}
		return false;
	}
	async function handleFilteredIdSniffer(messageString) {
		if (messageString.startsWith('SNIFFER_FILTEREDIDS_SET') && sniffer) {
			const messageParts = messageString.split(':');
			const filteredIds = messageParts[1].split(';');
			if(filteredIds.length)
				sniffer.filteredIds = new Set(filteredIds)
			return true
		}
		return false;
	}
	async function handleLogEnabledSniffer(messageString) {
		if (messageString.startsWith('SNIFFER_LOG_ENABLE') && sniffer) {
			const messageParts = messageString.split(':');
			const loggerEnabled = messageParts[1] === 'true'
			if(loggerEnabled)
				await sniffer.setupLogger()
			else
				sniffer.logToFile = null
			return true
		}
		return false;
	}

	async function handleBackupRestoreCommand(messageString) {
		if (!messageString.startsWith('RESTORE_BACKUP:')) return false;
		const allDataJson = messageString.substring('RESTORE_BACKUP:'.length);
		try {
			const allData = JSON.parse(allDataJson);
			if (allData && typeof allData === 'object') {
				for (const paramData of Object.values(allData)) {
					broadcastToClients(`BAFANG_DATA: ${JSON.stringify(paramData)}`);
					await new Promise(resolve => setTimeout(resolve, 200));
				}
			}
		} catch (e) {
			console.error('Error parsing RESTORE_BACKUP JSON:', e);
		}
		return true;
	}


	wss.on('connection', async (ws) => {
		clients.push(ws);
		console.log('New WebSocket client connected');
		if (!isCheckingPresence) { await checkCanDevicePresenceAndUpdateGlobal(); }
		else { await new Promise(resolve => setTimeout(resolve, 200)); }
		broadcastCanDeviceStatus();

		ws.on('message', async (message) => {
			const messageString = message.toString();
			console.log('Received from UI:', messageString);

			const sendRawWriteStatus = (paramType, success, errorMsg = null) => {
				if (success) {
					ws.send(`ACK: Raw ${paramType} write sequence initiated.`);
				} else {
					ws.send(`NACK: Raw ${paramType} write failed. ${errorMsg || ''}`);
				}
			};
		
			// Helper to send promise results back to UI
			const sendResult = (commandName, promiseResult) => {
				if (!promiseResult) { // Handle cases where the promise might not be returned (e.g., disconnected)
					ws.send(`ERROR: Failed to execute ${commandName}.`);
					return;
				}
				if (promiseResult.success) {
					ws.send(`ACK: ${commandName} successful.`);
				} else {
					ws.send(`NACK: ${commandName} failed. Reason: ${promiseResult.error}${promiseResult.timedOut ? ' (Timeout)' : ''}`);
				}
			};


			try {
				let handled = false;
				if (!handled) handled = await handleConnectionCommands(ws, messageString);
				if (!handled) handled = await handleReadCommands(ws, messageString, sendResult);
				if (!handled) handled = await handleBankCommands(ws, messageString);
				if (!handled) handled = await handleReadRawCommand(ws, messageString, sendResult);
				if (!handled) handled = await handleWriteShortCommands(ws, messageString, sendResult);
				if (!handled) handled = await handleWriteShortRawCommand(ws, messageString, sendResult);
				if (!handled) handled = await handleWriteLongRawParams(ws, messageString, sendRawWriteStatus); // Check RAW before parsed P
				if (!handled) handled = await handleWriteLongRawCustomParams(ws, messageString, sendRawWriteStatus);
				if (!handled) handled = await handleWriteLongParsedParams(ws, messageString);
				if (!handled) handled = await handleWriteLongSpeedParams(ws, messageString);
				if (!handled) handled = await handleWriteLongStringParams(ws, messageString);
				if (!handled) handled = await handleDisplaySpecificWrites(ws, messageString, sendResult);
				if (!handled) handled = await handleStartupAngleCommands(ws, messageString, sendResult);
				if (!handled) handled = await handleRawCanFrame(ws, messageString);
				if (!handled) handled = await handleStartFwUpload(ws, messageString);
				if (!handled) handled = await handleStartSniffer(ws, messageString);
				if (!handled) handled = await handleStopSniffer(messageString);
				if (!handled) handled = await handleFilteredIdSniffer(messageString);
				if (!handled) handled = await handleLogEnabledSniffer(messageString);
				if (!handled) handled = await handleStartRideLogger(ws, messageString);
				if (!handled) handled = await handleStopRideLogger(messageString);
				if (!handled) handled = await handleBackupRestoreCommand(messageString);

				if (!handled) {
					console.warn("Unknown command received from UI (unhandled):", messageString);
					ws.send(`Error: Unknown command format or unhandled: "${messageString}"`);
				}
			} catch (err) {
				console.error('Error processing UI message:', err);
				ws.send(`Error: ${err.message}`);
				await checkCanDevicePresenceAndUpdateGlobal();
				broadcastCanDeviceStatus();
			}
		});


    ws.on('close', () => {
        clients = clients.filter(client => client !== ws);
        console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients = clients.filter(client => client !== ws);
    });
});

	// --- CAN Bus Event Handling ---
	canbus.on('bafang_data_received', (parsedEvent) => {
	   try {
			// --- CONVERT BigInt to String before stringifying ---
			let eventToSend = { ...parsedEvent }; // Create a shallow copy to modify

			if (typeof eventToSend.timestamp_us === 'bigint') {
				eventToSend.timestamp_us = eventToSend.timestamp_us.toString(); // Convert BigInt to String
			}
			const jsonString = JSON.stringify(eventToSend);

			// --- Define types to skip for CONSOLE logging ---
			const typesToSkipInConsoleLog = [
				'display_realtime',
				'controller_realtime_0',
				'controller_state',
				'controller_realtime_1',
				'display_data_1',
				'display_data_2',
				'display_data_lightsensor',
				'controller_speed_params',
				'controller_current_assist_level',
				'controller_calories',
				'display_autoshutdown_time',
				'sensor_realtime',
				'battery_state',
				'battery_capacity',
				'sensor',
				'battery',
				'display',
				'controller'
				// Add any other types you want to omit from the console here
			];

			// --- Only log to console if the type is NOT in the skip list ---
			if (!typesToSkipInConsoleLog.includes(parsedEvent.type) && !parsedEvent.type.startsWith('unknown_source_0x')) {
				console.log("Broadcasting Parsed Data:", jsonString); // Log other types
			}
			  broadcastToClients(`BAFANG_DATA: ${jsonString}`);
		} catch (stringifyError) {
			console.error("Error stringifying parsed CAN data:", stringifyError, parsedEvent);
		}
	});

	// CB-010: the link died without the device leaving the bus. canbus.js emits this;
	// until now nothing listened, so the error never reached the browser at all.
	canbus.on('can_error', (message) => {
		broadcastToClients(`CAN_ERROR: ${message}`);
		attemptAutoRecovery(message);
	});

	// Close the stale handle and try to open the adapter again. Success puts the UI back
	// to green with no user action; exhausting the attempts leaves it red with the reason.
	async function attemptAutoRecovery(reason) {
		if (autoConnectInProgress || recoveryState === 'recovering' || manualDisconnect) return;
		if (fwUpdateInProgress) {
			// Never yank the handle out from under a running flash — the updater has its
			// own abort path, which fails cleanly. Show the loss and wait for it to finish.
			recoveryState = 'failed';
			recoveryReason = reason;
			broadcastCanDeviceStatus();
			return;
		}

		autoConnectInProgress = true;
		recoveryState = 'recovering';
		recoveryReason = reason;
		broadcastCanDeviceStatus(); // amber immediately, before any slow USB work

		let recovered = false;
		try {
			// Raced, because closing a handle whose device stopped answering can block
			// inside libusb — and this path exists to make the app responsive again.
			await withCanTimeout(canbus.close(), 'CAN close', 5000);
			await checkCanDevicePresenceAndUpdateGlobal();
			if (!detectedCanDeviceName) {
				recoveryReason = 'adapter is no longer present';
			} else {
				const started = await withCanTimeout(canbus.init(detectedCanDeviceName), 'CAN reconnect', 15000);
				// init() can "succeed" against a zombie: GSUsb.start() returns
				// "Stop in progress, retry scheduled" and schedules its own retry. Only a
				// passing probe proves we actually have a working adapter again.
				if (started === true) {
					const alive = await canbus.checkAlive({ force: true });
					if (alive.ok) recovered = true;
					else recoveryReason = alive.reason || 'adapter did not answer after reconnect';
				} else {
					recoveryReason = 'could not reopen the adapter';
				}
			}
		} catch (e) {
			recoveryReason = e.message || `${e}`;
		} finally {
			autoConnectInProgress = false;
		}

		if (recovered) {
			recoveryState = 'idle';
			recoveryAttempt = 0;
			probeMissCount = 0;
			console.log('Auto-recovery: adapter is back.');
		} else if (++recoveryAttempt < RECOVERY_BACKOFF_MS.length) {
			const wait = RECOVERY_BACKOFF_MS[recoveryAttempt - 1];
			console.warn(`Auto-recovery attempt ${recoveryAttempt} failed (${recoveryReason}); retrying in ${wait} ms.`);
			recoveryState = 'failed';
			// Scheduled AFTER clearing autoConnectInProgress above, or the retry would
			// trip its own guard on the first line and silently do nothing.
			recoveryTimer = setTimeout(() => { recoveryTimer = null; attemptAutoRecovery(reason); }, wait);
		} else {
			console.error(`Auto-recovery gave up after ${recoveryAttempt} attempts: ${recoveryReason}`);
			recoveryState = 'failed';
		}
		broadcastCanDeviceStatus();
	}

	function clearRecoveryState() {
		if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
		recoveryState = 'idle';
		recoveryReason = null;
		recoveryAttempt = 0;
		probeMissCount = 0;
	}

	canbus.on('can_status', async (isConnected, statusMessage) => { // Make async
		console.log("CAN Operational Status Update from canbus.js:", statusMessage, "- IsConnectedFlag:", isConnected);
		if (isConnected && canbus.getConnectedDeviceName()) {
			detectedCanDeviceName = canbus.getConnectedDeviceName();
		} else if (!isConnected) {
			// If disconnected, re-check presence to see if device is still there or gone
			await checkCanDevicePresenceAndUpdateGlobal();
		}
		// If still not set after an init attempt or disconnect, check again.
		// This ensures detectedCanDeviceName is as fresh as possible.
		if (!detectedCanDeviceName && !isConnected) {
			await checkCanDevicePresenceAndUpdateGlobal();
		}
		broadcastCanDeviceStatus();
	});

	// --- Broadcast Helper ---
	function broadcastToClients(message) {
		clients.forEach(client => {
			if (client.readyState === WebSocket.OPEN) {
				try { client.send(message); }
				catch (sendError) { console.error("Error sending to WebSocket client:", sendError); }
			}
		});
	}

	// Lightweight presence probe: enumerates the USB list only (no open()), so it
	// is safe to call even while canbus holds the device open (no BUSY errors).
	function isCanableInDeviceList() {
		try {
			return usb.getDeviceList().some(d =>
				d.deviceDescriptor.idVendor === CANABLE_VID &&
				d.deviceDescriptor.idProduct === CANABLE_PID);
		} catch (e) {
			console.warn('isCanableInDeviceList failed:', e.message);
			return false;
		}
	}

	let connectedMissCount = 0; // consecutive periodic checks where the connected device was absent

	// The device is still enumerated — but is the link to it actually working? This is the
	// question the USB-list check above cannot answer, and the one that matters after a
	// host resume, where the adapter is still listed and only the handle is dead.
	async function checkLinkLiveness(force = false) {
		// A flash is delay-sensitive and has its own liveness handling; recovery must not
		// reach in while one is running.
		if (fwUpdateInProgress || autoConnectInProgress || recoveryState === 'recovering') return;
		const now = Date.now();
		if (!force && now - lastProbeAt < PROBE_INTERVAL_MS) return;
		lastProbeAt = now;

		const alive = await canbus.checkAlive({ force });
		if (alive.ok) { probeMissCount = 0; return; }
		if (alive.soft) {
			// Two strikes before acting, matching the connectedMissCount convention above:
			// one failed transfer is not proof that the adapter is gone.
			if (++probeMissCount < 2) return;
			probeMissCount = 0;
			console.warn(`Periodic Check: adapter failed two liveness probes (${alive.reason}) — treating the link as dead.`);
			attemptAutoRecovery(alive.reason);
			return;
		}
		// A hard failure already went through _handleCanError, which emits can_error and
		// starts recovery. Nothing more to do here.
		probeMissCount = 0;
	}

	async function periodicCheck() { // Renamed and made async
		// A long gap between ticks means the process was suspended — the host slept.
		// That is the cheapest and most direct sleep/wake signal available, and it cuts
		// detection of a dead link down to this single tick.
		const sinceLastTick = Date.now() - lastTickAt;
		lastTickAt = Date.now();
		const wokeFromSleep = sinceLastTick > 10000;
		if (wokeFromSleep) console.log(`Periodic Check: ${Math.round(sinceLastTick / 1000)} s gap since the last tick — host likely slept; forcing a liveness probe.`);

		// While connected: watch for a physical unplug. The CAN handle stays
		// "started" on its own, so without this the UI keeps showing CONNECTED
		// with a dead handle (flash/read fail until a manual disconnect+reconnect).
		if (canbus.isConnected()) {
			if (isCanableInDeviceList()) {
				connectedMissCount = 0;
				await checkLinkLiveness(wokeFromSleep);
			} else if (++connectedMissCount >= 2) { // ~6s absent, guards against a transient enumeration glitch
				connectedMissCount = 0;
				console.warn('Periodic Check: connected CANable disappeared from USB — resetting connection.');
				manualDisconnect = false; // a physical unplug is not a manual disconnect; allow auto-connect on re-plug
				try { await canbus.close(); } catch (e) { console.warn('close() after unplug failed:', e.message); }
				detectedCanDeviceName = null;
				broadcastCanDeviceStatus();
			}
			return;
		}

		connectedMissCount = 0;
		const previousGlobalDeviceName = detectedCanDeviceName;
		await checkCanDevicePresenceAndUpdateGlobal(); // await this

		if (detectedCanDeviceName !== previousGlobalDeviceName) {
			console.log(`Periodic Check: Device presence changed: ${previousGlobalDeviceName || 'None'} -> ${detectedCanDeviceName || 'None'}`);
			// A removed device clears any manual-disconnect intent, so a fresh re-plug auto-connects again.
			if (!detectedCanDeviceName) manualDisconnect = false;
			broadcastCanDeviceStatus();
		}

		// Auto-connect: when a device is present and the user has not deliberately
		// disconnected, bring the connection up on its own.
		// Recovery owns the reconnect while it is running or waiting out its backoff —
		// two paths calling init() at once would fight over the same handle.
		if (recoveryTimer || recoveryState === 'recovering') return;
		if (detectedCanDeviceName && !manualDisconnect && !canbus.isConnected() && !autoConnectInProgress) {
			autoConnectInProgress = true;
			try {
				console.log(`Auto-connect: CANable found (${detectedCanDeviceName}) — connecting.`);
				broadcastToClients(`CAN_DEVICE_STATUS:CONNECTING:${detectedCanDeviceName}`);
				await canbus.init(detectedCanDeviceName);
			} catch (e) {
				console.warn('Auto-connect failed:', e.message);
			} finally {
				autoConnectInProgress = false;
			}
		}
	}

	// Immediate reaction to physical plug/unplug via USB hotplug events. This is
	// the primary signal (handles a fast unplug+replug that the periodic list
	// check could miss); the periodic check remains as a fallback.
	function setupUsbHotplug() {
		const events = usb.usb; // node-usb v2 exposes the hotplug EventEmitter here
		if (!events || typeof events.on !== 'function') {
			console.warn('USB hotplug API not available; relying on periodic polling.');
			return;
		}
		const matches = (device) => {
			try {
				return device && device.deviceDescriptor &&
					device.deviceDescriptor.idVendor === CANABLE_VID &&
					device.deviceDescriptor.idProduct === CANABLE_PID;
			} catch (e) { return false; }
		};
		try {
			events.on('detach', async (device) => {
				if (!matches(device)) return;
				console.warn('USB hotplug: CANable detached.');
				manualDisconnect = false; // a physical unplug is not a manual disconnect
				connectedMissCount = 0;
				// A real unplug is not something recovery can fix, and a re-plug is a clean
				// slate — drop any pending retry so it cannot fire against the new handle.
				clearRecoveryState();
				if (canbus.isConnected()) {
					try { await canbus.close(); } catch (e) { console.warn('close() on detach failed:', e.message); }
				}
				detectedCanDeviceName = null;
				broadcastCanDeviceStatus();
			});
			events.on('attach', (device) => {
				if (!matches(device)) return;
				console.log('USB hotplug: CANable attached.');
				clearRecoveryState(); // fresh device, fresh attempt budget
				// Let the OS finish enumerating, then probe + (auto)connect.
				setTimeout(() => { periodicCheck().catch((e) => console.warn('post-attach check failed:', e.message)); }, 400);
			});
			console.log('USB hotplug monitoring enabled.');
		} catch (e) {
			console.warn('Failed to enable USB hotplug monitoring:', e.message);
		}
	}

	function startPeriodicCanDeviceCheck() {
		if (canDevicePresenceInterval) clearInterval(canDevicePresenceInterval);
		canDevicePresenceInterval = setInterval(periodicCheck, 3000); // Call the async wrapper
	}


	// --- Cleanup ---
	async function cleanup() {
		console.log('Shutting down...');
		if (canDevicePresenceInterval) clearInterval(canDevicePresenceInterval);
		wss.close(() => console.log('WebSocket server closed.'));
		clients.forEach(client => client.terminate());
		await canbus.close();
		server.close(() => {
			console.log('HTTP server closed.');
			process.exit(0);
		});
		setTimeout(() => {
			console.error('Graceful shutdown timed out. Forcing exit.');
			process.exit(1);
		}, 5000);
	}
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);

	// --- Start Server ---
	server.listen(8080, async () => { // Make async
		console.log('HTTP+WS server running on http://localhost:8080');
		await checkCanDevicePresenceAndUpdateGlobal(); // await initial check
		setupUsbHotplug();
		startPeriodicCanDeviceCheck();
		console.log(`Initial CAN device state: ${detectedCanDeviceName ? 'Found (' + detectedCanDeviceName + ')' : 'Not Found'}`);
		const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
		if(detectedCanDeviceName)
			require('child_process').exec(start + ' ' + 'http://localhost:8080');
	});

	// Without this, launching a second copy — double-clicking the .exe again, the usual
	// way to "restart" it — crashed with an unhandled EADDRINUSE and a stack trace. The
	// server that is already running is the one the user wants, so point them at it.
	//
	// Registered on BOTH emitters: ws re-emits the HTTP server's error on the
	// WebSocketServer, so handling it only on `server` still ended in an unhandled
	// 'error' event and the same crash.
	server.on('error', handleFatalServerError);
	wss.on('error', handleFatalServerError);

	let fatalHandled = false;
	function handleFatalServerError(err) {
		if (fatalHandled) return; // both emitters fire for the same failure
		fatalHandled = true;
		if (err.code === 'EADDRINUSE') {
			console.error('Port 8080 is already in use — this app is most likely already running.');
			console.error('Opening http://localhost:8080; close the other copy first if you meant to restart.');
			const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
			require('child_process').exec(start + ' ' + 'http://localhost:8080');
		} else {
			console.error('Server error:', err.message);
		}
		process.exit(1);
	}


	process.on('unhandledRejection', (reason, promise) => {
	  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
	});
