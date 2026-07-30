// tab-ebics.js — separate eVistDrive Ride Core views kept alongside factory tabs
/* global Plotly */
import {
    state, socket, addLog, torqueMvToKg, torqueModel,
    TORQUE_ZERO_MV, TORQUE_DEFAULT_SPAN_MV, TORQUE_FULL_SCALE_KG, helpBadge, isEbicsConnected,
} from './shared.js';
// FW-056: the exact table and evaluation the controller runs, emitted by the same
// firmware generator, so the preview draws the real curve and not a lookalike.
import { evalPowerCurvePermille } from './power-curve-lut.js';

// Native mV per kg on the measured default characteristic (span 1620 / 60 kg = 27).
const EBICS_MV_PER_KG = TORQUE_DEFAULT_SPAN_MV / TORQUE_FULL_SCALE_KG;
import { isEbicsUIAvailable } from './ebics-detection.js';
import { updateEbicsCompatibilityUI } from './ebics-compat.js';

const LEVEL_NAMES = ['ECO', 'TOUR', 'SPORT', 'SPORT+', 'BOOST'];
// Approximates the Bafang display's own ECO/TOUR/SPORT/SPORT+/BOOST color convention
// (green / blue / indigo / salmon-orange / purple) — SPORT+ is salmon, not blood red.
const LEVEL_COLORS = ['#16a34a', '#2563eb', '#4f46e5', '#f2673f', '#7e22ce'];

function hexToRgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function tintProfileCards(levelIndex) {
    const tint = hexToRgba(LEVEL_COLORS[levelIndex] || '#475569', 0.16);
    ['ebicsProfileModeCard', 'ebicsProfileSharedCard', 'ebicsProfileChartCard'].forEach((id) => {
        const node = el(id);
        if (node) node.style.backgroundColor = tint;
    });
}
const PREVIEW_CADENCE_RPM = 60;
const HUMAN_POWER_CENTIKG_RPM_NUMERATOR = 1694;
const HUMAN_POWER_CENTIKG_RPM_DENOMINATOR = 1000;
const MODES = [
    { value: 1, label: 'Power Linear' },
    { value: 2, label: 'Power Progressive' },
    { value: 3, label: 'eMTB' },
    { value: 5, label: 'Torque' },
    // FW-056: only offered when the controller reports bank schema v4 or newer.
    { value: 6, label: 'Power Curve', minBankSchema: 4 },
];
const MODE_LABELS = Object.fromEntries(MODES.map((mode) => [mode.value, mode.label]));
const TUNING_FIELDS = [
    { key: 'iq_rise_slow_ms', label: 'Acceleration — low speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp from 0% to 100% while pedalling slowly or riding slowly. This is the SLOW end of an adaptive ramp — firmware blends toward the fast value as your speed/cadence rises.' },
    { key: 'iq_rise_fast_ms', label: 'Acceleration — high speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp from 0% to 100% once you are already riding at speed/cadence. Shorter than the slow value — quicker response once you are moving.' },
    { key: 'iq_fall_slow_ms', label: 'Deceleration — low speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp down to 0% at low speed/cadence. Also the base timing for the release fade after you stop pedalling, whenever a level’s "Release duration" is 0 (automatic).' },
    { key: 'iq_fall_fast_ms', label: 'Deceleration — high speed/cadence', unit: 'ms', min: 20, max: 5000, step: 10,
        help: 'Time for motor current to ramp down to 0% while riding at speed/cadence — shorter than the slow value.' },
    { key: 'startup_boost_cadence_step', label: 'Startup boost fade per cadence step', unit: '', min: 1, max: 100, step: 1,
        help: 'How fast each level’s "Startup boost" fades away as cadence rises. Higher = the boost disappears sooner after you start pedalling; lower = it lingers longer.' },
    // FW-032: ride latch (keeps assist alive through the crank dead-spots after a legal start).
    { key: 'assist_run_deadband_mv', label: 'Run deadband (keep-alive load)', unit: 'mV', min: 0, max: 100, step: 1,
        help: 'Once assist has properly started (see "Minimum pedal load" on a level), pedal load can drop this low before assist is allowed to release — keeps the motor pulling through the light spot of each pedal stroke instead of pulsing on/off.' },
    { key: 'assist_hold_ms', label: 'Sustain through dead-spot', unit: 'ms', min: 0, max: 3000, step: 10,
        help: 'How long assist stays latched at very light pedal load (below Run deadband) before it gives up and releases. Stops a single weak moment — a dead spot in the pedal stroke — from cutting assist.' },
    { key: 'assist_min_iq_pct', label: 'Current floor while latched', unit: '%', min: 0, max: 25, step: 1,
        help: 'Minimum motor current (percent of the level’s current limit) while assist is latched and you are still pedalling forward, even if pedal load momentarily reads near zero. Keeps the motor from stalling between pedal strokes.' },
    // FW-033: RUN torque estimator — smooths per-leg peaks in the power calc (0 = off).
    { key: 'assist_torque_run_filter_ms', label: 'RUN torque smoothing (anti-pulse)', unit: 'ms', min: 0, max: 1000, step: 10,
        help: 'Smooths the pedal-load signal used for RUN power/eMTB/torque calculations (not for starting or stopping), so the motor follows your average effort instead of pulsing with every single leg push. 0 = off (raw signal).' },
];

const el = (id) => document.getElementById(id);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const displayNumber = (value, precision = 0) => isNumber(value) ? value.toFixed(precision) : 'N/A';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let liveChartLastUpdate = 0;
let limitsChartLastUpdate = 0;
const liveHistory = { time: [], load: [], cadence: [], power: [], speed: [] };

function socketReady() {
    if (socket.readyState === WebSocket.OPEN && state.isCanConnected) return true;
    addLog('ERR', 'CAN controller is not connected.');
    return false;
}

function activeBankIndex() {
    const value = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank;
    return value === 1 ? 1 : 0;
}

function currentLevelIndex() {
    const value = state.displayRealtime?.current_assist_level;
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value - 1;
    return 0;
}

function selectedLevel(bankSelectId = 'ebicsProfileBankSelect', levelSelectId = 'ebicsProfileLevelSelect') {
    const bankIndex = parseInt(el(bankSelectId)?.value ?? '0', 10);
    const levelIndex = parseInt(el(levelSelectId)?.value ?? '0', 10);
    return {
        bankIndex,
        levelIndex,
        bank: state.lastBanks?.[bankIndex] || null,
        level: state.lastBanks?.[bankIndex]?.levels?.[levelIndex] || null,
    };
}

function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
}

function getPedalLoadKg() {
    const raw = isNumber(state.controllerRealtime0?.torque)
        ? state.controllerRealtime0.torque
        : state.sensorRealtime?.torque;
    return isNumber(raw) ? torqueMvToKg(raw) : null;
}

function currentElectricalPower() {
    const current = state.controllerRealtime1?.current;
    const voltage = state.controllerRealtime1?.voltage;
    return isNumber(current) && isNumber(voltage) ? Math.max(0, current * voltage) : null;
}

