// evistdrive/global-actions.js — the only place in the eVistDrive UI that talks to the bike.
//
// CB-026. There used to be thirteen buttons for this across six cards: Read banks, Read global
// tuning, Read (Limits), Read (Walk), Read (System), Write selected bank (RAM), Write global
// (RAM), Write (permanent) twice, Save, and three Restores — plus Read all and Save to Flash
// in the top bar. Every one of the per-card reads was a subset of the top bar's read, and
// every per-card write was a subset of its save. The difference that actually mattered — which
// of them survives switching the bike off — was explained only in tooltips.
//
// There are now three, in one place:
//
//   Read from bike      everything: both banks, the ride-feel tuning, the legacy parameter
//                       blocks, the torque scale and the device identification.
//   Save…               opens the dialog below, where the temporary/permanent choice is made
//                       with the consequences written next to each option.
//   Undo changes        puts the screen back to what was read. Never touches the bike.
//
// WHAT THE TWO SAVE MODES REALLY ARE — this is hardware, not a UI preference:
//
//   Banks + tuning   WRITE_BANK / WRITE_TUNING land in controller RAM. They take effect at
//                    once and are lost at power-off until SAVE_BANKS (0x6022) commits them.
//                    SAVE_BANKS always covers both banks AND the tuning together; there is no
//                    partial flash write, which is why saving was never a per-card action.
//   Legacy blocks    the controller commits P1/speed to permanent storage the moment it
//                    receives them. They CANNOT be tried temporarily, so the temporary mode
//                    leaves them alone and the dialog says so rather than pretending.
import { state, socket, addLog, syncAllDeviceInfo } from '../shared.js';
import { el, socketReady, writeBankAndWait, writeTuningAndWait, saveToFlashAndWait } from './common.js';
import {
    syncAllCompatibilityData, writeLegacyBlocks, restoreLegacyDraft, LONG_WRITE_GAP_MS,
} from './legacy-params.js';
import { restoreProfilesFromRead, unsupportedModeInBank } from './profiles.js';
import { restoreTuningFromRead } from './dynamics.js';
import { writeSocFullThreshold } from './limits.js';

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

/* ── Reading ────────────────────────────────────────────────────────────────────────── */

async function readEverything() {
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
    // The legacy blocks (0x6011 and friends) pace their own reads — each waits for the
    // controller's answer before the next — so just await the lot.
    await syncAllCompatibilityData();
    syncAllDeviceInfo();
    addLog('DATA', 'Read finished. Everything on screen now comes from the bike.');
}

/* ── Writing ────────────────────────────────────────────────────────────────────────── */

// What is on screen and could be sent, and what cannot be because it was never read. Writing a
// block that was never read would push this app's placeholders onto the bike as if they were
// the rider's settings — the one mistake none of these buttons may ever make.
function writeScope() {
    const banks = [0, 1].filter((index) => state.ebicsReceivedBanks?.[index]);
    return {
        banks,
        tuning: !!state.tuningSynced,
        legacy: !!state.ebicsCompatibilityReceived?.p1,
    };
}

async function writeRideSettings(scope) {
    // FW-056: refuse BEFORE sending anything. A bank the controller cannot parse is rejected
    // whole, and it keeps the old settings without saying so.
    for (const index of scope.banks) {
        const blocked = unsupportedModeInBank(index);
        if (blocked) return { ok: false, reason: blocked };
    }
    for (const index of scope.banks) {
        const written = await writeBankAndWait(state.lastBanks[index]);
        if (!written.ok) return { ok: false, reason: `bank ${index + 1} was not written (${written.reason})` };
        addLog('ACK', `Bank ${index + 1} written to controller memory.`);
    }
    if (scope.tuning) {
        const written = await writeTuningAndWait(state.lastTuning);
        if (!written.ok) return { ok: false, reason: `the ride-feel tuning was not written (${written.reason})` };
        addLog('ACK', 'Ride-feel tuning written to controller memory.');
    }
    return { ok: true };
}

