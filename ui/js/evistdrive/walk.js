// evistdrive/walk.js — eVistDrive Walk card summary + the legacy-parameter cross-reference table
//
// The editable Walk fields live in compat.js (they are written through the bank blob).
// This module shows what the controller currently has, and the table below it maps each
// legacy CAN block to the factory tab that still owns it.
import { state } from '../shared.js';
import { el, isNumber, displayNumber, setText } from './common.js';

export function updateWalkAndLegacy() {
    const p0 = state.controllerParams0;
    const p1 = state.controllerParams1;
    const p2 = state.controllerParams2;
    const walkBankIndex = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank ?? 0;
    const walkBank = state.banksSynced ? state.lastBanks?.[walkBankIndex] : null;
    setText('ebicsWalkSpeed', displayNumber(walkBank?.wa_target_rpm, 0));
    const rows = [
        ['0x6010', 'Acceleration table entries', p0?.acceleration_levels?.length ?? 'N/A'],
        ['0x6010', 'Assist-ratio table entries', p0?.assist_ratio_levels?.length ?? 'N/A'],
        ['0x6011', 'System voltage', isNumber(p1?.system_voltage) ? `${p1.system_voltage} V` : 'N/A'],
        ['0x6011', 'Battery current limit', isNumber(p1?.current_limit) ? `${p1.current_limit} A` : 'N/A'],
        ['0x6011', 'Stored low-charge current byte', isNumber(p1?.max_current_on_low_charge) ? `${p1.max_current_on_low_charge} A` : 'N/A'],
        // CB-026 / FW-130: Walk motor current is listed again. CB-019 had hidden it because no
        // firmware code read the byte; FW-130 wired it into the Walk Assist current ceiling.
        ['0x6020', 'Walk motor current', isNumber(walkBank?.wa_current_pct) ? `${walkBank.wa_current_pct.toFixed(0)} %` : 'N/A'],
        ['0x6020', 'Walk chainring speed', isNumber(walkBank?.wa_target_rpm) ? `${walkBank.wa_target_rpm.toFixed(0)} RPM` : 'N/A'],
        ['0x6012', 'Torque profile rows', p2?.torque_profiles?.length ?? 'N/A'],
    ];
    const body = el('ebicsLegacyTableBody');
    if (!body) return;
    body.innerHTML = '';
    rows.forEach((values) => {
        const row = body.insertRow();
        values.forEach((value) => { row.insertCell().textContent = value; });
        row.insertCell().textContent = 'Use original Controller / Assist tabs';
    });
}
