// tab-banks.js — ES Module (FW-006/CB-002: profile bank configuration)
import {
    state, socket,
    addLog,
} from './shared.js';

const MODES = [
    { value: 1, label: 'Power Linear' },
    { value: 2, label: 'Power Progressive' },
    { value: 3, label: 'eMTB (TSDZ)' },
    { value: 5, label: 'Torque (TSDZ)' },
];

const COLUMNS = [
    { key: 'support_ratio_pct', label: 'Support (%)', min: 0, max: 1000, step: 10 },
    { key: 'emtb_parameter', label: 'eMTB param', min: 0, max: 250, step: 5 },
    { key: 'torque_assist_factor', label: 'Torque factor', min: 0, max: 254, step: 5 },
    { key: 'max_motor_power_w', label: 'Max power (W, 0=off)', min: 0, max: 1500, step: 50 },
    { key: 'max_iq_pct', label: 'Max current (%)', min: 0, max: 100, step: 5 },
    { key: 'startup_boost_enabled', label: 'Boost', bool: true },
    { key: 'startup_boost_strength_pct', label: 'Boost (%)', min: 0, max: 300, step: 10 },
    { key: 'smooth_start_enabled', label: 'Smooth', bool: true },
    { key: 'smooth_start_ms', label: 'Smooth (ms)', min: 0, max: 5000, step: 50 },
    { key: 'release_ms', label: 'Release (ms, 0=auto)', min: 0, max: 3000, step: 50 },
];

state.lastBanks = state.lastBanks || {};

const el = (id) => document.getElementById(id);

// Offline defaults — mirror firmware assist_modes.c default_levels / emtb_levels.
// Preview only: a real "Read" overwrites these. Keep in sync with the firmware
// defaults if they change there.
function defaultLevel(mode, support, emtb, torque) {
    return {
        mode_type: mode, support_ratio_pct: support,
        support_min_pct: support, support_max_pct: support,
        reference_power_w: 200, progression_pct: 0,
        emtb_parameter: emtb, emtb_based_on_power: true,
        emtb_reference_voltage_mv: 36000, torque_assist_factor: torque,
        max_motor_power_w: 0, max_iq_pct: 100,
        assist_without_rotation: false, without_rotation_threshold_mv: 18,
        startup_boost_enabled: true, startup_boost_mode: 0,
        startup_boost_strength_pct: 200, startup_boost_end_rpm: 45,
        smooth_start_enabled: false, smooth_start_ms: 300,
        release_ms: 0, power_rise_filter_ms: 0, power_fall_filter_ms: 0,
    };
}

function defaultBank(bankIndex) {
    const mode = bankIndex === 1 ? 3 : 1; // bank 1 = eMTB, bank 0 = Power Linear
    const S = [100, 200, 320, 420, 520];
    const E = [60, 100, 140, 160, 180];
    const T = [50, 80, 120, 160, 200];
    return {
        bank_index: bankIndex,
        active_bank: 0,
        levels: S.map((s, i) => defaultLevel(mode, s, E[i], T[i])),
    };
}

const DEFAULT_TUNING = {
    iq_rise_slow_ms: 600, iq_rise_fast_ms: 300,
    iq_fall_slow_ms: 1000, iq_fall_fast_ms: 140,
    startup_boost_cadence_step: 20,
};

function buildModeSelect(bankIndex) {
    const select = el(`bankMode${bankIndex}`);
    if (!select || select.options.length) return;
    MODES.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => {
        const bank = state.lastBanks[bankIndex];
        if (!bank) return;
        const mode = parseInt(select.value, 10);
        bank.levels.forEach((lv) => { lv.mode_type = mode; });
    });
}

function renderBank(bankIndex) {
    const bank = state.lastBanks[bankIndex];
    const head = el(`bankTableHead${bankIndex}`);
    const body = el(`bankTableBody${bankIndex}`);
    if (!bank || !head || !body) return;

    buildModeSelect(bankIndex);
    el(`bankMode${bankIndex}`).value = bank.levels[0]?.mode_type ?? 1;

    head.innerHTML = '';
    const hr = head.insertRow();
    hr.insertCell().textContent = 'Level';
    COLUMNS.forEach((c) => { hr.insertCell().textContent = c.label; });

    body.innerHTML = '';
    bank.levels.forEach((lv, i) => {
        const row = body.insertRow();
        row.insertCell().textContent = ['ECO', 'TOUR', 'SPORT', 'SPORT+', 'BOOST'][i] ?? i + 1;
        COLUMNS.forEach((c) => {
            const cell = row.insertCell();
            const input = document.createElement('input');
            if (c.bool) {
                input.type = 'checkbox';
                input.checked = !!lv[c.key];
                input.addEventListener('change', () => { lv[c.key] = input.checked; });
            } else {
                input.type = 'number';
                input.min = c.min; input.max = c.max; input.step = c.step;
                input.value = lv[c.key] ?? 0;
                input.style.width = '5.5em';
                input.addEventListener('change', () => {
                    let v = parseInt(input.value, 10);
                    if (isNaN(v)) v = 0;
                    v = Math.min(c.max, Math.max(c.min, v));
                    input.value = v;
                    lv[c.key] = v;
                });
            }
            cell.appendChild(input);
        });
    });
}

