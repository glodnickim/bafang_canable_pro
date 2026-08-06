// evistdrive/common.js — pieces every eVistDrive card needs
//
// Everything under ui/js/evistdrive/ belongs to the eVistDrive Ride Core
// configurator. The factory Bafang tabs live one level up in ui/js/ and must
// keep working with an untouched factory controller, so nothing here is
// imported from there — the dependency only ever points this way.
import {
    state, socket, addLog, torqueMvToKg, helpBadge,
    TORQUE_DEFAULT_SPAN_MV, TORQUE_FULL_SCALE_KG,
} from '../shared.js';

// Native mV per kg on the measured default characteristic (span 1620 / 60 kg = 27).
export const EBICS_MV_PER_KG = TORQUE_DEFAULT_SPAN_MV / TORQUE_FULL_SCALE_KG;

export const LEVEL_NAMES = ['ECO', 'TOUR', 'SPORT', 'SPORT+', 'BOOST'];
// Approximates the Bafang display's own ECO/TOUR/SPORT/SPORT+/BOOST color convention
// (green / blue / indigo / salmon-orange / purple) — SPORT+ is salmon, not blood red.
export const LEVEL_COLORS = ['#16a34a', '#2563eb', '#4f46e5', '#f2673f', '#7e22ce'];

export const PREVIEW_CADENCE_RPM = 60;

/*
 * FW-069 adaptive Iq ramp breakpoints, mirrored from firmware config.h
 * (IQ_RAMP_SPEED_LO/HI, IQ_RAMP_CAD_LO/HI). They are compile-time constants, so the
 * controller does not report them and the app cannot read them — but leaving the four ramp
 * fields labelled only "low" and "high" meant nobody could tell at what speed the value they
 * were editing applied. Kept here so the field labels, the help text and the ramps chart all
 * quote ONE set of numbers; if firmware ever changes them, this is the single place to fix.
 *
 * Firmware maps speed and cadence to a ramp time separately and takes the SHORTER result
 * (assist_dynamics.c), and map() clamps at both ends: below the low breakpoints you get
 * exactly the slow value, above the high ones exactly the fast value.
 */
export const RAMP_SPEED_LO_KMH = 4.0;
export const RAMP_SPEED_HI_KMH = 20.0;
export const RAMP_CADENCE_LO_RPM = 20;
export const RAMP_CADENCE_HI_RPM = 70;
export const RAMP_SLOW_WHEN =
    `at or below ${RAMP_SPEED_LO_KMH.toFixed(1)} km/h AND ${RAMP_CADENCE_LO_RPM} rpm`;
export const RAMP_FAST_WHEN =
    `at or above ${RAMP_SPEED_HI_KMH.toFixed(1)} km/h OR ${RAMP_CADENCE_HI_RPM} rpm`;

export const MODES = [
    { value: 1, label: 'Power Linear' },
    { value: 2, label: 'Power Progressive' },
    { value: 3, label: 'eMTB' },
    { value: 5, label: 'Torque' },
    // FW-056: only offered when the controller reports bank schema v4 or newer.
    { value: 6, label: 'Power Curve', minBankSchema: 4 },
];
export const MODE_LABELS = Object.fromEntries(MODES.map((mode) => [mode.value, mode.label]));

export const el = (id) => document.getElementById(id);
export const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
export const displayNumber = (value, precision = 0) => isNumber(value) ? value.toFixed(precision) : 'N/A';
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function hexToRgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function socketReady() {
    if (socket.readyState === WebSocket.OPEN && state.isCanConnected) return true;
    addLog('ERR', 'CAN controller is not connected.');
    return false;
}

export function activeBankIndex() {
    const value = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank;
    return value === 1 ? 1 : 0;
}

export function currentLevelIndex() {
    const value = state.displayRealtime?.current_assist_level;
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value - 1;
    return 0;
}

export function selectedLevel(bankSelectId = 'ebicsProfileBankSelect', levelSelectId = 'ebicsProfileLevelSelect') {
    const bankIndex = parseInt(el(bankSelectId)?.value ?? '0', 10);
    const levelIndex = parseInt(el(levelSelectId)?.value ?? '0', 10);
    return {
        bankIndex,
        levelIndex,
        bank: state.lastBanks?.[bankIndex] || null,
        level: state.lastBanks?.[bankIndex]?.levels?.[levelIndex] || null,
    };
}

export function setText(id, value) {
    const node = el(id);
    // Write only on a real change: the Live and System cards refresh every field on every
    // CAN frame, and most values are identical to the previous frame. A no-op write is
    // still a DOM mutation, with the layout and style work that follows it.
    if (node && node.textContent !== String(value)) node.textContent = value;
}

export function getPedalLoadKg() {
    const raw = isNumber(state.controllerRealtime0?.torque)
        ? state.controllerRealtime0.torque
        : state.sensorRealtime?.torque;
    return isNumber(raw) ? torqueMvToKg(raw) : null;
}

