// evistdrive/v3-model-panel.js — the "Tryby V3" panel: per HMI level a mode, six corrections and
// two limits, plus the rider/hardware object and live charts of what the settings do.
//
// One source for the rider-facing character of the bike (design: integration/roadmap/
// V3_JEDEN_MODEL_PROJEKT_PL.md, plan V3_PLAN_WDROZENIA_20261114_PL.md). Every protocol call goes
// through v3-model-protocol.js; this file only draws and edits. Until the firmware reports the
// capability bits (8/10 model, 11 rider) the panel works offline and NEVER sends a write.
import { socket, addLog } from '../shared.js';
import * as P from './v3-model-protocol.js';
import { drawLineChart, sample } from './v3-model-charts.js';
import { el, socketReady, markReadNeeded } from './common.js';
import { markUnsavedInRam } from './global-actions.js';

const LEVEL_COLORS = ['#16a34a', '#0ea5e9', '#6366f1', '#f59e0b', '#dc2626'];
const SLIDERS = [
    {
        key: 'assist', label: 'Assist', left: 'mniej', right: 'więcej',
        help: 'Siła wspomagania: mnoży to, co daje mapa. 50 = fabrycznie dla trybu. W prawo więcej wsparcia przy tym samym nacisku, w lewo mniej (×0,5…×2).',
    },
    {
        key: 'attack', label: 'Attack', left: 'łagodniej', right: 'szybciej',
        help: 'Jak szybko silnik dochodzi do mocy po naciśnięciu pedału. 50 = fabrycznie. W prawo szybciej (krótszy czas narastania), w lewo łagodniej.',
    },
    {
        key: 'release', label: 'Release', left: 'wolniej', right: 'szybciej',
        help: 'Jak szybko wspomaganie opada, gdy odpuszczasz nacisk. 50 = fabrycznie. W prawo szybsze opadanie, w lewo silnik dłużej trzyma moc.',
    },
    {
        key: 'start', label: 'Start', left: 'wył. / łagodniej', right: 'żwawiej',
        help: 'Kop przy ruszaniu (stan Start: tylko z postoju, poniżej 6 km/h, gaśnie do 50 obr/min). 50 = fabrycznie. W prawo pełny kop przy lżejszym nacisku, w lewo potrzeba mocniejszego. 0 = Start wyłączony.',
    },
    {
        key: 'carry', label: 'Carry', left: 'wył. / słabiej', right: 'mocniej',
        help: 'Podtrzymanie wspomagania po chwilowym przerwaniu pedałowania (np. zmiana biegu, przeszkoda). 50 = fabrycznie. W prawo mocniej, w lewo słabiej. 0 = wyłączone.',
    },
    {
        key: 'range', label: 'Zakres', left: 'dłuższy', right: 'krótszy',
        help: 'Jaki wysiłek daje pełne wyjście mapy wysiłku. 50 = fabrycznie (e_full trybu). W prawo krótszy zakres: 100 % przy lżejszym nacisku. W lewo dłuższy: trzeba mocniej nacisnąć. Działa tylko z włączoną mapą wysiłku.',
    },
];

const model = {
    levels: P.factoryLevels(),
    baseline: null, // what the bike held at the last read; null = never read
    rider: P.factoryRider(),
    riderBaseline: null,
    generation: null,
    client: null,
    caps: null,
    discovered: false,
    rangeKnown: true,
    note: '',
    chartLevel: 2, // index 0..4 of the level drawn in the Start chart
    chartCadence: 60,
    chartForce: 20,
};

const seconds = (ms) => `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 2).replace(/\.?0+$/, '')} s`;
const fmtPercent = (value) => `${(Math.round(value * 10) / 10).toString().replace('.', ',')} %`;
const fmtNum = (value, digits = 2) => value.toFixed(digits).replace('.', ',');
const kg = (x10) => `${fmtNum(x10 / 10, 1)} kg`;

function clientFor() {
    if (!model.client) model.client = P.createModelClient(P.createSocketTransport(socket));
    return model.client;
}

/** Name of the V3 mode assigned to an HMI level 1..5 (on screen model), or null. */
export const v3ModeNameForLevel = (hmiLevel) => P.MODES[model.levels[hmiLevel - 1]?.mode]?.name ?? null;
export const v3ModelCanWrite = () => !!(model.caps?.model && model.caps.modelWritable);
export const v3RiderCanWrite = () => !!model.caps?.rider;
const canPersist = () => v3ModelCanWrite() || v3RiderCanWrite();
export const v3ModelIsDirty = () => !!model.baseline
    && !P.levelsEqual(model.levels, model.baseline);
const riderDirty = () => !model.riderBaseline || !P.ridersEqual(model.rider, model.riderBaseline);