async function performSave(mode) {
    if (!socketReady()) return;
    const scope = writeScope();
    const button = el('evdSaveButton');
    if (button) button.disabled = true;
    try {
        if (mode === 'permanent') {
            if (scope.legacy) {
                const legacy = await writeLegacyBlocks();
                legacy.written.forEach((what) => addLog('ACK', `${what}: written permanently.`));
            }
            // Its own command, outside every parameter block — see limits.js.
            const soc = writeSocFullThreshold();
            if (soc) addLog('ACK', `${soc}: sent.`);
        }
        // The bank blobs are 255 bytes of multi-frame each, and the controller has ONE
        // multi-frame channel: anything still streaming when a bank starts makes it error-ACK
        // the bank and keep its old settings. This is the whole reason a single save action
        // needs pacing that six separate buttons never did.
        await new Promise((resolve) => setTimeout(resolve, LONG_WRITE_GAP_MS));
        const ride = await writeRideSettings(scope);
        if (!ride.ok) {
            addLog('ERR', `Stopped: ${ride.reason}. Nothing was made permanent.`);
            return;
        }
        if (mode === 'temporary') {
            markUnsavedInRam();
            addLog('SAVE_REQ', 'Sent for a test ride. These settings are active now and will be '
                + 'gone when you switch the bike off — save permanently to keep them.');
            return;
        }
        const saved = await saveToFlashAndWait();
        if (!saved.ok) {
            markUnsavedInRam();
            addLog('ERR', `Everything reached the controller, but making it permanent was refused (${saved.reason}). It will be lost at power-off.`);
            return;
        }
        unsavedInRam = false;
        refreshUnsavedBadge();
        addLog('SAVE_REQ', 'Accepted as permanent — the controller performs the flash write at '
            + 'full standstill. Stop the bike completely for a moment.');
    } finally {
        if (button) button.disabled = false;
    }
}

/* ── The save dialog ────────────────────────────────────────────────────────────────── */

function describeScope(scope, mode) {
    const included = [];
    const skipped = [];
    if (scope.banks.length === 2) included.push('both profile banks (assist levels and Walk Assist)');
    else if (scope.banks.length === 1) {
        included.push(`profile bank ${scope.banks[0] + 1} (assist levels and Walk Assist)`);
        skipped.push(`profile bank ${scope.banks[0] === 0 ? 2 : 1} — never read from this bike`);
    } else skipped.push('both profile banks — never read from this bike');
    if (scope.tuning) included.push('the whole-bike ride-feel tuning');
    else skipped.push('the whole-bike ride-feel tuning — never read from this bike');
    if (mode === 'permanent') {
        if (scope.legacy) included.push('limits, speed, motor and system settings');
        else skipped.push('limits, speed, motor and system settings — never read from this bike');
    } else {
        skipped.push('limits, speed, motor and system settings — the controller always stores '
            + 'these permanently, so they cannot be tried out');
    }
    return { included, skipped };
}

function buildScopeList(scope, mode) {
    const { included, skipped } = describeScope(scope, mode);
    const wrap = document.createElement('div');
    wrap.className = 'evd-save-scope';
    const add = (title, items, className) => {
        if (!items.length) return;
        const heading = document.createElement('div');
        heading.className = `evd-save-scope-title ${className}`;
        heading.textContent = title;
        wrap.appendChild(heading);
        const list = document.createElement('ul');
        items.forEach((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            list.appendChild(item);
        });
        wrap.appendChild(list);
    };
    add('Will be sent:', included, 'is-included');
    add('Not included:', skipped, 'is-skipped');
    if (!included.length) {
        const warn = document.createElement('div');
        warn.className = 'evd-save-scope-title is-skipped';
        warn.textContent = 'Nothing has been read from this bike yet, so there is nothing safe to send. Press "Read from bike" first.';
        wrap.appendChild(warn);
    }
    return wrap;
}

function closeSaveDialog() {
    el('evdSaveDialog')?.replaceChildren();
    const dialog = el('evdSaveDialog');
    if (dialog) dialog.style.display = 'none';
    document.removeEventListener('keydown', onDialogKey, true);
    document.removeEventListener('pointerdown', onDialogOutside, true);
}

function onDialogKey(event) {
    if (event.key === 'Escape') closeSaveDialog();
}

