// evistdrive/dynamics.js — the two whole-bike pedal-input gates of the 0x6023 tuning block.
//
// Everything else in that block was removed from the UI (see the note above TUNING_FIELDS); the
// bytes still round-trip unchanged. The per-level ramps live nowhere in the UI any more: the V3
// model (v3-model-panel.js) replaces them.
import { state } from '../shared.js';
import { markUnsavedInRam } from './global-actions.js';
import { el, fieldInput } from './common.js';

// V3 cleanup: only the two pedal-input gates stay editable. Removed from the UI (not hidden):
// startup boost fade, ride latch (run deadband / hold / current floor), assist torque full scale
// and crank length (eMTB / Torque / rider-power maths of the removed AP2 modes). Their bytes
// still travel in the 0x6023 blob unchanged (TUNING_DEFAULTS below) so a write never zeroes them.
const TUNING_FIELDS = [
    { key: 'assist_start_steps', label: 'Ruch korby do startu', unit: 'kroki', min: 1, max: 20, step: 1,
        help: 'Ile kroków do przodu musi zobaczyć czujnik kadencji, zanim wspomaganie może ruszyć. 4 ≈ 15° obrotu korby. Mniej = wspomaganie łapie szybciej przy ruszaniu; więcej = trudniej je wywołać kołysaniem korbami na zjeździe.' },
    { key: 'assist_torque_run_window_deg', label: 'Wygładzanie momentu RUN', unit: '°', min: 0, max: 360, step: 15,
        help: 'Uśrednia sygnał nacisku używany w trakcie jazdy (nie do startu ani zatrzymania) po tylu stopniach obrotu korby. 180° = jedna noga, usuwa pulsowanie na nogę; 360° = pełny obrót. 0 = sygnał surowy.' },
];

// CB-020: the global block's fields, for the preset importer to clamp with. Same list the
// card renders from, so the two cannot drift apart.
export function tuningFieldDescriptors() {
    return TUNING_FIELDS;
}

function ensureTuningDefaults() {
    if (!state.lastTuning) {
        state.lastTuning = { ...TUNING_DEFAULTS };
        return;
    }
    // FW-032/033/068: an older controller read won't include these fields — backfill defaults.
    ['assist_run_deadband_mv', 'assist_hold_ms', 'assist_min_iq_pct', 'assist_torque_run_window_deg',
        'assist_start_steps', 'assist_torque_full_scale_centikg', 'crank_length_mm']
        .forEach((key) => {
            if (state.lastTuning[key] == null) state.lastTuning[key] = TUNING_DEFAULTS[key];
        });
}

export function renderDynamics() {
    ensureTuningDefaults();
    // FW-129: the two whole-bike settings this card gained need tuning blob v8. On an older
    // controller the serializer negotiates the version down and they have nowhere to go, so
    // show them disabled rather than letting the rider set a value that is silently dropped —
    // the same treatment Profiles gives its bank-schema-gated fields.
    const tuningSchema = state.lastTuning?.tuning_schema_version ?? 0;
    const gate = (field) => (field.minTuningSchema && tuningSchema < field.minTuningSchema
        ? { ...field, disabled: true, factoryDefaultLabel: 'Needs newer controller firmware. Factory default' }
        : field);
    const groups = [
        { container: el('ebicsDynamicsStartFields'), fields: TUNING_FIELDS.filter((field) => field.key === 'assist_start_steps') },
        { container: el('ebicsDynamicsTorqueRunFields'), fields: TUNING_FIELDS.filter((field) => field.key === 'assist_torque_run_window_deg') },
    ];
    groups.forEach((group) => {
        if (!group.container) return;
        group.container.innerHTML = '';
        // CB-012: Shift+click a single field to put just that one back.
        group.fields.forEach((field) => fieldInput(group.container, state.lastTuning, {
            ...gate(field),
            factoryDefault: TUNING_DEFAULTS[field.key],
            restoreValue: () => {
                const { source, tuning } = tuningRestoreSource();
                return { value: tuning[field.key], source };
            },
        }, markUnsavedInRam));
    });
}

// Firmware defaults for the tuning block, kept apart from state.lastTuning so editing can
// never overwrite the thing a restore is supposed to go back to.
const TUNING_DEFAULTS = Object.freeze({
    // Dead ramps: still sent on the wire so a controller keeps a sane blob, ignored by firmware.
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
    iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20,
    assist_start_steps: 4, // FW-068
    assist_run_deadband_mv: 5, assist_hold_ms: 1400, assist_min_iq_pct: 2,
    assist_torque_run_window_deg: 180,
    // FW-129. These are exactly the values the firmware behaved as before the card, so a
    // migrated v7 profile feels identical until the rider deliberately changes them.
    assist_torque_full_scale_centikg: 6000, crank_length_mm: 165,
});

// What a restore should put back: the values as read when there are any, otherwise the
// firmware defaults. Always a copy.
function tuningRestoreSource() {
    const read = state.lastTuningAsRead;
    return read
        ? { source: 'read', tuning: JSON.parse(JSON.stringify(read)) }
        : { source: 'defaults', tuning: { ...TUNING_DEFAULTS } };
}

// CB-026: what the top bar's one Undo does to the whole-bike tuning block. Screen only.
export function restoreTuningFromRead() {
    const { source, tuning } = tuningRestoreSource();
    state.lastTuning = tuning;
    renderDynamics();
    return source === 'read' ? 'ride-feel tuning (as read)' : 'ride-feel tuning (firmware defaults)';
}

export function bindDynamicsControls() {
    // CB-026: reading, writing and undoing are the top bar's job now. This block cannot be
    // persisted on its own anyway — SAVE_BANKS always covers the banks AND the tuning
    // together — so a per-card save was promising something the controller does not offer.
    ensureTuningDefaults();
}