/** Multiplier shown next to a slider (×0,50 … ×2,00). */
const multiplierText = (x) => `×${fmtNum(P.multiplier(x))}`;

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
    if (key === 'range') {
        const over = eff.eFull > 1 ? ' — powyżej 100 %: pełne wyjście tylko przy wysiłku ponad możliwości z T0' : '';
        return `100 % mapy przy ${fmtPercent(eff.eFull * 100)} wysiłku (domyślnie ${fmtPercent(mode.eFull * 100)})${over}`;
    }
    if (key === 'start') {
        if (eff.start === 0) return 'wyłączone';
        return `pełny kop przy ${fmtNum(P.startFullForceKg(level), 1)} kg nacisku (domyślnie ${mode.fFullKg} kg); profil ${eff.start} (domyślnie ${mode.start})`;
    }
    return eff.carry === 0 ? 'wyłączone' : `profil ${eff.carry} (domyślnie ${mode.carry})`;
}

function capsSummary(caps) {
    const yes = (b, text) => `${text}: ${b ? 'tak' : 'nie'}`;
    return [yes(caps.model, 'model (bit 8)'), yes(caps.modelWritable, 'zapis modelu (bit 10)'), yes(caps.rider, 'rowerzysta i sprzęt (bit 11)')].join(', ');
}

function statusText() {
    if (!model.discovered) return 'Nie sprawdzono, czy sterownik obsługuje model V3. Wartości poniżej to preset fabryczny lub plik.';
    if (!model.caps) return 'Sterownik nie odpowiedział na zapytanie o model V3 (starszy firmware albo brak połączenia). Panel działa tylko offline — zapis zablokowany, ramki zapisu nie są wysyłane.';
    const persist = P.PERSIST_TEXT[model.caps.persistState] ?? '';
    const blocked = [];
    if (!v3ModelCanWrite()) blocked.push('zapis poziomów zablokowany');
    if (!v3RiderCanWrite()) blocked.push('zapis „Rowerzysta i sprzęt” zablokowany');
    return `Firmware zgłasza: ${capsSummary(model.caps)}.${blocked.length ? ` ${blocked.join('; ')} (brak bitu w firmware — nic nie jest wysyłane).` : ''}`
        + ` Generacja ${model.generation ?? model.caps.generation}${persist ? `, ${persist}` : ''}.`;
}

function levelWarning(level) {
    const mode = P.MODES[level.mode];
    const out = [];
    if (level.start === 0) out.push('Start = 0: kop przy ruszaniu wyłączony.');
    if (level.carry === 0) out.push('Carry = 0: podtrzymanie wyłączone.');
    if (level.maxPowerW !== P.HW_POWER_W && level.maxPowerW < mode.powerW) {
        out.push(`Max Power poniżej domyślnego dla ${mode.name} (${mode.powerW} W): moc obcięta wcześniej niż fabrycznie.`);
    }
    if (level.maxTorquePct < mode.torquePct) out.push(`Max Torque poniżej domyślnego (${mode.torquePct} %): obcina też kop Start.`);
    if (!model.rider.effortMap && level.range !== 50) out.push('Zakres ≠ 50, ale mapa wysiłku jest wyłączona: korekta nie działa.');
    return out;
}

function hint(text) {
    const p = document.createElement('div');
    p.className = 'evd-v3-help';
    p.textContent = text;
    return p;
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
    const mult = document.createElement('span');
    mult.className = 'evd-v3-mult';
    mult.textContent = multiplierText(level[spec.key]);
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'btn btn-secondary btn-sm evd-v3-fifty';
    reset.textContent = '50'; reset.title = '50 = fabryczna wartość trybu';
    track.append(left, input, right, value, mult, reset);
    const caption = document.createElement('div');
    caption.className = 'evd-v3-effective';
    caption.textContent = describeEffective(level, spec.key);
    const disabled = spec.key === 'range' && !model.rangeKnown;
    if (disabled) {
        [input, value, reset].forEach((x) => { x.disabled = true; });
        caption.textContent = 'Firmware przysłał obiekt w wersji 1 (bez pola Zakres): korekta niedostępna, sterownik używa e_full trybu.';
    }
    const apply = (raw) => {
        const next = Math.min(100, Math.max(0, Math.round(Number(raw))));
        if (!Number.isFinite(next)) return;
        level[spec.key] = next;
        input.value = String(next); value.value = String(next);
        mult.textContent = multiplierText(next);
        wrap.classList.toggle('is-default', next === 50);
        caption.textContent = describeEffective(level, spec.key);
        refreshWarnings(index);
        markEdited(index);
        refreshCharts();
    };
    wrap.classList.toggle('is-default', level[spec.key] === 50);
    input.addEventListener('input', () => apply(input.value));
    value.addEventListener('change', () => apply(value.value));
    reset.addEventListener('click', () => apply(50));
    wrap.append(label, track, caption, hint(spec.help));
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
    markUnsavedInRam();
}