export function currentElectricalPower() {
    const current = state.controllerRealtime1?.current;
    const voltage = state.controllerRealtime1?.voltage;
    return isNumber(current) && isNumber(voltage) ? Math.max(0, current * voltage) : null;
}

// FW-056: lowest bank schema version reported by the controller. 0 until the banks
// have actually been read, so newer modes stay hidden while browsing offline.
export function bankSchemaVersion() {
    // state.lastBanks is an OBJECT keyed by bank index (see websocket.js), not an
    // array — calling array methods on it throws and takes the whole tab down.
    const banks = state.lastBanks ? Object.values(state.lastBanks) : [];
    const versions = banks
        .map((bank) => bank?.bank_schema_version)
        .filter((value) => Number.isFinite(value));
    return versions.length ? Math.min(...versions) : 0;
}

// FW-056: every mode is always listed so the curve and the chart can be explored
// offline. A mode the connected controller cannot store is flagged here and
// refused at Apply time — the controller would reject the whole bank blob and
// silently keep the old settings, which is far worse than an explicit error.
export function modeUnsupportedReason(modeType) {
    const mode = MODES.find((entry) => entry.value === modeType);
    if (!mode?.minBankSchema) return null;
    const schema = bankSchemaVersion();
    if (schema === 0) return 'not-read';
    return schema < mode.minBankSchema ? 'old-firmware' : null;
}

let modeSelectBuiltForSchema = null;

export function populateSelects() {
    ['ebicsProfileLevelSelect'].forEach((id) => {
        const select = el(id);
        if (!select || select.options.length) return;
        LEVEL_NAMES.forEach((name, index) => select.add(new Option(name, String(index))));
    });
    const modeSelect = el('ebicsProfileModeSelect');
    const schema = bankSchemaVersion();
    // Rebuilt (not just filled once) because the labels change once the banks are
    // read and we learn whether this controller supports the newer modes.
    if (modeSelect && (modeSelect.options.length !== MODES.length || modeSelectBuiltForSchema !== schema)) {
        const previous = modeSelect.value;
        modeSelect.innerHTML = '';
        MODES.forEach((mode) => {
            const suffix = modeUnsupportedReason(mode.value) === 'old-firmware'
                ? ' — needs newer firmware' : '';
            modeSelect.add(new Option(`${mode.label}${suffix}`, String(mode.value)));
        });
        if (MODES.some((mode) => String(mode.value) === previous)) modeSelect.value = previous;
        modeSelectBuiltForSchema = schema;
    }
}

/**
 * CB-012: Shift+click a field to put that one value back.
 *
 * `descriptor.restoreValue` is a function returning `{ value, source }` — `source` being
 * 'read' (what the controller sent) or 'defaults' (firmware defaults, when nothing has
 * been read). Cards that do not supply it simply do not get the behaviour.
 *
 * Only ever changes what is on screen. The controller keeps whatever it has until Write.
 */
function attachShiftRestore(input, target, descriptor, onChanged, applyToInput) {
    if (typeof descriptor.restoreValue !== 'function') return;
    const restore = (event) => {
        if (!event.shiftKey) return;
        event.preventDefault(); // do not also focus/toggle the control
        const { value, source } = descriptor.restoreValue();
        if (value === undefined) return;
        target[descriptor.key] = value;
        applyToInput(value);
        addLog('INFO', `${descriptor.label}: back to ${source === 'read' ? 'the value read from the controller' : 'the firmware default'} (not written to the bike yet).`);
        onChanged?.();
    };
    input.addEventListener('click', restore);
    input.title = 'Shift+click to put this one value back to what was read (or to the firmware default).';
}

