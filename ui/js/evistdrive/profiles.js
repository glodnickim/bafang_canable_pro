// evistdrive/profiles.js — eVistDrive Profiles card: the level editor and its preview charts
/* global Plotly */
import { state, socket, addLog, isEbicsConnected } from '../shared.js';
import { markUnsavedInRam } from './global-actions.js';
// FW-056: the exact table and evaluation the controller runs, emitted by the same
// firmware generator, so the preview draws the real curve and not a lookalike.
import { evalPowerCurvePermille } from './power-curve-lut.js';
import {
    M820_MAX_TORQUE_NM, iqPercentToTorqueNm, torqueNmToIqPercent,
} from './motor-limits.js';
import {
    LEVEL_NAMES, LEVEL_COLORS, MODE_LABELS, PREVIEW_CADENCE_RPM,
    el, isNumber, clamp, hexToRgba, socketReady, selectedLevel, tabIsVisible,
    writeBankAndWait,
    bankSchemaVersion, modeUnsupportedReason, populateSelects, fieldInput, plotLayout,
    updateFieldDisplays, markReadNeeded,
    RAMP_SPEED_LO_KMH, RAMP_SPEED_HI_KMH, RAMP_CADENCE_LO_RPM, RAMP_CADENCE_HI_RPM,
} from './common.js';
import { updateTorqueSummary } from './torque.js';
import { updateLiveSummary } from './live.js';
import { updateEnginePreviewUI } from './engine-preview-ui.js';
// The one chart on this tab that is an input rather than a picture. It is handed everything
// it needs as arguments and imports nothing back from here, so the dependency stays one-way.
import { renderLevelCurve, bindLevelCurveControls } from './level-curve.js';
import {
    chartHost, frozenAxis, drawEditable, handleTraces, pinned,
    fieldHandle, handleEditor, descriptorOf, toDisplayValue, solveOnGrid,
} from './editable-chart.js';

const HUMAN_POWER_CENTIKG_RPM_NUMERATOR = 1694;
const HUMAN_POWER_CENTIKG_RPM_DENOMINATOR = 1000;
const kgWithOneDecimal = (value) => Math.round(value * 10) / 10;
const displayKgWithOneDecimal = (value) => kgWithOneDecimal(value).toFixed(1);
// FW-084: the Extended Boost trigger is the one kg field on a 0.5 kg grid — one wire byte
// had to span the whole 60 kg sensor scale, and 0.5 rather than 0.25 so every storable value
// is exact at ONE decimal place like the other kg fields. Rounding it on the 0.1 kg grid
// would show the rider a value the controller cannot store.
const kgWithHalf = (value) => Math.round(value * 2) / 2;
const displayKgWithHalf = (value) => kgWithHalf(value).toFixed(1);

function tintProfileCards(levelIndex) {
    const tint = hexToRgba(LEVEL_COLORS[levelIndex] || '#475569', 0.16);
    // FW-069/071: the ramp charts belong to the edited LEVEL, exactly like the engine preview,
    // so they carry the level colour too. Without it they were the only per-level cards on the
    // page left white, which read as "these are global" — the opposite of what they are.
    ['ebicsProfileModeCard', 'ebicsProfileSharedCardLeft', 'ebicsProfileSharedCard', 'ebicsProfileChartCard'].forEach((id) => {
        const node = el(id);
        if (node) node.style.backgroundColor = tint;
    });
}

function modeFields(mode) {
    if (mode === 2) {
        return [
            { key: 'support_min_pct', label: 'Minimum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used at very low pedal power, before "Reference rider power" is reached. Lower values make genuinely light assistance easier; higher values make the motor contribute more even on a gentle pedal input.' },
            { key: 'support_max_pct', label: 'Maximum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used once your pedal power reaches "Reference rider power" (or goes above it). Higher values give a stronger top end; lower values keep hard pedalling more natural.' },
            { key: 'reference_power_w', label: 'Reference rider power', unit: 'W', min: 20, max: 1000, step: 10,
                help: 'Rider power at which support ramps from Minimum to Maximum. Lower values reach Maximum support sooner; higher values require more rider effort before the full support ratio is used.' },
            { key: 'progression_pct', label: 'Progression', unit: '%', min: 0, max: 100, step: 5,
                help: 'Shapes the ramp from Minimum to Maximum support between 0 W and Reference rider power: 0% = straight line, higher curves it so support builds up faster as you approach Reference rider power.' },
        ];
    }
    if (mode === 6) {
        // FW-056: same support window as Power Progressive, but the shape is one
        // exponent instead of a blend of a straight and a squared curve.
        return [
            { key: 'support_min_pct', label: 'Minimum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used at very low pedal power, before "Reference rider power" is reached. Lower values make genuinely light assistance easier; higher values make the motor contribute more even on a gentle pedal input.' },
            { key: 'support_max_pct', label: 'Maximum support', unit: '%', min: 0, max: 1000, step: 10,
                help: 'Support percentage used once your pedal power reaches "Reference rider power" (or goes above it). Higher values give a stronger top end; lower values keep hard pedalling more natural.' },
            { key: 'reference_power_w', label: 'Reference rider power', unit: 'W', min: 20, max: 1000, step: 10,
                help: 'Rider power at which support reaches Maximum. Lower values reach Maximum support sooner; higher values reserve it for harder rider effort. The curve below shapes everything between 0 W and this value.' },
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
                help: 'How aggressively motor power reacts to pedal load: pedal load is squared internally, so a firm push gives noticeably more than proportionally more assist than a light one. Higher values are stronger and more sensitive; 0 disables eMTB assist for this level.' },
            { key: 'emtb_based_on_power', label: 'Cadence-dependent response', type: 'checkbox',
                help: 'On: higher cadence reduces the eMTB response for the same pedal load, pairing load with effort. Off: only pedal load matters, cadence is ignored.' },
            {
                key: 'emtb_reference_voltage_mv', label: 'Reference voltage', unit: 'V', min: 12, max: 84, step: 1,
                fromNative: (value) => Math.round(value / 1000), toNative: (value) => Math.round(value * 1000),
                help: 'Battery voltage used only to convert the internal current target into the watts shown on the display/diagnostics — it does NOT change how hard the motor actually pushes. Set close to your pack’s real voltage so displayed watts are meaningful. Exception: if "Maximum motor power" below is set (non-zero), that power limit IS computed using this value, so setting it too low makes the power limit trigger earlier than intended. Set it to your pack\'s nominal voltage; a wrong value only makes the displayed watts wrong.',
            },
        ];
    }
    if (mode === 5) {
        return [
            {
                key: 'torque_assist_factor', label: 'Torque gain — 120 = 1.0×', min: 0, max: 254, step: 5,
                help: 'Scales the torque-derived target. Higher values give more motor current for the same pedal load; lower values make light assistance easier. Unlike Support %, it does not multiply estimated rider power.',
            },
        ];
    }
    return [{ key: 'support_ratio_pct', label: 'Rider power support', unit: '%', min: 0, max: 1000, step: 10,
        help: 'Motor power as a percentage of your estimated pedal power — e.g. 100% ≈ motor roughly matches your effort, 200% ≈ motor gives roughly double. Higher values are stronger; lower values make fine, low assistance easier. Main strength knob for Power Linear levels.' }];
}