function limitsRow(index) {
    const level = model.levels[index];
    const wrap = document.createElement('div');
    wrap.className = 'evd-v3-limits';
    const mode = P.MODES[level.mode];

    const powerBox = document.createElement('div');
    const power = document.createElement('label');
    power.className = 'evd-v3-limit';
    const hw = level.maxPowerW === P.HW_POWER_W;
    const powerName = document.createElement('span'); powerName.className = 'evd-v3-label'; powerName.textContent = 'Max Power';
    const hwBox = document.createElement('input');
    hwBox.type = 'checkbox'; hwBox.checked = hw;
    const hwText = document.createElement('span'); hwText.textContent = 'limit sprzętu';
    const watts = document.createElement('input');
    watts.type = 'number'; watts.min = '50'; watts.max = '64999'; watts.step = '10';
    watts.className = 'form-input'; watts.disabled = hw;
    watts.value = hw ? '' : String(level.maxPowerW);
    watts.setAttribute('aria-label', `Max Power w watach, poziom ${index + 1}`);
    const unit = document.createElement('span'); unit.textContent = `W (domyślnie ${mode.powerW === P.HW_POWER_W ? 'limit sprzętu' : `${mode.powerW} W`})`;
    const onPower = () => {
        if (hwBox.checked) { level.maxPowerW = P.HW_POWER_W; watts.disabled = true; watts.value = ''; }
        else {
            watts.disabled = false;
            if (!watts.value) watts.value = String(mode.powerW === P.HW_POWER_W ? 750 : mode.powerW);
            level.maxPowerW = Math.round(Number(watts.value));
        }
        refreshWarnings(index); markEdited(index); refreshCharts();
    };
    hwBox.addEventListener('change', onPower);
    watts.addEventListener('change', onPower);
    power.append(powerName, hwBox, hwText, watts, unit);
    powerBox.append(power, hint('Sufit mocy pobieranej z baterii na tym poziomie. Limit baterii i prądu fazy zostają nadrzędne. „limit sprzętu” (65000) = bez limitu trybu. Mniej W = spokojniej przy wysokiej kadencji i prędkości.'));

    const torqueBox = document.createElement('div');
    const torque = document.createElement('label');
    torque.className = 'evd-v3-limit';
    const torqueName = document.createElement('span'); torqueName.className = 'evd-v3-label'; torqueName.textContent = 'Max Torque';
    const pct = document.createElement('input');
    pct.type = 'number'; pct.min = '1'; pct.max = '100'; pct.step = '1';
    pct.className = 'form-input'; pct.value = String(level.maxTorquePct);
    pct.setAttribute('aria-label', `Max Torque w procentach, poziom ${index + 1}`);
    pct.addEventListener('change', () => {
        level.maxTorquePct = Math.round(Number(pct.value));
        refreshWarnings(index); markEdited(index); refreshCharts();
    });
    const pctUnit = document.createElement('span'); pctUnit.textContent = `% dozwolonego Iq (nie Nm; domyślnie ${mode.torquePct} %)`;
    torque.append(torqueName, pct, pctUnit);
    torqueBox.append(torque, hint('Sufit momentu silnika: ułamek dozwolonego prądu Iq. Obcina mapę i kop Start; najbardziej czuć go pod górę i przy ruszaniu.'));
    wrap.append(powerBox, torqueBox);
    return wrap;
}

