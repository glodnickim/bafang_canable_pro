// evistdrive/legacy-params.js — the editable fields the eVistDrive cards show for
// parameters that still live in the legacy Controller/Assist CAN blocks (0x6010,
// 0x6011, 0x6012, 0x62D9) rather than in an eVistDrive blob.
//
// Deliberately NOT split per card, unlike the rest of this folder: one draft object,
// one read/write path and one validation pass are shared by every section below, and
// separating them would mean exporting that plumbing across module boundaries for no
// gain. Sections, in order, and the card each one feeds:
//
//   previewP0/P1/P2, ensureDraft, createField   plumbing: draft state and field builder
//   renderLimpSocChart .. renderLimitsFields    Limits card
//   renderWalkFields, syncWalkData              Walk card
//   renderSystemFields                          System card
//   renderLegacy*Table, renderErrors            Walk card's legacy cross-reference
//   writeLegacyBlocks / restoreLegacyDraft      what the top bar's save and undo call
//
// The factory Controller/Assist tabs still own these blocks too; this module writes
// the same frames, so a change here shows up there after a re-read, and vice versa.
import {
    state, socket, addLog, waitFor, delay,
    sendCustomFrame, encodeToHex,
    wheelDiameterTable, uiToInternalAssistMap,
    torqueMvToKg, torqueKgToMv, LEGACY_TORQUE_LINEAR_MAX_KG,
    errorDescriptions, errorRecommendations, helpBadge, isEbicsConnected,
} from '../shared.js';
// Shared write-then-confirm helpers, so every 'Save to flash' button behaves identically.
import { writeBankAndWait, updateFieldDisplays, registerFieldDisplay, markReadNeeded } from './common.js';
import { markUnsavedInRam } from './global-actions.js';
// CB-025: the limp-mode chart is an editor. Same drag machinery as every other editable
// chart in the app — see editable-chart.js.
import {
    chartHost, frozenAxis, drawEditable, handleTraces, fieldHandle, handleEditor,
} from './editable-chart.js';

const LEVEL_NAMES = ['ECO', 'TOUR', 'SPORT', 'SPORT+', 'BOOST'];
const LEVEL_MAP = uiToInternalAssistMap[5];
const P2_LEVEL_PROPERTIES = [
    'start_torque_value', 'max_torque_value', 'return_torque_value', 'max_current', 'min_current',
];
const LIMP_FLOOR_PCT = 30;
const LIMP_STAGE2_PCT = 15;
const LIMP_DISABLED = 0xFF;

const el = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function previewP0() {
    const loadsKg = [0, 3, 6, 9, 12, 16, 20, 24, 28];
    return {
        par0_value_offset_0: 0,
        acceleration_levels: Array.from({ length: 9 }, (_, index) => ({ acceleration_level: clamp(2 + Math.floor(index / 2), 1, 7) })),
        assist_ratio_levels: loadsKg.map((kg) => ({ assist_ratio_level: torqueKgToMv(kg) })),
        assist_ratio_upper_limit: torqueKgToMv(60),
        unknown_bytes: new Array(33).fill(0),
    };
}

function previewP1() {
    return {
        system_voltage: 48,
        current_limit: 15,
        overvoltage: 60,
        undervoltage: 39000,
        undervoltage_under_load: 39000,
        battery_capacity: 15000,
        max_current_on_low_charge: 25,
        // CB-018: these three must match what a controller actually leaves the factory with
        // — InitEEPROM() in the firmware's src/parser.c. They were invented instead, and the
        // card shows them in ordinary-looking fields, so "Legal speed-limit flag: Enabled"
        // was read as the bike's own setting when the bike in fact had the limit OFF. That
        // is a rider believing the bike limits their speed when it does not.
        limp_mode_soc_limit: LIMP_DISABLED,        // firmware: LIMP_DISABLED
        limp_mode_soc_limit_stage2: LIMP_DISABLED, // firmware: LIMP_DISABLED
        full_capacity_range: 10,
        coaster_brake: true,                       // firmware: LEGALFLAG 1 — the 25 km/h legal limit is on by default
        motor_type: 1,
        motor_pole_pair_number: 22,
        speedmeter_magnets_number: 1,
        temperature_sensor_type: 16,
        motor_max_rotor_rpm: 202,
        throttle_start_voltage: 1.1,
        throttle_max_voltage: 3.6,
        speed_limit_enabled: 30,
        start_current: 0,
        current_loading_time: 1.0,
        current_shedding_time: 1.0,
        assist_levels: Array.from({ length: 9 }, (_, index) => ({
            current_limit: clamp(20 + index * 10, 0, 100),
            speed_limit: 100,
        })),
        displayless_mode: false,
        lamps_always_on: false,
        walk_assist_speed: 45, // FW-043: target chainring RPM (was 6 km/h)
    };
}

function previewP2() {
    return {
        torque_profiles: Array.from({ length: 6 }, (_, speedIndex) => ({
            start_torque_value: 20 + speedIndex * 2,
            max_torque_value: 40 + speedIndex * 3,
            return_torque_value: 60 + speedIndex * 4,
            max_current: 80 + speedIndex * 3,
            min_current: 100,
            torque_decay_time: speedIndex ? 20 : 0,
            start_pulse: speedIndex ? 100 : 0,
            current_decay_time: 5,
            stop_delay: 2,
        })),
        unknown_bytes_1: new Array(6).fill(0),
        unknown_bytes_2: new Array(8).fill(0),
        acceleration_level: 4,
    };
}

function ensureDraft() {
    if (!state.ebicsCompatibilityDraft) {
        const wheel = wheelDiameterTable.find((item) => item.text.startsWith('29')) || wheelDiameterTable[0];
        state.ebicsCompatibilityDraft = {
            p0: previewP0(),
            p1: previewP1(),
            p2: previewP2(),
            speed: { speed_limit: 25, wheel_diameter: clone(wheel), circumference: 2300 },
            startup_angle: 0,
        };
    }
    state.ebicsCompatibilityReceived = state.ebicsCompatibilityReceived || {};
    return state.ebicsCompatibilityDraft;
}

function captureEvent(eventType) {
    const draft = ensureDraft();
    const received = state.ebicsCompatibilityReceived;
    if (eventType === 'controller_params_0' && state.lastControllerP0) {
        draft.p0 = clone(state.lastControllerP0);
        received.p0 = true;
    }
    if (eventType === 'controller_params_1' && state.lastControllerP1) {
        draft.p1 = clone(state.lastControllerP1);
        received.p1 = true;
    }
    if (eventType === 'controller_params_2' && state.lastControllerP2) {
        draft.p2 = clone(state.lastControllerP2);
        received.p2 = true;
    }
    if (eventType === 'controller_speed_params' && state.controllerSpeedParams) {
        draft.speed = clone(state.controllerSpeedParams);
        received.speed = true;
    }
    if (eventType === 'controller_startup_angle' && state.lastStartupAngle !== null) {
        draft.startup_angle = state.lastStartupAngle;
        received.startup = true;
    }
    if (eventType === 'controller_errors' && Array.isArray(state.controllerErrors)) received.errors = true;
    if (eventType === 'controller_bank' && state.ebicsReceivedBanks?.[0] && state.ebicsReceivedBanks?.[1]) {
        received.banks = true;
    }
}

function socketReady() {
    if (socket.readyState === WebSocket.OPEN && state.isCanConnected) return true;
    addLog('ERR', 'CAN controller is not connected.');
    return false;
}

function sourceLabel(keys) {
    const received = state.ebicsCompatibilityReceived || {};
    const count = keys.filter((key) => received[key]).length;
    const complete = count === keys.length;
    const stale = !complete && isEbicsConnected();
    let text;
    if (complete) text = 'Values read from controller';
    else if (stale) text = count
        ? `⚠ Only partly read (${count}/${keys.length}) — read again before writing, values below may be stale.`
        : '⚠ Not read from the controller yet — values below are placeholders, NOT your bike\'s real settings.';
    else text = count
        ? `Partly read (${count}/${keys.length}) — read all before writing`
        : 'Offline defaults — connect and Read to load your real settings.';
    return { text, stale };
}