export function fieldInput(container, target, descriptor, onChanged) {
    if (!container || !target) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ebics-field';
    const label = document.createElement('label');
    label.append(descriptor.unit ? `${descriptor.label} (${descriptor.unit})` : descriptor.label);
    if (descriptor.help) {
        const details = [descriptor.help];
        if (Object.prototype.hasOwnProperty.call(descriptor, 'factoryDefault')) {
            const fromNative = descriptor.fromNative || ((value) => value);
            const rawDefault = descriptor.factoryDefault;
            const displayDefault = descriptor.type === 'checkbox'
                ? (rawDefault ? 'On' : 'Off')
                : fromNative(rawDefault);
            const suffix = descriptor.type === 'checkbox' || !descriptor.unit
                ? '' : ` ${descriptor.unit}`;
            details.push(`${descriptor.factoryDefaultLabel || 'Factory default'}: ${displayDefault}${suffix}.`);
        }
        if (descriptor.type !== 'checkbox'
            && Number.isFinite(descriptor.min) && Number.isFinite(descriptor.max)) {
            const suffix = descriptor.unit ? ` ${descriptor.unit}` : '';
            details.push(`Allowed range: ${descriptor.min}-${descriptor.max}${suffix}.`);
        }
        label.appendChild(helpBadge(details.join(' ')));
    }
    wrapper.appendChild(label);

    const input = document.createElement('input');
    input.disabled = !!descriptor.disabled;
    if (descriptor.type === 'checkbox') {
        input.type = 'checkbox';
        input.checked = !!target[descriptor.key];
        input.addEventListener('change', () => {
            target[descriptor.key] = input.checked;
            onChanged?.();
        });
        attachShiftRestore(input, target, descriptor, onChanged, (value) => { input.checked = !!value; });
    } else {
        input.type = 'number';
        input.className = 'form-input';
        input.min = descriptor.min;
        input.max = descriptor.max;
        input.step = descriptor.step ?? 1;
        const fromNative = descriptor.fromNative || ((value) => value);
        const toNative = descriptor.toNative || ((value) => value);
        input.value = fromNative(target[descriptor.key] ?? descriptor.min);
        input.addEventListener('change', () => {
            let value = parseFloat(input.value);
            if (!Number.isFinite(value)) value = descriptor.min;
            value = clamp(value, descriptor.min, descriptor.max);
            const nativeValue = toNative(value);
            target[descriptor.key] = nativeValue;
            // Show the value that will actually be stored. This matters for
            // quantized fields such as the 0.1 kg Start condition thresholds.
            input.value = fromNative(nativeValue);
            onChanged?.();
        });
        attachShiftRestore(input, target, descriptor, onChanged, (value) => { input.value = fromNative(value); });
    }
    wrapper.appendChild(input);
    container.appendChild(wrapper);
}

/* ── Writing to the controller ──────────────────────────────────────────────────────
 *
 * SAVE_BANKS only tells the controller to persist what it already holds in RAM. Edits
 * made in a card live in the browser until a WRITE_BANK or WRITE_TUNING sends them over,
 * so a "Save to flash" button that sends SAVE_BANKS alone persists the OLD values and the
 * next read brings them straight back. Every one of the three save buttons did exactly
 * that. These helpers live here so all three do the same thing and cannot drift apart.
 *
 * Each waits for the controller's own acknowledgement. Only one write is ever outstanding,
 * so a single result slot per kind is enough.
 */
const WRITE_ACK_TIMEOUT_MS = 5000;

async function waitForResult(read, clear, timeoutMs) {
    clear();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const result = read();
        if (result) {
            return result.success
                ? { ok: true }
                : { ok: false, reason: result.timedOut ? 'timed out' : (result.error || 'the controller rejected it') };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, reason: 'no answer from the controller' };
}

// A bank blob is ~190 bytes of multi-frame traffic, hence the generous wait.
export async function writeBankAndWait(bank, timeoutMs = WRITE_ACK_TIMEOUT_MS) {
    const pending = waitForResult(() => state.lastBankWriteResult,
        () => { state.lastBankWriteResult = null; }, timeoutMs);
    socket.send(`WRITE_BANK:${JSON.stringify(bank)}`);
    return pending;
}

export async function writeTuningAndWait(tuning, timeoutMs = WRITE_ACK_TIMEOUT_MS) {
    const pending = waitForResult(() => state.lastTuningWriteResult,
        () => { state.lastTuningWriteResult = null; }, timeoutMs);
    socket.send(`WRITE_TUNING:${JSON.stringify(tuning)}`);
    return pending;
}

// The controller defers the actual flash write to full standstill; this only confirms it
// accepted the request.
export async function saveToFlashAndWait(timeoutMs = WRITE_ACK_TIMEOUT_MS) {
    const pending = waitForResult(() => state.lastBankSaveResult,
        () => { state.lastBankSaveResult = null; }, timeoutMs);
    socket.send('SAVE_BANKS');
    return pending;
}

// Drawing a chart nobody can see costs exactly as much as drawing one they can. The Live
// and Limits cards already checked this; Profiles and Dynamics did not, so switching to
// any eVistDrive tab redrew five hidden charts.
export function tabIsVisible(tabId) {
    return !!el(tabId)?.classList.contains('active');
}

// Shared Plotly styling. Every eVistDrive chart starts here so they read as one
// set instead of five slightly different ones.
export function plotLayout(titleX, titleY) {
    return {
        // Top margin must leave room for the legend, which sits ABOVE the plot area (y > 1).
        // With t:18 the legend rendered outside the chart and painted over the input fields
        // above it (most visible on the two-series Deceleration chart).
        margin: { l: 58, r: 24, t: 58, b: 52 },
        paper_bgcolor: '#ffffff', plot_bgcolor: '#f8fafc',
        font: { family: 'system-ui, sans-serif', size: 11, color: '#475569' },
        xaxis: { title: titleX, gridcolor: '#e2e8f0', zerolinecolor: '#cbd5e1' },
        yaxis: { title: titleY, gridcolor: '#e2e8f0', rangemode: 'tozero' },
        legend: { orientation: 'h', y: 1.06, yanchor: 'bottom' },
        hovermode: 'x unified',
    };
}