/*
 * FW-071: the shared settings are grouped, and each group is a copy unit.
 *
 * The grouping is not decoration. "Copy to…" works per section, so a section that lumped
 * everything together would force an all-or-nothing copy and be useless for the case riders
 * actually have — identical ramps everywhere, different strength per level. Each group is
 * therefore something a rider would sensibly want to make uniform on its own.
 */
function sharedFieldGroups() {
    const all = sharedFieldList();
    const pick = (...keys) => keys.map((key) => all.find((field) => field.key === key));
    // A group is only as new as its newest field. Deriving the gate instead of repeating the
    // number means the section and the preset importer can never disagree about which
    // firmware can store it — they read the same property off the same descriptors.
    const gated = (groups) => groups.map((group) => ({
        ...group,
        minBankSchema: Math.max(0,
            ...group.fields.filter(Boolean).map((field) => field.minBankSchema || 0)) || undefined,
    }));
    return gated([
        {
            id: 'limits',
            title: 'Power and current ceiling',
            fields: pick('max_motor_power_w', 'max_iq_pct'),
        },
        {
            id: 'start',
            title: 'Start condition',
            note: 'When assist is allowed to begin. The crank-movement half of the condition is global — see the band at the bottom of this tab.',
            fields: pick('assist_without_rotation', 'minimum_pedal_load_kg',
                'riding_minimum_pedal_load_kg'),
        },
        {
            id: 'launch',
            title: 'Launch feel — boost and smooth start',
            fields: pick('startup_boost_enabled', 'startup_boost_strength_pct',
                'startup_boost_end_rpm', 'smooth_start_enabled', 'smooth_start_ms'),
        },
        {
            id: 'ramps',
            title: 'Current ramps — acceleration and deceleration',
            fields: pick('iq_rise_slow_ms', 'iq_rise_fast_ms', 'iq_fall_slow_ms', 'iq_fall_fast_ms'),
        },
        {
            id: 'smoothing',
            title: 'Power smoothing and release',
            fields: pick('release_ms', 'power_rise_filter_ms', 'power_fall_filter_ms'),
        },
        // FW-084. Kept as its own section on purpose: it is the one group here that can keep
        // the motor pushing with the cranks stationary, and "Copy to…" should move all three
        // of its values together — a duration copied without its trigger load is meaningless.
        {
            id: 'extendedBoost',
            title: 'Obstacle assist — Extended Boost',
            note: 'Keeps the motor pulling for a moment AFTER you stop pedalling, for lifting '
                + 'over steps and rocks. Arm it with a firm push above Trigger pedal load; when '
                + 'you then stop pedalling, the motor holds the current you were ALREADY '
                + 'getting for Boost duration, and the normal release ramp takes over after '
                + 'that. The trigger only ARMS it — it has no effect on how much help you get. '
                + 'Boost strength scales the held current: 100% keeps exactly what you had. '
                + 'IMPORTANT — READ THIS: while the boost runs the motor drives with the cranks '
                + 'STANDING STILL. Within that window only the brake or the timer stops it. '
                + 'Braking, backpedalling, a fault, leaving the assist level or the bike coming '
                + 'to a stop all cancel it immediately. Starting to pedal again also ends it at '
                + 'once and hands back to normal assist, smoothly. An arming that is not used '
                + 'within about 1.5 seconds expires. In legal mode the boost follows your '
                + 'normal 25 km/h limit — note that this goes beyond what EPAC allows for '
                + 'assistance without pedalling, and is a deliberate choice for this bike. Set '
                + 'Boost duration to 0 to switch it off completely.',
            fields: pick('extended_boost_trigger_load_kg', 'extended_boost_strength_pct',
                'extended_boost_duration_ms'),
        },
    ]);
}

// These two groups render in the LEFT column of the Profiles tab (next to the mode-specific
// card) instead of stacking under the other three on the right — see renderProfileEditor().
// FW-084 put extendedBoost here too: it hands over to the release ramp when it ends, so it
// belongs beside "Power smoothing and release" — and it keeps the two columns at three
// groups each instead of piling four on the right.
const LEFT_COLUMN_GROUPS = new Set(['ramps', 'smoothing', 'extendedBoost']);

// CB-020: every field a level owns, for the mode it is in. The preset importer clamps with
// these, so a loaded file can never put a value outside what the editor itself allows —
// and the ranges cannot drift apart, because there is only one set of them.
export function levelFieldDescriptors(modeType) {
    return [...modeFields(modeType || 1), ...sharedFieldList()];
}

// A motor power ceiling above what the battery can actually deliver (current limit ×
// overvoltage cutoff, i.e. worst-case pack voltage) can never be reached — it would just be
// a number with no effect. Cap the field's allowed range at that product when both battery
// values are known (read in the Limits tab); fall back to the hardware ceiling otherwise.
function maxMotorPowerCeilingW() {
    const currentLimitA = state.controllerParams1?.current_limit;
    const overvoltageV = state.controllerParams1?.overvoltage;
    if (!Number.isFinite(currentLimitA) || !Number.isFinite(overvoltageV)) return 1500;
    return Math.min(1500, Math.round(currentLimitA * overvoltageV));
}