function updateSourceLabels() {
    const labels = {
        ebicsCompatibilitySourceLimits: { keys: ['p1', 'speed'] },
        ebicsCompatibilitySourceWalk: { keys: ['banks'] },
        ebicsCompatibilitySourceLegacy: { keys: ['p0', 'p1', 'p2', 'startup'] },
        ebicsCompatibilitySourceSystem: { keys: ['p1'] },
    };
    Object.entries(labels).forEach(([id, { keys }]) => {
        const { text, stale } = sourceLabel(keys);
        if (el(id)) {
            el(id).textContent = text;
            el(id).classList.toggle('ebics-stale-warning', stale);
        }
        markReadNeeded(id, stale);
    });
}

// CB-018: which read does this field's data come from, and has that read happened?
//
// Until now an unread block was announced by one line of text above the card while the
// fields below it looked like ordinary values. Nobody reads the line — they read the field.
// That is how "Legal speed-limit flag: Enabled" was taken for the bike's own setting while
// the bike had the limit switched off.
function fieldIsUnread(target) {
    const draft = state.ebicsCompatibilityDraft;
    const received = state.ebicsCompatibilityReceived || {};
    if (draft) {
        if (target === draft.p0) return !received.p0;
        if (target === draft.p1) return !received.p1;
        if (target === draft.p2) return !received.p2;
        if (target === draft.speed) return !received.speed;
        // The startup angle sits on the draft root rather than in a sub-block, so it needs
        // its own case — without it, that one field kept showing a value nobody read.
        if (target === draft) return !received.startup;
    }
    // Walk fields are handed a bank object; the placeholders are a separate array, so an
    // object from it is by definition not something the controller sent.
    if (WALK_FIELD_PLACEHOLDERS.includes(target)) return true;
    return false;
}

const NOT_READ_TEXT = 'not read';

// Blank and lock the control, so a placeholder can never be mistaken for a measurement.
// Greying alone is not enough — a disabled select still shows "Enabled".
function markFieldUnread(control, isSelect) {
    control.disabled = true;
    control.title = 'Not read from the controller yet — press Read on this card. Nothing here is your bike\'s setting until you do.';
    if (isSelect) {
        control.innerHTML = '';
        control.add(new Option(`— ${NOT_READ_TEXT} —`, ''));
        control.value = '';
    } else {
        control.value = '';
        control.placeholder = NOT_READ_TEXT;
    }
}

function createField(container, target, descriptor) {
    if (!container || !target) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ebics-field';
    const label = document.createElement('label');
    label.append(descriptor.unit ? `${descriptor.label} (${descriptor.unit})` : descriptor.label);
    if (descriptor.help) label.appendChild(helpBadge(descriptor.help));
    wrapper.appendChild(label);

    const unread = fieldIsUnread(target);

    if (descriptor.options) {
        const select = document.createElement('select');
        select.className = 'form-select';
        select.disabled = !!descriptor.disabled;
        descriptor.options.forEach((option) => select.add(new Option(option.label, String(option.value))));
        const fromNative = descriptor.fromNative || ((value) => value);
        select.value = String(fromNative(target[descriptor.key]));
        if (unread) markFieldUnread(select, true);
        select.addEventListener('change', () => {
            const raw = select.value;
            const parsed = descriptor.boolean ? raw === 'true' : parseFloat(raw);
            const toNative = descriptor.toNative || ((value) => value);
            target[descriptor.key] = toNative(parsed);
            descriptor.onChange?.();
        });
        wrapper.appendChild(select);
    } else {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'form-input';
        input.min = descriptor.min;
        input.max = descriptor.max;
        input.step = descriptor.step ?? 1;
        input.disabled = !!descriptor.disabled;
        const fromNative = descriptor.fromNative || ((value) => value);
        const current = fromNative(target[descriptor.key]);
        input.value = isNumber(current) ? current : '';

        // CB-015: some firmware fields carry an "off" value outside their own range — limp
        // mode uses 255. Shown in a plain 0-100 box it read as a broken value, the browser
        // flagged it as out of range, and touching the box clamped 255 down to 100, turning
        // "off" into a real threshold with no way to type "off" back. The switch makes the
        // state explicit and settable in both directions.
        const isOff = (value) => value === descriptor.disabledValue || value === 0 || !isNumber(value);
        let offToggle = null;
        if (descriptor.disabledValue !== undefined) {
            const toggle = document.createElement('label');
            toggle.className = 'ebics-inline-check';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = !isOff(target[descriptor.key]);
            offToggle = box;
            toggle.appendChild(box);
            toggle.append(descriptor.enableLabel || 'Enabled');
            wrapper.appendChild(toggle);

            const applyState = () => {
                input.disabled = !box.checked || !!descriptor.disabled;
                if (!box.checked) {
                    target[descriptor.key] = descriptor.disabledValue;
                    input.value = '';
                } else if (!isNumber(parseFloat(input.value))) {
                    // Coming back from off with nothing to go on: start somewhere sane
                    // rather than at the range minimum, which is itself "off".
                    input.value = descriptor.enableDefault ?? descriptor.min;
                    target[descriptor.key] = Number(input.value);
                }
                descriptor.onChange?.();
            };
            box.addEventListener('change', applyState);
            // Off at render time means the box shows nothing rather than a raw 255.
            if (isOff(target[descriptor.key])) { input.value = ''; input.disabled = true; }
        }
        const updateValue = (normalizeInput) => {
            let value = parseFloat(input.value);
            if (!Number.isFinite(value)) return;
            value = clamp(value, descriptor.min, descriptor.max);
            if (normalizeInput) input.value = value;
            const toNative = descriptor.toNative || ((next) => next);
            target[descriptor.key] = toNative(value);
            descriptor.onChange?.();
        };
        input.addEventListener('change', () => updateValue(true));
        if (descriptor.liveUpdate) input.addEventListener('input', () => updateValue(false));
        // CB-025: chart -> box. The limp-mode chart writes the draft and then asks every
        // control bound to that key to repaint, so the number here follows the handle.
        registerFieldDisplay(wrapper, descriptor.key, () => {
            const value = target[descriptor.key];
            const off = descriptor.disabledValue !== undefined && isOff(value);
            if (offToggle) offToggle.checked = !off;
            input.disabled = off || !!descriptor.disabled;
            input.value = off ? '' : fromNative(value);
        });
        // Last, so it wins over the CB-015 on/off state above: an unread field must not
        // present any value at all, on or off.
        if (unread) markFieldUnread(input, false);
        wrapper.appendChild(input);
    }
    container.appendChild(wrapper);
}

const voltageOptions = [36, 40, 43, 48, 52, 60, 72].map((value) => ({ value, label: `${value} V` }));

function appendLimpRow(table, socRange, scale) {
    const row = table.insertRow();
    row.insertCell().textContent = socRange;
    row.insertCell().textContent = scale;
}

function limpStage1Disabled(stage1) {
    return !isNumber(stage1) || stage1 <= 0 || stage1 === LIMP_DISABLED;
}

function limpStage2Active(stage1, stage2) {
    return isNumber(stage2) && stage2 > 0 && stage2 < stage1 && stage2 !== LIMP_DISABLED;
}

// Mirrors compute_limp_factor() in eVistDrive firmware, including its final 30% floor clamp.
function firmwareLimpScalePct(soc, stage1, stage2) {
    if (limpStage1Disabled(stage1)) return 100;

    const clampedSoc = Math.max(0, soc);
    if (clampedSoc >= stage1) return 100;

    let factor;
    if (limpStage2Active(stage1, stage2)) {
        if (clampedSoc > stage2) {
            factor = LIMP_STAGE2_PCT
                + (100 - LIMP_STAGE2_PCT) * (clampedSoc - stage2) / (stage1 - stage2);
        } else {
            factor = LIMP_FLOOR_PCT
                + (LIMP_STAGE2_PCT - LIMP_FLOOR_PCT) * clampedSoc / stage2;
        }
    } else {
        factor = LIMP_FLOOR_PCT + (100 - LIMP_FLOOR_PCT) * clampedSoc / stage1;
    }
    return clamp(factor, LIMP_FLOOR_PCT, 100);
}

