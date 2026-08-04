// evistdrive/global-actions.js — the Read all / Save to Flash pair in the top bar.
//
// Saving to flash is ONE controller command (0x6022). Firmware serialises bank 1, bank 2
// and the ride-feel tuning and writes them together — there is no way to persist just one
// of them. Three cards each had their own "Save (Flash)" button sending that same global
// command, which read as "save this card" and was not. This is that command, once, where
// it can be seen from any tab.
//
// The legacy blocks (Limits, System) are not part of this: firmware writes those to
// permanent storage the moment they are received, so they need no save step at all.
// "Read all" does include reading them, though — the CB-024 fix below — because a value
// shown on screen before it was actually read is a placeholder wearing a real value's
// clothes, and every write button already checks for exactly that read.
import { state, socket, addLog, syncAllDeviceInfo } from '../shared.js';
import { el, socketReady, writeBankAndWait, writeTuningAndWait, saveToFlashAndWait } from './common.js';
import { syncAllCompatibilityData } from './legacy-params.js';

// Set when something reaches controller RAM, cleared once it has been made permanent.
// This is the honest definition: RAM contents differ from what survives a power cycle.
let unsavedInRam = false;

export function markUnsavedInRam() {
    unsavedInRam = true;
    refreshUnsavedBadge();
}

function refreshUnsavedBadge() {
    const badge = el('evdUnsavedBadge');
    if (badge) badge.style.display = unsavedInRam ? '' : 'none';
}

export function bindGlobalActions() {
    refreshUnsavedBadge();

    el('evdReadAllButton')?.addEventListener('click', async () => {
        if (!socketReady()) return;
        addLog('REQ', 'Reading everything from the controller...');
        socket.send('READ_BANK:0');
        await new Promise((resolve) => setTimeout(resolve, 400));
        socket.send('READ_BANK:1');
        await new Promise((resolve) => setTimeout(resolve, 400));
        socket.send('READ_TUNING');
        await new Promise((resolve) => setTimeout(resolve, 400));
        socket.send('READ_SYSTEM');
        await new Promise((resolve) => setTimeout(resolve, 200));
        socket.send('READ_TORQUE');
        // CB-024: this used to stop here. The legacy blocks (Limits/Walk/System — 0x6011
        // and friends) were never actually read by this button, only by each tab's own
        // "Read" — so switching tabs after "Read all" could show placeholders that looked
        // like real values. syncAllCompatibilityData paces its own reads (each waits for
        // the controller's answer before the next), so just await it here.
        await syncAllCompatibilityData();
        syncAllDeviceInfo();
    });

    el('evdSaveFlashButton')?.addEventListener('click', async () => {
        if (!socketReady()) return;

        const banksReady = !!(state.ebicsReceivedBanks?.[0] && state.ebicsReceivedBanks?.[1]);
        const tuningReady = !!state.tuningSynced;
        if (!banksReady && !tuningReady) {
            addLog('ERR', 'Nothing has been read from the controller yet — read first, so the values on screen are the bike\'s own and not placeholders.');
            return;
        }

        // Say plainly what is about to become permanent, and what is not included.
        const parts = [];
        if (banksReady) parts.push('both profile banks (levels and Walk Assist)');
        if (tuningReady) parts.push('the ride-feel tuning');
        const notIncluded = banksReady && tuningReady
            ? ''
            : `\n\nNOT included, because it has not been read in this session: ${banksReady ? 'the ride-feel tuning' : 'the profile banks'}. The controller keeps whatever it already holds for that.`;
        if (!confirm(`Make these permanent?\n\n${parts.map((p) => `• ${p}`).join('\n')}${notIncluded}\n\nThe controller performs the flash write at full standstill.`)) return;

        const button = el('evdSaveFlashButton');
        if (button) button.disabled = true;
        try {
            if (banksReady) {
                for (const index of [0, 1]) {
                    const written = await writeBankAndWait(state.lastBanks[index]);
                    if (!written.ok) {
                        addLog('ERR', `Bank ${index + 1} was not written (${written.reason}) — nothing has been made permanent.`);
                        return;
                    }
                    addLog('ACK', `Bank ${index + 1} written to controller RAM.`);
                }
            }
            if (tuningReady) {
                const written = await writeTuningAndWait(state.lastTuning);
                if (!written.ok) {
                    addLog('ERR', `Ride-feel tuning was not written (${written.reason}) — nothing has been made permanent.`);
                    return;
                }
                addLog('ACK', 'Ride-feel tuning written to controller RAM.');
            }
            const saved = await saveToFlashAndWait();
            if (!saved.ok) {
                addLog('ERR', `Everything is in RAM, but the flash write was refused (${saved.reason}). It will be lost at power-off.`);
                return;
            }
            unsavedInRam = false;
            refreshUnsavedBadge();
            addLog('SAVE_REQ', 'Accepted for flash — the controller writes it at full standstill. Stop the bike completely for a moment.');
        } finally {
            if (button) button.disabled = false;
        }
    });
}
