// bafang-parser.js
"use strict";
const { CanOperation, DeviceNetworkId } = require('./bafang-constants'); // Use constants

// --- Constants ---
const CAN_CHANNEL_PREFIX = 0x80; // Assuming 0x80 prefix for the channel/interface

function charsToString(char_arr) {
    // Filter out null bytes which can terminate strings early
    const filtered_arr = char_arr.filter(c => c !== 0);
    return String.fromCharCode.apply(null, filtered_arr);
}

// Note: Real checksum calculation might be needed for validation if provided parsers use it
function calculateChecksum(bytes) {
    let summ = 0;
    bytes.forEach((item) => {
        summ += item;
    });
    return summ & 255;
}

class BafangCanBatteryParser {
    static cells(packet, cells_arr) {
        if (!packet || !Array.isArray(packet.data) || !Array.isArray(cells_arr)) return;
        for (let i = 0; i < packet.data.length / 2; i++) {
            // Ensure indices are valid before accessing
            if ((packet.canCommandSubCode - 2) * 4 + i < cells_arr.length &&
                i * 2 + 1 < packet.data.length) {
                cells_arr[(packet.canCommandSubCode - 2) * 4 + i] =
                    ((packet.data[i * 2 + 1] << 8) + packet.data[i * 2]) / 1000;
            }
        }
    }

    static capacity(packet) {
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 7) {
             return { full_capacity: null, capacity_left: null, rsoc: null, asoc: null, soh: null, parseError: true };
        }
        return {
            full_capacity: (packet.data[1] << 8) + packet.data[0],
            capacity_left: (packet.data[3] << 8) + packet.data[2],
            rsoc: packet.data[4],
            asoc: packet.data[5],
            soh: packet.data[6],
        };
    }

    static state(packet) {
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 5) {
             return { current: null, voltage: null, temperature: null, parseError: true };
        }
        let tmp = (packet.data[1] << 8) + packet.data[0];
        // Handle signed int16 conversion (Two's complement)
        const isNegative = (tmp & 0x8000) > 0;
        if (isNegative) {
             // Calculate the negative value using two's complement logic
             tmp = -((~tmp + 1) & 0xFFFF); // Invert bits, add 1, mask to 16 bits, then negate
        }
        // Original logic for negative values (might be incorrect for standard two's complement)
        // if ((tmp & 32768) > 0) {
        //     tmp = -(65536 - tmp); // Corrected negation
        // }
        return {
            current: tmp / 100,
            voltage: ((packet.data[3] << 8) + packet.data[2]) / 100,
            temperature: packet.data[4] - 40, // Assuming temp is unsigned offset
        };
    }

    static design(packet) {
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 4) {
             return { total_cells_in_serie: null, total_series_parallel: null, capacity: null, parseError: true };
        }
        return {
            total_cells_in_serie: packet.data[0],
            total_series_parallel: packet.data[1],
            capacity: (packet.data[3] << 8) + packet.data[2],
        };
    }

    static chargingInfo(packet) {
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 6) {
             return { charge_cycles: null, max_uncharged_time: null, last_uncharged_time: null, parseError: true };
        }
        let daysAndHours = (hours=>Math.floor(hours/24) + "d " + Math.floor(hours%24) + "h");
        return {
            charge_cycles: (packet.data[1] << 8) + packet.data[0],
            max_uncharged_time: daysAndHours((packet.data[3] << 8) + packet.data[2]),
            last_uncharged_time: daysAndHours((packet.data[5] << 8) + packet.data[4]),
        };
    }
}