function formatLimpSoc(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function limpFloorStartSoc(stage1, stage2) {
    if (!limpStage2Active(stage1, stage2)) return 0;
    return stage2
        + (LIMP_FLOOR_PCT - LIMP_STAGE2_PCT) * (stage1 - stage2) / (100 - LIMP_STAGE2_PCT);
}

/*
 * CB-025: the limp chart is an editor too.
 *
 * Its container is created once and reused, never rebuilt. That is a requirement, not a
 * preference: updateLimpSocSummary runs on every frame of a drag, and a chart element removed
 * from the document loses the overlay's pointer capture — which would end the drag after the
 * first pixel.
 */
const LIMP_CHART_ID = 'ebicsLimpSocChart';
let limpChartElement = null;

function limpChartNode() {
    if (!limpChartElement) {
        limpChartElement = document.createElement('div');
        limpChartElement.className = 'ebics-limp-chart';
        limpChartElement.id = LIMP_CHART_ID;
    }
    return limpChartElement;
}

// The two thresholds, described by the very field descriptors the boxes above are built from.
// Kept next to the fields themselves (renderLimitsFields) so the two cannot drift apart.
const LIMP_FIELD_DESCRIPTORS = [
    { key: 'limp_mode_soc_limit', label: 'Limp SoC stage 1 threshold', unit: '%', min: 1, max: 100, step: 1 },
    { key: 'limp_mode_soc_limit_stage2', label: 'Limp SoC stage 2 threshold', unit: '%', min: 1, max: 100, step: 1 },
];

function renderLimpSocChart(chart, stage1, stage2) {
    if (!chart || !globalThis.Plotly) return;

    const host = chartHost(LIMP_CHART_ID);
    if (!host) return;
    const disabled = limpStage1Disabled(stage1);
    const stage2Enabled = limpStage2Active(stage1, stage2);
    const floorStart = limpFloorStartSoc(stage1, stage2);
    // Frozen while dragging: the axis end is derived from Stage 1, which is what the handle
    // moves — an axis that followed it would make the drag chase itself.
    const maxSoc = disabled
        ? 100
        : Math.min(100, frozenAxis(host, 'x', Math.max(15, stage1 * 1.25), 5));
    const points = new Set(Array.from({ length: 241 }, (_, index) => maxSoc * index / 240));
    [0, maxSoc, stage1, stage2Enabled ? stage2 : null, stage2Enabled ? floorStart : null]
        .filter((value) => isNumber(value) && value >= 0 && value <= maxSoc)
        .forEach((value) => points.add(value));
    const socValues = [...points].sort((a, b) => a - b);
    const limitValues = socValues.map((soc) => firmwareLimpScalePct(soc, stage1, stage2));

    const traces = [{
        x: socValues,
        y: limitValues,
        name: 'Effective firmware limit',
        type: 'scatter',
        mode: 'lines',
        fill: 'tozeroy',
        fillcolor: 'rgba(37, 99, 235, 0.12)',
        line: { color: '#2563eb', width: 3 },
        hovertemplate: 'Displayed SoC: %{x:.2f}%<br>Phase-current limit: %{y:.1f}%<extra></extra>',
    }];

    if (!disabled) {
        const markerSoc = stage2Enabled ? [stage1, stage2, floorStart] : [stage1, 0];
        const markerText = stage2Enabled
            ? ['Stage 1', 'Stage 2 (clamped)', '30% floor starts']
            : ['Stage 1', '30% floor'];
        traces.push({
            x: markerSoc,
            y: markerSoc.map((soc) => firmwareLimpScalePct(soc, stage1, stage2)),
            text: markerText,
            name: 'Firmware points',
            type: 'scatter',
            mode: 'markers',
            marker: { color: '#ea580c', size: 8 },
            hovertemplate: '%{text}<br>Displayed SoC: %{x:.2f}%<br>Effective limit: %{y:.1f}%<extra></extra>',
        });
    }

    /*
     * The two thresholds are the two corners of this curve, and both are a SoC — a position
     * along the x axis — so they slide left and right. The axis runs backwards (100 % on the
     * left, empty on the right) because that is the direction a ride goes; the drag maths is
     * a straight linear map either way.
     *
     * A threshold whose switch is off gets no handle: turning limp mode on is a decision, not
     * something to stumble into by brushing the chart.
     */
    const edit = {
        descriptors: LIMP_FIELD_DESCRIPTORS,
        onEdit: (key) => updateFieldDisplays(key),
    };
    const xRange = [maxSoc, 0];
    const yRange = [0, 105];
    const handles = [
        fieldHandle(edit, 'limp_mode_soc_limit', {
            axis: 'x', x: stage1, y: 100, value: stage1, color: '#ea580c',
            label: 'Stage 1 — limp starts here', disabled,
        }),
        fieldHandle(edit, 'limp_mode_soc_limit_stage2', {
            axis: 'x', x: stage2, y: firmwareLimpScalePct(stage2, stage1, stage2), value: stage2,
            color: '#ea580c', label: 'Stage 2 — steeper slope below here',
            disabled: !stage2Enabled,
        }),
    ];
    traces.push(...handleTraces(handles, 'Drag a threshold'));

    const layout = {
        height: 280,
        margin: { t: 18, r: 12, b: 48, l: 52 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,0.72)',
        font: { color: '#1e3a8a', size: 11 },
        showlegend: false,
        hovermode: false,
        xaxis: {
            title: 'Displayed SoC (%) — decreasing →',
            range: xRange,
            fixedrange: true,
            automargin: false,
            ticksuffix: '%',
            gridcolor: '#dbeafe',
            zerolinecolor: '#93c5fd',
        },
        yaxis: {
            title: 'Phase-current limit',
            range: yRange,
            fixedrange: true,
            automargin: false,
            ticksuffix: '%',
            gridcolor: '#dbeafe',
            zerolinecolor: '#93c5fd',
        },
    };

    drawEditable(LIMP_CHART_ID, traces, layout, {
        handles,
        xRange,
        yRange,
        grab: 'point',
        description: 'Low-SoC limp. Drag a threshold left or right, or use the arrow keys.',
        // The draft is what every other control on this tab edits; nothing here reaches the
        // controller until the tab's own Write button is pressed.
        onChange: handleEditor(ensureDraft().p1, edit, updateLimpSocSummary),
    });
}

function updateLimpSocSummary() {
    const summary = el('ebicsLimpSocSummary');
    if (!summary) return;

    const p1 = ensureDraft().p1 || {};
    const stage1 = Number(p1.limp_mode_soc_limit);
    const stage2 = Number(p1.limp_mode_soc_limit_stage2);
    const stage1Disabled = limpStage1Disabled(stage1);
    const stage2Active = limpStage2Active(stage1, stage2);

    const { table, chart, noteElement } = limpSummaryNodes(summary);
    while (table.rows.length) table.deleteRow(0);

    let note = '';
    if (stage1Disabled) {
        appendLimpRow(table, 'All SoC values', '100%');
        note = 'Stage 1 set to 0 or 255 disables SoC-based limp.';
    } else if (stage2Active) {
        const floorStart = limpFloorStartSoc(stage1, stage2);
        appendLimpRow(table, `SoC ≥ ${stage1}%`, '100%');
        appendLimpRow(table, `${formatLimpSoc(floorStart)}% < SoC < ${stage1}%`, `30% → 100%`);
        appendLimpRow(table, `0% ≤ SoC ≤ ${formatLimpSoc(floorStart)}%`, `${LIMP_FLOOR_PCT}%`);
        note = `The raw Stage 2 formula requests ${LIMP_STAGE2_PCT}%, but firmware clamps every result below ${LIMP_FLOOR_PCT}% back to ${LIMP_FLOOR_PCT}%.`;
    } else {
        appendLimpRow(table, `SoC ≥ ${stage1}%`, '100%');
        appendLimpRow(table, `0% < SoC < ${stage1}%`, `100% → ${LIMP_FLOOR_PCT}%`);
        appendLimpRow(table, 'SoC = 0%', `${LIMP_FLOOR_PCT}%`);
        note = 'Stage 2 is inactive unless it is greater than 0 and lower than Stage 1.';
    }

    noteElement.textContent = `${note} Firmware refreshes this scale about once per second from displayed SoC. Legacy Startup Boost is a separate path and can temporarily exceed the scaled ceiling.`;
    renderLimpSocChart(chart, stage1, stage2);
}

/*
 * The summary's furniture, built once and then updated in place.
 *
 * This used to replaceChildren() on every call, which was harmless while the chart was only a
 * picture. It is not harmless now: this function runs on every frame of a drag, and removing
 * the chart element from the document — which replaceChildren does even when the same node is
 * put straight back — releases the overlay's pointer capture and ends the drag after one pixel.
 */
let limpNodes = null;
function limpSummaryNodes(summary) {
    if (!limpNodes || limpNodes.summary !== summary || !summary.contains(limpNodes.chart)) {
        const title = document.createElement('div');
        title.className = 'ebics-limp-title';
        title.textContent = 'Low-SoC limp scales phase-current max from displayed SoC:';
        const table = document.createElement('table');
        table.className = 'ebics-limp-table';
        const chart = limpChartNode();
        const noteElement = document.createElement('div');
        noteElement.className = 'ebics-limp-note';
        summary.replaceChildren(title, table, chart, noteElement);
        limpNodes = { summary, title, table, chart, noteElement };
    }
    return limpNodes;
}

function renderLimitsFields() {
    const draft = ensureDraft();
    const electrical = el('ebicsLimitsElectricalFields');
    const speed = el('ebicsLimitsSpeedFields');
    if (electrical) electrical.innerHTML = '';
    if (speed) speed.innerHTML = '';

    [
        { key: 'system_voltage', label: 'System voltage', options: voltageOptions,
            help: 'Nominal battery voltage. Used by the controller for voltage-based calculations — set it to match your actual pack, not just a round number.' },
        { key: 'current_limit', label: 'Maximum battery current', unit: 'A', min: 1, max: 60, step: 1,
            help: 'Hard ceiling on current drawn from the battery, across all assist levels and Walk Assist. Protects the battery/BMS — separate from, and on top of, the per-level Maximum motor current phase-current limits in Profiles.' },
        { key: 'overvoltage', label: 'Overvoltage cutoff', unit: 'V', min: 0, max: 100, step: 1,
            help: 'Controller cuts off if pack voltage rises above this (e.g. during strong regen/braking on a full battery). Set above your pack\'s true full-charge voltage, not at or below it.' },
        {
            key: 'undervoltage_under_load', label: 'Undervoltage cutoff under load', unit: 'V', min: 0, max: 100, step: 0.1,
            fromNative: (value) => value / 1000, toNative: (value) => Math.round(value * 1000),
            help: 'Controller cuts off if pack voltage sags below this while under load. Set below your pack\'s real resting voltage at low charge, but high enough to protect the cells — check your BMS/cell specs.',
        },
        { key: 'battery_capacity', label: 'Battery capacity', unit: 'mAh', min: 100, max: 65000, step: 100,
            help: 'Nominal battery capacity, used for the range/remaining-capacity estimate shown on the display. Doesn\'t affect how the motor is driven.' },
        {
            key: 'limp_mode_soc_limit', label: 'Limp SoC stage 1 threshold', unit: '%', min: 1, max: 100, step: 1,
            // 255 is the firmware's "off"; so is 0. A fresh controller ships with both off.
            disabledValue: LIMP_DISABLED, enableLabel: 'Limp mode on', enableDefault: 20,
            help: 'Below this displayed SoC, firmware starts reducing the phase-current limit. Unticked means limp mode is off — which is how a controller leaves the factory.',
            onChange: updateLimpSocSummary,
            liveUpdate: true,
        },
        {
            key: 'limp_mode_soc_limit_stage2', label: 'Limp SoC stage 2 threshold', unit: '%', min: 1, max: 100, step: 1,
            disabledValue: LIMP_DISABLED, enableLabel: 'Second stage on', enableDefault: 10,
            help: 'A steeper second slope below this SoC. Only does anything when it is lower than Stage 1. Its raw 15% request is clamped by firmware to the 30% floor. Unticked means one slope only.',
            onChange: updateLimpSocSummary,
            liveUpdate: true,
        },
    ].forEach((field) => createField(electrical, draft.p1, field));
    updateLimpSocSummary();

    [
        { key: 'coaster_brake', label: 'Legal speed-limit flag', options: [{ value: true, label: 'Enabled' }, { value: false, label: 'Disabled' }], boolean: true,
            help: 'Turns the speed limit below on or off. When Disabled, there is no speed limit. This same limit can also be lifted temporarily on the bike, without touching Canable, with a handlebar gesture (cycle the assist level Eco→0→Eco within about 2.5 s); repeating the gesture restores the limit. The gesture resets to "restored" every time the bike is switched off.' },
        { key: 'speedmeter_magnets_number', label: 'Speed sensor pulses/revolution', min: 1, max: 255, step: 1,
            help: 'Number of speed-sensor pulses per wheel revolution. Must match your actual sensor/magnet setup — wrong here means every speed and distance reading (and the speed limit) is scaled incorrectly.' },
    ].forEach((field) => createField(speed, draft.p1, field));
    createField(speed, draft.speed, { key: 'speed_limit', label: 'Speed limit', unit: 'km/h', min: 1, max: 99, step: 0.1,
        help: 'Above this speed, assist fades out (see Legal speed-limit flag above to turn this on/off, and the handlebar gesture to lift it temporarily).' });
    createWheelField(speed, draft.speed);
    createField(speed, draft.speed, { key: 'circumference', label: 'Wheel circumference', unit: 'mm', min: 400, max: 3000, step: 1,
        help: 'Wheel circumference in millimetres, used together with the speed sensor to compute speed and distance. Overrides the rough estimate from Wheel diameter above if you\'ve measured your actual tyre. Typical values: 20″=1590, 24″=1905, 26″=2050, 27.5″(650B)=2145, 28″/700C=2224, 29″=2326 — exact figure depends on tyre width, so measure yours (roll the wheel one full turn, marked point to marked point) if you want it precise.' });

    renderLegalLimitState(speed, draft);
}

// CB-018: whether the bike limits your speed is worth more than one entry in a dropdown
// nobody opens. Say it, in the card, in words — and only once it is known, so an unread
// block never claims either way.
function renderLegalLimitState(container, draft) {
    if (!container) return;
    const note = document.createElement('div');
    note.className = 'ebics-source-note';
    note.style.gridColumn = '1 / -1';

    if (!state.ebicsCompatibilityReceived?.p1) {
        note.textContent = 'Speed limit: not read from the controller yet — press "Read" to see whether this bike limits assist.';
    } else if (draft.p1.coaster_brake) {
        const limit = isNumber(draft.speed?.speed_limit) ? `${draft.speed.speed_limit} km/h` : 'the speed set below';
        note.textContent = `Speed limit ACTIVE — assist fades out from ${limit}. It can still be lifted on the bike with the Eco→0→Eco handlebar gesture until the next power-off, which Canable cannot see.`;
    } else {
        note.classList.add('ebics-stale-warning');
        note.textContent = '⚠ Speed limit OFF — this bike does not limit assist at any speed. Set the flag above to Enabled and write it if you want the limit.';
    }
    container.appendChild(note);
}

function createWheelField(container, speedDraft) {
    if (!container || !speedDraft) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ebics-field';
    const label = document.createElement('label');
    label.append('Wheel diameter');
    label.appendChild(helpBadge('Used with the speed sensor pulse count to compute wheel speed. Pick the closest standard size; small errors here are usually not worth chasing — set "Wheel circumference" below directly if you have measured it.'));
    const select = document.createElement('select');
    select.className = 'form-select';
    wheelDiameterTable.forEach((wheel, index) => select.add(new Option(wheel.text, String(index))));
    const selectedIndex = wheelDiameterTable.findIndex((wheel) =>
        wheel.code?.[0] === speedDraft.wheel_diameter?.code?.[0] && wheel.code?.[1] === speedDraft.wheel_diameter?.code?.[1]);
    select.value = String(selectedIndex >= 0 ? selectedIndex : 0);
    select.addEventListener('change', () => {
        speedDraft.wheel_diameter = clone(wheelDiameterTable[parseInt(select.value, 10)]);
    });
    // CB-018: builds its own select rather than going through createField, so it needs the
    // same treatment — otherwise it alone would still show a wheel size nobody read.
    if (fieldIsUnread(speedDraft)) markFieldUnread(select, true);
    wrapper.append(label, select);
    container.appendChild(wrapper);
}

/*
 * FW-044/FW-057: the Walk Assist cut-off speed is edited here for convenience, but it physically
 * lives in the PROFILE BANK blob, not in the 0x6011 record the rest of this tab writes. Both
 * banks are shown side by side (no picker) so the rider can compare/edit them without switching.
 *
 * Writing still needs a guard: state.lastBanks holds placeholder defaults until a bank has
 * actually been read. Sending WRITE_BANK/SAVE_BANKS before that would overwrite the rider's real
 * per-level tuning with those placeholders — so Write/Save check ebicsReceivedBanks per bank.
 */
function bankStateFor(index) {
    const hasData = !!(state.lastBanks && state.ebicsReceivedBanks?.[index]);
    return { index, bank: hasData ? state.lastBanks[index] : WALK_FIELD_PLACEHOLDERS[index], hasData };
}

function setWalkStatus(text, isError = false) {
    const status = el('ebicsWalkStatus');
    if (!status) return;
    status.textContent = text;
    status.style.display = text ? 'block' : 'none';
    status.style.color = isError ? '#b91c1c' : '';
}

// Firmware boot defaults (assist_modes.c BANK_WA_*_DEFAULT) — matches what a fresh bank ships
// with. One independent object PER bank so editing bank 1's placeholder never bleeds into bank 2.
const WALK_FIELD_PLACEHOLDERS = [
    { wa_current_pct: 30, wa_target_rpm: 18, wa_latch_after_release: false, wa_latch_timeout_s: 30, wa_cutoff_kmh: 7 },
    { wa_current_pct: 30, wa_target_rpm: 18, wa_latch_after_release: false, wa_latch_timeout_s: 30, wa_cutoff_kmh: 7 },
];

function renderWalkActiveSummary() {
    const active = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank ?? 0;
    const { bank, hasData } = bankStateFor(active);
    if (el('ebicsWalkSpeed')) el('ebicsWalkSpeed').textContent = hasData ? (bank.wa_target_rpm ?? 'N/A') : String(bank.wa_target_rpm);
}

function renderWalkFields() {
    const bothRead = !!(state.ebicsReceivedBanks?.[0] && state.ebicsReceivedBanks?.[1]);
    const stale = !bothRead && isEbicsConnected();
    if (!bothRead) {
        const text = state.ebicsBankReadError
            ? `Bank read failed: ${state.ebicsBankReadError}`
            : (stale
                ? '⚠ Not read from the controller yet — fields below are placeholders, NOT your bike\'s real settings. Press "Read".'
                : 'Offline defaults — connect and press "Read from bike" to load your real settings.');
        setWalkStatus(text, stale || !!state.ebicsBankReadError);
    } else {
        setWalkStatus('');
    }
    markReadNeeded('walk', stale);
    renderWalkActiveSummary();

    const active = state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank ?? 0;
    [0, 1].forEach((index) => {
        const container = el(`ebicsWalkFields${index}`);
        if (!container) return;
        container.innerHTML = '';
        const { bank, hasData } = bankStateFor(index);
        const label = el(`ebicsWalkBankLabel${index}`);
        if (label) {
            label.textContent = hasData
                ? (index === active ? '— active' : '')
                : (isEbicsConnected() ? '— ⚠ not read yet' : '— offline default');
            label.classList.toggle('ebics-stale-warning', !hasData && isEbicsConnected());
        }
        // CB-019: "Walk motor current" removed. The value travels correctly all the way —
        // Para1[36] seeds it, the bank stores it in byte 8, the controller reports it back —
        // but nothing in firmware ever reads it: assist_modes_get_wa_current_pct() has no
        // caller, and walk_assist_motor.c limits current with fixed constants
        // (WA_MOTOR_IQ_ABS_MAX, WA_MOTOR_RUN_MAX_IQ). A slider that looks like the main
        // strength control and moves nothing is worse than no slider.
        //
        // The byte itself stays in the blob, untouched: dropping it would change the bank
        // layout and invalidate every bank already stored in a controller. Whatever was
        // read is written back unchanged.
        createField(container, bank, {
            key: 'wa_target_rpm', label: 'Walk chainring speed', unit: 'RPM', min: 18, max: 60, step: 1,
            onChange: renderWalkActiveSummary,
            help: 'Target CHAINRING speed Walk Assist tries to hold (the crank/chainring shaft, not the wheel) — bike walking speed then depends on the gear you\'re in, same as normal pedalling. Range is deliberately narrow (18-60 RPM) to keep this at a safe walking pace.',
        });
        createField(container, bank, {
            key: 'wa_cutoff_kmh', label: 'Cut-off speed', unit: 'km/h', min: 1, max: 25.5, step: 0.1,
            help: 'Above this bike speed, Walk Assist switches off completely — a safety backstop since Walk Assist holds motor speed, not wheel speed, so a high gear could otherwise push the bike faster than you can walk beside it.',
        });
        createField(container, bank, {
            key: 'wa_latch_after_release', label: 'Continue after releasing Walk button',
            options: [
                { value: false, label: 'Off - hold button' },
                { value: true, label: 'On - timed run' },
            ],
            boolean: true,
            help: 'Off (default): you must keep the Walk button held down the whole time — release it and the motor stops immediately. On: releasing the button after a proper press lets Walk Assist keep running hands-free for up to Timed run limit, until you brake, change assist level, press another button, or the timer runs out.',
        });
        createField(container, bank, {
            key: 'wa_latch_timeout_s', label: 'Timed run limit', unit: 's', min: 1, max: 120, step: 1,
            help: 'How long the hands-free timed run (see "Continue after releasing Walk button") is allowed to continue after you release the Walk button, if that option is enabled.',
        });
    });
}

function renderSystemFields() {
    const draft = ensureDraft();
    const motor = el('ebicsSystemMotorFields');
    const ride = el('ebicsSystemRideFields');
    if (motor) motor.innerHTML = '';
    if (ride) ride.innerHTML = '';
    [
        { key: 'motor_type', label: 'Motor direction', options: [{ value: 1, label: 'Forward' }, { value: 0, label: 'Reverse' }],
            help: 'Which direction counts as "forward" for the motor\'s commutation. Wrong setting makes the motor fight itself or spin the wrong way — leave this alone unless you know it needs changing after a wiring/sensor change.' },
        { key: 'motor_pole_pair_number', label: 'Mechanical gear ratio', min: 1, max: 255, step: 1,
            help: 'Despite the label, this is electrical revolutions per crank revolution (motor pole pairs × the gearbox\'s mechanical reduction), not a simple mechanical ratio. On the M820: 7 pole pairs × 11.43:1 gearbox = 80. This feeds every speed/cadence/Walk-Assist-RPM calculation that depends on motor revolutions — do not "correct" it down to the mechanical ratio (≈11.4), that would inflate those readings roughly 7×.' },
        { key: 'speedmeter_magnets_number', label: 'Speed sensor pulses/revolution', min: 1, max: 255, step: 1,
            help: 'Number of speed-sensor pulses per wheel revolution. Must match your actual sensor/magnet setup — wrong here means every speed and distance reading (and the speed limit) is scaled incorrectly.' },
        { key: 'motor_max_rotor_rpm', label: 'Off-road Magic number', min: 0, max: 65535, step: 1,
            help: 'Not read by firmware since FW-050 — the off-road speed-limit-bypass gesture (cycle assist level Eco→0→Eco) now uses a fixed sequence instead of a code stored here. Kept in storage for compatibility; editing this field has no effect.' },
        { key: 'temperature_sensor_type', label: 'Decay base (unused)', min: 0, max: 255, step: 1,
            help: 'Dead setting. It belonged to the old cadence-based pedal-assist calculation, which FW-094 removed from the firmware entirely — no code reads this value any more. The field is still stored and read back only so the controller\'s parameter block keeps its layout. Editing it has no effect on riding.' },
    ].forEach((field) => createField(motor, draft.p1, field));
    [
        { key: 'full_capacity_range', label: 'Cadence exponent (unused)', min: 0, max: 255, step: 1,
            help: 'Dead setting. It shaped the old cadence-based pedal-assist calculation, which FW-094 removed from the firmware entirely — no code reads this value any more. The field is still stored and read back only so the controller\'s parameter block keeps its layout. Editing it has no effect on riding.' },
        { key: 'throttle_start_voltage', label: 'Throttle start voltage', unit: 'V', min: 0, max: 4.2, step: 0.1,
            help: 'Throttle ADC voltage that reads as "no throttle input". Below this, the throttle contributes nothing — the natural off-point for a disconnected or idle throttle.' },
        { key: 'throttle_max_voltage', label: 'Throttle maximum voltage', unit: 'V', min: 0, max: 4.2, step: 0.1,
            help: 'Throttle ADC voltage that reads as "full throttle". Between Start and here, throttle current ramps linearly up to the level\'s current limit.' },
        {
            key: 'start_current', label: 'Old overrun duration (unused)', unit: 'ms', min: 0, max: 10200, step: 40,
            fromNative: (value) => value * 40, toNative: (value) => Math.round(value / 40),
            help: 'Dead setting. It set how long the old firmware kept pulling after you stopped pedalling ("power drag-on"). FW-094 removed that mechanism entirely. This is NOT the Extended Boost you configure per assist level — that one is a separate, safety-gated feature in the profile settings. Editing this has no effect on riding.',
        },
        { key: 'current_loading_time', label: 'PAS timeout', unit: 's', min: 0.1, max: 25.5, step: 0.1,
            help: 'LIVE setting — this one does affect riding, despite sitting among the dead fields here. It is how long the pedal sensor may go without a torque/rotation signal before cadence is forced to zero and the reverse-pedalling latch clears. Very short values can falsely read as "stopped pedalling" during the normal dead-spots between pedal strokes.' },
        { key: 'current_shedding_time', label: 'Ramp-end control (unused)', min: 0.1, max: 25.5, step: 0.1,
            help: 'Dead setting. Stored and read back, but no firmware code reads it — and none has for several releases. Editing it has no effect on riding.' },
    ].forEach((field) => createField(ride, draft.p1, field));
}

function formatNumber(value, decimals = null) {
    if (!isNumber(value)) return '';
    return Number.isInteger(decimals) ? value.toFixed(decimals) : value;
}

function tableInput(value, min, max, step, onChange, disabled = false, decimals = null) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = formatNumber(value, decimals);
    input.disabled = disabled;
    if (!disabled) input.addEventListener('change', () => {
        const parsed = parseFloat(input.value);
        if (!Number.isFinite(parsed)) return;
        const next = clamp(parsed, min, max);
        input.value = formatNumber(next, decimals);
        onChange(next);
    });
    return input;
}

