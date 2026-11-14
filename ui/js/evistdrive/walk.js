// evistdrive/walk.js — eVistDrive Walk card summary: the Walk chainring speed from the active bank.
// (The editable Walk fields live in legacy-params.js; they are written through the bank blob.)
import { state } from '../shared.js';
import { displayNumber, setText } from './common.js';

export function updateWalkAndLegacy() {
    const walkBankIndex = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank ?? 0;
    const walkBank = state.banksSynced ? state.lastBanks?.[walkBankIndex] : null;
    setText('ebicsWalkSpeed', displayNumber(walkBank?.wa_target_rpm, 0));
}