function button(text, className, onClick, { id, disabled = false, title = '' } = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = className; b.textContent = text;
    if (id) b.id = id;
    b.disabled = disabled; b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

function levelCard(index) {
    const level = model.levels[index];
    const card = document.createElement('section');
    card.className = 'ebics-card evd-v3-card';
    card.id = `evdV3Card-${index}`;
    card.style.borderTop = `4px solid ${LEVEL_COLORS[index]}`;
    const head = document.createElement('div');
    head.className = 'evd-v3-head';
    const title = document.createElement('div');
    title.className = 'ebics-card-title';
    title.textContent = `Poziom ${index + 1} (przycisk HMI)`;
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
    card.appendChild(hint('Tryb wybiera charakter (ECO spokojny … BOOST pełna moc przy krótkim zakresie nacisku, AUTO = punkt TRAIL). Zmiana trybu ustawia jego domyślne Max Power i Max Torque.'));
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
    const writable = v3ModelCanWrite();
    const blockedTitle = 'Zablokowane: firmware nie zgłasza zapisu modelu (bit 8 i 10).';
    actions.append(
        button('Fabryczne na ekranie', 'btn btn-secondary btn-sm', () => {
            model.levels[index] = P.factoryLevels()[index];
            markEdited(index);
            renderPanel();
        }, { title: 'Ustawia fabryczny poziom tylko na ekranie. Nic nie wysyła.' }),
        button('Fabryczne w sterowniku', 'btn btn-secondary btn-sm', () => { void restoreLevel(index + 1); },
            { disabled: !writable, title: writable ? 'Sterownik ustawia fabryczny preset tego poziomu w RAM (op 6), potem odczyt.' : blockedTitle }),
        button('Zapisz ten poziom (RAM)', 'btn btn-blue btn-sm', () => { void writeLevels(index + 1, 1); },
            { id: `evdV3WriteOne-${index}`, disabled: !writable, title: writable ? 'Zapis jednego poziomu do RAM sterownika, potem odczyt kontrolny.' : blockedTitle }),
    );
    card.appendChild(actions);
    return card;
}

// ---- rider and hardware (object 5) --------------------------------------------------------

function riderSection() {
    const box = document.createElement('section');
    box.className = 'ebics-card evd-v3-rider';
    box.id = 'evdV3Rider';
    const title = document.createElement('div');
    title.className = 'ebics-card-title';
    title.textContent = 'Rowerzysta i sprzęt';
    box.append(title, hint('Ustawienia wspólne dla wszystkich poziomów: dotyczą Ciebie i silnika, nie trybu.'));
    const r = model.rider;

    // Effort map switch.
    const mapRow = document.createElement('div'); mapRow.className = 'evd-v3-row';
    const mapLabel = document.createElement('label'); mapLabel.className = 'evd-v3-limit';
    const mapBox = document.createElement('input'); mapBox.type = 'checkbox'; mapBox.checked = r.effortMap; mapBox.id = 'evdV3EffortMap';
    const mapText = document.createElement('span'); mapText.className = 'evd-v3-label'; mapText.textContent = 'Mapa wysiłku';
    mapLabel.append(mapBox, mapText);
    mapBox.addEventListener('change', () => { r.effortMap = mapBox.checked; riderEdited(); model.levels.forEach((_, i) => refreshWarnings(i)); });
    mapRow.append(mapLabel, hint('Włączona (domyślnie): wsparcie zależy od tego, jaką część swoich możliwości przy danej kadencji dajesz — liniowo do 60 % wysiłku (80 % wyjścia), dalej łagodnie. Mocniejszy tryb ma krótszy zakres. Wyłączona: stara mapa (nacisk × kadencja, tabela współczynników), jak przed zmianą; Zakres i Siła rowerzysty wtedy nie działają.'));

    // Rider strength.
    const strength = numberRow({
        label: 'Siła rowerzysty T0', unit: 'kg', min: 10, max: 60, step: 0.5,
        value: r.riderStrengthX10kg / 10,
        onChange: (v) => { r.riderStrengthX10kg = Math.round(v * 10); riderEdited(); },
        help: 'Nacisk (kg) przy pełnym wysiłku na małej kadencji. Możliwości przy kadencji liczone są jako T0·(1 − kad/190). Więcej kg = na to samo wsparcie trzeba mocniej naciskać (silny rowerzysta), mniej = pełne wsparcie przy lżejszym nacisku. Domyślnie 30 kg (z logów jazd).',
    });

    // C1 thresholds.
    const off = numberRow({
        label: 'C1 Iq_off', unit: 'Iq', min: 0, max: P.RIDER_LIMITS.offMax, step: 1, value: r.lowAssistOffIq,
        onChange: (v) => { r.lowAssistOffIq = Math.round(v); riderEdited(); },
        help: 'Próg wyłączenia małego wspomagania. Gdy żądany prąd spadnie poniżej Iq_off na ok. 150 ms, silnik szybko schodzi do zera zamiast wisieć w paśmie terkotu wolnobiegu (ok. 15–60 Iq). 0 = C1 wyłączone. Domyślnie 40.',
    });
    const on = numberRow({
        label: 'C1 Iq_on', unit: 'Iq', min: 0, max: P.RIDER_LIMITS.onMax, step: 1, value: r.lowAssistOnIq,
        onChange: (v) => { r.lowAssistOnIq = Math.round(v); riderEdited(); },
        help: 'Próg powrotu: wspomaganie wraca, gdy żądanie przekroczy Iq_on, i startuje od razu od tej wartości (bez przechodzenia przez pasmo terkotu). Musi być ≥ Iq_off, maks. 250. Domyślnie 55.',
    });

    const errors = document.createElement('div'); errors.id = 'evdV3RiderErrors'; errors.className = 'form-hint';
    const writable = v3RiderCanWrite();
    const actions = document.createElement('div'); actions.className = 'evd-v3-actions';
    actions.append(
        button('Fabryczne na ekranie', 'btn btn-secondary btn-sm', () => { model.rider = P.factoryRider(); riderEdited(); renderPanel(); },
            { title: 'Siła 30 kg, Iq_off 40, Iq_on 55, mapa wysiłku włączona. Nic nie wysyła.' }),
        button('Zapisz rowerzystę i sprzęt (RAM)', 'btn btn-blue btn-sm', () => { void writeRider(); },
            { id: 'evdV3WriteRider', disabled: !writable, title: writable ? 'Zapis obiektu 5 do RAM sterownika, potem odczyt kontrolny.' : 'Zablokowane: firmware nie zgłasza obiektu 5 (bit 11).' }),
    );
    box.append(mapRow, strength, off, on, errors, actions);
    return box;
}

function numberRow({ label, unit, min, max, step, value, onChange, help }) {
    const row = document.createElement('div'); row.className = 'evd-v3-row';
    const line = document.createElement('label'); line.className = 'evd-v3-limit';
    const name = document.createElement('span'); name.className = 'evd-v3-label'; name.textContent = label;
    const input = document.createElement('input');
    input.type = 'number'; input.className = 'form-input';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    const u = document.createElement('span'); u.textContent = unit;
    input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(v); });
    line.append(name, input, u);
    row.append(line, hint(help));
    return row;
}