function legacyTorqueThresholdControl(entry, levelIndex) {
    const kg = torqueMvToKg(entry.assist_ratio_level);
    const wrapper = document.createElement('div');
    wrapper.appendChild(tableInput(kg, 0, LEGACY_TORQUE_LINEAR_MAX_KG, 0.1, (value) => {
        setAscendingLevel(ensureDraft().p0.assist_ratio_levels, levelIndex, 'assist_ratio_level', torqueKgToMv(value));
    }, false, 1));

    if (isNumber(kg) && kg > LEGACY_TORQUE_LINEAR_MAX_KG) {
        const warning = document.createElement('small');
        warning.className = 'form-hint text-amber-600';
        warning.textContent = `Read ${kg.toFixed(1)} kg; Legacy linear map ends at ${LEGACY_TORQUE_LINEAR_MAX_KG.toFixed(1)} kg. Editing or writing will clamp this value.`;
        wrapper.appendChild(warning);
    }
    return wrapper;
}

function setAscendingLevel(array, levelIndex, key, value) {
    const internalIndices = LEVEL_NAMES.map((_, index) => LEVEL_MAP[index + 1]);
    const internal = internalIndices[levelIndex];
    array[internal][key] = value;
    if (!el('ebicsLegacyAutoCorrectionCheckbox')?.checked) return;
    for (let index = levelIndex + 1; index < internalIndices.length; index++) {
        const entry = array[internalIndices[index]];
        if (entry[key] < value) entry[key] = value;
    }
    for (let index = levelIndex - 1; index >= 0; index--) {
        const entry = array[internalIndices[index]];
        if (entry[key] > value) entry[key] = value;
    }
    renderLegacyAssistTable();
}

