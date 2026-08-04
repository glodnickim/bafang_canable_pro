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

export function bindLimitsControls() {
    el('ebicsSocFullSaveButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        const volts = parseFloat(el('ebicsSocFullInput')?.value);
        if (!(volts >= 20 && volts <= 90)) { alert('Enter the measured full-charge pack voltage in the range 20–90 V.'); return; }
        const pack10mv = Math.round(volts * 100); // V -> units of 10 mV
        socket.send(`SET_SOC_FULL:${pack10mv}`);
        addLog('REQ', `Full-charge voltage -> ${volts.toFixed(1)} V (saves at standstill)`);
    });
}
