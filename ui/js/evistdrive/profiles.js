// evistdrive/profiles.js — eVistDrive Profiles card: the level editor and its preview charts
/* global Plotly */
import { state, socket, addLog, isEbicsConnected } from '../shared.js';
// FW-056: the exact table and evaluation the controller runs, emitted by the same
// firmware generator, so the preview draws the real curve and not a lookalike.
import { evalPowerCurvePermille } from './power-curve-lut.js';
import {
    LEVEL_NAMES, LEVEL_COLORS, MODE_LABELS, PREVIEW_CADENCE_RPM, EBICS_MV_PER_KG,
    el, isNumber, clamp, hexToRgba, socketReady, selectedLevel, tabIsVisible,
    bankSchemaVersion, modeUnsupportedReason, populateSelects, fieldInput, plotLayout,
} from './common.js';
import { updateTorqueSummary } from './torque.js';
import { updateLimitsSummary } from './limits.js';
import { updateLiveSummary } from './live.js';

const HUMAN_POWER_CENTIKG_RPM_NUMERATOR = 1694;
const HUMAN_POWER_CENTIKG_RPM_DENOMINATOR = 1000;

function tintProfileCards(levelIndex) {
    const tint = hexToRgba(LEVEL_COLORS[levelIndex] || '#475569', 0.16);
    ['ebicsProfileModeCard', 'ebicsProfileSharedCard', 'ebicsProfileChartCard'].forEach((id) => {
        const node = el(id);
        if (node) node.style.backgroundColor = tint;
    });
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
// The offline editing surface. Handing out the objects from PROFILE_LEVEL_PLACEHOLDER_BANKS
// directly meant that editing a field with no bike attached permanently overwrote the
// project's own factory defaults for the rest of the session — so "back to defaults" would
// have restored whatever had last been typed. The defaults table is now a read-only
// reference and this working copy is what the editor touches.
let placeholderWorkingBanks = null;
function placeholderBanks() {
    if (!placeholderWorkingBanks) {
        placeholderWorkingBanks = JSON.parse(JSON.stringify(PROFILE_LEVEL_PLACEHOLDER_BANKS));
    }
    return placeholderWorkingBanks;
}

// The level the editor writes into when nothing has been read from the controller.
export function offlineWorkingLevel(bankIndex, levelIndex) {
    const banks = placeholderBanks();
    const bank = banks[bankIndex] || banks[0];
    return bank[levelIndex] || bank[0];
}
const placeholderLevel = offlineWorkingLevel;

// A copy of the firmware boot defaults. Always a copy: hand out the original and the next
// edit silently redefines what "default" means.
export function firmwareDefaultLevel(bankIndex, levelIndex) {
    const bank = PROFILE_LEVEL_PLACEHOLDER_BANKS[bankIndex] || PROFILE_LEVEL_PLACEHOLDER_BANKS[0];
    return JSON.parse(JSON.stringify(bank[levelIndex] || bank[0]));
}

// Throw away offline edits for one bank and take a fresh copy of the defaults.
function resetPlaceholderBank(bankIndex) {
    const banks = placeholderBanks();
    const source = PROFILE_LEVEL_PLACEHOLDER_BANKS[bankIndex] || PROFILE_LEVEL_PLACEHOLDER_BANKS[0];
    banks[bankIndex] = JSON.parse(JSON.stringify(source));
}

// CB-012: what a Restore should put back for one level — the values as read from the
// controller when there are any, otherwise the firmware defaults. Always a fresh copy, so
// the caller cannot write back through it into the source.
function restoreSourceLevel(bankIndex, levelIndex) {
    const read = state.lastBanksAsRead?.[bankIndex]?.levels?.[levelIndex];
    if (read) return { source: 'read', level: JSON.parse(JSON.stringify(read)) };
    const bank = PROFILE_LEVEL_PLACEHOLDER_BANKS[bankIndex] || PROFILE_LEVEL_PLACEHOLDER_BANKS[0];
    const level = bank[levelIndex] || bank[0];
    return { source: 'defaults', level: JSON.parse(JSON.stringify(level)) };
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
    // Not named `state`: that would shadow the imported ride state for this whole function.
    const stateBadge = el('ebicsCadenceCompState');
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
    if (stateBadge) stateBadge.textContent = badge;
    if (note) note.textContent = status + CADENCE_COMP_DESCRIPTION;
    if (strip) {
        strip.classList.toggle('is-on', enabled && supported && !!bank);
        strip.classList.toggle('is-blocked', blocked);
    }
}

export function renderProfileEditor() {
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
    // CB-012: each field learns where its own "put it back" value comes from, so Shift+click
    // on one field restores only that one.
    const withRestore = (field) => ({
        ...field,
        restoreValue: () => {
            const { source, level: original } = restoreSourceLevel(selected.bankIndex, selected.levelIndex);
            return { value: original[field.key], source };
        },
    });
    modeFields(mode).forEach((field) => fieldInput(modeContainer, level, withRestore(field), refresh));
    sharedFields().forEach((field) => fieldInput(sharedContainer, level, withRestore(field), refresh));
    renderProfileChart();
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

export function humanPowerFromLoadKg(loadKg, cadenceRpm = PREVIEW_CADENCE_RPM) {
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

export function renderProfileChart() {
    const powerChart = el('ebicsProfileChart');
    const supportChart = el('ebicsProfileChartSupport');
    const selected = selectedLevel();
    const levels = selected.bank?.levels;
    if (!powerChart || typeof Plotly === 'undefined') return;
    // Two charts, five traces each. Skipped while the card is hidden and redrawn on the
    // way in (see the app-tab-changed handler in index.js), so nothing is ever stale.
    if (!tabIsVisible('tab-ebics-profiles')) return;
    const hasData = Array.isArray(levels) && levels.length > 0;
    const previewLevels = hasData
        ? levels.slice(0, LEVEL_NAMES.length)
        // The working copy, not the pristine defaults: offline edits must still show up on
        // the chart, and the editor writes into the working copy.
        : (placeholderBanks()[selected.bankIndex] || placeholderBanks()[0]);
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

export function bindProfileControls() {
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

    // CB-012: undo a session of clicking, for the whole selected bank. Only touches what is
    // on screen — the bike keeps its settings until Write (RAM) is pressed.
    el('ebicsProfilesRestoreButton')?.addEventListener('click', () => {
        const selected = selectedLevel();
        const read = state.lastBanksAsRead?.[selected.bankIndex];
        const label = read ? 'the values read from the controller' : 'the firmware defaults';
        if (!confirm(`Put bank ${selected.bankIndex + 1} back to ${label}?\n\nThis only changes what you see here. Nothing is sent to the bike until you press "Write (RAM)".`)) return;

        if (read) {
            state.lastBanks[selected.bankIndex] = JSON.parse(JSON.stringify(read));
        } else {
            // Nothing was ever read, so the editor is working on the offline copy: rebuild
            // it from the untouched defaults table.
            resetPlaceholderBank(selected.bankIndex);
        }
        renderProfileEditor();
        updateLimitsSummary();
        addLog('INFO', `Bank ${selected.bankIndex + 1} put back to ${label}. Not written to the bike — press "Write (RAM)" to apply.`);
    });
}