function renderLegacyAssistTable() {
    const body = el('ebicsLegacyAssistTableBody');
    if (!body) return;
    body.innerHTML = '';
    const draft = ensureDraft();
    LEVEL_NAMES.forEach((name, levelIndex) => {
        const internal = LEVEL_MAP[levelIndex + 1];
        const row = body.insertRow();
        row.insertCell().textContent = name;
        const p1Level = draft.p1.assist_levels[internal];
        const p0Accel = draft.p0.acceleration_levels[internal];
        const p0Threshold = draft.p0.assist_ratio_levels[internal];
        row.insertCell().appendChild(tableInput(p1Level.current_limit, 0, 100, 1, (value) => {
            setAscendingLevel(draft.p1.assist_levels, levelIndex, 'current_limit', value);
        }));
        row.insertCell().appendChild(tableInput(p1Level.speed_limit, 0, 100, 1, (value) => {
            setAscendingLevel(draft.p1.assist_levels, levelIndex, 'speed_limit', value);
        }));
        row.insertCell().appendChild(tableInput(p0Accel.acceleration_level, 1, 7, 1, (value) => {
            setAscendingLevel(draft.p0.acceleration_levels, levelIndex, 'acceleration_level', value);
        }));
        row.insertCell().appendChild(legacyTorqueThresholdControl(p0Threshold, levelIndex));
    });
}

