// evistdrive/presets.js — CB-020: share a ride tuning as a small, readable file.
//
// This is NOT the Data Backup tab. That one dumps every CAN event the app has seen —
// display, battery, sensor, serial numbers — and restores the lot. Useful for putting one
// bike back the way it was, useless for sending someone "how my bike rides".
//
// A preset carries ONLY the ride tuning: both profile banks and the global ride-core block.
// Everything that belongs to one physical bike is deliberately left out, because sending it
// to somebody else would break their bike rather than tune it:
//
//   * torque sensor span calibration — measured on one sensor, meaningless on another
//   * full-charge pack voltage and battery capacity — depends on the pack
//   * wheel circumference, serial numbers, display and battery blocks
//
// None of those live in state.lastBanks / state.lastTuning, so exporting exactly those two
// objects is what keeps the file safe by construction rather than by a filter someone has
// to remember to update.
import { state, addLog } from '../shared.js';
import { markUnsavedInRam } from './global-actions.js';
import { el, LEVEL_NAMES, MODES, bankSchemaVersion } from './common.js';
import { renderProfileEditor } from './profiles.js';
import { renderDynamics } from './dynamics.js';

const PRESET_FORMAT = 'evistdrive-preset';
const PRESET_VERSION = 1;

// Runtime state, not tuning: which bank the HMI currently has selected. Copying it from a
// file would silently switch the rider's active bank on import.
const BANK_RUNTIME_KEYS = ['active_bank'];
const LEGACY_START_MV_PER_KG = 27;
const kgWithOneDecimal = (value) => Math.round(value * 10) / 10;

// FW-077: presets written by older Canable versions used mV fields and
// stored the rolling value as a reduction. Normalise them at the import edge so
// the editor and newly exported presets contain kg only.
function normaliseLegacyStartLoads(level) {
    if (!level) return level;
    const converted = { ...level };
    if (Number.isFinite(level.minimum_pedal_load_kg)) {
        converted.minimum_pedal_load_kg = kgWithOneDecimal(level.minimum_pedal_load_kg);
        if (Number.isFinite(level.riding_minimum_pedal_load_kg)) {
            converted.riding_minimum_pedal_load_kg =
                kgWithOneDecimal(level.riding_minimum_pedal_load_kg);
        }
        return converted;
    }
    if (!Number.isFinite(level.without_rotation_threshold_mv)) return level;
    const minimumMv = Math.max(0, level.without_rotation_threshold_mv);
    const reductionMv = Number.isFinite(level.start_load_reduction_mv)
        ? Math.max(0, level.start_load_reduction_mv) : 0;
    converted.minimum_pedal_load_kg = kgWithOneDecimal(
        minimumMv / LEGACY_START_MV_PER_KG);
    converted.riding_minimum_pedal_load_kg = kgWithOneDecimal(
        Math.max(0, minimumMv - reductionMv) / LEGACY_START_MV_PER_KG);
    return converted;
}

/* ── Export ─────────────────────────────────────────────────────────────────────── */

function controllerVersionForMetadata() {
    const info = state.controllerOtherInfo || {};
    return info.controller_sw_version || info.sw_version || null;
}

export function buildPreset(name, note) {
    const banks = [0, 1].map((index) => {
        const bank = state.lastBanks?.[index];
        if (!bank) return null;
        const copy = JSON.parse(JSON.stringify(bank));
        BANK_RUNTIME_KEYS.forEach((key) => { delete copy[key]; });
        return copy;
    });
    return {
        format: PRESET_FORMAT,
        version: PRESET_VERSION,
        created: new Date().toISOString(),
        name: name || '',
        note: note || '',
        source: {
            controller_sw_version: controllerVersionForMetadata(),
            bank_schema_version: bankSchemaVersion() || null,
        },
        banks,
        tuning: state.lastTuning ? JSON.parse(JSON.stringify(state.lastTuning)) : null,
    };
}