class BafangCanControllerParser {
    static package0(packet) { // Realtime 0
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 8) {
             return { remaining_capacity: null, single_trip: null, cadence: null, torque: null, remaining_distance: null, parseError: true };
        }
        const tmp = (packet.data[7] << 8) + packet.data[6];
        return {
            remaining_capacity: packet.data[0],
            single_trip: ((packet.data[2] << 8) + packet.data[1]) / 100,
            cadence: packet.data[3],
            torque: (packet.data[5] << 8) + packet.data[4],
            remaining_distance: tmp < 65535 ? tmp / 100 : null, // Handle max value as null
        };
    }

    static package1(packet) { // Realtime 1
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 8) {
             return { speed: null, current: null, voltage: null, temperature: null, motor_temperature: null, parseError: true };
        }
        return {
            speed: ((packet.data[1] << 8) + packet.data[0]) / 100,
            current: ((packet.data[3] << 8) + packet.data[2]) / 100,
            voltage: ((packet.data[5] << 8) + packet.data[4]) / 100,
            temperature: packet.data[6] === 0xFF ? null : packet.data[6] - 40, // Handle invalid temp
            motor_temperature: packet.data[7] === 0xFF ? null : packet.data[7] - 40, // Handle invalid temp
        };
    }

    static state(packet){
        if (!packet || !Array.isArray(packet.data)) {
             return { state_number: null };
        }
        return { state_number: packet.data[0] };
    }

	static parameter0(packet) {
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 64) {
             return { parseError: true, error: "Invalid data length for Parameter1" };
         }
	
		const pkg = {
			par0_value_offset_0: packet.data[0],
            acceleration_levels: [],
			assist_ratio_levels: [], 
			assist_ratio_upper_limit: null,			
			unknown_bytes: [], 
        };
		
		
		if (packet.data.length >= 63){
		pkg.unknown_bytes = packet.data.slice(30, 63);
		} else {
            console.warn("Insufficient data length for assist levels in Parameter0");
        }
		
		if (packet.data.length >= 10) { // Need up to byte 9
            for (let i = 0; i < 9; i++) {
                 // Check bounds for assist level data access
                 if (1 + i < packet.data.length && 9 + i < packet.data.length) {
                    pkg.acceleration_levels.push({
						acceleration_level: packet.data[1 + i],
                    });
                 } else {
                      console.warn("Insufficient data length for full assist levels in Parameter0");
                      break; // Stop processing assist levels if data is too short
                 }
            }
		} else {
        console.warn("[Parser] Insufficient data for general_acceleration_levels in Parameter0");
        }
		
        if (packet.data.length >= 28) { // Need up to byte 9 (for start_accel) + 18 (for assist_ratio) = byte 27
           for (let i = 0; i < 9; i++) {
                const lowByte = packet.data[10 + (i * 2)];
                const highByte = packet.data[10 + (i * 2) + 1];
                pkg.assist_ratio_levels.push({
                    assist_ratio_level: (highByte << 8) | lowByte,
                });
            }
        } else {
            console.warn("[Parser] Insufficient data for assist_ratio_levels in Parameter0");
        }
		
       if (packet.data.length >= 30) { // Need up to byte 29
            const lowByte = packet.data[28];
            const highByte = packet.data[29];
            pkg.assist_ratio_upper_limit = (highByte << 8) | lowByte;
        } else {
            console.warn("[Parser] Insufficient data for assist_ratio_upper_limit in Parameter0");
        }
		
		return pkg;
    }
	
    static parameter1(packet) {
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 64) {
             return { parseError: true, error: "Invalid data length for Parameter1" };
         }
        // Optional: Add checksum validation if needed
        // if (packet.data[63] !== calculateChecksum(packet.data.slice(0, 63))) {
        //     console.warn("Parameter1 checksum mismatch");
        //     return { parseError: true, error: "Checksum mismatch" };
        // }
        const pkg = {
            system_voltage: packet.data[0], // Assuming SystemVoltage type handled elsewhere
            current_limit: packet.data[1],
            overvoltage: packet.data[2],
            undervoltage: packet.data[5]+(packet.data[6]<<8),
            undervoltage_under_load: packet.data[3]+(packet.data[4]<<8),
            battery_recovery_voltage: packet.data[5],
			par1_value_offset_6: packet.data[6],
            battery_capacity: (packet.data[8] << 8) + packet.data[7],
            max_current_on_low_charge: packet.data[9],
			limp_mode_soc_limit: packet.data[10], 
			limp_mode_soc_limit_stage2: packet.data[11],
            full_capacity_range: packet.data[12],
            pedal_sensor_type: packet.data[13], // Assuming PedalSensorType enum handled elsewhere
            coaster_brake: packet.data[14] === 1,
            pedal_sensor_signals_per_rotation: packet.data[15],
            speed_sensor_channel_number: packet.data[16], // Assuming SpeedSensorChannelNumber type
			par1_value_offset_17: packet.data[17],
            motor_type: packet.data[18], // Assuming MotorType enum
            motor_pole_pair_number: packet.data[19],
            speedmeter_magnets_number: packet.data[20],
            temperature_sensor_type: packet.data[21], // Assuming TemperatureSensorType enum
            deceleration_ratio: ((packet.data[23] << 8) + packet.data[22]) / 100,
            motor_max_rotor_rpm: (packet.data[25] << 8) + packet.data[24],
            motor_d_axis_inductance: (packet.data[27] << 8) + packet.data[26],
            motor_q_axis_inductance: (packet.data[29] << 8) + packet.data[28],
            motor_phase_resistance: (packet.data[31] << 8) + packet.data[30],
            motor_reverse_potential_coefficient: (packet.data[33] << 8) + packet.data[32],
            throttle_start_voltage: packet.data[34] / 10,
            throttle_max_voltage: packet.data[35] / 10,
			speed_limit_enabled: packet.data[36],
            start_current: packet.data[37],
            current_loading_time: packet.data[38] / 10,
            current_shedding_time: packet.data[39] / 10,
            assist_levels: [],
            displayless_mode: packet.data[58] === 1,
            lamps_always_on: packet.data[59] === 1,
			// FW-043: Walk Assist target CHAINRING RPM, stored raw (was km/h x100 — see serializer).
			walk_assist_speed: (packet.data[61] << 8) + packet.data[60],
			par1_value_offset_62: packet.data[62],
            checksum_missmatch: packet.data[63] !== calculateChecksum(packet.data.slice(0, 63)),
        };
        // Ensure data length is sufficient before accessing assist levels
        if (packet.data.length >= 63) {
            for (let i = 0; i < 9; i++) {
                 // Check bounds for assist level data access
                 if (40 + i < packet.data.length && 49 + i < packet.data.length) {
                    pkg.assist_levels.push({
                        current_limit: packet.data[40 + i],
                        speed_limit: packet.data[49 + i],
                    });
                 } else {
                      console.warn("Insufficient data length for full assist levels in Parameter1");
                      break; // Stop processing assist levels if data is too short
                 }
            }
        } else {
             console.warn("Insufficient data length for assist levels in Parameter1");
        }
        return pkg;
    }

    static parameter2(packet) {
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 64) {
             return { parseError: true, error: "Invalid data length for Parameter2" };
         }
        // Optional: Add checksum validation if needed
        // if (packet.data[63] !== calculateChecksum(packet.data.slice(0, 63))) {
        //     console.warn("Parameter2 checksum mismatch");
        //     return { parseError: true, error: "Checksum mismatch" };
        // }
        const pkg = {
            torque_profiles: [],
			unknown_bytes_1: [],
			unknown_bytes_2: [],
            checksum_missmatch: packet.data[63] !== calculateChecksum(packet.data.slice(0, 63)),			
        };
		
		if (packet.data.length >= 62){
            pkg.unknown_bytes_1 = packet.data.slice(30, 36);
            pkg.unknown_bytes_2 = packet.data.slice(55, 63);
		} else {
            console.warn("Insufficient data length for assist levels in Parameter0");
        }
        // Ensure data length is sufficient before accessing torque profiles
        if (packet.data.length >= 54) { // Need up to index 48 + 5 = 53
             for (let i = 0; i <= 5; i++) {
                 // Check bounds for torque profile data access
                 if (48 + i < packet.data.length) {
                    pkg.torque_profiles.push({
                        start_torque_value: packet.data[0 + i],
                        max_torque_value: packet.data[6 + i],
                        return_torque_value: packet.data[12 + i],
                        min_current: packet.data[24 + i],
                        max_current: packet.data[18 + i],
                        torque_decay_time: packet.data[30 + i],
                        start_pulse: packet.data[36 + i],
                        current_decay_time: packet.data[42 + i],
                        stop_delay: packet.data[48 + i],
                    });
                 } else {
                     console.warn("Insufficient data length for full torque profiles in Parameter2");
                     break; // Stop processing profiles if data is too short
                 }
             }
			 pkg.acceleration_level = packet.data[54];
        } else {
             console.warn("Insufficient data length for torque profiles in Parameter2");
        }
        return pkg;
    }

    static parameter3(packet) { // Speed Parameters
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 6) {
             return { parseError: true, error: "Invalid data length for Speed Parameters" };
         }
        // Finding wheel diameter requires WheelDiameterTable - cannot do here without it
        // For now, just return the codes
        const wheelCode = [packet.data[2], packet.data[3]];
        return {
            speed_limit: ((packet.data[1] << 8) + packet.data[0]) / 100,
            wheel_diameter_code: wheelCode, // Return code instead of object
            circumference: (packet.data[5] << 8) + packet.data[4],
        };
    }
	
	    /**
     * Parses the Startup Angle data (Command 0x62, Sub 0xD9)
     * @param {object} packet - The parsed CAN frame object { data: number[] }
     * @returns {object} Object containing { startup_angle: number } or parse error.
     */
    static parameter4(packet) { // Startup Angle
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 2) { // Needs at least 2 bytes
             return { parseError: true, error: "Invalid data length for Startup Angle (0x62/0xD9)" };
         }
         const angleByte1 = packet.data[0]; // Low byte
         const angleByte2 = packet.data[1]; // High byte
         const angle = (angleByte2 * 256) + angleByte1; // Little Endian calculation

         return {
             startup_angle: angle,
         };
    }
	
	static parameter5(packet) { // Calories
         if (!packet || !Array.isArray(packet.data) || packet.data.length < 2) { // Needs at least 2 bytes
             return { parseError: true, error: "Invalid data length for calories" };
         }

		 return {
            calories: ((packet.data[1] << 8) + packet.data[0])
		 }

    }

    // FW-006: profile bank blob (0x6020) — 8B header + 5x35B level records + CRC16-CCITT
    static bankBlob(packet) {
        const LEVELS = 5;
        const d = packet?.data;
        if (!Array.isArray(d) || d.length < 185) {
            return { parseError: true, error: `Invalid bank blob length ${d?.length}` };
        }
        if (d[0] !== 0x45 || d[1] !== 0x42 || d[2] < 1 || d[2] > 6) {
            return { parseError: true, error: 'Bad bank blob magic/version' };
        }
        // FW-056: v4 has the same layout and length as v3; the version byte only
        // tells us the controller understands Power Curve (mode 6).
        // FW-057: v5 adds header byte 12 = cadence compensation on/off for this bank.
        // FW-068/069: v6 is the first version with a longer record. Byte 5 is the record
        // STRIDE — read it instead of assuming a constant, so this parser keeps working
        // the next time the record grows.
        const version = d[2];
        const RECORD = d[5] >= 35 ? d[5] : 35;
        const HEADER = version >= 5 ? 13 : (version >= 3 ? 12 : (version === 2 ? 10 : 8));
        const BLOB_LEN = HEADER + LEVELS * RECORD + 2;
        if (d.length < BLOB_LEN) {
            return { parseError: true, error: `Invalid v${version} bank blob length ${d.length}` };
        }
        let crc = 0xFFFF;
        const crcAt = HEADER + LEVELS * RECORD;
        for (let i = 0; i < crcAt; i++) {
            crc ^= d[i] << 8;
            for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
        }
        if (((d[crcAt + 1] << 8) | d[crcAt]) !== crc) {
            return { parseError: true, error: 'Bank blob CRC mismatch' };
        }
        const u16 = (o) => d[o] | (d[o + 1] << 8);
        const levels = [];
        for (let l = 0; l < LEVELS; l++) {
            const r = HEADER + l * RECORD;
            levels.push({
                mode_type: d[r],
                // FW-056: in Power Curve the support_ratio bytes carry the upper-half exponent.
                support_ratio_pct: d[r] === 6 ? 0 : u16(r + 1),
                curve_exponent_high_x10: d[r] === 6 && d[r + 1] >= 3 && d[r + 1] <= 25 ? d[r + 1] : 15,
                support_min_pct: u16(r + 3), support_max_pct: u16(r + 5),
                reference_power_w: u16(r + 7),
                // FW-056: record byte 9 is the shape byte — gamma in Power Curve
                // (mode 6), progression in Power Progressive (mode 2).
                progression_pct: d[r] === 6 ? 0 : d[r + 9],
                curve_exponent_x10: d[r] === 6 && d[r + 9] >= 3 && d[r + 9] <= 25 ? d[r + 9] : 15,
                emtb_parameter: d[r + 10], emtb_based_on_power: d[r + 11] !== 0,
                emtb_reference_voltage_mv: u16(r + 12), torque_assist_factor: d[r + 14],
                max_motor_power_w: u16(r + 15), max_iq_pct: d[r + 17],
                assist_without_rotation: d[r + 18] !== 0,
                without_rotation_threshold_mv: u16(r + 19),
                startup_boost_enabled: d[r + 21] !== 0, startup_boost_mode: d[r + 22],
                startup_boost_strength_pct: u16(r + 23), startup_boost_end_rpm: d[r + 25],
                smooth_start_enabled: d[r + 26] !== 0, smooth_start_ms: u16(r + 27),
                release_ms: u16(r + 29), power_rise_filter_ms: u16(r + 31),
                power_fall_filter_ms: u16(r + 33),
                // FW-068/069: only present from record length 46 on. Older controllers get the
                // firmware defaults so the card shows something meaningful either way.
                start_load_reduction_mv: RECORD >= 46 ? d[r + 35] : 0,
                start_rise_mv: RECORD >= 46 ? d[r + 36] : 0,
                start_rise_window_ms: RECORD >= 46 ? d[r + 37] * 10 : 400,
                iq_rise_slow_ms: RECORD >= 46 ? u16(r + 38) : 600,
                iq_rise_fast_ms: RECORD >= 46 ? u16(r + 40) : 300,
                iq_fall_slow_ms: RECORD >= 46 ? u16(r + 42) : 1000,
                iq_fall_fast_ms: RECORD >= 46 ? u16(r + 44) : 140,
            });
        }
        // FW-043: header byte 7 = this bank's Walk Assist cut-off wheel speed in 0.1 km/h units.
        // 0 = written by firmware/tooling from before the field existed -> show the default.
        const waCutoffRaw = d[7];
        return {
            bank_index: d[3],
            active_bank: d[6],
            bank_schema_version: version,
            wa_cutoff_kmh: waCutoffRaw >= 10 ? waCutoffRaw / 10 : 7,
            wa_current_pct: version >= 2 && d[8] >= 1 && d[8] <= 100 ? d[8] : 30,
            wa_target_rpm: version >= 2 && d[9] >= 20 && d[9] <= 60 ? d[9] : 50,
            wa_latch_after_release: version >= 3 && d[10] !== 0,
            wa_latch_timeout_s: version >= 3 && d[11] >= 1 && d[11] <= 120 ? d[11] : 30,
            cadence_comp_enabled: version >= 5 && d[12] !== 0, // FW-057, off on older firmware
            levels,
        };
    }

    // FW-010: global ride-feel tuning blob (0x6023) — 4B header + 5 u16 fields + CRC16-CCITT
    static tuningBlob(packet) {
        // v1 16 B (ramps only), v2 22 B (+latch), v3/v4/v5 24 B (+torque-run filter),
        // v6 32 B (+start steps, FW-068). All read.
        const d = packet?.data;
        if (!Array.isArray(d) || d.length < 16) {
            return { parseError: true, error: `Invalid tuning blob length ${d?.length}` };
        }
        if (d[0] !== 0x54 || d[1] !== 0x55 || d[2] < 1 || d[2] > 6) {
            return { parseError: true, error: 'Bad tuning blob magic/version' };
        }
        const version = d[2];
        // bytes before the 2-byte CRC / minimum total length, per version
        const bodyLen = version >= 6 ? 30 : (version >= 3 ? 22 : (version === 2 ? 20 : 14));
        const minLen = version >= 6 ? 32 : (version >= 3 ? 24 : (version === 2 ? 22 : 16));
        if (d.length < minLen) {
            return { parseError: true, error: `Invalid v${version} tuning blob length ${d.length}` };
        }
        let crc = 0xFFFF;
        for (let i = 0; i < bodyLen; i++) {
            crc ^= d[i] << 8;
            for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
        }
        if (((d[bodyLen + 1] << 8) | d[bodyLen]) !== crc) {
            return { parseError: true, error: 'Tuning blob CRC mismatch' };
        }
        const u16 = (o) => d[o] | (d[o + 1] << 8);
        const out = {
            // FW-068: the writer must never send a version the controller cannot parse —
            // an unknown version byte makes the firmware reject the whole blob, so the
            // serializer negotiates down to whatever the controller reported here.
            tuning_schema_version: version,
            iq_rise_slow_ms: u16(4), iq_rise_fast_ms: u16(6),
            iq_fall_slow_ms: u16(8), iq_fall_fast_ms: u16(10),
            startup_boost_cadence_step: u16(12),
        };
        if (version >= 2) {
            out.assist_run_deadband_mv = u16(14);
            out.assist_hold_ms = u16(16);
            out.assist_min_iq_pct = u16(18);
        } else {
            out.assist_run_deadband_mv = 5;
            out.assist_hold_ms = 1400;
            out.assist_min_iq_pct = 2;
        }
        // FW-033: torque-run filter; older controllers backfill the firmware default.
        out.assist_torque_run_filter_ms = version >= 3 ? u16(20) : 300;
        // FW-068: crank movement required before assist may start. 0 = written by tooling
        // that predates the field, so show the firmware default rather than "no condition".
        out.assist_start_steps = (version >= 6 && u16(22) >= 1) ? u16(22) : 4;
        return out;
    }

    // FW-015/017: ride-core diagnostics (0x6029) — v1 24 B (peak only) or v2 32 B
    // (peak + flags byte + current pas_idle_ms/pressure/iq_request/iq_setpoint), CRC16-CCITT.
    static rideDiagnostics(packet) {
        const d = packet?.data;
        if (!Array.isArray(d) || d.length < 24) {
            return { parseError: true, error: `Invalid diagnostics length ${d?.length}` };
        }
        if (d[0] !== 0x44 || d[1] !== 0x47 || (d[2] !== 1 && d[2] !== 2 && d[2] !== 3 && d[2] !== 4)) {
            return { parseError: true, error: 'Bad diagnostics magic/version' };
        }
        const version = d[2];
        // v1 24 B (peak), v2 32 B (+current), v3 37 B (+torque_run, measured i_q, batt-limit),
        // v4 47 B (FW-057: +cadence compensation, u_abs, pack voltage). CRC = last 2 B.
        const BODY = { 1: 22, 2: 30, 3: 35, 4: 45 };
        const bodyLen = BODY[version];
        const minLen = bodyLen + 2;
        if (d.length < minLen) {
            return { parseError: true, error: `Invalid v${version} diagnostics length ${d.length}` };
        }
        let crc = 0xFFFF;
        for (let i = 0; i < bodyLen; i++) { crc ^= d[i] << 8; for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF; }
        if (((d[bodyLen + 1] << 8) | d[bodyLen]) !== crc) {
            return { parseError: true, error: 'Diagnostics CRC mismatch' };
        }
        const u16 = (o) => d[o] | (d[o + 1] << 8);
        const i16 = (o) => { const v = u16(o); return v >= 32768 ? v - 65536 : v; };
        const out = {
            version,
            ride_engine: d[3],
            cadence_for_assist: d[4],           // peak
            without_rotation_active: (d[5] & 0x01) !== 0,
            torque_for_assist_mv: u16(6),       // peak
            human_power_w: u16(8),              // peak
            support_ratio_pct: u16(10),         // peak
            motor_power_w: u16(12),             // peak
            requested_battery_current_ma: u16(14),
            iq_request: i16(16),                // peak
            iq_setpoint: i16(18),               // peak
            speed_x100: u16(20),
            // v2+ current fields — null on v1 so the UI shows "unavailable", not 0
            pedaling_active: version >= 2 ? (d[5] & 0x02) !== 0 : null,
            // FW-061: these two were mislabelled. The firmware packs bit 2 = brake
            // active and bit 3 = torque sensor fault (CAN_Display.c 0x6029 flags),
            // never "pedal release" or "release latched".
            brake_active: version >= 2 ? (d[5] & 0x04) !== 0 : null,
            torque_fault: version >= 2 ? (d[5] & 0x08) !== 0 : null,
            backward_detected: version >= 2 ? (d[5] & 0x10) !== 0 : null,
            calibration_active: version >= 2 ? (d[5] & 0x20) !== 0 : null,
            comms_lost: version >= 2 ? (d[5] & 0x40) !== 0 : null,
            pwm_on: version >= 2 ? (d[5] & 0x80) !== 0 : null,
            pas_idle_ms: version >= 2 ? u16(22) : null,
            fast_pressure: version >= 2 ? u16(24) : null,     // raw (fast 35 ms)
            iq_request_now: version >= 2 ? i16(26) : null,    // effective
            iq_setpoint_now: version >= 2 ? i16(28) : null,
            // FW-033: RUN pressure (slow estimator), measured i_q, batt-limit — null on v1/v2
            run_pressure: version >= 3 ? u16(30) : null,
            measured_iq: version >= 3 ? i16(32) : null,
            battery_limiting: version >= 3 ? (d[34] & 0x01) !== 0 : null,
            // FW-057: cadence compensation — null on older firmware so the UI says
            // "unavailable" instead of implying the compensation ran and did nothing.
            cadence_comp_permille: version >= 4 ? u16(35) : null,   // peak, 1000 = none applied
            precomp_motor_power_w: version >= 4 ? u16(37) : null,   // peak, before compensation
            u_abs: version >= 4 ? u16(39) : null,                   // peak, saturates at the FOC ceiling
            pack_voltage_mv: version >= 4 ? u16(41) : null,
            cadence_now: version >= 4 ? d[43] : null,
            cadence_comp_enabled: version >= 4 ? (d[44] & 0x01) !== 0 : null,
        };
        return out;
    }

    // FW-014/018: system status (0x6028) — 8 B single frame: 'S','Y',ver, engine, pending, [full_lo, full_hi], crcLo
    // ver1: bytes 5..6 unused. ver2 (FW-018): bytes 5..6 = soc_full_pack_10mv (LE), 0 = not configured.
    static systemStatus(packet) {
        const d = packet?.data;
        if (!Array.isArray(d) || d.length < 8) {
            return { parseError: true, error: `Invalid system status length ${d?.length}` };
        }
        if (d[0] !== 0x53 || d[1] !== 0x59 || (d[2] !== 1 && d[2] !== 2)) {
            return { parseError: true, error: 'Bad system status magic/version' };
        }
        let c = 0xFFFF;
        for (let i = 0; i < 7; i++) { c ^= d[i] << 8; for (let b = 0; b < 8; b++) c = ((c & 0x8000) ? (c << 1) ^ 0x1021 : c << 1) & 0xFFFF; }
        if ((c & 0xFF) !== d[7]) {
            return { parseError: true, error: 'System status CRC mismatch' };
        }
        const out = {
            ride_engine: d[3],                                  // 0 Legacy, 1 ride core
            ride_engine_pending: d[4] === 0xFF ? null : d[4],   // null = none
        };
        if (d[2] >= 2) {                                        // FW-018: full-charge pack-voltage threshold
            const pack10mv = d[5] + (d[6] << 8);
            out.soc_full_pack_mv = pack10mv * 10;               // mV (0 = not configured)
            out.soc_full_pack_v = pack10mv ? pack10mv / 100 : null; // volts, null when unset
        } else {
            out.soc_full_pack_mv = null;                        // v1 firmware: field unavailable (not zero)
            out.soc_full_pack_v = null;
        }
        return out;
    }

    // FW-013: torque load telemetry + calibration status (0x6025) — 24 B, CRC16-CCITT
    // FW-013 v1 = 24 B. FW-061 v2 = 56 B: same first 22 bytes, then the coast
    // re-zero diagnostics, then CRC. Counters are cumulative since power-on.
    static COAST_RESULTS = ['NONE', 'APPLIED', 'NO_CHANGE', 'TOO_SHORT', 'UNSTABLE',
        'LOCKOUT', 'OUT_OF_REACQUIRE_RANGE', 'IMPLAUSIBLE_RAW'];

    static torqueTelemetry(packet) {
        const d = packet?.data;
        if (!Array.isArray(d) || d.length < 24) {
            return { parseError: true, error: `Invalid torque telemetry length ${d?.length}` };
        }
        if (d[0] !== 0x54 || d[1] !== 0x43 || (d[2] !== 1 && d[2] !== 2)) {
            return { parseError: true, error: 'Bad torque telemetry magic/version' };
        }
        const version = d[2];
        const BLOB_LEN = version >= 2 ? 56 : 24;
        if (d.length < BLOB_LEN) {
            return { parseError: true, error: `Invalid v${version} torque telemetry length ${d.length}` };
        }
        const bodyLen = BLOB_LEN - 2;
        let crc = 0xFFFF;
        for (let i = 0; i < bodyLen; i++) {
            crc ^= d[i] << 8;
            for (let b = 0; b < 8; b++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
        }
        if (((d[bodyLen + 1] << 8) | d[bodyLen]) !== crc) {
            return { parseError: true, error: 'Torque telemetry CRC mismatch' };
        }
        const u16 = (o) => d[o] | (d[o + 1] << 8);
        const i16 = (o) => { const v = u16(o); return v >= 32768 ? v - 65536 : v; };
        const out = {
            version,
            capabilities: d[3],
            load_centikg: u16(4),
            zero_effective_native: u16(6),
            delta_native: u16(8),
            span_native: u16(10),
            calibration_source: d[12], // 0 default, 1 user
            calibration_state: d[13],
            calibration_error: d[14],
            sensor_valid: d[15] !== 0,
            reference_centikg: u16(16),
            preview_span_native: u16(18),
            full_scale_native: u16(20),
        };
        if (version < 2) return out;
        return Object.assign(out, {
            raw_native: u16(22),
            coast_candidate_native: u16(24),
            coast_spread_mv: u16(26),
            coast_last_step_mv: i16(28),          // signed
            coast_lockout_s: d[30],
            coast_active: (d[31] & 0x01) !== 0,
            coast_was_moving: (d[31] & 0x02) !== 0,
            coast_candidate_stable: (d[31] & 0x04) !== 0,
            coast_last_result: BafangCanControllerParser.COAST_RESULTS[d[32]] ?? `UNKNOWN_${d[32]}`,
            coast_windows_started: u16(34),
            coast_windows_completed: u16(36),
            coast_applied: u16(38),
            coast_rejected_too_short: u16(40),
            coast_rejected_unstable: u16(42),
            coast_rejected_lockout: u16(44),
            coast_rejected_out_of_range: u16(46),
            coast_rejected_implausible: u16(48),
            coast_no_change: u16(50),
            offset_correction_mv: i16(52),
        });
    }
}