export function updateBanksUI() {
    // Seed offline defaults so the config is always visible, even before a Read.
    if (!state.lastBanks[0]) state.lastBanks[0] = defaultBank(0);
    if (!state.lastBanks[1]) state.lastBanks[1] = defaultBank(1);

    el('banksContainer').style.display = 'block';
    const ph = el('banksPlaceholder');
    ph.style.display = 'block';
    ph.textContent = state.banksSynced
        ? 'Values read from controller.'
        : '⚠ Showing default values — click Read Banks to load the controller’s actual configuration.';

    const active = state.lastBanks[0]?.active_bank ?? state.lastBanks[1]?.active_bank;
    el('activeBankLabel').textContent = (!state.banksSynced || active === undefined) ? 'N/A (not read)' :
        `Bank ${active + 1} (${active ? 'eMTB default' : 'Power default'})`;
    [0, 1].forEach((i) => renderBank(i));
}

el('banksReadButton').onclick = () => {
    addLog('REQ', 'Reading profile banks...');
    socket.send('READ_BANK:0');
    setTimeout(() => socket.send('READ_BANK:1'), 400);
};

el('banksApplyButton').onclick = () => {
    [0, 1].forEach((i) => {
        const bank = state.lastBanks[i];
        if (bank) {
            socket.send(`WRITE_BANK:${JSON.stringify(bank)}`);
            addLog('SAVE_REQ', `Bank ${i + 1} -> controller RAM`);
        }
    });
    if (!state.lastBanks[0] && !state.lastBanks[1]) {
        addLog('ERR', 'No bank data. Read Banks first.');
    }
};

el('banksSaveButton').onclick = () => {
    if (!confirm('Persist bank configuration to controller flash? (Written at full standstill.)')) return;
    socket.send('SAVE_BANKS');
    addLog('SAVE_REQ', 'Persist banks (flash write deferred to standstill)');
};

// --- FW-010: global ride-feel tuning (shares the same 0x6022 flash-persist trigger as banks) ---
const TUNING_FIELDS = [
    { key: 'iq_rise_slow_ms', label: 'Acceleration, low speed/cadence (ms)', min: 20, max: 5000, step: 10 },
    { key: 'iq_rise_fast_ms', label: 'Acceleration, high speed/cadence (ms)', min: 20, max: 5000, step: 10 },
    { key: 'iq_fall_slow_ms', label: 'Deceleration, low speed/cadence (ms)', min: 20, max: 5000, step: 10 },
    { key: 'iq_fall_fast_ms', label: 'Deceleration, high speed/cadence (ms)', min: 20, max: 5000, step: 10 },
    { key: 'startup_boost_cadence_step', label: 'Startup boost cadence step (1-100, higher = fades faster)', min: 1, max: 100, step: 1 },
];

function renderTuning() {
    if (!state.lastTuning) state.lastTuning = { ...DEFAULT_TUNING };
    const t = state.lastTuning;
    const body = el('tuningTableBody');
    if (!body) return;
    const ph = el('tuningPlaceholder');
    ph.style.display = 'block';
    ph.textContent = state.tuningSynced
        ? 'Values read from controller.'
        : '⚠ Showing default values — click Read Tuning to load the controller’s actual values.';
    el('tuningContainer').style.display = 'block';
    body.innerHTML = '';
    TUNING_FIELDS.forEach((f) => {
        const row = body.insertRow();
        row.insertCell().textContent = f.label;
        const cell = row.insertCell();
        const input = document.createElement('input');
        input.type = 'number';
        input.min = f.min; input.max = f.max; input.step = f.step;
        input.value = t[f.key] ?? 0;
        input.style.width = '6em';
        input.addEventListener('change', () => {
            let v = parseInt(input.value, 10);
            if (isNaN(v)) v = f.min;
            v = Math.min(f.max, Math.max(f.min, v));
            input.value = v;
            t[f.key] = v;
        });
        cell.appendChild(input);
    });
}

export function updateTuningUI() {
    renderTuning();
}

el('tuningReadButton').onclick = () => {
    addLog('REQ', 'Reading global tuning...');
    socket.send('READ_TUNING');
};

el('tuningApplyButton').onclick = () => {
    if (!state.lastTuning) { addLog('ERR', 'No tuning data. Read Tuning first.'); return; }
    socket.send(`WRITE_TUNING:${JSON.stringify(state.lastTuning)}`);
    addLog('SAVE_REQ', 'Tuning -> controller RAM');
};

el('tuningSaveButton').onclick = () => {
    if (!confirm('Persist tuning (and banks) to controller flash? (Written at full standstill.)')) return;
    socket.send('SAVE_BANKS');
    addLog('SAVE_REQ', 'Persist tuning + banks (flash write deferred to standstill)');
};

// Render config immediately with offline defaults so the fields are always visible.
updateBanksUI();
updateTuningUI();