function refreshRiderState() {
    const errors = P.validateRider(model.rider);
    const box = el('evdV3RiderErrors');
    if (box) box.textContent = errors.length ? `Popraw: ${errors.join('; ')}.` : '';
    el('evdV3Rider')?.classList.toggle('is-edited', !!model.riderBaseline && riderDirty());
    const write = el('evdV3WriteRider');
    if (write) write.disabled = !v3RiderCanWrite() || errors.length > 0;
    refreshCharts();
}

function riderEdited() {
    markUnsavedInRam();
    refreshRiderState();
}

// ---- charts ---------------------------------------------------------------------------------

function chartsSection() {
    const box = document.createElement('section');
    box.className = 'ebics-card evd-v3-charts';
    const title = document.createElement('div');
    title.className = 'ebics-card-title';
    title.textContent = 'Co robią te ustawienia (wykresy na żywo)';
    box.append(title, hint('Wykresy liczą wzory z planu wdrożenia z wartości na ekranie, nie z pomiaru. Odświeżają się przy każdym ruchu suwaka.'));

    const controls = document.createElement('div'); controls.className = 'evd-v3-chart-controls';
    const levelSel = document.createElement('select'); levelSel.className = 'form-select'; levelSel.id = 'evdV3ChartLevel';
    model.levels.forEach((l, i) => levelSel.add(new Option(`Poziom ${i + 1} (${P.MODES[l.mode].name})`, String(i))));
    levelSel.value = String(model.chartLevel);
    levelSel.addEventListener('change', () => { model.chartLevel = Number(levelSel.value); refreshCharts(); });
    const cad = document.createElement('input'); cad.type = 'range'; cad.min = '0'; cad.max = '120'; cad.step = '5'; cad.value = String(model.chartCadence);
    const cadText = document.createElement('span'); cadText.id = 'evdV3ChartCadenceText';
    cad.addEventListener('input', () => { model.chartCadence = Number(cad.value); refreshCharts(); });
    const force = document.createElement('input'); force.type = 'range'; force.min = '2'; force.max = '50'; force.step = '1'; force.value = String(model.chartForce);
    const forceText = document.createElement('span'); forceText.id = 'evdV3ChartForceText';
    force.addEventListener('input', () => { model.chartForce = Number(force.value); refreshCharts(); });
    const lab = (text, ...nodes) => { const l = document.createElement('label'); l.className = 'evd-v3-limit'; const s = document.createElement('span'); s.textContent = text; l.append(s, ...nodes); return l; };
    controls.append(lab('Poziom (Start):', levelSel), lab('Kadencja:', cad, cadText), lab('Nacisk (Start vs kadencja):', force, forceText));

    const grid = document.createElement('div'); grid.className = 'evd-v3-chart-grid';
    const chart = (id, heading, text) => {
        const fig = document.createElement('figure'); fig.className = 'evd-v3-chart';
        const cap = document.createElement('figcaption'); cap.textContent = heading;
        const canvas = document.createElement('canvas'); canvas.id = id;
        const note = document.createElement('div'); note.className = 'evd-v3-help'; note.id = `${id}Note`; note.textContent = text;
        fig.append(cap, canvas, note);
        return fig;
    };
    grid.append(
        chart('evdV3ChartEffort', 'Mapa wysiłku: wsparcie od nacisku przy wybranej kadencji',
            'Oś X: nacisk w kg (szczyt suwu). Oś Y: wyjście mapy w % pełnej skali po korekcie Assist, obcięte przez Max Torque. Kolano: 60 % wysiłku daje 80 % wyjścia trybu.'),
        chart('evdV3ChartStart', 'Start: cel momentu przy ruszaniu od nacisku',
            'Iq_start = Max Torque · min(1, F / F_full). Korekta Start skaluje F_full (więcej = pełny kop przy lżejszym nacisku), 0 = wyłączony.'),
        chart('evdV3ChartFade', 'Start: wygaszanie z kadencją',
            'Kop pełny do 25 obr/min, zero przy 50 obr/min (gaśnie też przy 12 km/h i po 4 s). Linia: cel przy wybranym nacisku.'),
        chart('evdV3ChartC1', 'C1: małe wspomaganie, histereza Iq_off / Iq_on',
            'Oś X: prąd, którego żąda mapa. Oś Y: prąd silnika. Przy wzroście silnik rusza dopiero od Iq_on, przy spadku wyłącza się poniżej Iq_off. Szare pole: pasmo terkotu wolnobiegu z logów.'),
    );
    box.append(controls, grid);
    return box;
}