class BafangCanDisplayParser {
    static decodeCurrentAssistLevel(currentAssistLevelCode, totalAssistLevels) {
        // Simplified lookup, as original depends on specific table values
        const assistLevelMap = {
            // Example mappings, replace with actual values if known
			3:{0: 0, 12: 1, 2: 2, 3: 3, 6: 'walk'},
            5:{0: 0, 11: 1, 13: 2, 21: 3, 23: 4, 3: 5, 6: 'walk'},
            9:{0: 0, 1: 1, 11: 2, 12: 3, 13: 4, 2: 5, 21: 6, 22: 7, 23: 8, 3: 9, 6: 'walk'}
        };
        return assistLevelMap[totalAssistLevels][currentAssistLevelCode] !== undefined ? assistLevelMap[totalAssistLevels][currentAssistLevelCode] : 'unknown';
    }

    static errorCodes(data) {
        if (!Array.isArray(data)) return [];
        const errors = [];
        let errorString = charsToString(data);
        while (errorString.length >= 2) {
            // Use try-catch for robustness
            try {
                const code = parseInt(errorString.substring(0, 2), 10);
                if (!isNaN(code)) {
                    errors.push(code);
                }
            } catch (e) { /* ignore parsing errors */ }
            errorString = errorString.substring(2);
        }
        return errors;
    }