function renderLegacyProfileTable() {
    const body = el('ebicsLegacyProfileTableBody');
    if (!body) return;
    body.innerHTML = '';
    const profiles = ensureDraft().p2.torque_profiles;
    LEVEL_NAMES.forEach((name, levelIndex) => {
        const property = P2_LEVEL_PROPERTIES[levelIndex];
        const row = body.insertRow();
        row.insertCell().textContent = name;
        profiles.forEach((profile) => {
            row.insertCell().appendChild(tableInput(profile[property], 0, 255, 1, (value) => { profile[property] = value; }));
        });
    });
}

function renderLegacyBoostTable() {
    const body = el('ebicsLegacyBoostTableBody');
    if (!body) return;
    body.innerHTML = '';
    const profiles = ensureDraft().p2.torque_profiles;
    LEVEL_NAMES.forEach((name, index) => {
        const storage = profiles[index + 1];
        const row = body.insertRow();
        row.insertCell().textContent = name;
        row.insertCell().appendChild(tableInput(storage.start_pulse, 0, 255, 1, (value) => { storage.start_pulse = value; }));
        row.insertCell().appendChild(tableInput(storage.torque_decay_time, 0, 255, 1, (value) => { storage.torque_decay_time = value; }));
    });
}

function renderLegacyAdvancedFields() {
    const container = el('ebicsLegacyAdvancedFields');
    if (!container) return;
    container.innerHTML = '';
    const draft = ensureDraft();
    createField(container, draft, { key: 'startup_angle', label: 'TS coefficient (0x62D9)', min: 0, max: 360, step: 1 });
    createField(container, draft.p1, { key: 'full_capacity_range', label: 'Cadence exponent', min: 0, max: 255, step: 1 });
    createField(container, draft.p1, { key: 'temperature_sensor_type', label: 'Decay base', min: 0, max: 255, step: 1 });
    createField(container, draft.p1, { key: 'motor_max_rotor_rpm', label: 'Magic number', min: 0, max: 65535, step: 1 });
    createField(container, draft.p1, { key: 'motor_type', label: 'Motor direction', options: [{ value: 1, label: 'Forward' }, { value: 0, label: 'Reverse' }] });
    createField(container, draft.p1, { key: 'motor_pole_pair_number', label: 'Gear ratio', min: 1, max: 255, step: 1 });
}