function onDialogOutside(event) {
    const dialog = el('evdSaveDialog');
    if (!dialog || dialog.style.display === 'none') return;
    if (dialog.contains(event.target) || el('evdSaveButton')?.contains(event.target)) return;
    closeSaveDialog();
}

/*
 * The whole point of the dialog: the choice between "try it" and "keep it" is made ONCE, here,
 * with what each one means written beside it — instead of being spread across two buttons whose
 * difference lived in a tooltip.
 */
function openSaveDialog() {
    const dialog = el('evdSaveDialog');
    if (!dialog) return;
    if (dialog.style.display !== 'none') { closeSaveDialog(); return; }

    const scope = writeScope();
    const anythingToSend = scope.banks.length > 0 || scope.tuning || scope.legacy;

    const heading = document.createElement('div');
    heading.className = 'evd-save-title';
    heading.textContent = 'Send the settings on screen to the bike';

    const options = document.createElement('div');
    options.className = 'evd-save-options';
    const OPTIONS = [
        {
            mode: 'temporary',
            title: 'Try it — this ride only',
            detail: 'Assist levels, Walk Assist and the ride-feel tuning take effect straight '
                + 'away, so you can ride and judge them. Switching the bike off brings the old '
                + 'settings back. Nothing is made permanent.',
        },
        {
            mode: 'permanent',
            title: 'Keep it — save permanently',
            detail: 'Everything above, plus limits, speed, motor and system settings, and the '
                + 'controller is told to commit it. It performs the flash write at full '
                + 'standstill, so stop the bike completely for a moment afterwards.',
        },
    ];
    let chosen = 'temporary';
    const scopeBox = document.createElement('div');
    const radios = [];
    OPTIONS.forEach((option) => {
        const label = document.createElement('label');
        label.className = 'evd-save-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'evdSaveMode';
        radio.value = option.mode;
        radio.checked = option.mode === chosen;
        radios.push(radio);
        const body = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'evd-save-option-title';
        title.textContent = option.title;
        const detail = document.createElement('div');
        detail.className = 'evd-save-option-detail';
        detail.textContent = option.detail;
        body.append(title, detail);
        label.append(radio, body);
        radio.addEventListener('change', () => {
            chosen = option.mode;
            scopeBox.replaceChildren(buildScopeList(scope, chosen));
        });
        options.appendChild(label);
    });
    scopeBox.appendChild(buildScopeList(scope, chosen));

    const footer = document.createElement('div');
    footer.className = 'evd-save-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeSaveDialog);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-orange';
    confirm.textContent = 'Send';
    confirm.disabled = !anythingToSend;
    confirm.addEventListener('click', () => {
        const mode = radios.find((radio) => radio.checked)?.value || 'temporary';
        closeSaveDialog();
        performSave(mode);
    });
    footer.append(cancel, confirm);

    dialog.replaceChildren(heading, options, scopeBox, footer);
    dialog.style.display = '';
    document.addEventListener('keydown', onDialogKey, true);
    document.addEventListener('pointerdown', onDialogOutside, true);
}

/* ── Undo ───────────────────────────────────────────────────────────────────────────── */

// Screen only, and deliberately everything at once: a single Undo that quietly left one card
// edited would be the same trap the three per-card Restores were.
function undoScreenChanges() {
    if (!confirm('Put every setting on screen back to what was read from the bike?\n\n'
        + 'Anything not read from this bike goes back to the firmware defaults instead.\n\n'
        + 'Nothing is sent to the bike — it keeps whatever it is holding now.')) return;
    const restored = [
        ...restoreProfilesFromRead(),
        restoreTuningFromRead(),
    ];
    restoreLegacyDraft();
    restored.push('limits, speed, motor and system settings');
    addLog('INFO', `Screen put back: ${restored.join(', ')}. Nothing was sent to the bike.`);
}

export function bindGlobalActions() {
    refreshUnsavedBadge();
    el('evdReadAllButton')?.addEventListener('click', readEverything);
    el('evdSaveButton')?.addEventListener('click', openSaveDialog);
    el('evdUndoButton')?.addEventListener('click', undoScreenChanges);
}
