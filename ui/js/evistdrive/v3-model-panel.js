// evistdrive/v3-model-panel.js — the "Tryby V3" panel: per HMI level a mode and five corrections.
//
// One source for the rider-facing character of the bike (design: integration/roadmap/
// V3_JEDEN_MODEL_PROJEKT_PL.md). Every protocol call goes through v3-model-protocol.js; this
// file only draws and edits. Until the firmware reports the model capability (stage 2e) the
// panel works offline on the factory preset and NEVER sends a write.
import { socket, addLog } from '../shared.js';
import * as P from './v3-model-protocol.js';
import { el, socketReady, markReadNeeded } from './common.js';
import { markUnsavedInRam } from './global-actions.js';

const LEVEL_TITLES = ['Poziom 1', 'Poziom 2', 'Poziom 3', 'Poziom 4', 'Poziom 5'];
const SLIDERS = [
    { key: 'assist', label: 'Assist', left: 'mniej', right: 'więcej' },
    { key: 'attack', label: 'Attack', left: 'łagodniej', right: 'szybciej' },
    { key: 'release', label: 'Release', left: 'wolniej', right: 'szybciej' },
    { key: 'start', label: 'Start', left: 'wył. / łagodniej', right: 'żwawiej' },
    { key: 'carry', label: 'Carry', left: 'wył. / słabiej', right: 'mocniej' },
];

const model = {
    levels: P.factoryLevels(),
    baseline: null, // what the bike held at the last read; null = never read
    generation: null,
    client: null,
    caps: null,
    discovered: false,
    note: '',
};

const seconds = (ms) => `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 2).replace(/\.?0+$/, '')} s`;
const fmtPercent = (value) => `${(Math.round(value * 10) / 10).toString().replace('.', ',')} %`;

function clientFor() {
    if (!model.client) model.client = P.createModelClient(P.createSocketTransport(socket));
    return model.client;
}

/** Name of the V3 mode assigned to an HMI level 1..5 (on screen model), or null. */
export const v3ModeNameForLevel = (hmiLevel) => P.MODES[model.levels[hmiLevel - 1]?.mode]?.name ?? null;
export const v3ModelCanWrite = () => !!(model.caps?.model && model.caps.modelWritable);
export const v3ModelIsDirty = () => !!model.baseline
    && !P.levelsEqual(model.levels, model.baseline);

/** What an effective-value caption says for one slider, next to the mode default. */
export function describeEffective(level, key) {
    const mode = P.MODES[level.mode];
    const eff = P.effectiveValues(level);
    if (!mode || !eff) return '';
    if (key === 'assist') {
        const base = `${fmtPercent(eff.ratioPct)} (domyślnie ${fmtPercent(mode.ratio)})`;
        return mode.progressive
            ? `szczyt ${base}, nachylenie ${eff.slope.toFixed(2).replace('.', ',')}`
            : `współczynnik ${base}`;
    }
    if (key === 'attack') return `pełna skala w ${seconds(eff.attackMs)} (domyślnie ${seconds(mode.attackMs)})`;
    if (key === 'release') return `czas opadania ${seconds(eff.releaseMs)} (domyślnie ${seconds(mode.releaseMs)})`;
    const own = key === 'start' ? eff.start : eff.carry;
    const base = key === 'start' ? mode.start : mode.carry;
    return own === 0 ? 'wyłączone' : `profil ${own} (domyślnie ${base})`;
}

function statusText() {
    if (!model.discovered) return 'Nie sprawdzono, czy sterownik obsługuje model V3. Wartości poniżej to preset fabryczny lub plik.';
    if (!model.caps) return 'Sterownik nie odpowiedział na zapytanie o model V3 (starszy firmware albo brak połączenia). Panel działa tylko offline — zapis zablokowany.';
    if (!model.caps.model) return 'Firmware nie zgłasza obsługi modelu V3 (przed etapem 2e). Zapis zablokowany, ramki zapisu nie są wysyłane.';
    if (!model.caps.modelWritable) return 'Firmware zgłasza model tylko do odczytu. Zapis zablokowany.';
    const persist = P.PERSIST_TEXT[model.caps.persistState] ?? '';
    return `Sterownik obsługuje model V3 (generacja ${model.generation ?? model.caps.generation})${persist ? ` — ${persist}` : ''}.`;
}

function levelWarning(level) {
    const mode = P.MODES[level.mode];
    const out = [];
    if (level.start === 0) out.push('Start = 0: profil ruszania wyłączony.');
    if (level.carry === 0) out.push('Carry = 0: podtrzymanie wyłączone.');
    if (level.maxPowerW < mode.powerW && mode.powerW === P.HW_POWER_W && level.maxPowerW !== P.HW_POWER_W) {
        out.push('Max Power niższy niż limit sprzętu: obcina moc także przy Assist 50.');
    }
    return out;
}