export function exportPreset() {
    if (!state.lastBanks?.[0] && !state.lastBanks?.[1] && !state.lastTuning) {
        addLog('ERR', 'Nothing to export yet — press "Read from bike" first so the file holds your bike\'s real settings.');
        return;
    }
    const name = (el('ebicsPresetName')?.value || '').trim();
    const note = (el('ebicsPresetNote')?.value || '').trim();
    const preset = buildPreset(name, note);
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const stamp = preset.created.slice(0, 19).replace(/:/g, '-');
    const slug = name ? `_${name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40)}` : '';
    link.download = `evistdrive-preset_${stamp}${slug}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addLog('DATA', `Preset exported${name ? ` ("${name}")` : ''}. It holds ride tuning only — no sensor calibration, battery or wheel settings.`);
}

/* ── Import: validation ─────────────────────────────────────────────────────────── */

export function validatePreset(parsed) {
    if (!parsed || typeof parsed !== 'object') return { error: 'That file is not a preset.' };
    if (parsed.format !== PRESET_FORMAT) {
        return { error: 'That file is not an eVistDrive preset. The Data Backup tab reads whole-device backups; this reads ride tuning presets.' };
    }
    if (!Number.isFinite(parsed.version) || parsed.version > PRESET_VERSION) {
        return { error: `Preset format v${parsed.version} is newer than this app understands (v${PRESET_VERSION}). Update the app.` };
    }
    const banks = Array.isArray(parsed.banks) ? parsed.banks : [];
    const hasBank = banks.some((bank) => Array.isArray(bank?.levels) && bank.levels.length);
    if (!hasBank && !parsed.tuning) return { error: 'The preset holds neither banks nor global tuning.' };
    return { preset: parsed };
}

// Modes the connected controller cannot store. Writing a bank that contains one makes the
// firmware reject the WHOLE blob, so it has to be caught before the values reach the editor.
export function unsupportedModesIn(preset) {
    const schema = bankSchemaVersion();
    if (!schema) return []; // nothing read yet — the write path blocks separately
    const found = new Set();
    (preset.banks || []).forEach((bank) => {
        (bank?.levels || []).forEach((level) => {
            const mode = MODES.find((entry) => entry.value === level?.mode_type);
            if (mode?.minBankSchema && schema < mode.minBankSchema) found.add(mode.label);
        });
    });
    return [...found];
}

/* ── Import: clamping ───────────────────────────────────────────────────────────── */

// Ranges come from the field descriptors the editor already uses, so a value can never be
// loaded outside what the UI itself would allow. Reported rather than applied silently:
// a preset quietly reshaped on import is a preset that no longer matches its author's bike.
function clampInto(target, source, descriptors, label, adjusted, skipped) {
    const schema = bankSchemaVersion();
    descriptors.filter(Boolean).forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(source, field.key)) return;
        /*
         * FW-084: a preset written on newer firmware can carry settings this controller has
         * no room for in its bank format. Loading them anyway would put a value in the
         * editor that the serializer then drops on write — the rider would see a boost
         * duration on screen, press Apply, get an OK, and ride a bike that never got it.
         * Refuse the field and say so instead.
         */
        if (field.minBankSchema && (schema === 0 || schema < field.minBankSchema)) {
            if (skipped) skipped.push(`${label} · ${field.label}`);
            return;
        }
        const value = source[field.key];
        if (field.type === 'checkbox') { target[field.key] = !!value; return; }
        if (!Number.isFinite(value)) return;
        /*
         * CB-024 FIX: min/max on a descriptor are in the unit the field is DISPLAYED in,
         * while the profile stores the native value. Comparing the two directly destroyed
         * every field where they differ: a preset's emtb_reference_voltage_mv of 36000 was
         * "clamped" to 84 (the volts maximum) and a curve exponent of 15 to 2.5. Both were
         * then reported to the rider as an out-of-range value that had been corrected.
         *
         * Clamp in display space and convert back, so the bounds mean what they say. Fields
         * without a conversion are unaffected — fromNative/toNative default to identity.
         */
        const fromNative = field.fromNative || ((raw) => raw);
        const toNative = field.toNative || ((shown) => shown);
        /*
         * The bounds are translated INTO the stored unit and the comparison happens there.
         * Clamping in display units instead would miss the case that matters most: a
         * fromNative() that clamps on its own (the Nm view of max_iq_pct does) makes an
         * out-of-range native value look in-range, and it would be written through untouched.
         * Every conversion in use is monotonic, so translating the two ends is exact — and it
         * avoids re-quantizing a value that was already fine.
         */
        const nativeMin = Number.isFinite(field.min) ? Number(toNative(field.min)) : -Infinity;
        const nativeMax = Number.isFinite(field.max) ? Number(toNative(field.max)) : Infinity;
        let clamped = value;
        if (Number.isFinite(nativeMin) && value < nativeMin) clamped = nativeMin;
        else if (Number.isFinite(nativeMax) && value > nativeMax) clamped = nativeMax;
        if (clamped !== value) {
            // Reported in the unit the rider sees, not in the stored one.
            adjusted.push(`${label} · ${field.label}: ${fromNative(value)} → ${fromNative(clamped)}`);
        }
        target[field.key] = clamped;
    });
}

/* ── Import: applying ───────────────────────────────────────────────────────────── */

/*
 * Settings that belong to a BANK rather than to one of its levels: cadence compensation
 * and the walk-assist block. The export has always carried them — they are part of how a
 * bank rides — so the import has to be able to apply them, otherwise the file promises
 * something loading it does not deliver. They get their own checkbox per bank, because
 * wanting somebody's level tuning without their walk-assist speed is entirely reasonable.
 */
const BANK_SETTING_FIELDS = [
    { key: 'cadence_comp_enabled', label: 'Cadence compensation', type: 'checkbox' },
    { key: 'wa_cutoff_kmh', label: 'Walk Assist cut-off speed', min: 1, max: 25.5 },
    { key: 'wa_current_pct', label: 'Walk Assist current', min: 1, max: 100 },
    { key: 'wa_target_rpm', label: 'Walk Assist target rpm', min: 18, max: 60 },
    { key: 'wa_latch_after_release', label: 'Walk Assist latch', type: 'checkbox' },
    { key: 'wa_latch_timeout_s', label: 'Walk Assist latch timeout', min: 1, max: 120 },
];

// selection: { levels: Set("bankIndex:levelIndex"), bankSettings: Set(bankIndex), tuning: bool }
export function applyPreset(preset, selection, descriptors) {
    const adjusted = [];
    const skipped = [];
    let levelCount = 0;
    let bankSettingCount = 0;

    (preset.banks || []).forEach((bank, bankIndex) => {
        const targetBank = state.lastBanks?.[bankIndex];
        if (!targetBank || !Array.isArray(bank?.levels)) return;
        if (selection.bankSettings?.has(bankIndex)) {
            clampInto(targetBank, bank, BANK_SETTING_FIELDS, `Bank ${bankIndex + 1}`, adjusted, skipped);
            bankSettingCount++;
        }
        bank.levels.forEach((legacySourceLevel, levelIndex) => {
            if (!selection.levels.has(`${bankIndex}:${levelIndex}`)) return;
            const targetLevel = targetBank.levels?.[levelIndex];
            const sourceLevel = normaliseLegacyStartLoads(legacySourceLevel);
            if (!targetLevel || !sourceLevel) return;
            // mode_type first: it decides which mode-specific fields even apply.
            if (Number.isFinite(sourceLevel.mode_type)) targetLevel.mode_type = sourceLevel.mode_type;
            const label = `Bank ${bankIndex + 1} / ${LEVEL_NAMES[levelIndex]}`;
            clampInto(targetLevel, sourceLevel, descriptors.levelFields(sourceLevel.mode_type), label, adjusted, skipped);
            levelCount++;
        });
    });

    if (selection.tuning && preset.tuning && state.lastTuning) {
        clampInto(state.lastTuning, preset.tuning, descriptors.tuningFields(), 'Global', adjusted, skipped);
    }
    return {
        levelCount,
        bankSettingCount,
        tuningApplied: !!(selection.tuning && preset.tuning),
        adjusted,
        skipped,
    };
}

/* ── Import: the picker ─────────────────────────────────────────────────────────── */

function buildImportPanel(preset, descriptors, container) {
    container.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'ebics-preset-panel';

    const title = document.createElement('div');
    title.className = 'ebics-preset-panel-title';
    const when = (preset.created || '').slice(0, 10);
    title.textContent = preset.name
        ? `“${preset.name}” — pick what to load`
        : `Preset${when ? ` from ${when}` : ''} — pick what to load`;
    panel.appendChild(title);

    if (preset.note) {
        const note = document.createElement('p');
        note.className = 'form-hint';
        note.textContent = preset.note;
        panel.appendChild(note);
    }

    const blocked = unsupportedModesIn(preset);
    if (blocked.length) {
        const warn = document.createElement('p');
        warn.className = 'form-hint ebics-stale-warning';
        warn.textContent = `⚠ This preset uses ${blocked.join(', ')}, which your controller's firmware cannot store. Loading those levels would make the controller reject the whole bank on write. Flash newer firmware first.`;
        panel.appendChild(warn);
    }

    const boxes = [];
    const bankSettingBoxes = [];
    (preset.banks || []).forEach((bank, bankIndex) => {
        if (!Array.isArray(bank?.levels) || !bank.levels.length) return;
        const row = document.createElement('div');
        row.className = 'ebics-preset-row';
        const heading = document.createElement('strong');
        heading.textContent = `Bank ${bankIndex + 1}`;
        row.appendChild(heading);
        {
            // Separate from the levels on purpose: taking somebody's level tuning without
            // their walk-assist speed is a perfectly ordinary thing to want.
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = true;
            box.dataset.bank = String(bankIndex);
            label.appendChild(box);
            label.appendChild(document.createTextNode('bank settings'));
            label.title = 'Cadence compensation and the Walk Assist block for this bank.';
            row.appendChild(label);
            bankSettingBoxes.push(box);
        }
        bank.levels.forEach((level, levelIndex) => {
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = true;
            box.dataset.slot = `${bankIndex}:${levelIndex}`;
            const mode = MODES.find((entry) => entry.value === level?.mode_type);
            const unsupported = mode?.minBankSchema && bankSchemaVersion()
                && bankSchemaVersion() < mode.minBankSchema;
            if (unsupported) { box.checked = false; box.disabled = true; }
            label.appendChild(box);
            label.appendChild(document.createTextNode(
                LEVEL_NAMES[levelIndex] + (mode ? ` (${mode.label})` : '')));
            row.appendChild(label);
            boxes.push(box);
        });
        panel.appendChild(row);
    });

    let tuningBox = null;
    if (preset.tuning) {
        const row = document.createElement('div');
        row.className = 'ebics-preset-row';
        const label = document.createElement('label');
        tuningBox = document.createElement('input');
        tuningBox.type = 'checkbox';
        tuningBox.checked = true;
        label.appendChild(tuningBox);
        label.appendChild(document.createTextNode('Global — whole bike (start condition, latch, RUN smoothing, boost decay)'));
        row.appendChild(label);
        panel.appendChild(row);
    }

    const footer = document.createElement('div');
    footer.className = 'ebics-preset-footer';
    const count = document.createElement('span');
    count.className = 'ebics-preset-count';
    footer.appendChild(count);
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn btn-orange';
    load.textContent = 'Load into editor';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    footer.appendChild(load);
    footer.appendChild(cancel);
    panel.appendChild(footer);

    const refreshCount = () => {
        const levels = boxes.filter((box) => box.checked).length;
        const bankSettings = bankSettingBoxes.filter((box) => box.checked).length;
        const tuning = !!tuningBox?.checked;
        const parts = [];
        if (levels) parts.push(`${levels} level(s)`);
        if (bankSettings) parts.push(`${bankSettings} bank setting block(s)`);
        if (tuning) parts.push('the global block');
        count.textContent = parts.length
            ? `Loads ${parts.join(' + ')} into the editor. Nothing is written to the controller.`
            : 'Nothing selected';
        load.disabled = !parts.length;
    };
    boxes.forEach((box) => box.addEventListener('change', refreshCount));
    bankSettingBoxes.forEach((box) => box.addEventListener('change', refreshCount));
    tuningBox?.addEventListener('change', refreshCount);
    refreshCount();

    cancel.addEventListener('click', () => { container.innerHTML = ''; });
    load.addEventListener('click', () => {
        const selection = {
            levels: new Set(boxes.filter((box) => box.checked).map((box) => box.dataset.slot)),
            bankSettings: new Set(bankSettingBoxes.filter((box) => box.checked)
                .map((box) => Number(box.dataset.bank))),
            tuning: !!tuningBox?.checked,
        };
        const result = applyPreset(preset, selection, descriptors);
        container.innerHTML = '';
        renderProfileEditor();
        renderDynamics();
        markUnsavedInRam();
        addLog('DATA', `Preset loaded: ${result.levelCount} level(s), ${result.bankSettingCount} bank setting block(s)${result.tuningApplied ? ' + global' : ''}. Nothing has reached the bike — use "Save…" in the top bar when you are ready.`);
        if (result.adjusted.length) {
            addLog('ERR', `${result.adjusted.length} value(s) were outside this app's allowed range and were clamped: ${result.adjusted.slice(0, 6).join('; ')}${result.adjusted.length > 6 ? ' …' : ''}`);
        }
        // FW-084: never silent. A skipped field is a promise the file made that this
        // controller cannot keep, and the rider has to hear it before they ride.
        if (result.skipped.length) {
            addLog('ERR', `${result.skipped.length} setting(s) in this preset need newer firmware than your controller reports and were NOT loaded: ${result.skipped.slice(0, 6).join('; ')}${result.skipped.length > 6 ? ' …' : ''}`);
        }
    });

    container.appendChild(panel);
}

/* ── Wiring ─────────────────────────────────────────────────────────────────────── */

export function bindPresetControls(descriptors) {
    el('ebicsPresetExportButton')?.addEventListener('click', exportPreset);

    const input = el('ebicsPresetImportInput');
    el('ebicsPresetImportButton')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            let parsed = null;
            try {
                parsed = JSON.parse(event.target.result);
            } catch {
                addLog('ERR', 'That file is not valid JSON.');
                input.value = '';
                return;
            }
            const { preset, error } = validatePreset(parsed);
            input.value = ''; // so picking the same file twice fires change again
            if (error) { addLog('ERR', error); return; }
            if (!state.lastBanks?.[0] && !state.lastBanks?.[1]) {
                addLog('ERR', 'Read the bike first ("Read from bike"), so the preset is loaded on top of your real settings rather than placeholders.');
                return;
            }
            buildImportPanel(preset, descriptors, el('ebicsPresetPanel'));
        };
        reader.readAsText(file);
    });
}