function sharedFieldList() {
    return [
        /*
         * CB-024: both ceilings are set in the unit the rider actually feels.
         *
         * Torque instead of "percent of phase current": nobody can picture 75 % of a
         * phase-current limit, and every rider knows what 60 Nm means. The percent is still
         * what gets stored and is still shown in the caption, so nothing is hidden.
         *
         * The power ceiling gets an explicit on/off switch because 0 does NOT mean "no
         * motor" — it means "no extra power limit". The old label said "0 disables", which
         * reads exactly backwards and is the kind of thing someone discovers by setting it
         * to 0 and expecting the motor to stop.
         */
        {
            key: 'max_motor_power_w',
            label: 'Limit maximum motor power',
            type: 'toggleValue',
            valueLabel: 'Maximum motor power', unit: 'W',
            min: 0, max: maxMotorPowerCeilingW(), step: 25, slider: true,
            offText: 'No extra power limit — only the torque ceiling above applies.',
            onText: (watts) => `${watts} W ceiling once you are spinning.`,
            defaultOnValue: 600,
            help: 'Caps motor power while you are pedalling at higher cadence. It does NOT set how hard the bike pulls away — at low cadence there is almost no power to cap, so launch force comes from the torque setting above. Switch it off for no extra power limit; the torque ceiling still applies either way. The allowed range is capped at Maximum battery current × Overvoltage cutoff (Limits tab) — the most power the battery could ever supply.',
        },
        {
            key: 'max_iq_pct',
            label: 'Maximum motor torque', unit: 'Nm',
            min: 0, max: M820_MAX_TORQUE_NM, step: 1, slider: true, sliderStep: 1,
            fromNative: (pct) => Math.round(iqPercentToTorqueNm(pct)),
            toNative: (nm) => torqueNmToIqPercent(nm),
            note: (pct) => (pct > 0
                ? `About ${Math.round(iqPercentToTorqueNm(pct))} Nm · ${pct}% of the phase-current limit`
                : 'Assist is switched off at this level.'),
            help: `Limits how hard the motor can push, which you feel most when pulling away and at low cadence. The Nm figure is an ESTIMATE for a Bafang M820 (${M820_MAX_TORQUE_NM} Nm at full phase current) — the controller stores a percentage of its own phase-current limit, so if that limit is set below the motor's rated current the real torque is lower than the number shown. This is the final cap: startup boost, latch floor and Extended Boost are all clipped by it.`,
        },
        { key: 'assist_without_rotation', label: 'Assist without crank rotation', type: 'checkbox',
            help: 'Allow the motor to push from a dead stop, before the cranks are turning — useful for pulling away on a steep start. Still needs a clear push on the pedal (see Minimum pedal load) to trigger, so it can\'t be set off by an idle foot resting on the pedal.' },
        { key: 'minimum_pedal_load_kg', label: 'Minimum pedal load', unit: 'kg', min: 0, max: 22.5, step: 0.1,
            fromNative: displayKgWithOneDecimal, toNative: kgWithOneDecimal,
            help: 'Minimum pedal load needed to start assist from standstill. It is also used by Assist without crank rotation. Lower values engage with a lighter touch; higher values require a firmer push and better resist accidental activation.' },
        { key: 'riding_minimum_pedal_load_kg', label: 'Minimum pedal load while riding', unit: 'kg', min: 0, max: 22.5, step: 0.1,
            fromNative: displayKgWithOneDecimal, toNative: kgWithOneDecimal,
            help: 'Direct minimum load needed to re-engage assist while the bike is already moving (at least 1 km/h) and the cranks turn forward. This is an actual threshold, not a value subtracted from another field. It does not continuously limit assist after engagement.' },
        // FW-069: Iq ramps, moved here from the global Dynamics card so each level (and each
        // bank) can have its own character of power build-up.
        // FW-069: "low" and "high" are the fixed firmware breakpoints from config.h, spelled
        // out here (and on the ramps chart) because the labels alone never told the rider at
        // what speed the value they were editing actually applied.
        { key: 'iq_rise_slow_ms', label: `Acceleration — low speed/cadence (≤ ${RAMP_SPEED_LO_KMH} km/h and ≤ ${RAMP_CADENCE_LO_RPM} rpm)`, unit: 'ms', min: 20, max: 5000, step: 10,
            help: `Time for motor current to ramp from 0% to 100% at low speed AND low cadence — exactly this value at or below ${RAMP_SPEED_LO_KMH} km/h and ${RAMP_CADENCE_LO_RPM} rpm, blending toward the fast value above that. Pulling away from a standstill always uses this one. Example presets (Aggressive / Normal / Smooth): 250 / 500 / 800 ms. Higher = softer, more gradual pull-away; lower = the motor comes in faster but can feel abrupt at low speed.` },
        { key: 'iq_rise_fast_ms', label: `Acceleration — high speed/cadence (≥ ${RAMP_SPEED_HI_KMH} km/h or ≥ ${RAMP_CADENCE_HI_RPM} rpm)`, unit: 'ms', min: 20, max: 5000, step: 10,
            help: `Time for motor current to ramp from 0% to 100% once you are riding: exactly this value at or above ${RAMP_SPEED_HI_KMH} km/h OR ${RAMP_CADENCE_HI_RPM} rpm. Speed and cadence are judged separately and the FASTER of the two wins, so ${RAMP_CADENCE_HI_RPM} rpm in a low gear ramps like ${RAMP_SPEED_HI_KMH} km/h. This is the value that governs how sharply the motor answers a hard push mid-ride — raise it to take the edge off peaks without touching how the bike pulls away. Example presets (Aggressive / Normal / Smooth): 100 / 250 / 400 ms.` },
        { key: 'iq_fall_slow_ms', label: `Deceleration — low speed/cadence (≤ ${RAMP_SPEED_LO_KMH} km/h and ≤ ${RAMP_CADENCE_LO_RPM} rpm)`, unit: 'ms', min: 20, max: 5000, step: 10,
            help: `Time for motor current to ramp down to 0% at low speed AND low cadence — exactly this value at or below ${RAMP_SPEED_LO_KMH} km/h and ${RAMP_CADENCE_LO_RPM} rpm. Example presets (Aggressive / Normal / Smooth): 300 / 500 / 800 ms. Higher = power lingers longer as you ease off; lower = it drops away promptly.` },
        { key: 'iq_fall_fast_ms', label: `Deceleration — high speed/cadence (≥ ${RAMP_SPEED_HI_KMH} km/h or ≥ ${RAMP_CADENCE_HI_RPM} rpm)`, unit: 'ms', min: 20, max: 5000, step: 10,
            help: `Time for motor current to ramp down to 0% once you are riding: exactly this value at or above ${RAMP_SPEED_HI_KMH} km/h OR ${RAMP_CADENCE_HI_RPM} rpm, and the faster of the two wins. THIS is the one you feel when you ease off the pedal while still spinning — it is normally the shortest ramp on the bike, so power falls away quickly. Raise it if assist disappears too eagerly the moment you stop pushing hard. It does NOT control what happens after the cranks stop: that is Release duration. Example presets (Aggressive / Normal / Smooth): 100 / 180 / 300 ms.` },
        { key: 'startup_boost_enabled', label: 'Startup boost', type: 'checkbox',
            help: 'Give a temporary power boost right when you start pedalling from a stop, fading out as cadence rises (see Startup boost strength/end cadence here, and the global "Startup boost fade per cadence step" in the whole-bike band at the bottom of this tab).' },
        { key: 'startup_boost_strength_pct', label: 'Startup boost strength', unit: '%', min: 0, max: 300, step: 10,
            help: 'How much extra power the startup boost adds at cadence 0, as a percentage on top of the normal request. Higher values give a harder launch. Fades out by the time cadence reaches Startup boost end cadence.' },
        { key: 'startup_boost_end_rpm', label: 'Startup boost end cadence', unit: 'rpm', min: 0, max: 120, step: 5,
            help: 'Cadence at which the startup boost has fully faded away. Higher values let boost remain for longer into the pedal stroke; lower values end it sooner.' },
        { key: 'smooth_start_enabled', label: 'Smooth start', type: 'checkbox',
            help: 'Ease the very first moment of assist in gradually over Smooth start duration, on top of the normal acceleration ramp — softer than the ramp alone for a very gentle launch.' },
        { key: 'smooth_start_ms', label: 'Smooth start duration', unit: 'ms', min: 0, max: 5000, step: 50,
            help: 'How long the smooth-start easing takes, if Smooth start is enabled. Higher values make launch softer but slower; lower values make it more immediate.' },
        { key: 'release_ms', label: 'Release duration — 0 = automatic', unit: 'ms', min: 0, max: 3000, step: 50,
            help: 'Total time of the straight-line fade from whatever assist current is flowing at the moment you stop pedalling down to zero. 650 ms means about 650 ms to zero, whether you were pushing hard or barely at all — there is no extra tail after it. 0 = let this level\'s adaptive Deceleration ramps decide instead (their timing depends on your speed and cadence at the moment you stop). Example presets (Aggressive / Normal / Smooth): 250 / 450 / 650 ms. Higher = a longer, gentler hand-off; lower = assist disappears sooner after you stop.' },
        { key: 'power_rise_filter_ms', label: 'Power rise filter', unit: 'ms', min: 0, max: 5000, step: 50,
            help: 'Smooths sudden increases in requested motor power over this many milliseconds, before this level\'s current ramp even sees it. 0 = no smoothing (react immediately). Example presets (Aggressive / Normal / Smooth): 50 / 150 / 300 ms. Higher = calmer, less jumpy response to a hard push; lower = more immediate but can feel twitchy.' },
        // FW-084: Extended Boost. The trigger is a calibrated pedal load in kg, deliberately
        // not a rate of rise — see the section note in sharedFieldGroups().
        { key: 'extended_boost_trigger_load_kg', label: 'Trigger pedal load', unit: 'kg', min: 1, max: 60, step: 0.5, minBankSchema: 8,
            fromNative: displayKgWithHalf, toNative: kgWithHalf,
            help: 'A confirmed pedal load at or above this value arms Extended Boost. It uses calibrated pedal load, not the rate at which the signal rises, and the load has to be held for about 30 ms — a single spike from a chain slap or a pothole is ignored. Higher values mean only a deliberate hard push arms the boost; lower values arm it more easily, including when you did not mean to. This one field steps in 0.5 kg rather than 0.1 kg, which is what lets it reach the sensor\'s full 60 kg. Setting it at 60 kg disables the boost in practice — nothing can push past the top of the scale.' },
        { key: 'extended_boost_strength_pct', label: 'Boost strength', unit: '%', min: 0, max: 255, step: 5, minBankSchema: 8,
            help: 'Multiplies the current calculated from the peak load of the latest qualifying pedal push. 100% = exactly that current, 150% = one and a half times it, 255% = the maximum 2.55×. The result is still capped by this level\'s Maximum motor current and by every controller safety limit — speed, power, battery, voltage and temperature.' },
        { key: 'extended_boost_duration_ms', label: 'Boost duration — 0 = Off', unit: 'ms', min: 0, max: 2000, step: 25, minBankSchema: 8,
            help: 'How long the motor may keep pushing after forward pedalling is recognized as stopped. 0 disables Extended Boost completely, which is the default. Start at 200 ms and only increase it once you have confirmed the brake, backward-pedal and limit behaviour on your own bike. The release ramp runs AFTER this time, so the two add up. In legal mode the boost is treated as non-pedal assistance and stops helping above 7 km/h — the cranks are stationary while it runs.' },
        { key: 'power_fall_filter_ms', label: 'Power fall filter', unit: 'ms', min: 0, max: 5000, step: 50,
            help: 'Smooths sudden drops in requested motor power over this many milliseconds — helps assist not visibly dip in the dead spots of each pedal stroke. This is an exponential time constant, not time-to-zero: after one interval about 37% of the previous step remains. Example presets (Aggressive / Normal / Smooth): 100 / 200 / 400 ms. Higher = steadier through the dead spots; lower = assist follows every dip in your pedal stroke.' },
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
        assist_without_rotation: false, minimum_pedal_load_kg: 0.7,
        // FW-077 uses direct kg thresholds; FW-069 ramps match firmware boot values.
        riding_minimum_pedal_load_kg: 0.3,
        iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
        iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
        startup_boost_enabled: true, startup_boost_strength_pct: 100, startup_boost_end_rpm: 27,
        smooth_start_enabled: false, smooth_start_ms: 300,
        release_ms: 650, power_rise_filter_ms: 150, power_fall_filter_ms: 375,
        // FW-084: off out of the box, exactly like a fresh controller.
        extended_boost_trigger_load_kg: 20, extended_boost_strength_pct: 100,
        extended_boost_duration_ms: 0,
    }));
}
const PROFILE_LEVEL_PLACEHOLDER_BANKS = [
    buildProfilePlaceholderBank(1), // Bank 1 default: Power Linear (ASSIST_MODE_POWER_LINEAR)
    buildProfilePlaceholderBank(3), // Bank 2 default: eMTB (ASSIST_MODE_EMTB)
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

/*
 * CB-026: what the top bar's one Undo does to the profile banks.
 *
 * BOTH banks, because the single Undo is defined as "put the screen back to the bike", and a
 * version that quietly left the other bank edited would be the same trap the per-card buttons
 * were. Screen only — the controller keeps whatever it holds until a save.
 *
 * Returns what it actually put back so the caller can say so in one message.
 */
export function restoreProfilesFromRead() {
    const restored = [];
    [0, 1].forEach((bankIndex) => {
        const read = state.lastBanksAsRead?.[bankIndex];
        if (read) {
            state.lastBanks = state.lastBanks || {};
            state.lastBanks[bankIndex] = JSON.parse(JSON.stringify(read));
            restored.push(`bank ${bankIndex + 1} (as read)`);
        } else {
            // Nothing was ever read for this bank, so the editor is working on the offline
            // copy: rebuild it from the untouched defaults table.
            resetPlaceholderBank(bankIndex);
            restored.push(`bank ${bankIndex + 1} (firmware defaults)`);
        }
    });
    renderProfileEditor();
    return restored;
}

// Every level object of ONE bank — read from the controller if we have it, the offline
// working copy otherwise. This is what "Copy to…" writes into.
function bankWorkingLevels(bankIndex) {
    const read = state.lastBanks?.[bankIndex]?.levels;
    if (Array.isArray(read) && read.length) return read;
    const banks = placeholderBanks();
    return banks[bankIndex] || banks[0];
}

/*
 * Everything the editable level-curve chart needs, gathered fresh on every call.
 *
 * It edits the SAME objects the field grid does — bankWorkingLevels() — so a point dragged
 * here and a number typed below are one and the same edit, and there is no second copy of a
 * value to fall out of step. The controller's own values come from state.lastBanksAsRead,
 * which CB-012 already maintains and nothing ever writes to.
 *
 * onEdit runs on every frame of a drag. Only the matching number box is repainted there,
 * because that is the one thing that must not lag behind the finger; the six preview charts
 * are far too heavy for that and wait for the pointer to be released.
 */
function levelCurveContext() {
    const selected = selectedLevel();
    const levels = bankWorkingLevels(selected.bankIndex);
    return {
        bankIndex: selected.bankIndex,
        levelIndex: selected.levelIndex,
        levels,
        baselineLevels: state.lastBanksAsRead?.[selected.bankIndex]?.levels || null,
        descriptors: sharedFieldList(),
        onEdit: (levelIndex, key, stored, { committed }) => {
            if (levelIndex === selected.levelIndex) updateFieldDisplays(key);
            if (!committed) return;
            markUnsavedInRam();
            renderProfileChart();
            refreshEnginePreview(levels[selected.levelIndex]);
            updateTorqueSummary();
            addLog('DATA', `${LEVEL_NAMES[levelIndex]}: ${key} set to ${stored} on screen — not written to the bike yet.`);
        },
    };
}

/*
 * CB-025: what the ramps preview chart needs to become an editor instead of a picture.
 *
 * Same contract as the level curve: the chart writes the level object the field grid already
 * works on, the ranges come from the same descriptors the number boxes are built from, and the
 * controller's own values come from state.lastBanksAsRead. Passing this in is what makes the
 * chart editable — engine-preview-ui.js renders read-only without it, which is what keeps it
 * usable from anywhere that only wants the picture.
 */
function previewEditContext() {
    const selected = selectedLevel();
    const levels = bankWorkingLevels(selected.bankIndex);
    return {
        descriptors: sharedFieldList(),
        baselineLevel: state.lastBanksAsRead?.[selected.bankIndex]
            ?.levels?.[selected.levelIndex] || null,
        onEdit: (key, value, { committed }) => {
            // The number box must not lag behind the handle; everything else can wait for the
            // pointer to be released.
            updateFieldDisplays(key);
            if (!committed) return;
            markUnsavedInRam();
            renderProfileChart();
            updateTorqueSummary();
            renderLevelCurve(levelCurveContext());
            addLog('DATA', `${LEVEL_NAMES[selected.levelIndex]}: ${key} set to ${value} on screen — not written to the bike yet.`);
        },
    };
}

function refreshEnginePreview(level) {
    updateEnginePreviewUI(level, state.lastTuning, previewEditContext());
}

/*
 * CB-025: the same contract for the two big engine curves, whose handles move the MODE
 * fields (support ratio, the support window, the curve shape) rather than the shared ones.
 *
 * Deliberately does not redraw the engine curves from onEdit — they redraw themselves on
 * every frame of the drag, and calling back into them here would be a second redraw per
 * frame chasing the first.
 */
function curveEditContext(selected, mode) {
    return {
        descriptors: modeFields(mode || 1),
        baselineLevel: state.lastBanksAsRead?.[selected.bankIndex]
            ?.levels?.[selected.levelIndex] || null,
        onEdit: (key, value, { committed }) => {
            updateFieldDisplays(key);
            if (!committed) return;
            markUnsavedInRam();
            updateTorqueSummary();
            updateLiveSummary();
            addLog('DATA', `${LEVEL_NAMES[selected.levelIndex]}: ${key} set to ${value} on screen — not written to the bike yet.`);
        },
    };
}

/*
 * FW-071: section copy, replacing the two "apply to all levels" checkboxes.
 *
 * The checkboxes were a MODE: left on and forgotten, one edit silently rewrote four other
 * levels with no confirmation and nothing to undo. This is a one-shot action instead — the
 * targets are chosen at the moment of copying, the number of values about to be overwritten
 * is shown before it happens, and the previous values are kept for a single undo.
 *
 * Because the scope is now deliberate rather than ambient, copying across BOTH banks is safe
 * to offer; as a mode it would have been the fastest way to wipe a tune by accident.
 */
let lastCopyUndo = null; // { label, entries: [{ bankIndex, levelIndex, values }] }

function copySectionValues(sourceBankIndex, sourceLevelIndex, keys, targets) {
    const source = bankWorkingLevels(sourceBankIndex)[sourceLevelIndex];
    if (!source) return 0;
    const entries = [];
    let written = 0;
    targets.forEach(({ bankIndex, levelIndex }) => {
        if (bankIndex === sourceBankIndex && levelIndex === sourceLevelIndex) return;
        const target = bankWorkingLevels(bankIndex)[levelIndex];
        if (!target) return;
        const previous = {};
        keys.forEach((key) => {
            previous[key] = target[key];
            target[key] = source[key];
            written++;
        });
        entries.push({ bankIndex, levelIndex, values: previous });
    });
    return { written, entries };
}

function undoLastCopy() {
    if (!lastCopyUndo) return false;
    lastCopyUndo.entries.forEach(({ bankIndex, levelIndex, values }) => {
        const target = bankWorkingLevels(bankIndex)[levelIndex];
        if (!target) return;
        Object.keys(values).forEach((key) => { target[key] = values[key]; });
    });
    lastCopyUndo = null;
    return true;
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
    + 'and voltage limits still apply; the throttle and Walk Assist are not affected. '
    + 'Factory default: Off.';

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
        status = 'Not read from the controller yet — press "Read from bike" to see this bank\'s real setting. ';
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
    const hasData = !!selected.level;
    const stale = !hasData && isEbicsConnected();
    if (source) {
        source.classList.toggle('ebics-stale-warning', stale);
        source.textContent = hasData
            ? 'Selected bank read from controller'
            : (stale
                ? '⚠ Not read from the controller yet — values below are placeholders, NOT your bike\'s real settings. Press "Read banks".'
                : 'Offline defaults — connect and press "Read from bike" to load your real settings.');
    }
    markReadNeeded('profiles', stale);

    populateSelects(); // FW-056: mode list depends on the schema version just read
    renderCadenceComp(selected); // FW-057
    const modeSelect = el('ebicsProfileModeSelect');
    const level = selected.level || placeholderLevel(selected.bankIndex, selected.levelIndex);
    if (modeSelect) modeSelect.value = String(level.mode_type || 1);
    const modeContainer = el('ebicsProfileModeFields');
    const sharedContainerLeft = el('ebicsProfileSharedFieldsLeft');
    const sharedContainerRight = el('ebicsProfileSharedFieldsRight');
    if (modeContainer) modeContainer.innerHTML = '';
    if (sharedContainerLeft) sharedContainerLeft.innerHTML = '';
    if (sharedContainerRight) sharedContainerRight.innerHTML = '';
    const refresh = () => {
        renderProfileChart();
        updateTorqueSummary();
        refreshEnginePreview(level);
        // Box -> chart. A value typed (or nudged with the spinner, or put back with
        // Shift+click) moves the matching point immediately.
        renderLevelCurve(levelCurveContext());
    };
    const mode = level.mode_type || 1;
    const unsupported = modeUnsupportedReason(mode); // FW-056
    if (modeContainer && unsupported) {
        const note = document.createElement('div');
        note.className = 'form-hint ebics-stale-warning';
        note.style.gridColumn = '1 / -1';
        note.textContent = unsupported === 'not-read'
            ? '⚠ Banks not read yet — this mode needs firmware with bank schema v4. Press "Read from bike" to confirm your controller supports it. You can still shape the curve here; writing is blocked until it is confirmed.'
            : '⚠ This controller reports an older bank format and cannot store this mode. Writing is blocked — it would reject the whole bank and silently keep your old settings. Flash firmware with FW-056 first.';
        modeContainer.appendChild(note);
    }
    // CB-012: each field learns where its own "put it back" value comes from, so Shift+click
    // on one field restores only that one.
    const factoryLevel = PROFILE_LEVEL_PLACEHOLDER_BANKS[selected.bankIndex]
        || PROFILE_LEVEL_PLACEHOLDER_BANKS[0];
    const factoryDefaults = factoryLevel[selected.levelIndex] || factoryLevel[0];
    const withRestore = (field) => ({
        ...field,
        // CB-024: an off-able field remembers its last non-zero value PER bank and level, so
        // switching the power limit off on BOOST cannot resurrect ECO's number.
        memoryScope: `${selected.bankIndex}:${selected.levelIndex}`,
        factoryDefault: factoryDefaults[field.key],
        factoryDefaultLabel:
            `Factory default for Bank ${selected.bankIndex + 1} / ${LEVEL_NAMES[selected.levelIndex]}`,
        restoreValue: () => {
            const { source, level: original } = restoreSourceLevel(selected.bankIndex, selected.levelIndex);
            return { value: original[field.key], source };
        },
    });
    modeFields(mode).forEach((field) =>
        fieldInput(modeContainer, level, withRestore(field), refresh));
    // FW-071: shared settings render as sections, each with its own "Copy to…" button.
    // "Current ramps" and "Power smoothing and release" (LEFT_COLUMN_GROUPS) render into
    // the left column, next to the mode-specific card, so the two halves of the page stay
    // roughly balanced instead of piling all five groups on the right.
    if (sharedContainerLeft || sharedContainerRight) {
        sharedFieldGroups().forEach((group) => {
            const sharedContainer = LEFT_COLUMN_GROUPS.has(group.id) ? sharedContainerLeft : sharedContainerRight;
            if (!sharedContainer) return;
            const block = document.createElement('section');
            block.className = 'ebics-field-group';
            block.appendChild(buildSectionHead(group, selected, refresh));
            if (group.note) {
                const note = document.createElement('p');
                note.className = 'form-hint ebics-field-group-note';
                note.textContent = group.note;
                block.appendChild(note);
            }
            const grid = document.createElement('div');
            grid.className = 'ebics-field-grid';
            block.appendChild(grid);
            group.fields.filter(Boolean).forEach((field) =>
                fieldInput(grid, level, withRestore(field), refresh));

            /*
             * FW-084: a group the connected controller CANNOT STORE must not be editable —
             * typing a boost duration that the serializer then drops on write is worse than
             * being told the firmware is too old, because the rider would ride expecting it.
             *
             * "Nothing read yet" is a different situation and stays editable, exactly like
             * the mode selector does: offline there is no controller to disagree with, the
             * values are placeholders, and nothing can be written anyway. Disabling it there
             * only looked broken — the fields lost their spinners while every other card
             * kept them.
             */
            if (group.minBankSchema) {
                const schema = bankSchemaVersion();
                const tooOld = schema > 0 && schema < group.minBankSchema;
                if (tooOld || schema === 0) {
                    const note = document.createElement('p');
                    note.className = 'form-hint ebics-stale-warning';
                    note.textContent = tooOld
                        ? `⚠ This controller reports bank schema v${schema} and cannot store these settings — they are shown read-only. Flash firmware with FW-084 first.`
                        : `⚠ Banks not read yet — these settings need bank schema v${group.minBankSchema}. You can set them up here, but press "Read from bike" to confirm your controller can store them.`;
                    block.insertBefore(note, grid);
                }
                if (tooOld) {
                    grid.querySelectorAll('input, select, textarea, button')
                        .forEach((control) => { control.disabled = true; });
                    // Read-only has to LOOK read-only, or a greyed spinner is the only clue.
                    grid.style.opacity = '0.55';
                }
            }

            // Every group gets its own collapsible preview chart, including "ramps" — this
            // replaces the old always-visible Acceleration/Deceleration cards, which took a
            // lot of space for two curves most people only need to check occasionally.
            const chartDetails = document.createElement('details');
            chartDetails.style.marginTop = '12px';
            const chartSummary = document.createElement('summary');
            chartSummary.style.cursor = 'pointer';
            chartSummary.style.fontWeight = '600';
            chartSummary.style.color = '#4b5563';
            chartSummary.style.padding = '8px 0';
            chartSummary.textContent = '▶ Preview chart';
            chartDetails.appendChild(chartSummary);

            const chartContainer = document.createElement('div');
            chartContainer.id = `ebicsEnginePreview${group.id.charAt(0).toUpperCase() + group.id.slice(1)}Chart`;
            chartContainer.className = 'ebics-chart';
            chartContainer.style.marginTop = '8px';
            chartDetails.appendChild(chartContainer);
            block.appendChild(chartDetails);

            // Plotly can't size into a container hidden by a closed <details> — it draws
            // blank and never recovers on its own. Redraw once the panel is actually visible.
            chartDetails.addEventListener('toggle', () => {
                if (chartDetails.open) refreshEnginePreview(level);
            });

            sharedContainer.appendChild(block);
        });
    }
    renderProfileChart();
    refreshEnginePreview(level);
    renderLevelCurve(levelCurveContext());
}

// FW-071: header of one shared section — title plus the copy affordance.
function buildSectionHead(group, selected, refresh) {
    const head = document.createElement('div');
    head.className = 'ebics-field-group-head';

    const title = document.createElement('div');
    title.className = 'ebics-card-title ebics-field-group-title';
    title.textContent = group.title;
    head.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'ebics-field-group-actions';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn btn-secondary ebics-copy-button';
    copyButton.textContent = '⧉ Copy to…';
    copyButton.title = `Copy every value of "${group.title}" from ${LEVEL_NAMES[selected.levelIndex]} to other levels or the other bank.`;
    actions.appendChild(copyButton);

    const status = document.createElement('span');
    status.className = 'ebics-copy-status';
    actions.appendChild(status);
    head.appendChild(actions);

    copyButton.addEventListener('click', () => {
        const open = head.querySelector('.ebics-copy-panel');
        if (open) { open.remove(); return; }
        head.appendChild(buildCopyPanel(group, selected, refresh, status));
    });
    return head;
}

// The target picker. Deliberately shows the number of values it is about to overwrite:
// the whole point of replacing the checkboxes was to make the scope visible BEFORE the act.
function buildCopyPanel(group, selected, refresh, status) {
    const keys = group.fields.filter(Boolean).map((field) => field.key);
    const panel = document.createElement('div');
    panel.className = 'ebics-copy-panel';

    const heading = document.createElement('div');
    heading.className = 'ebics-copy-panel-title';
    heading.textContent = `Copy "${group.title}" (${keys.length} values) from ${LEVEL_NAMES[selected.levelIndex]}`;
    panel.appendChild(heading);

    const levelRow = document.createElement('div');
    levelRow.className = 'ebics-copy-row';
    const levelBoxes = LEVEL_NAMES.map((name, index) => {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.levelIndex = String(index);
        const isSourceLevel = index === selected.levelIndex;
        // The source LEVEL stays selectable: with "also the other bank" ticked it is a real
        // target there (SPORT+ of bank 1 -> SPORT+ of bank 2). Only the exact source SLOT is
        // skipped, in collectTargets — disabling the box here would quietly make that
        // perfectly reasonable copy impossible.
        box.checked = !isSourceLevel;
        label.appendChild(box);
        label.appendChild(document.createTextNode(isSourceLevel ? `${name} (source)` : name));
        levelRow.appendChild(label);
        return box;
    });
    panel.appendChild(levelRow);

    const bankRow = document.createElement('div');
    bankRow.className = 'ebics-copy-row';
    const bankChoice = document.createElement('label');
    const bankBox = document.createElement('input');
    bankBox.type = 'checkbox';
    bankChoice.appendChild(bankBox);
    bankChoice.appendChild(document.createTextNode('Also the other bank (same levels)'));
    bankRow.appendChild(bankChoice);
    panel.appendChild(bankRow);

    const footer = document.createElement('div');
    footer.className = 'ebics-copy-footer';
    const count = document.createElement('span');
    count.className = 'ebics-copy-count';
    footer.appendChild(count);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-orange';
    confirm.textContent = 'Copy';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    footer.appendChild(confirm);
    footer.appendChild(cancel);
    panel.appendChild(footer);

    const collectTargets = () => {
        const banks = [selected.bankIndex];
        if (bankBox.checked) banks.push(selected.bankIndex === 0 ? 1 : 0);
        const targets = [];
        banks.forEach((bankIndex) => {
            levelBoxes.forEach((box, levelIndex) => {
                if (!box.checked) return;
                // Only the exact source slot is skipped; the same level number on the other
                // bank is a different slot and a legitimate target.
                const isSourceSlot = bankIndex === selected.bankIndex
                    && levelIndex === selected.levelIndex;
                if (isSourceSlot) return;
                targets.push({ bankIndex, levelIndex });
            });
        });
        return targets;
    };
    const updateCount = () => {
        const targets = collectTargets();
        count.textContent = targets.length === 0
            ? 'Nothing selected'
            : `Overwrites ${targets.length * keys.length} values in ${targets.length} level(s)`;
        confirm.disabled = targets.length === 0;
    };
    levelBoxes.forEach((box) => box.addEventListener('change', updateCount));
    bankBox.addEventListener('change', updateCount);
    updateCount();

    cancel.addEventListener('click', () => panel.remove());
    confirm.addEventListener('click', () => {
        const targets = collectTargets();
        const result = copySectionValues(selected.bankIndex, selected.levelIndex, keys, targets);
        lastCopyUndo = { label: group.title, entries: result.entries };
        panel.remove();
        showCopyStatus(status, result, refresh);
        markUnsavedInRam();
        addLog('DATA', `Copied "${group.title}" to ${result.entries.length} level(s) — not written to the controller yet.`);
        refresh();
    });
    return panel;
}

// Confirmation plus the single-step undo. Copying is destructive and silent by nature, so
// the way back has to be within reach, not buried in a log line.
function showCopyStatus(status, result, refresh) {
    status.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = `Copied to ${result.entries.length} level(s) · `;
    status.appendChild(text);
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'ebics-copy-undo';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => {
        if (undoLastCopy()) {
            status.textContent = 'Undone';
            addLog('DATA', 'Copy undone — previous values restored.');
            refresh();
            renderProfileEditor();
        }
    });
    status.appendChild(undo);
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

    /*
     * CB-025: these two are editors as well.
     *
     * Handles go on the SELECTED level only. Five levels' worth would be fifteen handles on a
     * chart whose whole point is comparing the five lines, and the card already says the
     * selected one is the subject (it is the line drawn thicker).
     *
     * There is no inverse function anywhere here. Every handle asks solveOnGrid which of the
     * values the controller can actually store puts the curve closest to the pointer, using
     * the SAME forward function the chart draws with — supportRatioForChart or
     * requestedPowerForLevel. That matters because most of these cannot be inverted at all:
     * the Power Curve gammas are a lookup table, the eMTB parameter sits inside a clamped
     * denominator, and the power view is clipped by the battery ceiling. A hand-derived
     * inverse would be a second model that could disagree with the one on screen.
     */
    const editContext = curveEditContext(selected, selectedMode);
    const editedLevel = previewLevels[selected.levelIndex] || previewLevels[0] || {};

    const probeValue = (key, displayValue, xValue, view) => {
        const descriptor = descriptorOf(editContext, key);
        const stored = descriptor?.toNative ? descriptor.toNative(displayValue) : displayValue;
        const probe = { ...editedLevel, mode_type: selectedMode, [key]: stored };
        return view === 'support'
            ? supportRatioForChart(probe, xValue, chartMode)
            : requestedPowerForLevel(probe, xValue, chartMode);
    };

    /*
     * The power view is clipped by what the battery could ever supply, and a handle sitting in
     * a clipped stretch cannot express anything: every value above the clip draws the same
     * flat line, so dragging it would move the pointer and not the number.
     *
     * So on that view a handle slides left until the line is still rising, and the choice is
     * frozen for the duration of a drag — recomputing it every frame would slide the point out
     * from under the pointer.
     */
    const powerCeilingW = previewPowerCeilingW(editedLevel);
    const uncappedPowerAt = (xValue) => requestedPowerForLevel(
        { ...editedLevel, mode_type: selectedMode }, xValue, chartMode, false);
    const observableX = (host, key, view, preferredX) => {
        if (view !== 'power' || !(powerCeilingW > 0)) return preferredX;
        const stepX = Math.max(1, x[1] - x[0]);
        let candidate = preferredX;
        while (candidate > stepX && uncappedPowerAt(candidate) > powerCeilingW * 0.8) {
            candidate -= stepX;
        }
        return frozenAxis(host, `handle-x-${key}`, candidate, stepX);
    };

    const curveHandle = (key, preferredX, view, host, extra = {}) => {
        const descriptor = descriptorOf(editContext, key);
        if (!descriptor) return null;
        const current = toDisplayValue(descriptor, editedLevel[key]);
        const xValue = observableX(host, key, view, preferredX);
        return fieldHandle(editContext, key, {
            axis: 'y',
            x: xValue,
            y: probeValue(key, current, xValue, view),
            value: current,
            color: LEVEL_COLORS[selected.levelIndex] || '#475569',
            toValue: (target) => solveOnGrid({
                min: Number(descriptor.min),
                max: Number(descriptor.max),
                step: descriptor.step ?? 1,
                current,
                target,
                evaluate: (candidate) => probeValue(key, candidate, xValue, view),
            }),
            ...extra,
        });
    };

    // Where each handle sits, per mode. The x positions are chosen so that the value being
    // dragged is the one that actually moves the curve THERE — a handle at a point its own
    // parameter barely affects would be a control that fights back.
    const referenceW = clamp(selectedLevelConfig.reference_power_w || 200, 50, 500);
    const midLoadKg = 30;
    const buildHandles = (view, host) => {
        if (chartMode === 'load') {
            return [curveHandle(selectedMode === 5 ? 'torque_assist_factor' : 'emtb_parameter',
                midLoadKg, view, host)];
        }
        if (selectedMode === 1) return [curveHandle('support_ratio_pct', 200, view, host)];
        const list = [
            // At 0 W the support view IS the minimum, exactly. The power view is 0 W there
            // whatever the minimum is, so on that chart the handle moves to where the value
            // can actually be seen.
            curveHandle('support_min_pct', view === 'support' ? 0 : referenceW * 0.2, view, host),
            curveHandle('support_max_pct', referenceW, view, host),
            fieldHandle(editContext, 'reference_power_w', {
                axis: 'x',
                // At the FOOT of the knee line, not on the curve. On the curve it would land
                // exactly where the Maximum-support handle already is — both are at the
                // reference power, at the same height — and the two would be impossible to
                // tell apart or to grab separately.
                x: referenceW,
                y: 0,
                value: referenceW,
                color: '#94a3b8',
                label: 'Reference rider power (drag the knee sideways)',
            }),
        ];
        if (selectedMode === 2) list.push(curveHandle('progression_pct', referenceW / 2, view, host));
        if (selectedMode === 6) {
            // The two gammas split the support window at its midpoint by construction, so each
            // one is grabbed in the half it actually shapes.
            list.push(curveHandle('curve_exponent_x10', referenceW * 0.25, view, host));
            list.push(curveHandle('curve_exponent_high_x10', referenceW * 0.75, view, host));
        }
        return list;
    };

    const draw = (target, targetId, view) => {
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
        const host = chartHost(targetId);
        const handles = buildHandles(view, host).filter(Boolean);
        traces.push(...handleTraces(handles, 'Drag these to shape this level'));

        const layout = profilePlotLayout(axisX,
            view === 'support' ? 'Support ratio (%)' : 'Requested motor power (W)');
        // Both axes have to be pinned for the drag geometry, and the value axis additionally
        // frozen while dragging: its height comes from the very curves being shaped.
        const xTop = x[x.length - 1];
        const peak = traces.reduce((top, trace) => (Array.isArray(trace.y) && trace.mode === 'lines'
            ? Math.max(top, ...trace.y) : top), 1);
        const yTop = frozenAxis(host, `y-${view}`, peak * 1.12, view === 'support' ? 100 : 100);
        layout.xaxis = pinned(layout.xaxis, [0, xTop]);
        layout.yaxis = pinned(layout.yaxis, [0, yTop]);
        layout.hovermode = false;
        layout.shapes = referenceShape.slice();
        if (view === 'power' && selectedLevelConfig.max_motor_power_w > 0) {
            layout.shapes.push({
                type: 'line', xref: 'paper', x0: 0, x1: 1,
                y0: selectedLevelConfig.max_motor_power_w, y1: selectedLevelConfig.max_motor_power_w,
                line: { color: '#f87171', width: 1.5, dash: 'dot' },
            });
        }

        drawEditable(targetId, traces, layout, {
            handles,
            xRange: [0, xTop],
            yRange: [0, yTop],
            grab: 'point',
            description: `${LEVEL_NAMES[selected.levelIndex]}: drag a point to shape this `
                + 'level\'s curve, or use the arrow keys.',
            onChange: handleEditor(editedLevel, editContext, renderProfileChart),
        });
    };

    draw(supportChart, 'ebicsProfileChartSupport', 'support');
    draw(powerChart, 'ebicsProfileChart', 'power');
}