    static package0(packet) { // Realtime Data
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 3) {
             return { parseError: true, error: "Invalid data length for Display Realtime" };
        }
        const rideMode = (packet.data[0] & 0b10000) ? 'BOOST' : 'ECO'; // Simplified BafangCanRideMode
        return {
            assist_levels: packet.data[0] & 0b1111,
            ride_mode: rideMode,
            boost: (packet.data[0] & 0b100000) >> 5 === 1,
            current_assist_level: BafangCanDisplayParser.decodeCurrentAssistLevel(
                packet.data[1],
                packet.data[0] & 0b1111,
            ),
            light: (packet.data[2] & 1) === 1,
            button_up: (packet.data[2] & 0b10) >> 1 === 1,
            button_down: (packet.data[2] & 0b100000) >> 5 === 1,
        };
    }

    static package1(packet) { // Data Block 1 (Mileage/Speed)
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 8) {
             return { parseError: true, error: "Invalid data length for Display Data1" };
        }
        return {
            total_mileage: (packet.data[2] << 16) | (packet.data[1] << 8) | packet.data[0],
            single_mileage: (((packet.data[5] << 16) | (packet.data[4] << 8) | packet.data[3])) / 10,
            max_speed: ((packet.data[7] << 8) + packet.data[6]) / 10,
        };
    }

    static package2(packet) { // Data Block 2 (Avg Speed/Service)
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 5) {
             return { parseError: true, error: "Invalid data length for Display Data2" };
        }
        return {
            average_speed: ((packet.data[1] << 8) + packet.data[0]) / 10,
            service_mileage: (((packet.data[4] << 16) | (packet.data[3] << 8) | packet.data[2])) / 10,
        };
    }
	
	static package3(packet) { // display light levels
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 4) {
             return { parseError: true, error: "Invalid data length for Display Data1" };
        }
   
        return {
            light_sensor_level_numbers: packet.data[0],
            light_sensor_level: packet.data[1],
            backlight_level_numbers: packet.data[2],
            backlight_level: packet.data[3],
        };
    }

}