// FW-056: lowest bank schema version reported by the controller. 0 until the banks
// have actually been read, so newer modes stay hidden while browsing offline.
function bankSchemaVersion() {
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
function modeUnsupportedReason(modeType) {
    const mode = MODES.find((entry) => entry.value === modeType);
    if (!mode?.minBankSchema) return null;
    const schema = bankSchemaVersion();
    if (schema === 0) return 'not-read';
    return schema < mode.minBankSchema ? 'old-firmware' : null;
}

let modeSelectBuiltForSchema = null;

function populateSelects() {
    ['ebicsProfileLevelSelect', 'ebicsLimitsLevelSelect'].forEach((id) => {
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

function fieldInput(container, target, descriptor, onChanged) {
    if (!container || !target) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ebics-field';
    const label = document.createElement('label');
    label.append(descriptor.unit ? `${descriptor.label} (${descriptor.unit})` : descriptor.label);
    if (descriptor.help) label.appendChild(helpBadge(descriptor.help));
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
            input.value = value;
            target[descriptor.key] = toNative(value);
            onChanged?.();
        });
    }
    wrapper.appendChild(input);
    container.appendChild(wrapper);
}

function modeFields(mode) {
    if (mode === 2) {
        return [
            { key: 'support_min_pct', label: 'Minimum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used at very low pedal power, before "Reference rider power" is reached.' },
            { key: 'support_max_pct', label: 'Maximum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used once your pedal power reaches "Reference rider power" (or goes above it).' },
            { key: 'reference_power_w', label: 'Reference rider power', unit: 'W', min: 20, max: 1000, step: 10,
                help: 'Rider power at which support ramps from Minimum to Maximum. Below this you get closer to Minimum support; at or above it you get Maximum support.' },
            { key: 'progression_pct', label: 'Progression', unit: '%', min: 0, max: 100, step: 5,
                help: 'Shapes the ramp from Minimum to Maximum support between 0 W and Reference rider power: 0% = straight line, higher curves it so support builds up faster as you approach Reference rider power.' },
        ];
    }
    if (mode === 6) {
        // FW-056: same support window as Power Progressive, but the shape is one
        // exponent instead of a blend of a straight and a squared curve.
        return [
            { key: 'support_min_pct', label: 'Minimum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used at very low pedal power, before "Reference rider power" is reached.' },
            { key: 'support_max_pct', label: 'Maximum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used once your pedal power reaches "Reference rider power" (or goes above it).' },
            { key: 'reference_power_w', label: 'Reference rider power', unit: 'W', min: 20, max: 1000, step: 10,
                help: 'Rider power at which support reaches Maximum. The curve below shapes everything between 0 W and this value.' },
            {
                key: 'curve_exponent_x10', label: 'Curve shape — lower half (gamma)', min: 0.3, max: 2.5, step: 0.1,
                fromNative: (value) => (value ?? 15) / 10,
                toNative: (value) => Math.round(clamp(value, 0.3, 2.5) * 10),
                help: 'Shapes the first half of the support window: from Minimum support up to the middle of the window, which is reached at half of Reference rider power. 1.0 = a straight line. Above 1.0 bends down — gentle at light pedalling. Below 1.0 bends the other way — near-full support already at light pedal load, which is aggressive: test it on a stand first, with Smooth start on and a conservative Maximum motor current.',
            },
            {
                key: 'curve_exponent_high_x10', label: 'Curve shape — upper half (gamma)', min: 0.3, max: 2.5, step: 0.1,
                fromNative: (value) => (value ?? 15) / 10,
                toNative: (value) => Math.round(clamp(value, 0.3, 2.5) * 10),
                help: 'Shapes the second half of the support window: from the middle of the window up to Maximum support, reached at Reference rider power. Set both halves to 1.0 for a straight line. A low value here makes the motor commit early once you are already working; a high value keeps the top of the range in reserve until you really push.',
            },
        ];
    }
    if (mode === 3) {
        return [
            { key: 'emtb_parameter', label: 'eMTB sensitivity', min: 0, max: 250, step: 5,
                help: 'How aggressively motor power reacts to pedal load: pedal load is squared internally, so a firm push gives noticeably more than proportionally more assist than a light one. 0 disables eMTB assist for this level.' },
            { key: 'emtb_based_on_power', label: 'Cadence-dependent response', type: 'checkbox',
                help: 'On: higher cadence reduces the eMTB response for the same pedal load, pairing load with effort. Off: only pedal load matters, cadence is ignored.' },
            {
                key: 'emtb_reference_voltage_mv', label: 'Reference voltage', unit: 'V', min: 12, max: 84, step: 1,
                fromNative: (value) => Math.round(value / 1000), toNative: (value) => Math.round(value * 1000),
                help: 'Battery voltage used only to convert the internal current target into the watts shown on the display/diagnostics — it does NOT change how hard the motor actually pushes. Set close to your pack’s real voltage so displayed watts are meaningful. Exception: if "Maximum motor power" below is set (non-zero), that power limit IS computed using this value, so setting it too low makes the power limit trigger earlier than intended.',
            },
        ];
    }
    if (mode === 5) {
        return [
            {
                key: 'torque_assist_factor', label: 'Torque gain — 120 = 1.0×', min: 0, max: 254, step: 5,
                help: 'Scales the torque-derived target. Unlike Support %, it does not multiply estimated rider power.',
            },
        ];
    }
    return [{ key: 'support_ratio_pct', label: 'Rider power support', unit: '%', min: 0, max: 1000, step: 10,
        help: 'Motor power as a percentage of your estimated pedal power — e.g. 100% ≈ motor roughly matches your effort, 200% ≈ motor gives roughly double. Main strength knob for Power Linear levels.' }];
}

function sharedFields() {
    return [
        { key: 'max_motor_power_w', label: 'Maximum motor power — 0 disables', unit: 'W', min: 0, max: 1500, step: 25,
            help: 'Hard ceiling on requested motor power for this level, converted to a current limit using the Reference voltage field (eMTB mode) or nominal voltage. 0 = no power ceiling (Maximum motor current below still applies).' },
        { key: 'max_iq_pct', label: 'Maximum motor current', unit: '%', min: 0, max: 100, step: 5,
            help: 'Hard ceiling on motor current for this level, as a percentage of the controller\'s overall phase-current limit. This is the final cap — startup boost, latch floor and everything else are still clipped by it.' },
        { key: 'assist_without_rotation', label: 'Assist without crank rotation', type: 'checkbox',
            help: 'Allow the motor to push from a dead stop, before the cranks are turning — useful for pulling away on a steep start. Still needs a clear push on the pedal (see Minimum pedal load) to trigger, so it can\'t be set off by an idle foot resting on the pedal.' },
        {
            key: 'without_rotation_threshold_mv', label: 'Minimum pedal load', unit: 'kg', min: 0, max: 11, step: 0.1,
            fromNative: (value) => Math.round((value / EBICS_MV_PER_KG) * 10) / 10,
            toNative: (value) => Math.round(value * EBICS_MV_PER_KG),
            help: 'Relative load above the automatically calibrated zero point. Firmware accepts 0-300 mV native, which is ~0-11 kg on the measured sensor characteristic.',
        },
        { key: 'startup_boost_enabled', label: 'Startup boost', type: 'checkbox',
            help: 'Give a temporary power boost right when you start pedalling from a stop, fading out as cadence rises (see Startup boost strength/end cadence, and the global "Startup boost fade per cadence step" in Dynamics).' },
        { key: 'startup_boost_strength_pct', label: 'Startup boost strength', unit: '%', min: 0, max: 300, step: 10,
            help: 'How much extra power the startup boost adds at cadence 0, as a percentage on top of the normal request. Fades out by the time cadence reaches Startup boost end cadence.' },
        { key: 'startup_boost_end_rpm', label: 'Startup boost end cadence', unit: 'rpm', min: 0, max: 120, step: 5,
            help: 'Cadence at which the startup boost has fully faded away. Above this cadence you get the normal, un-boosted assist.' },
        { key: 'smooth_start_enabled', label: 'Smooth start', type: 'checkbox',
            help: 'Ease the very first moment of assist in gradually over Smooth start duration, on top of the normal acceleration ramp — softer than the ramp alone for a very gentle launch.' },
        { key: 'smooth_start_ms', label: 'Smooth start duration', unit: 'ms', min: 0, max: 5000, step: 50,
            help: 'How long the smooth-start easing takes, if Smooth start is enabled.' },
        { key: 'release_ms', label: 'Release duration — 0 = automatic', unit: 'ms', min: 0, max: 3000, step: 50,
            help: 'How long assist takes to fade to zero once you stop pedalling. 0 = let the adaptive Acceleration/Deceleration ramps in Dynamics decide (their timing depends on your speed and cadence at the moment you stop).' },
        { key: 'power_rise_filter_ms', label: 'Power rise filter', unit: 'ms', min: 0, max: 5000, step: 50,
            help: 'Smooths sudden increases in requested motor power over this many milliseconds, before the current ramp in Dynamics even sees it. 0 = no smoothing (react immediately).' },
        { key: 'power_fall_filter_ms', label: 'Power fall filter', unit: 'ms', min: 0, max: 5000, step: 50,
            help: 'Smooths sudden drops in requested motor power over this many milliseconds — helps assist not visibly dip in the dead spots of each pedal stroke. 0 = no smoothing.' },
    ];
}

// Firmware boot defaults for a fresh bank (assist_modes.c DEFAULT_POWER_LEVEL / default_levels
// vs emtb_levels), one independent placeholder object PER assist level PER bank (ratio/emtb/
// torque numbers match ECO..BOOST in firmware; bank 1 defaults to Power Linear mode, bank 2
// defaults to eMTB mode, exactly like a fresh controller) — so offline/unread previews show 5
// distinct, editable lines, and switching banks actually looks different, instead of one shared
// object that made every level (and both banks) look and edit identically.
const PROFILE_LEVEL_RATIOS = [100, 200, 320, 420, 520];
const PROFILE_LEVEL_EMTB = [60, 100, 140, 160, 180];
const PROFILE_LEVEL_TORQUE = [50, 80, 120, 160, 200];
function buildProfilePlaceholderBank(modeType) {
    return PROFILE_LEVEL_RATIOS.map((ratio, index) => ({
        mode_type: modeType,
        support_ratio_pct: ratio, support_min_pct: ratio, support_max_pct: ratio,
        reference_power_w: 200, progression_pct: 0, curve_exponent_x10: 15, curve_exponent_high_x10: 15,
        emtb_parameter: PROFILE_LEVEL_EMTB[index], emtb_based_on_power: true, emtb_reference_voltage_mv: 36000,
        torque_assist_factor: PROFILE_LEVEL_TORQUE[index],
        max_motor_power_w: 0, max_iq_pct: 100,
        assist_without_rotation: false, without_rotation_threshold_mv: 18,
        startup_boost_enabled: true, startup_boost_strength_pct: 100, startup_boost_end_rpm: 27,
        smooth_start_enabled: false, smooth_start_ms: 300,
        release_ms: 650, power_rise_filter_ms: 150, power_fall_filter_ms: 375,
    }));
}
const PROFILE_LEVEL_PLACEHOLDER_BANKS = [
    buildProfilePlaceholderBank(1), // Bank 1 default: Power Linear (ASSIST_MODE_POWER_LINEAR)
    buildProfilePlaceholderBank(3), // Bank 2 default: eMTB (ASSIST_MODE_EMTB_TSDZ)
];
function placeholderLevel(bankIndex, levelIndex) {
    const bank = PROFILE_LEVEL_PLACEHOLDER_BANKS[bankIndex] || PROFILE_LEVEL_PLACEHOLDER_BANKS[0];
    return bank[levelIndex] || bank[0];
}

// FW-057: cadence compensation is stored per bank (blob header byte 12, schema v5),
// so it lives next to the bank selector rather than inside the level editor.
const CADENCE_COMP_DESCRIPTION =
    'Scales the assist request with cadence — 100% up to 70 rpm, 82% at 80, 93% at 100, '
    + '106% at 110, 132% at 120 and above — so assist does not fade away when you spin fast. '
    + 'Applies to every level and every pedalling mode in this bank. Power, current, temperature '
    + 'and voltage limits still apply; the throttle and Walk Assist are not affected.';

function renderCadenceComp(selected) {
    const box = el('ebicsCadenceCompEnabled');
    const strip = el('ebicsCadenceCompRow');
    const note = el('ebicsCadenceCompNote');
    const state = el('ebicsCadenceCompState');
    const scope = el('ebicsCadenceCompBank');
    if (!box) return;

    const supported = bankSchemaVersion() >= 5;
    const bank = selected.bank;
    const enabled = !!bank?.cadence_comp_enabled;
    const blocked = !!bank && !supported;

    box.disabled = !supported || !bank;
    box.checked = enabled;
    if (scope) scope.textContent = `Bank ${selected.bankIndex + 1}`;

    // The description is always visible — the status only says whether the setting
    // below it is the bike's real one, never replaces the explanation of the feature.
    let status = '';
    let badge = enabled ? 'ON' : 'OFF';
    if (!bank) {
        badge = 'NOT READ';
        status = 'Not read from the controller yet — press "Read banks" to see this bank\'s real setting. ';
    } else if (blocked) {
        badge = 'UNAVAILABLE';
        status = 'This controller\'s firmware does not have cadence compensation, so the switch is locked. ';
    }
    if (state) state.textContent = badge;
    if (note) note.textContent = status + CADENCE_COMP_DESCRIPTION;
    if (strip) {
        strip.classList.toggle('is-on', enabled && supported && !!bank);
        strip.classList.toggle('is-blocked', blocked);
    }
}

function renderProfileEditor() {
    const selected = selectedLevel();
    tintProfileCards(selected.levelIndex);
    const source = el('ebicsProfilesSource');
    const readButton = el('ebicsProfilesReadButton');
    const hasData = !!selected.level;
    const stale = !hasData && isEbicsConnected();
    if (source) {
        source.classList.toggle('ebics-stale-warning', stale);
        source.textContent = hasData
            ? 'Selected bank read from controller'
            : (stale
                ? '⚠ Not read from the controller yet — values below are placeholders, NOT your bike\'s real settings. Press "Read banks".'
                : 'Offline defaults — connect and press "Read banks" to load your real settings.');
    }
    readButton?.classList.toggle('btn-needs-read', stale);

    populateSelects(); // FW-056: mode list depends on the schema version just read
    renderCadenceComp(selected); // FW-057
    const modeSelect = el('ebicsProfileModeSelect');
    const level = selected.level || placeholderLevel(selected.bankIndex, selected.levelIndex);
    if (modeSelect) modeSelect.value = String(level.mode_type || 1);
    const modeContainer = el('ebicsProfileModeFields');
    const sharedContainer = el('ebicsProfileSharedFields');
    if (modeContainer) modeContainer.innerHTML = '';
    if (sharedContainer) sharedContainer.innerHTML = '';
    const refresh = () => {
        renderProfileChart();
        updateTorqueSummary();
        updateLimitsSummary();
    };
    const mode = level.mode_type || 1;
    const unsupported = modeUnsupportedReason(mode); // FW-056
    if (modeContainer && unsupported) {
        const note = document.createElement('div');
        note.className = 'form-hint ebics-stale-warning';
        note.style.gridColumn = '1 / -1';
        note.textContent = unsupported === 'not-read'
            ? '⚠ Banks not read yet — this mode needs firmware with bank schema v4. Press "Read banks" to confirm your controller supports it. You can still shape the curve here; writing is blocked until it is confirmed.'
            : '⚠ This controller reports an older bank format and cannot store this mode. Writing is blocked — it would reject the whole bank and silently keep your old settings. Flash firmware with FW-056 first.';
        modeContainer.appendChild(note);
    }
    modeFields(mode).forEach((field) => fieldInput(modeContainer, level, field, refresh));
    sharedFields().forEach((field) => fieldInput(sharedContainer, level, field, refresh));
    renderProfileChart();
}

// Must match .ebics-chart min-height in style.css, so the reserved space and the drawn chart
// agree — otherwise the plot either overlaps the next card or leaves a gap.
const DYNAMICS_CHART_HEIGHT = 380;

function plotLayout(titleX, titleY) {
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

function profilePlotLayout(titleX, titleY) {
    const layout = plotLayout(titleX, titleY);
    layout.height = 380;
    layout.margin = { ...layout.margin, b: 78 };
    layout.xaxis = { ...layout.xaxis, automargin: true };
    layout.yaxis = { ...layout.yaxis, automargin: true };
    layout.legend = { ...layout.legend, y: 1.08 };
    return layout;
}

function humanPowerFromLoadKg(loadKg, cadenceRpm = PREVIEW_CADENCE_RPM) {
    return loadKg * 100 * cadenceRpm * HUMAN_POWER_CENTIKG_RPM_NUMERATOR /
        (HUMAN_POWER_CENTIKG_RPM_DENOMINATOR * 1000);
}

function loadKgFromHumanPower(humanPowerW, cadenceRpm = PREVIEW_CADENCE_RPM) {
    const wattsPerKg = humanPowerFromLoadKg(1, cadenceRpm);
    return wattsPerKg > 0 ? humanPowerW / wattsPerKg : 0;
}

function previewPowerCeilingW(level) {
    const p1 = state.controllerParams1 || state.lastControllerP1 || {};
    const voltage = isNumber(p1.system_voltage) ? p1.system_voltage : 48;
    const batteryCurrent = isNumber(p1.current_limit) ? p1.current_limit : 15;
    const electricalCeiling = Math.max(1, voltage * batteryCurrent);
    return level.max_motor_power_w > 0
        ? Math.min(level.max_motor_power_w, electricalCeiling)
        : electricalCeiling;
}

// FW-056: mirrors calculate_support_ratio_pct() in firmware assist_modes.c,
// including its integer arithmetic — same truncating division into permille, same
// lookup table, same support-window interpolation.
function powerCurveShapePermille(inputPermille, lowX10, highX10) {
    if (inputPermille <= 500) {
        return Math.floor((evalPowerCurvePermille(inputPermille * 2, lowX10) + 1) / 2);
    }
    return 500 + Math.floor((evalPowerCurvePermille((inputPermille - 500) * 2, highX10) + 1) / 2);
}

function supportRatioForPowerMode(level, humanPower) {
    const mode = level.mode_type || 1;
    if (mode === 1) return level.support_ratio_pct || 0;
    const reference = clamp(level.reference_power_w || 200, 50, 500);
    // Firmware works in milliwatts and divides by whole watts, truncating.
    const inputPermille = Math.min(1000, Math.floor((humanPower * 1000) / reference));
    let curvePermille;
    if (mode === 6) {
        curvePermille = powerCurveShapePermille(
            inputPermille,
            level.curve_exponent_x10 ?? 15,
            level.curve_exponent_high_x10 ?? 15);
    } else {
        const progression = clamp(level.progression_pct || 0, 0, 100);
        curvePermille = Math.floor(
            ((100 - progression) * inputPermille +
                Math.floor(progression * inputPermille * inputPermille / 1000)) / 100);
    }
    const min = clamp(level.support_min_pct || 0, 0, 1000);
    const max = Math.max(min, clamp(level.support_max_pct || 0, 0, 1000));
    return min + Math.floor((max - min) * curvePermille / 1000);
}

function requestedPowerForLevel(level, xValue, chartMode, applyCeiling = true) {
    const mode = level.mode_type || 1;
    const humanPower = chartMode === 'power' ? xValue : humanPowerFromLoadKg(xValue);
    const loadKg = chartMode === 'load' ? xValue : loadKgFromHumanPower(xValue);

    let output = 0;
    if (mode === 1 || mode === 2 || mode === 6) {
        output = humanPower * supportRatioForPowerMode(level, humanPower) / 100;
    } else {
        const referenceVoltage = Math.max(12000, level.emtb_reference_voltage_mv || 36000);
        const deltaX160 = loadKg * 160 / 60;
        let targetX160;
        if (mode === 5) {
            targetX160 = deltaX160 * (level.torque_assist_factor || 0) / 120;
        } else {
            const cadence = level.emtb_based_on_power ? PREVIEW_CADENCE_RPM : 0;
            const denominator = Math.max(10, 510 - 2 * (level.emtb_parameter || 0) - cadence);
            targetX160 = deltaX160 * deltaX160 / denominator;
        }
        output = targetX160 * referenceVoltage * 160 / 1000000;
    }
    return applyCeiling ? Math.min(output, previewPowerCeilingW(level)) : output;
}

// FW-056: support view — the ratio the firmware applies, before the power and
// current ceilings. Derived from the same function as the power view so the two
// can never drift apart.
function supportRatioForChart(level, xValue, chartMode) {
    const humanPower = chartMode === 'power' ? xValue : humanPowerFromLoadKg(xValue);
    if (humanPower <= 0) {
        const mode = level.mode_type || 1;
        if (mode === 1) return level.support_ratio_pct || 0;
        if (mode === 2 || mode === 6) return level.support_min_pct || 0;
        return 0;
    }
    return requestedPowerForLevel(level, xValue, chartMode, false) / humanPower * 100;
}

function renderProfileChart() {
    const powerChart = el('ebicsProfileChart');
    const supportChart = el('ebicsProfileChartSupport');
    const selected = selectedLevel();
    const levels = selected.bank?.levels;
    if (!powerChart || typeof Plotly === 'undefined') return;
    const hasData = Array.isArray(levels) && levels.length > 0;
    const previewLevels = hasData
        ? levels.slice(0, LEVEL_NAMES.length)
        : (PROFILE_LEVEL_PLACEHOLDER_BANKS[selected.bankIndex] || PROFILE_LEVEL_PLACEHOLDER_BANKS[0]);
    const selectedMode = selected.level?.mode_type || levels?.[0]?.mode_type
        || parseInt(el('ebicsProfileModeSelect')?.value ?? '1', 10);
    const chartMode = (selectedMode === 1 || selectedMode === 2 || selectedMode === 6) ? 'power' : 'load';
    const x = chartMode === 'power'
        ? Array.from({ length: 21 }, (_, index) => index * 20)
        : Array.from({ length: 31 }, (_, index) => index * 2);
    const axisX = chartMode === 'power'
        ? 'Rider power (W)'
        : `Pedal load (kg) at ${PREVIEW_CADENCE_RPM} rpm reference`;
    const selectedLevelConfig = previewLevels[selected.levelIndex] || previewLevels[0] || {};
    // FW-056: mark where the curve tops out and where the power ceiling bites.
    const referenceShape = (chartMode === 'power' && (selectedMode === 2 || selectedMode === 6))
        ? [{
            type: 'line', yref: 'paper', y0: 0, y1: 1,
            x0: clamp(selectedLevelConfig.reference_power_w || 200, 50, 500),
            x1: clamp(selectedLevelConfig.reference_power_w || 200, 50, 500),
            line: { color: '#94a3b8', width: 1.5, dash: 'dash' },
        }]
        : [];

    const draw = (target, view) => {
        if (!target) return;
        const unit = view === 'support' ? '%' : 'W';
        const traces = previewLevels.map((level, index) => ({
            x,
            y: x.map((value) => {
                const merged = { ...level, mode_type: level.mode_type || selectedMode };
                return view === 'support'
                    ? supportRatioForChart(merged, value, chartMode)
                    : requestedPowerForLevel(merged, value, chartMode);
            }),
            name: hasData ? LEVEL_NAMES[index] : `${LEVEL_NAMES[index]} (placeholder)`,
            type: 'scatter',
            mode: 'lines',
            line: {
                width: index === selected.levelIndex ? 4 : 2.5,
                color: LEVEL_COLORS[index] || '#475569',
            },
            opacity: index === selected.levelIndex ? 1 : 0.92,
            hovertemplate: `${LEVEL_NAMES[index]}${hasData ? '' : ' (placeholder)'}<br>%{x}<br>%{y:.0f} ${unit}<extra></extra>`,
        }));
        const layout = profilePlotLayout(axisX,
            view === 'support' ? 'Support ratio (%)' : 'Requested motor power (W)');
        layout.shapes = referenceShape.slice();
        if (view === 'power' && selectedLevelConfig.max_motor_power_w > 0) {
            layout.shapes.push({
                type: 'line', xref: 'paper', x0: 0, x1: 1,
                y0: selectedLevelConfig.max_motor_power_w, y1: selectedLevelConfig.max_motor_power_w,
                line: { color: '#f87171', width: 1.5, dash: 'dot' },
            });
        }
        Plotly.react(target, traces, layout, { responsive: true, displaylogo: false });
    };

    draw(supportChart, 'support');
    draw(powerChart, 'power');
}

function updateLiveSummary(eventType = '') {
    const bankIndex = activeBankIndex();
    const levelIndex = currentLevelIndex();
    const level = state.lastBanks?.[bankIndex]?.levels?.[levelIndex];
    const load = getPedalLoadKg();
    const cadence = isNumber(state.controllerRealtime0?.cadence) ? state.controllerRealtime0.cadence : state.sensorRealtime?.cadence;
    const realtime = state.controllerRealtime1;
    const power = currentElectricalPower();
    const displayLevel = state.displayRealtime?.current_assist_level;

    setText('ebicsLiveBank', state.banksSynced ? `Bank ${bankIndex + 1}` : 'N/A');
    setText('ebicsLiveLevel', Number.isInteger(displayLevel) ? (displayLevel === 0 ? 'OFF' : LEVEL_NAMES[displayLevel - 1] || `Level ${displayLevel}`) : 'N/A');
    setText('ebicsLiveMode', level ? MODE_LABELS[level.mode_type] || `Mode ${level.mode_type}` : 'N/A');
    setText('ebicsLiveTorqueKg', displayNumber(load, 1));
    setText('ebicsLiveCadence', displayNumber(cadence));
    setText('ebicsLiveSpeed', displayNumber(realtime?.speed, 1));
    setText('ebicsLivePower', displayNumber(power));
    setText('ebicsLiveCurrent', displayNumber(realtime?.current, 1));
    setText('ebicsLiveControllerTemp', displayNumber(realtime?.temperature));
    setText('ebicsLiveMotorTemp', displayNumber(realtime?.motor_temperature));
    setText('ebicsLiveControllerState', state.controllerState?.state_number ?? 'N/A');
    setText('ebicsLiveRemainingCapacity', displayNumber(state.controllerRealtime0?.remaining_capacity));
    setText('ebicsLiveRemainingDistance', displayNumber(state.controllerRealtime0?.remaining_distance, 1));
    setText('ebicsLiveLastTrip', displayNumber(state.controllerRealtime0?.single_trip, 1));

    if (['controller_realtime_0', 'controller_realtime_1', 'sensor_realtime'].includes(eventType)) updateLiveChart(load, cadence, power, realtime?.speed);
}

function updateLiveChart(load, cadence, power, speed) {
    const now = Date.now();
    if (!el('tab-ebics-live')?.classList.contains('active')) return;
    if (now - liveChartLastUpdate < 300 || typeof Plotly === 'undefined') return;
    liveChartLastUpdate = now;
    liveHistory.time.push(new Date(now));
    liveHistory.load.push(isNumber(load) ? load : null);
    liveHistory.cadence.push(isNumber(cadence) ? cadence : null);
    liveHistory.power.push(isNumber(power) ? power : null);
    liveHistory.speed.push(isNumber(speed) ? speed : null);
    Object.values(liveHistory).forEach((values) => {
        if (values.length > 180) values.splice(0, values.length - 180);
    });
    const chart = el('ebicsLiveChart');
    if (!chart) return;
    const traces = [
        { x: liveHistory.time, y: liveHistory.load, name: 'Load (kg)', type: 'scatter', mode: 'lines', line: { color: '#2563eb' } },
        { x: liveHistory.time, y: liveHistory.cadence, name: 'Cadence (rpm)', type: 'scatter', mode: 'lines', line: { color: '#16a34a' } },
        { x: liveHistory.time, y: liveHistory.speed, name: 'Speed (km/h)', type: 'scatter', mode: 'lines', line: { color: '#9333ea' } },
        { x: liveHistory.time, y: liveHistory.power, name: 'Power (W)', type: 'scatter', mode: 'lines', yaxis: 'y2', line: { color: '#ea580c' } },
    ];
    const layout = plotLayout('Time', 'Load / cadence / speed');
    layout.yaxis2 = { title: 'Power (W)', overlaying: 'y', side: 'right', rangemode: 'tozero', gridcolor: 'transparent' };
    layout.margin.r = 58;
    Plotly.react(chart, traces, layout, { responsive: true, displaylogo: false });
}

function updateTorqueSummary() {
    const load = getPedalLoadKg();
    const safeLoad = isNumber(load) ? clamp(load, 0, 60) : 0;
    setText('ebicsTorqueKg', safeLoad.toFixed(1));
    const fill = el('ebicsTorqueGaugeFill');
    if (fill) fill.style.width = `${safeLoad / 60 * 100}%`;
    const level = selectedLevel().level || state.lastBanks?.[activeBankIndex()]?.levels?.[currentLevelIndex()];
    const minLoad = isNumber(level?.without_rotation_threshold_mv) ? level.without_rotation_threshold_mv / EBICS_MV_PER_KG : null;
    setText('ebicsTorqueMinLoadKg', displayNumber(minLoad, 1));
}

const CAL_STATE_LABELS = ['Idle', 'Capturing zero…', 'Apply reference weight', 'Capturing load…', 'Preview ready', 'Success', 'Failed', 'Cancelled'];
const CAL_ERROR_LABELS = ['None', 'Not stationary', 'Signal unstable', 'Reference out of range', 'Load too small', 'Sensor saturated', 'Computed scale out of range', 'Sensor fault', 'Timeout'];

// FW-013: refresh calibration/telemetry card from a 0x6025 snapshot.
export function updateTorqueCalUI(t) {
    if (!t) return;
    setText('ebicsTorqueSourcePill', torqueModel.source === 'firmware'
        ? `Scale: firmware (${torqueModel.calibrationSource === 'user' ? 'calibrated' : 'default'})`
        : 'Scale: default (estimated)');
    setText('ebicsTorqueKg', ((t.load_centikg || 0) / 100).toFixed(1));
    const fill = el('ebicsTorqueGaugeFill');
    if (fill) fill.style.width = `${clamp((t.load_centikg || 0) / 6000 * 100, 0, 100)}%`;
    setText('ebicsTorqueCalSource', t.calibration_source === 1 ? 'User calibrated' : 'Default');
    setText('ebicsTorqueZero', t.zero_effective_native ?? 'N/A');
    setText('ebicsTorqueFullScale', t.full_scale_native ?? 'N/A');
    setText('ebicsCalState', CAL_STATE_LABELS[t.calibration_state] ?? String(t.calibration_state));
    setText('ebicsCalError', CAL_ERROR_LABELS[t.calibration_error] ?? String(t.calibration_error));
    setText('ebicsCalPreviewSpan', t.preview_span_native ? `${t.preview_span_native}` : 'N/A');
    updateCoastDiag(t); // FW-061
}

// FW-061: coast re-zero diagnostics (torque telemetry v2). Answers the question
// "did the zero move, by how much, and if not — why not", which is impossible to
// tell from the load reading alone.
const COAST_RESULT_HINTS = {
    NONE: 'No coast evaluated yet since power-on.',
    APPLIED: 'The zero was corrected.',
    NO_CHANGE: 'Evaluated, but the zero was already on target (or drift is still awaiting confirmation).',
    TOO_SHORT: 'Coasts are ending before the 5.5 s window completes — the zero is simply never sampled.',
    UNSTABLE: 'The sampling window was too noisy to trust (rough surface, chain slap, foot shifting).',
    LOCKOUT: 'Blocked by the 60 s minimum between in-ride corrections.',
    OUT_OF_REACQUIRE_RANGE: 'Rest sits more than 40 mV off target — never corrected automatically. Check the sensor.',
    IMPLAUSIBLE_RAW: 'Raw baseline outside the plausible window — sensor fault territory.',
};

function updateCoastDiag(t) {
    const has = t.version >= 2;
    const dash = (v) => (has && v !== undefined && v !== null) ? v : '—';
    setText('coastLastResult', has ? t.coast_last_result : '—');
    setText('coastResultHint', has ? (COAST_RESULT_HINTS[t.coast_last_result] || '') : 'Needs firmware with torque telemetry v2.');
    setText('coastRaw', dash(t.raw_native));
    setText('coastZero', dash(t.zero_effective_native));
    setText('coastCandidate', dash(t.coast_candidate_native));
    setText('coastSpread', has ? `${t.coast_spread_mv} mV (limit 10)` : '—');
    setText('coastLastStep', has ? `${t.coast_last_step_mv > 0 ? '+' : ''}${t.coast_last_step_mv} mV` : '—');
    setText('coastOffset', has ? `${t.offset_correction_mv} mV` : '—');
    setText('coastLockout', has ? (t.coast_lockout_s ? `${t.coast_lockout_s} s` : 'ready') : '—');
    setText('coastState', has
        ? `${t.coast_active ? 'window open' : 'idle'}, ${t.coast_was_moving ? 'riding' : 'standstill'}`
        : '—');
    setText('coastWindows', has ? `${t.coast_windows_completed} / ${t.coast_windows_started}` : '—');
    setText('coastApplied', dash(t.coast_applied));
    setText('coastRejTooShort', dash(t.coast_rejected_too_short));
    setText('coastRejUnstable', dash(t.coast_rejected_unstable));
    setText('coastRejLockout', dash(t.coast_rejected_lockout));
    setText('coastRejRange', dash(t.coast_rejected_out_of_range));
    setText('coastRejImplausible', dash(t.coast_rejected_implausible));
    setText('coastNoChange', dash(t.coast_no_change));
}

// FW-015/017: TSDZ diagnostics card (peak + live)
export function updateDiagUI(d) {
    if (!d) return;
    // peak
    setText('diagCadence', d.cadence_for_assist);
    setText('diagTorque', d.torque_for_assist_mv);
    setText('diagHumanPower', d.human_power_w);
    setText('diagSupport', d.support_ratio_pct);
    setText('diagMotorPower', d.motor_power_w);
    setText('diagBatCurrent', d.requested_battery_current_ma);
    setText('diagIqRequest', d.iq_request);
    setText('diagIqSetpoint', d.iq_setpoint);
    setText('diagSpeed', (d.speed_x100 / 100).toFixed(1));
    // live (v2 only; null -> "—" so v1 firmware never shows a fake 0)
    const dash = (v) => (v === null || v === undefined) ? '—' : v;
    setText('diagPasIdle', dash(d.pas_idle_ms));
    setText('diagPedaling', d.pedaling_active === null ? '—' : (d.pedaling_active ? 'yes' : 'no'));
    setText('diagFastPressure', dash(d.fast_pressure));
    setText('diagRunPressure', dash(d.run_pressure)); // FW-033: slow RUN estimator
    setText('diagIqReqNow', dash(d.iq_request_now));
    setText('diagIqSetNow', dash(d.iq_setpoint_now));
    setText('diagIqMeasured', dash(d.measured_iq)); // FW-033: actual FOC current
    setText('diagBattLimit', d.battery_limiting === null ? '—' : (d.battery_limiting ? 'yes' : 'no'));
    // FW-061: these two fields were showing the wrong thing — the firmware packs
    // brake and torque-fault here, not pedal release / release latch.
    setText('diagRelease', d.brake_active === null ? '—' : (d.brake_active ? 'yes' : 'no'));
    setText('diagLatched', d.torque_fault === null ? '—' : (d.torque_fault ? 'yes' : 'no'));
}

// FW-017: stored fall ramps read from the tuning block (0x6023)
export function updateDiagTuning(t) {
    if (!t) return;
    setText('diagFallSlow', t.iq_fall_slow_ms ?? '—');
    setText('diagFallFast', t.iq_fall_fast_ms ?? '—');
}

// FW-018 status card (0x6028). FW-030/043: the engine fields are gone — TSDZ is the only
// engine — so this now only surfaces the full-charge SOC threshold that shares the frame.
export function updateEngineUI(s) {
    if (!s) return;
    // FW-018: full-charge pack-voltage threshold (100% anchor)
    const v = s.soc_full_pack_v; // volts, or null when unset / unavailable (old firmware)
    setText('ebicsSocFullActive', v == null
        ? (s.soc_full_pack_mv === null ? 'Unavailable (older firmware)' : 'Not set')
        : `${v.toFixed(1)} V`);
    const input = el('ebicsSocFullInput');
    if (input && document.activeElement !== input && v != null) input.value = v.toFixed(1);
}

function ensureTuningDefaults() {
    if (!state.lastTuning) {
        state.lastTuning = {
            iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
            iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
            startup_boost_cadence_step: 20,
            assist_run_deadband_mv: 5, assist_hold_ms: 1400, assist_min_iq_pct: 2,
            assist_torque_run_filter_ms: 300,
        };
    } else {
        // FW-032/033: an older controller read won't include these fields — backfill defaults.
        if (state.lastTuning.assist_run_deadband_mv == null) state.lastTuning.assist_run_deadband_mv = 5;
        if (state.lastTuning.assist_hold_ms == null) state.lastTuning.assist_hold_ms = 1400;
        if (state.lastTuning.assist_min_iq_pct == null) state.lastTuning.assist_min_iq_pct = 2;
        if (state.lastTuning.assist_torque_run_filter_ms == null) state.lastTuning.assist_torque_run_filter_ms = 300;
    }
}

function renderDynamics() {
    ensureTuningDefaults();
    const groups = [
        { container: el('ebicsDynamicsAccelerationFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('iq_rise_')) },
        { container: el('ebicsDynamicsDecelerationFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('iq_fall_')) },
        { container: el('ebicsDynamicsBoostFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('startup_boost_')) },
        { container: el('ebicsDynamicsLatchFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('assist_run_') || field.key.startsWith('assist_hold_') || field.key.startsWith('assist_min_')) },
        { container: el('ebicsDynamicsTorqueRunFields'), fields: TUNING_FIELDS.filter((field) => field.key.startsWith('assist_torque_run_')) },
    ];
    groups.forEach((group) => {
        if (!group.container) return;
        group.container.innerHTML = '';
        group.fields.forEach((field) => fieldInput(group.container, state.lastTuning, field, renderDynamicsCharts));
    });
    renderDynamicsCharts();
}

function renderDynamicsCharts() {
    if (typeof Plotly === 'undefined') return;
    ensureTuningDefaults();
    const tuning = state.lastTuning;
    const rampTrace = (duration, falling, name, color, chartEnd) => ({
        x: [0, duration, chartEnd],
        y: falling ? [100, 0, 0] : [0, 100, 100],
        name,
        type: 'scatter',
        mode: 'lines+markers',
        line: { width: 3, color },
        marker: { size: [10, 10, 5], color, line: { width: 2, color: '#ffffff' } },
        hovertemplate: '%{x:.0f} ms<br>%{y:.0f}%<extra>%{fullData.name}</extra>',
    });
    const rampLayout = (chartEnd, startText, endText) => {
        const layout = plotLayout('Time from target change (ms)', 'Current command (%)');
        // Declare the height (like profilePlotLayout does). Without it Plotly falls back to its
        // own default (450px) while .ebics-chart only reserves min-height, so the chart painted
        // over the card below it.
        layout.height = DYNAMICS_CHART_HEIGHT;
        layout.xaxis.range = [0, chartEnd];
        layout.yaxis.range = [-5, 105];
        layout.hovermode = 'closest';
        layout.annotations = [
            { x: 0, y: startText === '0%' ? 0 : 100, text: `Start ${startText}`, showarrow: true, arrowhead: 2, ax: 42, ay: startText === '0%' ? -28 : 28 },
            { x: chartEnd, y: endText === '100%' ? 100 : 0, text: `Settled ${endText}`, showarrow: false, xanchor: 'right', yshift: endText === '100%' ? -16 : 16 },
        ];
        return layout;
    };

    const riseEnd = Math.max(tuning.iq_rise_slow_ms, tuning.iq_rise_fast_ms, 100) * 1.15;
    const accelerationChart = el('ebicsDynamicsAccelerationChart');
    if (accelerationChart) Plotly.react(accelerationChart, [
        rampTrace(tuning.iq_rise_slow_ms, false, `Low speed — ${tuning.iq_rise_slow_ms} ms`, '#2563eb', riseEnd),
        rampTrace(tuning.iq_rise_fast_ms, false, `High speed — ${tuning.iq_rise_fast_ms} ms`, '#16a34a', riseEnd),
    ], rampLayout(riseEnd, '0%', '100%'), { responsive: true, displaylogo: false });

    const fallEnd = Math.max(tuning.iq_fall_slow_ms, tuning.iq_fall_fast_ms, 100) * 1.15;
    const decelerationChart = el('ebicsDynamicsDecelerationChart');
    if (decelerationChart) Plotly.react(decelerationChart, [
        rampTrace(tuning.iq_fall_slow_ms, true, `Low speed — ${tuning.iq_fall_slow_ms} ms`, '#ea580c', fallEnd),
        rampTrace(tuning.iq_fall_fast_ms, true, `High speed — ${tuning.iq_fall_fast_ms} ms`, '#9333ea', fallEnd),
    ], rampLayout(fallEnd, '100%', '0%'), { responsive: true, displaylogo: false });

    const profile = selectedLevel().level || state.lastBanks?.[activeBankIndex()]?.levels?.[currentLevelIndex()];
    const strength = profile?.startup_boost_enabled ? profile.startup_boost_strength_pct || 0 : 0;
    const endRpm = Math.max(10, profile?.startup_boost_end_rpm || 90);
    const cadence = Array.from({ length: Math.ceil(endRpm / 5) + 1 }, (_, index) => index * 5);
    const fade = clamp((256 - tuning.startup_boost_cadence_step) / 256, 0, 1);
    const boost = cadence.map((rpm) => strength * Math.pow(fade, rpm / 5));
    const boostChart = el('ebicsDynamicsBoostChart');
    const boostLayout = plotLayout('Cadence (rpm)', 'Boost (%)');
    boostLayout.height = DYNAMICS_CHART_HEIGHT; // see rampLayout: keeps it inside its own card
    if (boostChart) Plotly.react(boostChart, [{ x: cadence, y: boost, name: 'Boost', type: 'scatter', mode: 'lines', fill: 'tozeroy', line: { width: 3, color: '#2563eb' } }], boostLayout, { responsive: true, displaylogo: false });
}

function updateLimitsSummary(forceChart = false) {
    const selection = selectedLevel('ebicsLimitsBankSelect', 'ebicsLimitsLevelSelect');
    const level = selection.level;
    const batteryLimit = state.controllerParams1?.current_limit;
    const motorLimit = state.controllerParams1?.max_current_on_low_charge;
    const liveCurrent = state.controllerRealtime1?.current;
    const livePower = currentElectricalPower();
    setText('ebicsLimitBatteryCurrent', displayNumber(batteryLimit));
    setText('ebicsLimitMotorCurrent', displayNumber(motorLimit));
    setText('ebicsLimitPower', displayNumber(level?.max_motor_power_w));
    setText('ebicsLimitIq', displayNumber(level?.max_iq_pct));
    setText('ebicsLimitLiveCurrent', displayNumber(liveCurrent, 1));
    setText('ebicsLimitLivePower', displayNumber(livePower));

    const chart = el('ebicsLimitsChart');
    if (!chart || typeof Plotly === 'undefined') return;
    const now = Date.now();
    if (!forceChart && (!el('tab-ebics-limits')?.classList.contains('active') || now - limitsChartLastUpdate < 300)) return;
    limitsChartLastUpdate = now;
    const currentPct = isNumber(liveCurrent) && isNumber(batteryLimit) && batteryLimit > 0 ? 100 * liveCurrent / batteryLimit : null;
    const powerPct = isNumber(livePower) && isNumber(level?.max_motor_power_w) && level.max_motor_power_w > 0 ? 100 * livePower / level.max_motor_power_w : null;
    Plotly.react(chart, [
        { x: ['Battery current', 'Motor power'], y: [currentPct, powerPct], name: 'Live / ceiling', type: 'bar', marker: { color: ['#2563eb', '#16a34a'] }, text: [currentPct, powerPct].map((value) => isNumber(value) ? `${value.toFixed(0)}%` : 'N/A'), textposition: 'auto' },
        { x: ['Battery current', 'Motor power'], y: [100, level?.max_motor_power_w > 0 ? 100 : null], name: 'Configured ceiling', type: 'bar', marker: { color: '#cbd5e1' } },
    ], { ...plotLayout('', 'Configured ceiling (%)'), barmode: 'group', yaxis: { title: 'Configured ceiling (%)', range: [0, Math.max(120, currentPct || 0, powerPct || 0)], gridcolor: '#e2e8f0' } }, { responsive: true, displaylogo: false });
}

function updateWalkAndLegacy() {
    const p0 = state.controllerParams0;
    const p1 = state.controllerParams1;
    const p2 = state.controllerParams2;
    const walkBankIndex = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank ?? 0;
    const walkBank = state.banksSynced ? state.lastBanks?.[walkBankIndex] : null;
    setText('ebicsWalkCurrent', walkBank?.wa_current_pct ?? 'N/A');
    setText('ebicsWalkSpeed', displayNumber(walkBank?.wa_target_rpm, 0));
    const rows = [
        ['0x6010', 'Acceleration table entries', p0?.acceleration_levels?.length ?? 'N/A'],
        ['0x6010', 'Assist-ratio table entries', p0?.assist_ratio_levels?.length ?? 'N/A'],
        ['0x6011', 'System voltage', isNumber(p1?.system_voltage) ? `${p1.system_voltage} V` : 'N/A'],
        ['0x6011', 'Battery current limit', isNumber(p1?.current_limit) ? `${p1.current_limit} A` : 'N/A'],
        ['0x6011', 'Stored low-charge current byte', isNumber(p1?.max_current_on_low_charge) ? `${p1.max_current_on_low_charge} A` : 'N/A'],
        ['0x6020', 'Walk motor current', walkBank?.wa_current_pct != null ? `${walkBank.wa_current_pct} %` : 'N/A'],
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

export function updateEbicsUI(eventType = '') {
    if (!isEbicsUIAvailable()) return;
    updateEbicsCompatibilityUI(eventType);
    const fullUpdate = !eventType;
    if (fullUpdate || ['controller_realtime_0', 'controller_realtime_1', 'controller_state', 'sensor_realtime', 'display_realtime', 'controller_bank'].includes(eventType)) {
        updateLiveSummary(eventType);
        updateTorqueSummary();
    }
    if (fullUpdate || ['controller_realtime_1', 'controller_params_1', 'controller_bank'].includes(eventType)) {
        updateLimitsSummary(fullUpdate);
    }
    if (fullUpdate || ['controller_params_0', 'controller_params_1', 'controller_params_2'].includes(eventType)) updateWalkAndLegacy();
    if (fullUpdate || eventType === 'controller_bank') renderProfileEditor();
    if (fullUpdate || eventType === 'controller_tuning') renderDynamics();
}

function bindControls() {
    populateSelects();
    ['ebicsProfileBankSelect', 'ebicsProfileLevelSelect'].forEach((id) => el(id)?.addEventListener('change', renderProfileEditor));
    el('ebicsCadenceCompEnabled')?.addEventListener('change', () => { //FW-057
        const selected = selectedLevel();
        if (!selected.bank) return;
        selected.bank.cadence_comp_enabled = el('ebicsCadenceCompEnabled').checked;
    });
    el('ebicsProfileModeSelect')?.addEventListener('change', () => {
        const selected = selectedLevel();
        const level = selected.level || placeholderLevel(selected.bankIndex, selected.levelIndex);
        level.mode_type = parseInt(el('ebicsProfileModeSelect').value, 10);
        // FW-056: gamma and progression share one wire byte, so entering Power
        // Curve without a stored gamma must land on the 1.5 default rather than
        // reinterpreting whatever the progression slider happened to hold.
        if (level.mode_type === 6) {
            if (!(level.curve_exponent_x10 >= 3 && level.curve_exponent_x10 <= 25)) {
                level.curve_exponent_x10 = 15;
            }
            if (!(level.curve_exponent_high_x10 >= 3 && level.curve_exponent_high_x10 <= 25)) {
                level.curve_exponent_high_x10 = 15;
            }
        }
        renderProfileEditor();
        updateLiveSummary();
    });
    ['ebicsLimitsBankSelect', 'ebicsLimitsLevelSelect'].forEach((id) => el(id)?.addEventListener('change', updateLimitsSummary));

    el('ebicsProfilesReadButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        addLog('REQ', 'Reading eVistDrive profile banks...');
        socket.send('READ_BANK:0');
        setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send('READ_BANK:1'); }, 400);
    });
    el('ebicsProfilesApplyButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        const selected = selectedLevel();
        if (!selected.bank) { addLog('ERR', 'No eVistDrive bank data to apply.'); return; }
        if (!state.ebicsReceivedBanks?.[selected.bankIndex]) {
            addLog('ERR', `Read eVistDrive bank ${selected.bankIndex + 1} before writing changes.`);
            return;
        }
        // FW-056: the controller validates every level and rejects the whole blob
        // on an unknown mode, so catch it here with a readable reason.
        const blocked = (selected.bank.levels || []).findIndex(
            (lv) => modeUnsupportedReason(lv.mode_type) === 'old-firmware');
        if (blocked >= 0) {
            const label = MODE_LABELS[selected.bank.levels[blocked].mode_type];
            addLog('ERR', `${LEVEL_NAMES[blocked]} uses "${label}", which this controller's firmware cannot store. Writing would be rejected and your current settings kept. Flash newer firmware or pick another mode.`);
            return;
        }
        socket.send(`WRITE_BANK:${JSON.stringify(selected.bank)}`);
        addLog('SAVE_REQ', `eVistDrive bank ${selected.bankIndex + 1} -> controller RAM`);
    });
    el('ebicsProfilesSaveButton')?.addEventListener('click', () => {
        if (!socketReady() || !confirm('Persist both eVistDrive banks and tuning to flash at full standstill?')) return;
        socket.send('SAVE_BANKS');
        addLog('SAVE_REQ', 'Persist eVistDrive banks and tuning at standstill');
    });
    el('ebicsDynamicsReadButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        socket.send('READ_TUNING');
        addLog('REQ', 'Reading eVistDrive global tuning...');
    });
    el('ebicsDynamicsApplyButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        if (!state.tuningSynced) {
            addLog('ERR', 'Read eVistDrive tuning before writing changes.');
            return;
        }
        ensureTuningDefaults();
        socket.send(`WRITE_TUNING:${JSON.stringify(state.lastTuning)}`);
        addLog('SAVE_REQ', 'eVistDrive tuning -> controller RAM');
    });
    el('ebicsDynamicsSaveButton')?.addEventListener('click', () => {
        if (!socketReady() || !confirm('Persist eVistDrive tuning and banks to flash at full standstill?')) return;
        socket.send('SAVE_BANKS');
        addLog('SAVE_REQ', 'Persist eVistDrive tuning and banks at standstill');
    });

    // FW-013: torque telemetry live read + load calibration operations
    el('ebicsTorqueReadButton')?.addEventListener('click', () => {
        if (socketReady()) { socket.send('READ_TORQUE'); addLog('REQ', 'Reading torque telemetry'); }
    });
    const calRefCentikg = () => {
        const kg = parseFloat(el('ebicsCalRefKg')?.value);
        return (isNumber(kg) && kg > 0) ? Math.round(kg * 100) : 0;
    };
    const calOp = (op, ref) => {
        if (!socketReady()) return;
        socket.send(`TORQUE_CAL:${op}${ref !== undefined ? ':' + ref : ''}`);
        setTimeout(() => socket.send('READ_TORQUE'), 300); // refresh status after the op
    };
    el('ebicsCalStart')?.addEventListener('click', () => { calOp(1); addLog('REQ', 'Calibration: start (capture zero)'); });
    el('ebicsCalCapture')?.addEventListener('click', () => {
        const ref = calRefCentikg();
        if (ref < 500 || ref > 3000) { alert('Reference weight must be 5–30 kg.'); return; }
        calOp(2, ref); addLog('REQ', `Calibration: capture ${ref / 100} kg`);
    });
    el('ebicsCalSave')?.addEventListener('click', () => { calOp(3); addLog('SAVE_REQ', 'Calibration: commit (saved at standstill)'); });
    el('ebicsCalCancel')?.addEventListener('click', () => { calOp(4); addLog('REQ', 'Calibration: cancel'); });
    el('ebicsCalRestore')?.addEventListener('click', () => {
        if (!confirm('Restore the default sensor scale (discard user calibration)?')) return;
        calOp(5); addLog('REQ', 'Calibration: restore default');
    });

    // FW-030/043: the whole "Ride engine (developer)" card is gone (single TSDZ engine), so its
    // Read/Set buttons no longer exist. READ_SYSTEM — still needed for the FW-018 full-charge SOC
    // threshold that shares 0x6028 — is sent automatically on connect and on tab open (below).

    // FW-018: full-charge pack-voltage threshold (100% anchor)
    el('ebicsSocFullSaveButton')?.addEventListener('click', () => {
        if (!socketReady()) return;
        const volts = parseFloat(el('ebicsSocFullInput')?.value);
        if (!(volts >= 20 && volts <= 90)) { alert('Enter the measured full-charge pack voltage in the range 20–90 V.'); return; }
        const pack10mv = Math.round(volts * 100); // V -> units of 10 mV
        socket.send(`SET_SOC_FULL:${pack10mv}`);
        addLog('REQ', `Full-charge voltage -> ${volts.toFixed(1)} V (saves at standstill)`);
    });

    // FW-015/017: diagnostics read + auto-poll (10 Hz) + stored fall-ramp read
    let diagTimer = null;
    const stopDiagPoll = () => { if (diagTimer) { clearInterval(diagTimer); diagTimer = null; } const cb = el('ebicsDiagAuto'); if (cb) cb.checked = false; };
    el('ebicsDiagReadButton')?.addEventListener('click', () => {
        if (socketReady()) socket.send('READ_DIAG');
    });
    el('ebicsDiagTuningButton')?.addEventListener('click', () => {
        if (socketReady()) { socket.send('READ_TUNING'); addLog('REQ', 'Reading stored fall ramps'); }
    });
    el('ebicsDiagAuto')?.addEventListener('change', (e) => {
        if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
        if (e.target.checked && socketReady()) {
            diagTimer = setInterval(() => { if (socketReady()) socket.send('READ_DIAG'); else stopDiagPoll(); }, 100); // 10 Hz
        }
    });

    window.addEventListener('app-tab-changed', (event) => {
        const tab = String(event.detail?.tab || '');
        if (tab.startsWith('ebics-')) updateEbicsUI();
        if (tab === 'ebics-torque' && socketReady()) socket.send('READ_TORQUE');
        if (tab === 'ebics-system' && socketReady()) socket.send('READ_SYSTEM');
        // FW-018: full-charge voltage field lives in the eVistDrive Limits tab -> read its current value there
        if (tab === 'ebics-limits' && socketReady()) socket.send('READ_SYSTEM');
        // FW-017: stop the diagnostics poll whenever we leave the System tab
        if (tab !== 'ebics-system') stopDiagPoll();
    });
    window.addEventListener('controller-flavor-changed', () => updateEbicsUI());
}

bindControls();
updateEbicsUI();