export function bindProfileControls() {
    ['ebicsProfileBankSelect', 'ebicsProfileLevelSelect'].forEach((id) => el(id)?.addEventListener('change', renderProfileEditor));
    // Picking a different setting to shape only redraws that one card — the field grid below
    // is unaffected, so there is no reason to rebuild it.
    bindLevelCurveControls(() => renderLevelCurve(levelCurveContext()));
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

    // CB-026: reading, writing and undoing are the top bar's job now — see global-actions.js.
}

/*
 * FW-056, kept as its own check because the whole bank stands or falls together.
 *
 * The controller validates every level in the blob and rejects ALL of it on a mode it does not
 * know — then silently keeps the settings it already had. A rider who is not watching the log
 * would ride away believing the new tune was applied. This turns that into a readable reason
 * before anything is sent, and it has to run wherever a bank is written, which since CB-026 is
 * the one save action in the top bar.
 *
 * Returns a sentence to show, or null when the bank is safe to write.
 */
export function unsupportedModeInBank(bankIndex) {
    const levels = state.lastBanks?.[bankIndex]?.levels || [];
    const blocked = levels.findIndex((level) => modeUnsupportedReason(level.mode_type) === 'old-firmware');
    if (blocked < 0) return null;
    const label = MODE_LABELS[levels[blocked].mode_type];
    return `Bank ${bankIndex + 1}, ${LEVEL_NAMES[blocked]} uses "${label}", which this `
        + 'controller\'s firmware cannot store. The controller would reject the whole bank and '
        + 'quietly keep your current settings. Flash newer firmware or pick another mode.';
}