function sliderRow(index, spec) {
    const level = model.levels[index];
    const wrap = document.createElement('div');
    wrap.className = 'evd-v3-row';
    const id = `evdV3-${index}-${spec.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.className = 'evd-v3-label';
    label.textContent = spec.label;
    const track = document.createElement('div');
    track.className = 'evd-v3-track';
    const left = document.createElement('small');
    left.textContent = spec.left;
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '100'; input.step = '1';
    input.id = id; input.value = String(level[spec.key]); input.className = 'evd-v3-slider';
    input.setAttribute('list', 'evdV3Ticks');
    const right = document.createElement('small');
    right.textContent = spec.right;
    const value = document.createElement('input');
    value.type = 'number'; value.min = '0'; value.max = '100'; value.step = '1';
    value.value = String(level[spec.key]); value.className = 'form-input evd-v3-number';
    value.setAttribute('aria-label', `${spec.label}, poziom ${index + 1}`);
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'btn btn-secondary btn-sm evd-v3-fifty';
    reset.textContent = '50'; reset.title = '50 = domyślna wartość trybu';
    track.append(left, input, right, value, reset);
    const caption = document.createElement('div');
    caption.className = 'evd-v3-effective';
    caption.textContent = describeEffective(level, spec.key);
    const apply = (raw) => {
        const next = Math.min(100, Math.max(0, Math.round(Number(raw))));
        if (!Number.isFinite(next)) return;
        level[spec.key] = next;
        input.value = String(next); value.value = String(next);
        wrap.classList.toggle('is-default', next === 50);
        caption.textContent = describeEffective(level, spec.key);
        refreshWarnings(index);
        markEdited(index);
    };
    wrap.classList.toggle('is-default', level[spec.key] === 50);
    input.addEventListener('input', () => apply(input.value));
    value.addEventListener('change', () => apply(value.value));
    reset.addEventListener('click', () => apply(50));
    wrap.append(label, track, caption);
    return wrap;
}

function refreshWarnings(index) {
    const box = el(`evdV3Warn-${index}`);
    if (!box) return;
    box.replaceChildren(...levelWarning(model.levels[index]).map((text) => {
        const p = document.createElement('div'); p.className = 'form-hint'; p.textContent = text; return p;
    }));
}

function markEdited(index) {
    el(`evdV3Card-${index}`)?.classList.add('is-edited');
    const writable = v3ModelCanWrite();
    const button = el(`evdV3WriteOne-${index}`);
    if (button) button.disabled = !writable;
    markUnsavedInRam();
}

function limitsRow(index) {
    const level = model.levels[index];
    const wrap = document.createElement('div');
    wrap.className = 'evd-v3-limits';

    const power = document.createElement('label');
    power.className = 'evd-v3-limit';
    const hw = level.maxPowerW === P.HW_POWER_W;
    power.innerHTML = '<span>Max Power</span>';
    const hwBox = document.createElement('input');
    hwBox.type = 'checkbox'; hwBox.checked = hw;
    const hwText = document.createElement('span'); hwText.textContent = 'limit sprzętu';
    const watts = document.createElement('input');
    watts.type = 'number'; watts.min = '50'; watts.max = '64999'; watts.step = '10';
    watts.className = 'form-input'; watts.disabled = hw;
    watts.value = hw ? '' : String(level.maxPowerW);
    watts.setAttribute('aria-label', `Max Power w watach, poziom ${index + 1}`);
    const unit = document.createElement('span'); unit.textContent = 'W';
    const mode = P.MODES[level.mode];
    const onPower = () => {
        if (hwBox.checked) { level.maxPowerW = P.HW_POWER_W; watts.disabled = true; watts.value = ''; }
        else {
            watts.disabled = false;
            if (!watts.value) watts.value = String(mode.powerW === P.HW_POWER_W ? 500 : mode.powerW);
            level.maxPowerW = Math.round(Number(watts.value));
        }
        refreshWarnings(index); markEdited(index);
    };
    hwBox.addEventListener('change', onPower);
    watts.addEventListener('change', onPower);
    power.append(hwBox, hwText, watts, unit);

    const torque = document.createElement('label');
    torque.className = 'evd-v3-limit';
    torque.innerHTML = '<span>Max Torque</span>';
    const pct = document.createElement('input');
    pct.type = 'number'; pct.min = '1'; pct.max = '100'; pct.step = '1';
    pct.className = 'form-input'; pct.value = String(level.maxTorquePct);
    pct.setAttribute('aria-label', `Max Torque w procentach, poziom ${index + 1}`);
    pct.addEventListener('change', () => {
        level.maxTorquePct = Math.round(Number(pct.value));
        markEdited(index);
    });
    const pctUnit = document.createElement('span'); pctUnit.textContent = '% dozwolonego Iq (nie Nm)';
    torque.append(pct, pctUnit);
    wrap.append(power, torque);
    return wrap;
}

function levelCard(index) {
    const level = model.levels[index];
    const card = document.createElement('section');
    card.className = 'ebics-card evd-v3-card';
    card.id = `evdV3Card-${index}`;
    const head = document.createElement('div');
    head.className = 'evd-v3-head';
    const title = document.createElement('div');
    title.className = 'ebics-card-title';
    title.textContent = `${LEVEL_TITLES[index]} (przycisk HMI)`;
    const modeSelect = document.createElement('select');
    modeSelect.className = 'form-select';
    modeSelect.setAttribute('aria-label', `Tryb dla poziomu ${index + 1}`);
    P.MODES.forEach((mode) => modeSelect.add(new Option(mode.name, String(mode.id))));
    modeSelect.value = String(level.mode);
    modeSelect.addEventListener('change', () => {
        level.mode = Number(modeSelect.value);
        // A new mode brings its own default limits; the corrections stay where the rider put them.
        const mode = P.MODES[level.mode];
        level.maxPowerW = mode.powerW; level.maxTorquePct = mode.torquePct;
        markEdited(index);
        renderPanel();
    });
    head.append(title, modeSelect);
    card.appendChild(head);
    const sharedWith = model.levels.map((l, i) => (i !== index && l.mode === level.mode ? i + 1 : null)).filter(Boolean);
    if (sharedWith.length) {
        const note = document.createElement('div');
        note.className = 'form-hint';
        note.textContent = `Ten sam tryb mają też poziomy: ${sharedWith.join(', ')}. Korekty są jednak osobne dla każdego poziomu.`;
        card.appendChild(note);
    }
    SLIDERS.forEach((spec) => card.appendChild(sliderRow(index, spec)));
    card.appendChild(limitsRow(index));
    const warn = document.createElement('div');
    warn.id = `evdV3Warn-${index}`;
    card.appendChild(warn);
    const actions = document.createElement('div');
    actions.className = 'evd-v3-actions';
    const restore = document.createElement('button');
    restore.type = 'button'; restore.className = 'btn btn-secondary btn-sm';
    restore.textContent = 'Przywróć fabryczny poziom (na ekranie)';
    restore.addEventListener('click', () => {
        model.levels[index] = P.factoryLevels()[index];
        markEdited(index);
        renderPanel();
    });
    const writeOne = document.createElement('button');
    writeOne.type = 'button'; writeOne.className = 'btn btn-blue btn-sm';
    writeOne.id = `evdV3WriteOne-${index}`;
    writeOne.disabled = !v3ModelCanWrite();
    writeOne.textContent = 'Zapisz ten poziom w sterowniku (RAM)';
    writeOne.title = v3ModelCanWrite() ? 'Zapis jednego poziomu do RAM sterownika, potem odczyt kontrolny.' : 'Zablokowane: firmware nie zgłasza obsługi modelu V3.';
    writeOne.addEventListener('click', () => writeLevels(index + 1, 1));
    actions.append(restore, writeOne);
    card.appendChild(actions);
    return card;
}

// ---- hardware section: settings that live elsewhere in the app and are NOT part of any mode ----

const HARDWARE = [
    { name: 'Kalibracja czujnika nacisku', where: 'ebics-torque', tab: 'Torque', detail: 'Zero i zakres czujnika. Jeden właściciel przeliczenia nacisku.' },
    { name: 'Bateria i SOC', where: 'ebics-limits', tab: 'Limits', detail: 'Napięcie systemu, prąd baterii, odcięcia napięcia, pojemność, tryb awaryjny (limp) wg SOC.' },
    { name: 'Limit prędkości i koło', where: 'ebics-limits', tab: 'Limits', detail: 'Flaga limitu prawnego, limit prędkości, obwód koła, impulsy czujnika prędkości.' },
    { name: 'Prąd fazy', where: null, tab: '', detail: 'Brak ustawienia w CANable: stały limit w firmware (etap 1). Ograniczenie momentu trybu to Max Torque powyżej, nie ten limit.' },
    { name: 'PAS (czujnik pedałowania)', where: 'ebics-system', tab: 'System', detail: 'PAS timeout, progi gazu i dane silnika.' },
    { name: 'Walk Assist', where: 'ebics-walk', tab: 'Walk', detail: 'Prąd, prędkość łańcucha, odcięcie i zatrzask Walk. Osobny tryb funkcjonalny, niezależny od trybów jazdy.' },
];

function hardwareSection() {
    const box = document.createElement('section');
    box.className = 'ebics-card evd-v3-hardware mt-4';
    box.id = 'evdV3Hardware';
    const title = document.createElement('div');
    title.className = 'ebics-card-title';
    title.textContent = 'Sprzęt — ustawienia niezależne od trybów';
    const note = document.createElement('p');
    note.className = 'form-hint';
    note.textContent = 'Te ustawienia nie należą do żadnego trybu ani poziomu. Edytujesz je w istniejących zakładkach; limity trybu (Max Power, Max Torque) są powyżej i działają niezależnie.';
    box.append(title, note);
    const list = document.createElement('ul');
    list.className = 'evd-v3-hw-list';
    HARDWARE.forEach((item) => {
        const li = document.createElement('li');
        const name = document.createElement('b'); name.textContent = item.name;
        const detail = document.createElement('span'); detail.textContent = ` — ${item.detail}`;
        li.append(name, detail);
        if (item.where) {
            const open = document.createElement('button');
            open.type = 'button'; open.className = 'btn btn-secondary btn-sm';
            open.textContent = `Otwórz: ${item.tab}`;
            open.addEventListener('click', () => document.querySelector(`.tab-button[data-tab="${item.where}"]`)?.click());
            li.appendChild(open);
        }
        list.appendChild(li);
    });
    box.appendChild(list);
    return box;
}

// ---- panel -----------------------------------------------------------------------------

export function renderPanel() {
    const root = el('evdV3Panel');
    if (!root) return;
    const scrollTop = root.scrollTop;
    const ticks = document.createElement('datalist');
    ticks.id = 'evdV3Ticks';
    [0, 25, 50, 75, 100].forEach((v) => { const o = document.createElement('option'); o.value = String(v); ticks.appendChild(o); });
    const status = el('evdV3Status');
    if (status) status.textContent = `${statusText()}${model.note ? ` ${model.note}` : ''}`;
    const stale = !model.baseline && model.caps?.model;
    markReadNeeded('profiles', !!stale);
    const grid = document.createElement('div');
    grid.className = 'evd-v3-grid';
    model.levels.forEach((_, index) => grid.appendChild(levelCard(index)));
    root.replaceChildren(ticks, grid, hardwareSection());
    model.levels.forEach((_, index) => refreshWarnings(index));
    root.scrollTop = scrollTop;
    const writeAll = el('evdV3WriteAll');
    if (writeAll) writeAll.disabled = !v3ModelCanWrite();
    ['evdV3Persist', 'evdV3Factory'].forEach((id) => { const b = el(id); if (b) b.disabled = !v3ModelCanWrite(); });
}

// ---- actions ---------------------------------------------------------------------------

export async function discoverModel() {
    if (!socketReady()) return null;
    model.caps = await clientFor().discover();
    model.discovered = true;
    return model.caps;
}

/** Read all five levels (RAM view). Part of the top bar's "Read from bike". */
export async function readModelFromBike() {
    await discoverModel();
    if (!model.caps?.model) {
        model.note = '';
        addLog('INFO', 'Model V3: sterownik go nie obsługuje, zostaje preset fabryczny na ekranie.');
        renderPanel();
        return false;
    }
    try {
        const back = await clientFor().read(0, P.VIEW.CONFIGURED);
        model.levels = P.cloneLevels(back.levels);
        model.baseline = P.cloneLevels(back.levels);
        model.generation = back.generation;
        model.note = 'Odczytano z urządzenia.';
        addLog('DATA', `Model V3 odczytany (generacja ${back.generation}).`);
    } catch (error) {
        model.note = `Odczyt modelu nie powiódł się: ${error.message}`;
        addLog('ERR', model.note);
    }
    renderPanel();
    return true;
}

async function writeLevels(first, count) {
    if (!socketReady()) return false;
    if (!v3ModelCanWrite()) {
        addLog('ERR', 'Model V3: zapis zablokowany — firmware nie zgłasza obsługi modelu.');
        return false;
    }
    const levels = model.levels.slice(first - 1, first - 1 + count);
    let result;
    try {
        result = await clientFor().write(first, levels, { baseGeneration: model.generation ?? 0xFFFF });
    } catch (error) {
        result = { ok: false, text: error.message };
    }
    if (!result.ok) {
        model.note = `Zapis modelu nie powiódł się: ${result.text}`;
        addLog('ERR', model.note);
        renderPanel();
        return false;
    }
    model.generation = result.generation;
    model.baseline = model.baseline ? model.baseline.map((l, i) => (i >= first - 1 && i < first - 1 + count ? { ...model.levels[i] } : l)) : P.cloneLevels(model.levels);
    model.note = count === 5 ? 'Zapisano wszystkie poziomy w RAM sterownika, odczyt kontrolny zgodny.' : `Zapisano poziom ${first} w RAM sterownika, odczyt kontrolny zgodny.`;
    addLog('ACK', `Model V3: ${model.note}`);
    renderPanel();
    return true;
}

export const writeAllLevels = () => writeLevels(1, 5);

export async function persistModel() {
    if (!v3ModelCanWrite()) { addLog('ERR', 'Model V3: zapis trwały zablokowany — brak obsługi w firmware.'); return false; }
    const result = await clientFor().persist(model.generation ?? 0xFFFF);
    if (!result.ok) { model.note = `Zapis trwały odrzucony: ${result.text}`; addLog('ERR', model.note); renderPanel(); return false; }
    model.note = 'Zapis trwały przyjęty — sterownik zapisze we flash na postoju; sprawdź stan po zatrzymaniu.';
    addLog('SAVE_REQ', `Model V3: ${model.note}`);
    renderPanel();
    return true;
}

async function restoreFactory() {
    model.levels = P.factoryLevels();
    markEdited(0);
    if (v3ModelCanWrite() && confirm('Przywrócić fabryczny preset modelu V3 w sterowniku (RAM)?\nStan trwały zmieni się dopiero po "Zapisz na stałe".')) {
        const result = await clientFor().restoreFactory();
        model.note = result.ok ? 'Fabryczny preset ustawiony w RAM sterownika.' : `Przywrócenie odrzucone: ${result.text}`;
        if (result.ok) { model.generation = result.generation; await readModelFromBike(); return; }
    } else {
        model.note = 'Fabryczny preset ustawiony na ekranie (sterownik nie zmieniony).';
    }
    renderPanel();
}

/** Top bar "Undo": screen back to what was read (or to the factory preset when never read). */
export function restoreModelFromRead() {
    model.levels = model.baseline ? P.cloneLevels(model.baseline) : P.factoryLevels();
    renderPanel();
    return model.baseline ? 'tryby V3 (jak odczytano)' : 'tryby V3 (preset fabryczny)';
}

/** What the top bar's Save… may send for the model. */
export const v3ModelScope = () => ({ writable: v3ModelCanWrite(), dirty: v3ModelIsDirty() || !model.baseline });

// ---- preset file (same model, same file for people with a different bike) ---------------

// Preset format and validation live in the protocol module (pure, unit-tested).

function bindPresetButtons() {
    el('evdV3PresetExport')?.addEventListener('click', () => {
        const preset = P.buildPreset(model.levels, el('evdV3PresetName')?.value || '', el('evdV3PresetNote')?.value || '');
        const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${(preset.name || 'tryby-v3').replace(/[^\w.-]+/g, '_')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    });
    const input = el('evdV3PresetFile');
    el('evdV3PresetImport')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        try {
            const preset = P.parsePreset(await file.text());
            model.levels = preset.levels;
            model.note = `Wczytano preset${preset.name ? ` „${preset.name}”` : ''} na ekran. Nic nie wysłano do sterownika.`;
            markEdited(0);
        } catch (error) {
            model.note = `Preset odrzucony: ${error.message}`;
        }
        renderPanel();
    });
}

export function bindModelPanel() {
    el('evdV3Read')?.addEventListener('click', () => { void readModelFromBike(); });
    el('evdV3WriteAll')?.addEventListener('click', () => { void writeAllLevels(); });
    el('evdV3Persist')?.addEventListener('click', () => { void persistModel(); });
    el('evdV3Factory')?.addEventListener('click', () => { void restoreFactory(); });
    el('evdV3Discover')?.addEventListener('click', async () => { await discoverModel(); renderPanel(); });
    bindPresetButtons();
    // The panel owns no CAN event: it redraws when the model is read, edited or the tab opens.
    window.addEventListener('app-tab-changed', (event) => {
        if (event.detail?.tab === 'ebics-profiles' || event.detail === 'ebics-profiles') renderPanel();
    });
    renderPanel();
}

// Exposed for the browser render check and for debugging in the console.
export const _modelForTests = model;