class BafangCanSensorParser {
    static package0(packet) { // Realtime Data
        if (!packet || !Array.isArray(packet.data) || packet.data.length < 3) {
             return { parseError: true, error: "Invalid data length for Sensor Realtime" };
        }
        return {
            torque: (packet.data[1] << 8) + packet.data[0],
            cadence: packet.data[2],
        };
    }
}

	/**
	 * Parses a Bafang-specific CanFrame (with 4-byte ID array) into a structured object.
	 * IMPORTANT: Assumes the input frame.id[0] might have the channel prefix, which needs stripping
	 *            for logical sourceDeviceCode identification.
	 * @param {object} frame - An object with `id` (number[4]) and `data` (number[]).
	 * @returns {object} ParsedCanFrame object.
	 */
	function parseCanFrame(frame) {
		if (!Array.isArray(frame.id) || frame.id.length !== 4 || !Array.isArray(frame.data)) {
			console.error("Invalid frame format passed to parseCanFrame:", frame);
			return { parseError: true };
		}
		// Strip the channel prefix from the source byte to get the logical Bafang ID
		const logicalSourceDeviceCode = frame.id[0] & 0x0F; // Mask to get lower 4 bits

		// Also strip prefix from target if needed? Usually target is just the Bafang ID.
		// Assuming target in byte 1 is already the logical Bafang ID.
		const logicalTargetDeviceCode = (frame.id[1] & 0b11111000) >> 3;

		return {
			canCommandCode: frame.id[2],
			canCommandSubCode: frame.id[3],
			canOperationCode: frame.id[1] & 0b111,
			sourceDeviceCode: logicalSourceDeviceCode, // Use the stripped logical ID
			targetDeviceCode: logicalTargetDeviceCode,
			data: frame.data,
			// Store original prefixed ID byte for potential debugging
			originalSourceByte: frame.id[0],
		};
	}


	function intToByteArray(integer, bytes) {
		const array = [];
		for (let i = 0; i < bytes; i++) {
			array.push(integer & 255);
			integer >>= 8;
		}
		// Bafang seems to use Little Endian for multi-byte values in data payloads
		return array; // Return in Little Endian order
	}

	/**
	 * Converts the Bafang 4-byte ID array to a 32-bit number (Big Endian) for sending.
	 */
	function bafangIdArrayTo32Bit(idArray) {
		if (!Array.isArray(idArray) || idArray.length !== 4) {
			throw new Error("Invalid Bafang ID array format for conversion.");
		}
		return (((idArray[0] << 24) | (idArray[1] << 16) | (idArray[2] << 8) | idArray[3]) >>> 0);
	}

	/**
	 * Generates the Bafang 4-byte CAN ID array, adding the channel prefix to the source byte.
	 * @param {DeviceNetworkId} source - The logical Bafang source ID (e.g., DeviceNetworkId.BESST).
	 * @param {DeviceNetworkId} target - The logical Bafang target ID.
	 * @param {CanOperation} canOperationCode
	 * @param {number} canCommandCode
	 * @param {number} canCommandSubCode
	 * @returns {number[]} The 4-byte array for ID construction.
	 */
	function generateCanFrameId(source, target, canOperationCode, canCommandCode, canCommandSubCode) {
		 // Add the prefix ONLY to the source byte when generating for sending
		 const prefixedSource = (source & 0x0F) | CAN_CHANNEL_PREFIX; // Mask source to 4 bits and add prefix
		 return [
			prefixedSource,
			((target & 0b11111) << 3) | (canOperationCode & 0b111),
			canCommandCode,
			canCommandSubCode,
		];
	}

// --- Export ---
module.exports = {
    CanOperation,
    DeviceNetworkId,
    charsToString,
    parseCanFrame,
    BafangCanBatteryParser,
    BafangCanControllerParser,
    BafangCanDisplayParser,
    BafangCanSensorParser,
    // Export Utilities needed by serializer
    intToByteArray,
    calculateChecksum,
    generateCanFrameId,
    bafangIdArrayTo32Bit,
	CAN_CHANNEL_PREFIX 
};