function renderErrors() {
    const body = el('ebicsControllerErrorsTableBody');
    if (!body) return;
    body.innerHTML = '';
    const errors = state.controllerErrors || [];
    if (!errors.length) {
        const row = body.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 3;
        cell.textContent = state.ebicsCompatibilityReceived?.errors ? 'No controller errors reported.' : 'Errors not read yet.';
        return;
    }
    errors.forEach((code) => {
        const row = body.insertRow();
        row.insertCell().textContent = code;
        row.insertCell().textContent = errorDescriptions[String(code)] || 'Unknown controller error';
        row.insertCell().textContent = errorRecommendations[String(code)] || 'Inspect controller and wiring.';
    });
}

function renderLegacyStatus() {
    const body = el('ebicsLegacyTableBody');
    if (!body) return;
    body.innerHTML = '';
    const draft = ensureDraft();
    const rows = [
        ['0x6010', 'TQ filter and lower thresholds', '5 assist levels', sourceLabel(['p0']).text],
        ['0x6011', 'Limits, Walk, PAS and Legacy values', `${draft.p1.system_voltage} V / ${draft.p1.current_limit} A`, sourceLabel(['p1']).text],
        ['0x6012', 'assist_profile[5][6] and Extended Boost storage', '30 profile values', sourceLabel(['p2']).text],
        ['0x62D9', 'TS coefficient', draft.startup_angle, sourceLabel(['startup']).text],
    ];
    rows.forEach((values) => {
        const row = body.insertRow();
        values.forEach((value) => { row.insertCell().textContent = value; });
    });
}

function renderCompatibilityUI() {
    renderLimitsFields();
    renderWalkFields();
    renderSystemFields();
    renderLegacyAdvancedFields();
    renderLegacyAssistTable();
    renderLegacyProfileTable();
    renderLegacyBoostTable();
    renderLegacyStatus();
    renderErrors();
    updateSourceLabels();
}

async function readBlock(command, reset, predicate, key, timeoutMs = 1800) {
    reset();
    socket.send(command);
    const received = await waitFor(predicate, timeoutMs, 50);
    if (!received) addLog('WARN', `Timeout while reading eVistDrive compatibility ${key}.`);
    return received;
}

export async function syncAllCompatibilityData() {
    if (!socketReady()) return;
    addLog('REQ', 'Reading eVistDrive compatibility Controller/Assist blocks...');
    state.ebicsCompatibilityReceived = {};
    await readBlock('READ:2:96:7', () => { state.controllerErrors = null; }, () => Array.isArray(state.controllerErrors), 'errors');
    await readBlock('READ:2:96:16', () => { state.lastControllerP0 = null; }, () => state.lastControllerP0 !== null, 'P0');
    await readBlock('READ:2:96:17', () => { state.lastControllerP1 = null; state.controllerParams1 = null; }, () => state.lastControllerP1 !== null, 'P1');
    await readBlock('READ:2:96:18', () => { state.lastControllerP2 = null; }, () => state.lastControllerP2 !== null, 'P2');
    await readBlock('READ:2:50:3', () => { state.controllerSpeedParams = null; }, () => state.controllerSpeedParams !== null, 'speed');
    await readBlock('READ_STARTUP_ANGLE', () => { state.lastStartupAngle = null; }, () => state.lastStartupAngle !== null, 'startup angle');
    renderCompatibilityUI();
}

async function syncWalkData() {
    if (!socketReady()) return;
    addLog('REQ', 'Reading eVistDrive Walk bank settings...');
    setWalkStatus('Reading Walk settings from profile banks...');
    state.ebicsBankReadError = '';
    state.ebicsReceivedBanks = {};
    state.banksSynced = false;
    if (state.lastBanks) {
        delete state.lastBanks[0];
        delete state.lastBanks[1];
    }
    renderCompatibilityUI();

    // Needed only for migration from very old bank blobs that did not store Walk current/RPM.
    await readBlock('READ:2:96:17', () => {
        state.lastControllerP1 = null;
        state.controllerParams1 = null;
    }, () => state.lastControllerP1 !== null, 'P1 for Walk migration');

    const bank0Read = await readBlock('READ_BANK:0', () => {
        state.ebicsReceivedBanks[0] = false;
    }, () => state.ebicsReceivedBanks?.[0] === true, 'bank 1', 3000);
    const bank1Read = await readBlock('READ_BANK:1', () => {
        state.ebicsReceivedBanks[1] = false;
    }, () => state.ebicsReceivedBanks?.[1] === true, 'bank 2', 3000);

    state.banksSynced = !!(state.ebicsReceivedBanks?.[0] && state.ebicsReceivedBanks?.[1]);
    if (!state.banksSynced) {
        const missing = [];
        if (!bank0Read) missing.push('bank 1');
        if (!bank1Read) missing.push('bank 2');
        state.ebicsBankReadError = `${missing.join(', ')} did not answer`;
    }
    renderCompatibilityUI();
}

function requireRead(keys, action) {
    const missing = keys.filter((key) => !state.ebicsCompatibilityReceived?.[key]);
    if (!socketReady()) return false;
    if (missing.length) {
        addLog('ERR', `Cannot ${action}: read ${missing.join(', ')} first.`);
        return false;
    }
    return true;
}

function p1Subset(keys) {
    const p1 = ensureDraft().p1;
    return Object.fromEntries(keys.map((key) => [key, clone(p1[key])]));
}

function legacyP0ForWrite() {
    const p0 = clone(ensureDraft().p0);
    const maxMv = torqueKgToMv(LEGACY_TORQUE_LINEAR_MAX_KG);
    let clamped = false;
    p0.assist_ratio_levels?.forEach((entry) => {
        if (entry.assist_ratio_level > maxMv) {
            entry.assist_ratio_level = maxMv;
            clamped = true;
        }
    });
    return { p0, clamped };
}

const LIMIT_P1_KEYS = [
    'system_voltage', 'current_limit', 'max_current_on_low_charge', 'overvoltage',
    'undervoltage_under_load', 'battery_capacity', 'limp_mode_soc_limit',
    'limp_mode_soc_limit_stage2', 'coaster_brake', 'speedmeter_magnets_number',
];
const SYSTEM_P1_KEYS = [
    'motor_type', 'motor_pole_pair_number', 'speedmeter_magnets_number',
    'motor_max_rotor_rpm', 'temperature_sensor_type', 'full_capacity_range',
    'throttle_start_voltage', 'throttle_max_voltage', 'start_current',
    'current_loading_time', 'current_shedding_time',
];

/*
 * CB-026: the legacy blocks, written by the ONE save action in the top bar.
 *
 * These blocks are not like the eVistDrive blobs: the controller commits them to permanent
 * storage the moment it receives them, so there is no "try it and switch the bike off"
 * for anything in here. That is a property of the controller, not a choice this app makes,
 * and it is why the save dialog says so out loud.
 *
 * Limits and System both live in P1 and share `speedmeter_magnets_number`, so they go out as
 * ONE P1 frame rather than two that would each overwrite part of the other's work.
 *
 * Returns what it did instead of talking to the user: the caller is running several writes in
 * a row and has to report on all of them together.
 */