export function refreshCharts() {
    const r = model.rider;
    const t0 = r.riderStrengthX10kg / 10;
    const cadence = model.chartCadence;
    const cadText = el('evdV3ChartCadenceText'); if (cadText) cadText.textContent = `${cadence} obr/min`;
    const forceText = el('evdV3ChartForceText'); if (forceText) forceText.textContent = `${model.chartForce} kg`;

    // (a) effort map, all five levels
    const tMax = P.tMaxKg(cadence, t0);
    const xMax = Math.max(10, Math.ceil(tMax * 1.3 / 5) * 5);
    const effortSeries = model.levels.map((level, i) => ({
        label: `P${i + 1} ${P.MODES[level.mode].short}`,
        color: LEVEL_COLORS[i],
        width: i === model.chartLevel ? 3 : 1.5,
        points: sample((f) => 100 * P.effortOutput(f, cadence, level, t0).output, xMax),
    }));
    const sel = model.levels[model.chartLevel];
    const selOut = P.effortOutput(tMax, cadence, sel, t0);
    const yMaxEffort = Math.max(100, Math.ceil(Math.max(...effortSeries.flatMap((s) => s.points.map((p) => p[1]))) / 10) * 10);
    drawLineChart(el('evdV3ChartEffort'), {
        xLabel: `nacisk [kg] przy ${cadence} obr/min (T_max = ${fmtNum(tMax, 1)} kg)`, yLabel: 'wyjście [% skali]', yUnit: '%',
        xMax, yMax: yMaxEffort,
        series: [...effortSeries, {
            label: `P${model.chartLevel + 1} bez Assist (s·u)`, color: LEVEL_COLORS[model.chartLevel], dash: true, width: 1.5,
            points: sample((f) => 100 * P.effortOutput(f, cadence, sel, t0).base, xMax),
        }],
        vlines: [
            { x: 0.6 * selOut.eFull * tMax, label: 'kolano', color: '#64748b' },
            { x: selOut.eFull * tMax, label: `e_full ${fmtNum(selOut.eFull)}`, color: LEVEL_COLORS[model.chartLevel] },
            { x: tMax, label: 'T_max', color: '#94a3b8' },
        ],
        hlines: [{ y: sel.maxTorquePct, label: `Max Torque P${model.chartLevel + 1}`, color: '#dc2626' }],
    });
    const effortNote = el('evdV3ChartEffortNote');
    if (effortNote) {
        effortNote.textContent = `${r.effortMap ? '' : 'MAPA WYŁĄCZONA — sterownik używa starej mapy; wykres pokazuje, co dałaby mapa po włączeniu. '}`
            + `Poziom ${model.chartLevel + 1}: pełne wyjście trybu przy ${fmtNum(selOut.eFull * tMax, 1)} kg, kolano przy ${fmtNum(0.6 * selOut.eFull * tMax, 1)} kg. `
            + 'Max Power (W) dodatkowo ogranicza przy dużej kadencji i prędkości — nie jest tu rysowany, bo zależy od napięcia baterii.';
    }

    // (b) Start target vs force, selected level
    const fFull = P.startFullForceKg(sel);
    drawLineChart(el('evdV3ChartStart'), {
        xLabel: 'nacisk [kg]', yLabel: 'Iq_start [% dozw. Iq]', yUnit: '%', xMax: 50, yMax: 100,
        series: [
            { label: `P${model.chartLevel + 1} ${P.MODES[sel.mode].name}`, color: LEVEL_COLORS[model.chartLevel], width: 3, points: sample((f) => 100 * P.startTarget(f, sel), 50) },
            { label: 'Start = 50 (fabrycznie)', color: '#94a3b8', dash: true, points: sample((f) => 100 * P.startTarget(f, { ...sel, start: 50 }), 50) },
        ],
        vlines: fFull ? [{ x: fFull, label: `F_full ${fmtNum(fFull, 1)} kg`, color: LEVEL_COLORS[model.chartLevel] }] : [],
        hlines: [{ y: sel.maxTorquePct, label: 'Max Torque', color: '#dc2626' }],
    });
    const startNote = el('evdV3ChartStartNote');
    if (startNote) startNote.textContent = sel.start === 0 ? 'Start = 0: stan Start wyłączony, przy ruszaniu działa tylko zwykła mapa.'
        : `F_full trybu ${P.MODES[sel.mode].fFullKg} kg, po korekcie Start ${fmtNum(fFull, 1)} kg. Start nigdy nie obniża zwykłej mapy, tylko dokłada.`;

    // (c) fade vs cadence
    const atForce = P.startTarget(model.chartForce, sel);
    drawLineChart(el('evdV3ChartFade'), {
        xLabel: 'kadencja [obr/min]', yLabel: 'udział / cel [%]', yUnit: '%', xMax: 70, yMax: 100,
        series: [
            { label: 'wygaszanie f', color: '#64748b', dash: true, points: sample((c) => 100 * P.startFade(c), 70) },
            { label: `cel przy ${model.chartForce} kg`, color: LEVEL_COLORS[model.chartLevel], width: 3, points: sample((c) => 100 * atForce * P.startFade(c), 70) },
        ],
        vlines: [{ x: 25, label: '25' }, { x: 50, label: '50' }],
    });

    // (d) C1 hysteresis
    const iqMax = Math.max(120, Math.ceil((r.lowAssistOnIq + 40) / 20) * 20);
    const c1Series = r.lowAssistOffIq
        ? [
            { label: 'narastanie (wejście od Iq_on)', color: '#0ea5e9', width: 3, points: sample((q) => P.lowAssistOutput(q, r, true), iqMax, 240) },
            { label: 'opadanie (wyjście poniżej Iq_off)', color: '#f59e0b', dash: true, width: 2, points: sample((q) => P.lowAssistOutput(q, r, false), iqMax, 240) },
        ]
        : [{ label: 'C1 wyłączone: prąd = żądanie', color: '#64748b', width: 2, points: [[0, 0], [iqMax, iqMax]] }];
    drawLineChart(el('evdV3ChartC1'), {
        xLabel: 'żądany prąd [Iq]', yLabel: 'prąd silnika [Iq]', xMax: iqMax, yMax: iqMax,
        bands: [{ y0: 15, y1: 60, color: 'rgba(148,163,184,0.18)', label: 'pasmo terkotu 15–60' }],
        series: c1Series,
        vlines: r.lowAssistOffIq ? [
            { x: r.lowAssistOffIq, label: `Iq_off ${r.lowAssistOffIq}`, color: '#f59e0b' },
            { x: r.lowAssistOnIq, label: `Iq_on ${r.lowAssistOnIq}`, color: '#0ea5e9' },
        ] : [],
    });
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
    title.textContent = 'Inne ustawienia sprzętu (w innych zakładkach)';
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
            li.appendChild(button(`Otwórz: ${item.tab}`, 'btn btn-secondary btn-sm', () => document.querySelector(`.tab-button[data-tab="${item.where}"]`)?.click()));
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
    const top = document.createElement('div');
    top.className = 'evd-v3-top';
    top.append(riderSection(), chartsSection());
    const grid = document.createElement('div');
    grid.className = 'evd-v3-grid mt-4';
    model.levels.forEach((_, index) => grid.appendChild(levelCard(index)));
    root.replaceChildren(ticks, top, grid, hardwareSection());
    model.levels.forEach((_, index) => refreshWarnings(index));
    refreshRiderState();
    root.scrollTop = scrollTop;
    const writeAll = el('evdV3WriteAll');
    if (writeAll) {
        writeAll.disabled = !v3ModelCanWrite();
        writeAll.title = v3ModelCanWrite() ? 'Zapis pięciu poziomów do RAM sterownika, potem odczyt kontrolny.' : 'Zablokowane: firmware nie zgłasza zapisu modelu (bit 8 i 10).';
    }
    const persist = el('evdV3Persist');
    if (persist) {
        persist.disabled = !canPersist();
        persist.title = canPersist() ? 'Sterownik zapisze model i ustawienia rowerzysty we flash na postoju (0x6037 op 1).' : 'Zablokowane: firmware nie zgłasza modelu ani obiektu 5.';
    }
    const factory = el('evdV3Factory');
    if (factory) factory.disabled = false; // works on screen always; in the controller only with the capability
}

