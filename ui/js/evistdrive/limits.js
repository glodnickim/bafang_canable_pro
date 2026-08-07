// evistdrive/limits.js — eVistDrive Limits card
//
// The editable limit FIELDS (0x6011 and friends) are rendered by compat.js, which owns
// the legacy parameter blocks. This module owns the full-charge voltage control below them.
import { addLog, socket } from '../shared.js';
import { el, setText, socketReady } from './common.js';

// FW-018: full-charge pack-voltage threshold (100% anchor). It travels in the system
// status frame (0x6028) but belongs here — it is what the rider's 100% actually means.
export function updateSocFullUI(s) {
    if (!s) return;
    const v = s.soc_full_pack_v; // volts, or null when unset / unavailable (old firmware)
    setText('ebicsSocFullActive', v == null
        ? (s.soc_full_pack_mv === null ? 'Unavailable (older firmware)' : 'Not set')
        : `${v.toFixed(1)} V`);
    const input = el('ebicsSocFullInput');
    if (input && document.activeElement !== input && v != null) input.value = v.toFixed(1);
}

/*
 * CB-026: the full-charge threshold travels on its own command (SET_SOC_FULL), not inside any
 * of the parameter blocks, so the one save action has to send it separately.
 *
 * Only sent when the box holds a value the controller would accept. An empty or nonsense box
 * means "nothing to say about this setting" — never a reason to fail the whole save, and never
 * a reason to push a guess at what the rider's pack does at 100 %.
 *
 * Returns what it did, for the caller's one summary. Never talks to the user itself.
 */
export function writeSocFullThreshold() {
    const raw = el('ebicsSocFullInput')?.value;
    const volts = parseFloat(raw);
    if (!(volts >= 20 && volts <= 90)) return null;
    socket.send(`SET_SOC_FULL:${Math.round(volts * 100)}`); // V -> units of 10 mV
    addLog('REQ', `Full-charge voltage -> ${volts.toFixed(1)} V (the controller stores it at standstill)`);
    return `full-charge voltage ${volts.toFixed(1)} V`;
}

export function bindLimitsControls() {
    // CB-026: nothing here talks to the bike any more — the top bar owns reading and saving.
}