export async function writeLegacyBlocks() {
    const received = state.ebicsCompatibilityReceived || {};
    if (!received.p1) {
        return { ok: true, written: [], skipped: ['limits and system (never read from the bike)'] };
    }
    const draft = ensureDraft();
    /*
     * The WHOLE P1 block, never a subset.
     *
     * WRITE_LONG_P1 carries a fixed 64-byte structure and the serializer packs it by position.
     * Hand it an object with only the ten fields one card owns and every OTHER field is packed
     * from `undefined` — the block that comes back is not "the old values with a few changed",
     * it is garbage. Measured on the bench 2026-08-07: a subset write turned 15 A / 59 V /
     * 22.44 V into 66 A / 8 V / 1.28 V and switched the legal speed limit off, while the very
     * same values sent as a complete block wrote cleanly.
     *
     * The draft IS the complete block — a clone of the last read, with the edited fields
     * changed in place — so sending it whole is both correct and the smallest possible change.
     * Fields the parser adds for its own use are dropped; the controller has no room for them.
     */
    const p1 = clone(draft.p1);
    delete p1._rawBytes;
    delete p1.checksum_missmatch;
    socket.send(`WRITE_LONG_P1:${JSON.stringify(p1)}`);
    const written = ['limits and system'];
    const skipped = [];
    if (received.speed) {
        // The controller carries ONE multi-frame channel. Starting a second long write while
        // the first is still streaming makes it error-ACK the newcomer — seen on the bench as
        // `normal_ack subCode:33` immediately followed by `error_ack subCode:33`, and then a
        // bank that never changed. The same 500 ms spacing the old per-block writes used.
        await delay(LONG_WRITE_GAP_MS);
        socket.send(`WRITE_LONG_SPEED:${JSON.stringify(draft.speed)}`);
        written.push('speed limit and wheel');
    } else {
        skipped.push('speed limit and wheel (never read from the bike)');
    }
    await delay(LONG_WRITE_GAP_MS);
    return { ok: true, written, skipped };
}

// One multi-frame transfer must finish before the next one starts; see writeLegacyBlocks().
// A 255-byte bank blob is the longest of them, so the gap is sized for that rather than for
// the 64-byte P1 block.
export const LONG_WRITE_GAP_MS = 600;

/** Throw away on-screen edits to the legacy blocks and rebuild the draft from what was read. */
export function restoreLegacyDraft() {
    state.ebicsCompatibilityDraft = null;
    ensureDraft();
    captureEvent('controller_params_0');
    captureEvent('controller_params_1');
    captureEvent('controller_params_2');
    updateLegacyParamsUI();
}

// CB-026: applyWalk and applySystem are gone. Walk Assist lives inside the bank blob, so the
// top bar's save already carries it when it writes the banks, and the System block is part of
// the single P1 frame writeLegacyBlocks() sends. Both were writing the same bytes a second
// time from a second button.

async function applyLegacy() {
    if (!requireRead(['p0', 'p1', 'p2', 'startup'], 'write Legacy blocks')) return;
    const draft = ensureDraft();
    const { p0, clamped } = legacyP0ForWrite();
    const clampNotice = clamped
        ? `\n\nLower torque threshold values above ${LEGACY_TORQUE_LINEAR_MAX_KG.toFixed(1)} kg will be clamped before writing.`
        : '';
    if (!confirm(`Write eVistDrive Legacy P0, assist-level P1, P2 and TS coefficient to controller RAM?${clampNotice}`)) return;
    socket.send(`WRITE_LONG_P0:${JSON.stringify(p0)}`);
    await delay(500);
    socket.send(`WRITE_LONG_P1:${JSON.stringify({
        ...p1Subset(SYSTEM_P1_KEYS),
        assist_levels: draft.p1.assist_levels,
    })}`);
    await delay(500);
    socket.send(`WRITE_LONG_P2:${JSON.stringify(draft.p2)}`);
    await delay(500);
    socket.send(`WRITE_STARTUP_ANGLE:${draft.startup_angle}`);
    addLog('SAVE_REQ', 'eVistDrive Legacy P0/P1/P2 + TS coefficient');
}

async function clearControllerErrors() {
    if (!socketReady()) return;
    if (!confirm('Clear all controller error codes?')) return;
    socket.send('WRITE_SHORT:2:96:7:01');
    await delay(500);
    sendCustomFrame(encodeToHex(5, 2, 4, '6007'), '00');
    await delay(500);
    sendCustomFrame(encodeToHex(5, 2, 6, '0000'), '');
    await delay(500);
    socket.send('READ:2:96:7');
    addLog('SAVE_REQ', 'Clear controller errors from eVistDrive System');
}

function calibratePosition() {
    if (!socketReady()) return;
    if (!confirm('WARNING: the motor will spin. Remove the chain and secure the bike. Continue?')) return;
    socket.send('WRITE_SHORT:2:98:0:0000000000');
    addLog('SAVE_REQ', 'Calibrate position sensor from eVistDrive System');
}

async function restoreControllerDefaults() {
    if (!socketReady()) return;
    const confirmed = confirm(
        'Restore controller defaults using native eVistDrive0x6101?\n\n'
        + 'This overwrites saved controller settings in EEPROM, including P0/P1/P2 Legacy settings, TS coefficient, Walk settings, limits, bank/tuning flags and related controller defaults.\n\n'
        + 'eVistDrive torque zero remains automatic; this is not manual torque-zero calibration.\n\n'
        + 'Continue?'
    );
    if (!confirmed) return;
    socket.send('WRITE_SHORT:2:97:1');
    addLog('SAVE_REQ', 'Restore controller defaults from eVistDrive System (native 0x6101)');
    await delay(1200);
    await syncAllCompatibilityData();
}

function repairChecksum(block) {
    if (!socketReady()) return;
    const snapshot = block === 'P1' ? state.lastControllerP1Read : state.lastControllerP2Read;
    if (!snapshot) {
        addLog('ERR', `Cannot repair ${block} checksum: no last-read snapshot.`);
        return;
    }
    if (!confirm(`Rewrite ${block} from the last-read snapshot to repair its checksum?`)) return;
    socket.send(`WRITE_LONG_${block}:${JSON.stringify(snapshot)}`);
    setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(block === 'P1' ? 'READ:2:96:17' : 'READ:2:96:18');
    }, 1000);
    addLog('SAVE_REQ', `Repair ${block} checksum from eVistDrive System`);
}

/*
 * CB-026: the per-card Read and Write buttons are gone from every eVistDrive tab.
 *
 * Reading one block was always a subset of the top bar's read, and writing one card was
 * always a subset of its save — so a rider faced six buttons that did four overlapping
 * things, with only the tooltips explaining which of them actually survived a power cycle.
 * There is now one read, one save (with the temporary/permanent choice made in the dialog)
 * and one undo, in one place. What stays here is what is genuinely NOT a settings write:
 * calibration, defaults, error clearing and checksum repair.
 */
function bindButtons() {
    el('ebicsCalibratePositionButton')?.addEventListener('click', calibratePosition);
    el('ebicsRestoreControllerDefaultsButton')?.addEventListener('click', restoreControllerDefaults);
    el('ebicsClearControllerErrorsButton')?.addEventListener('click', clearControllerErrors);
    el('ebicsRepairP1ChecksumButton')?.addEventListener('click', () => repairChecksum('P1'));
    el('ebicsRepairP2ChecksumButton')?.addEventListener('click', () => repairChecksum('P2'));
}

export function updateLegacyParamsUI(eventType = '') {
    ensureDraft();
    if (eventType) captureEvent(eventType);
    const relevant = [
        'controller_params_0', 'controller_params_1', 'controller_params_2',
        'controller_speed_params', 'controller_startup_angle', 'controller_errors',
        'controller_bank', // FW-044: unlocks/refreshes the Walk cut-off once banks are read
    ];
    if (!eventType || relevant.includes(eventType)) renderCompatibilityUI();
}

bindButtons();
renderCompatibilityUI();