// ---- actions ---------------------------------------------------------------------------

export async function discoverModel() {
    if (!socketReady()) return null;
    model.caps = await clientFor().discover();
    model.discovered = true;
    return model.caps;
}

/** Read all five levels and the rider object (RAM view). Part of the top bar's "Read from bike". */
export async function readModelFromBike() {
    await discoverModel();
    if (!model.caps?.model && !model.caps?.rider) {
        model.note = '';
        addLog('INFO', 'Model V3: sterownik go nie obsługuje, zostaje preset fabryczny na ekranie.');
        renderPanel();
        return false;
    }
    const notes = [];
    if (model.caps.model) {
        try {
            const back = await clientFor().read(0, P.VIEW.CONFIGURED);
            model.levels = P.cloneLevels(back.levels);
            model.baseline = P.cloneLevels(back.levels);
            model.generation = back.generation;
            model.rangeKnown = back.rangeKnown;
            notes.push(back.rangeKnown ? 'Poziomy odczytane.' : 'Poziomy odczytane (obiekt w wersji 1, bez pola Zakres).');
            addLog('DATA', `Model V3 odczytany (generacja ${back.generation}, wersja ${back.schemaVersion}).`);
        } catch (error) {
            notes.push(`Odczyt poziomów nie powiódł się: ${error.message}`);
            addLog('ERR', notes[notes.length - 1]);
        }
    }
    if (model.caps.rider) {
        try {
            const back = await clientFor().readRider(P.VIEW.CONFIGURED);
            model.rider = { ...back.rider };
            model.riderBaseline = { ...back.rider };
            model.generation = back.generation;
            notes.push('Rowerzysta i sprzęt odczytane.');
        } catch (error) {
            notes.push(`Odczyt „Rowerzysta i sprzęt” nie powiódł się: ${error.message}`);
            addLog('ERR', notes[notes.length - 1]);
        }
    }
    model.note = notes.join(' ');
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

/** Write object 5 (rider and hardware) to RAM, with readback. */
export async function writeRider() {
    if (!socketReady()) return false;
    if (!v3RiderCanWrite()) { addLog('ERR', 'Rowerzysta i sprzęt: zapis zablokowany — firmware nie zgłasza obiektu 5 (bit 11).'); return false; }
    let result;
    try {
        result = await clientFor().writeRider(model.rider, { baseGeneration: model.generation ?? 0xFFFF });
    } catch (error) {
        result = { ok: false, text: error.message };
    }
    if (!result.ok) {
        model.note = `Zapis „Rowerzysta i sprzęt” nie powiódł się: ${result.text}`;
        addLog('ERR', model.note);
        renderPanel();
        return false;
    }
    model.generation = result.generation;
    model.riderBaseline = { ...model.rider };
    model.note = 'Zapisano „Rowerzysta i sprzęt” w RAM sterownika, odczyt kontrolny zgodny.';
    addLog('ACK', model.note);
    renderPanel();
    return true;
}

export async function persistModel() {
    if (!canPersist()) { addLog('ERR', 'Model V3: zapis trwały zablokowany — brak obsługi w firmware.'); return false; }
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
    if (v3ModelCanWrite() && confirm('Przywrócić fabryczny preset wszystkich pięciu poziomów w sterowniku (RAM, op 5)?\nStan trwały zmieni się dopiero po "Zapisz na stałe".')) {
        const result = await clientFor().restoreFactory();
        model.note = result.ok ? 'Fabryczny preset ustawiony w RAM sterownika.' : `Przywrócenie odrzucone: ${result.text}`;
        if (result.ok) { model.generation = result.generation; await readModelFromBike(); return; }
    } else {
        model.note = 'Fabryczny preset ustawiony na ekranie (sterownik nie zmieniony).';
    }
    renderPanel();
}

async function restoreLevel(level) {
    if (!v3ModelCanWrite()) return;
    if (!confirm(`Przywrócić fabryczny preset poziomu ${level} w sterowniku (RAM, op 6)?`)) return;
    const result = await clientFor().restoreLevel(level);
    if (!result.ok) { model.note = `Przywrócenie poziomu ${level} odrzucone: ${result.text}`; addLog('ERR', model.note); renderPanel(); return; }
    model.generation = result.generation;
    await readModelFromBike();
}

/** Top bar "Undo": screen back to what was read (or to the factory preset when never read). */
export function restoreModelFromRead() {
    model.levels = model.baseline ? P.cloneLevels(model.baseline) : P.factoryLevels();
    model.rider = model.riderBaseline ? { ...model.riderBaseline } : P.factoryRider();
    renderPanel();
    return model.baseline ? 'tryby V3 (jak odczytano)' : 'tryby V3 (preset fabryczny)';
}

/** What the top bar's Save… may send for the model and the rider object. */
export const v3ModelScope = () => ({
    writable: v3ModelCanWrite(), dirty: v3ModelIsDirty() || !model.baseline,
    riderWritable: v3RiderCanWrite(), riderDirty: riderDirty(),
});

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
    window.addEventListener('resize', () => refreshCharts());
    renderPanel();
}

// Exposed for the browser render check and for debugging in the console.
export const _modelForTests = model;
