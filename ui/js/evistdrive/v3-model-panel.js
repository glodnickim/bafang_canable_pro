// evistdrive/v3-model-panel.js — the "eVistDrive Profiles" panel: per HMI level a mode, six
// corrections and two limits, plus the rider/hardware object and live charts of what the settings do.
//
// Two views of the same model (owner 2026-11-16): "Prosty" (default) shows per level the mode,
// Wsparcie, Moc maks. and Kop na starcie; "Zaawansowany" shows everything. Every setting is
// explained ONCE (legend, or one "?" per section) — never repeated in the level cards.
//
// One source for the rider-facing character of the bike (design: integration/roadmap/
// V3_JEDEN_MODEL_PROJEKT_PL.md, plan V3_PLAN_WDROZENIA_20261114_PL.md). Every protocol call goes
// through v3-model-protocol.js; this file only draws and edits. Until the firmware reports the
// capability bits (8/10 model, 11 rider) the panel works offline and NEVER sends a write.
import { socket, addLog, state, helpBadge } from '../shared.js';
import * as P from './v3-model-protocol.js';
import { drawLineChart, sample } from './v3-model-charts.js';
import { el, socketReady, markReadNeeded, writeBankAndWait } from './common.js';
import { markUnsavedInRam } from './global-actions.js';

// Chart colours per HMI level (the detailed charts draw five levels at once).
const LEVEL_COLORS = ['#16a34a', '#0ea5e9', '#6366f1', '#f59e0b', '#dc2626'];
// Colour and one-line character per mode (index = P.MODES id).
const MODE_STYLE = [
    { color: '#16a34a', line: 'Spokojnie i oszczędnie: łagodne wsparcie, długi zasięg.' },
    { color: '#0d9488', line: 'Równe, naturalne wsparcie na co dzień i w teren.' },
    { color: '#ea580c', line: 'Żwawo: mocne wsparcie i szybsza reakcja.' },
    { color: '#dc2626', line: 'Bardzo dynamicznie: wsparcie mocno rośnie z naciskiem.' },
    { color: '#9333ea', line: 'Pełna moc już przy krótkim zakresie nacisku.' },
    { color: '#2563eb', line: 'Charakter jak TRAIL (punkt TRAIL), moc do 750 W.' },
];
const modeColor = (id) => MODE_STYLE[id]?.color ?? '#2563eb';

// Corrections 0..100 (50 = factory for the mode). `simple` = shown in the simple view.
const SLIDERS = [
    { key: 'assist', label: 'Wsparcie', simple: true },
    { key: 'attack', label: 'Narastanie' },
    { key: 'release', label: 'Opadanie' },
    { key: 'start', label: 'Kop na starcie', simple: true, off: true },
    { key: 'carry', label: 'Podtrzymanie', off: true },
    { key: 'range', label: 'Zakres' },
];

// The ONE place every setting is explained. `adv` = only relevant in the advanced view.
const LEGEND = [
    { name: 'Wsparcie (Assist)', short: 'Ile silnik dokłada do Twojego nacisku.', full: 'Siła wspomagania: mnoży to, co daje mapa. 50 = fabrycznie dla trybu. W prawo więcej wsparcia przy tym samym nacisku, w lewo mniej (×0,5…×2).' },
    { name: 'Moc maks. (Max Power)', short: 'Sufit mocy z baterii na tym poziomie.', full: 'Sufit mocy pobieranej z baterii na tym poziomie. Limit baterii i prądu fazy zostają nadrzędne. Skrajnie w prawo albo „limit sprzętu” (65000) = bez limitu trybu. Mniej W = spokojniej przy wysokiej kadencji i prędkości. Zmiana trybu ustawia jego domyślną moc.' },
    { name: 'Kop na starcie (Start)', short: 'Dodatkowa siła przy ruszaniu z miejsca. 0 = wyłączony.', full: 'Kop przy ruszaniu (stan Start: tylko z postoju, poniżej 6 km/h, gaśnie do 50 obr/min). 50 = fabrycznie. W prawo pełny kop przy lżejszym nacisku, w lewo potrzeba mocniejszego. 0 = Start wyłączony.' },
    { name: 'Narastanie (Attack)', adv: true, short: 'Jak szybko silnik dochodzi do mocy.', full: 'Jak szybko silnik dochodzi do mocy po naciśnięciu pedału. 50 = fabrycznie. W prawo szybciej (krótszy czas narastania), w lewo łagodniej.' },
    { name: 'Opadanie (Release)', adv: true, short: 'Jak szybko wsparcie gaśnie, gdy odpuszczasz.', full: 'Jak szybko wspomaganie opada, gdy odpuszczasz nacisk. 50 = fabrycznie. W prawo szybsze opadanie, w lewo silnik dłużej trzyma moc.' },
    { name: 'Podtrzymanie (Carry)', adv: true, short: 'Wsparcie w krótkiej przerwie pedałowania. 0 = wył.', full: 'Podtrzymanie wspomagania po chwilowym przerwaniu pedałowania (np. zmiana biegu, przeszkoda). 50 = fabrycznie. W prawo mocniej, w lewo słabiej. 0 = wyłączone.' },
    { name: 'Zakres (Range)', adv: true, short: 'Przy jakim nacisku wsparcie dochodzi do 100 %.', full: 'Jaki wysiłek daje pełne wyjście mapy wysiłku. 50 = fabrycznie (e_full trybu). W prawo krótszy zakres: 100 % przy lżejszym nacisku. W lewo dłuższy: trzeba mocniej nacisnąć. Działa tylko z włączoną mapą wysiłku.' },
    { name: 'Max Torque', adv: true, short: 'Sufit momentu silnika (% dozwolonego Iq, nie Nm).', full: 'Sufit momentu silnika: ułamek dozwolonego prądu Iq. Obcina mapę i kop Start; najbardziej czuć go pod górę i przy ruszaniu. Zmiana trybu ustawia jego domyślny Max Torque.' },
    { name: '50 i ↺', short: '50 = ustawienie fabryczne trybu; ↺ wraca do niego.', full: 'Każda korekta 0..100 działa wokół wartości fabrycznej trybu: 50 = fabrycznie, mnożnik ×0,5 przy 0 … ×2 przy 100. Ikona ↺ przy suwaku przywraca wartość fabryczną (dla mocy: domyślną moc trybu).' },
    { name: 'Miniwykres', short: 'Wsparcie od nacisku; przerywana linia = fabrycznie.', full: 'Miniwykres w karcie: wyjście mapy wysiłku (po korekcie Wsparcia i Zakresu, obcięte przez Max Torque) od nacisku przy 60 obr/min. Linia przerywana: ten sam tryb z korektami 50. Liczony z wartości na ekranie, nie z pomiaru.' },
    { name: 'Wartości efektywne', adv: true, short: 'Wynik korekty w jednostkach (s, kg, %).', full: 'Pod suwakiem w widoku zaawansowanym: co dana korekta daje w liczbach, obok wartości domyślnej trybu. Mnożnik (×) obok wartości: 0 → ×0,5, 50 → ×1, 100 → ×2.' },
    { name: 'Pierwszeństwo', short: 'Hamulec, błędy, stop i jazda wstecz zawsze wygrywają.', full: 'Hamulec, błędy, stop i jazda wstecz mają zawsze pierwszeństwo przed każdym ustawieniem trybu. Korekty są osobne dla każdego poziomu, także gdy kilka poziomów ma ten sam tryb.' },
];

const PRESSURE_HELP = 'Start z miejsca: najmniejszy nacisk, przy którym wspomaganie rusza, gdy koło stoi (wymaga też obrotu korby). '
    + 'Start w czasie jazdy: próg, gdy koło się toczy (powyżej 3 km/h); ten sam próg jest „trafieniem” podtrzymania — jadące wspomaganie gaśnie, gdy przez pełny obrót korby albo „Czas bez nacisku” nacisk ani razu go nie przekroczy. Nie może być większy niż start z miejsca. '
    + 'Wartości są faktycznym progiem zadziałania V3 (dokładność czujnika ok. ±0,3 kg); dolna granica obu progów to ok. 1,5 kg (szum czujnika 10 mV) — niższa wartość działa jak 1,5 kg.';

const VIEW_KEY = 'evdProfilesView';
function loadView() {
    try { return globalThis.localStorage?.getItem(VIEW_KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; }
}
function saveView(view) {
    try { globalThis.localStorage?.setItem(VIEW_KEY, view); } catch { /* private window: the choice just is not remembered */ }
}

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
    view: loadView(),
    // open state of the collapsible sections, kept across re-renders
    open: { legend: false, pressure: true, rider: false, charts: false, hardware: false },
};

const seconds = (ms) => `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 2).replace(/\.?0+$/, '')} s`;
const fmtPercent = (value) => `${(Math.round(value * 10) / 10).toString().replace('.', ',')} %`;
const fmtNum = (value, digits = 2) => value.toFixed(digits).replace('.', ',');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
const readDone = () => !!(model.baseline || model.riderBaseline);
const isAdvanced = () => model.view === 'advanced';

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
    return [yes(caps.model, 'model (bit 8)'), yes(caps.modelWritable, 'zapis modelu (bit 10)'), yes(caps.rider, 'rowerzysta i sprzęt (bit 11)'), yes(caps.riderHold, 'model podtrzymania (bit 12)')].join(', ');
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
    if (level.start === 0) out.push('Kop na starcie = 0: kop przy ruszaniu wyłączony.');
    if (level.carry === 0) out.push('Podtrzymanie = 0: wyłączone.');
    if (level.maxPowerW !== P.HW_POWER_W && level.maxPowerW < P.modeDefaultPowerW(mode.id)) {
        out.push(`Moc maks. poniżej domyślnej dla ${mode.name} (${P.modeDefaultPowerW(mode.id)} W): moc obcięta wcześniej niż fabrycznie.`);
    }
    if (level.maxTorquePct < mode.torquePct) out.push(`Max Torque poniżej domyślnego (${mode.torquePct} %): obcina też kop na starcie.`);
    if (!model.rider.effortMap && level.range !== 50) out.push('Zakres ≠ 50, ale mapa wysiłku jest wyłączona: korekta nie działa.');
    return out;
}

// ---- small DOM helpers ------------------------------------------------------------------

function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
}

function button(text, className, onClick, { id, disabled = false, title = '' } = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = className; b.textContent = text;
    if (id) b.id = id;
    b.disabled = disabled; b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

/** Collapsible section; its open state survives re-renders. */
function section(key, title, { id, className = '', help } = {}) {
    const box = document.createElement('details');
    box.className = `ebics-card evd-v3-sec ${className}`.trim();
    if (id) box.id = id;
    box.open = !!model.open[key];
    const summary = node('summary', 'ebics-card-title evd-v3-sec-title');
    summary.append(node('span', '', title));
    if (help) summary.appendChild(helpBadge(help));
    box.appendChild(summary);
    box.addEventListener('toggle', () => {
        model.open[key] = box.open;
        if (key === 'charts' && box.open) refreshCharts();
    });
    return box;
}

/**
 * A big slider: label, value badge (or a number field in the advanced view), a small ↺ reset
 * icon and a thick range input. `get()` returns the slider position after the model changed.
 */
function bigSlider(o) {
    const row = node('div', 'evd-sl');
    const head = node('div', 'evd-sl-head');
    const label = node('label', 'evd-sl-label', o.label);
    label.htmlFor = o.id;
    const input = document.createElement('input');
    input.type = 'range'; input.className = 'evd-range'; input.id = o.id;
    input.min = String(o.min); input.max = String(o.max); input.step = String(o.step);
    let badge;
    if (o.numberAria) {
        badge = document.createElement('input');
        badge.type = 'number'; badge.className = 'evd-sl-badge evd-sl-number';
        badge.min = String(o.min); badge.max = String(o.max); badge.step = String(o.step);
        badge.setAttribute('aria-label', o.numberAria);
    } else {
        badge = node('span', 'evd-sl-badge');
        badge.setAttribute('aria-hidden', 'true');
    }
    const sub = o.sub ? node('span', 'evd-sl-sub') : null;
    const reset = o.reset ? button('↺', 'evd-sl-reset', () => { o.onInput(o.reset.value()); show(); }, { title: o.reset.title }) : null;
    if (reset) reset.setAttribute('aria-label', `${o.label}: ${o.reset.title}`);
    head.append(label, ...(sub ? [sub] : []), ...(reset ? [reset] : []), badge);
    row.append(head, input);
    function show() {
        const pos = o.get();
        input.value = String(pos);
        input.style.setProperty('--fill', `${((clamp(pos, o.min, o.max) - o.min) / (o.max - o.min)) * 100}%`);
        if (o.numberAria) badge.value = String(pos); else badge.textContent = o.badge(pos);
        input.setAttribute('aria-valuetext', o.badge(pos));
        if (sub) sub.textContent = o.sub(pos);
        row.classList.toggle('is-default', !!o.isDefault?.(pos));
    }
    input.addEventListener('input', () => { o.onInput(Number(input.value)); show(); });
    if (o.numberAria) {
        badge.addEventListener('change', () => {
            const v = Number(badge.value);
            if (Number.isFinite(v)) o.onInput(clamp(v, o.min, o.max));
            show();
        });
    }
    if (o.disabled) [input, badge, reset].forEach((x) => { if (x) x.disabled = true; });
    show();
    return { row, show };
}

// ---- level cards --------------------------------------------------------------------------

function afterLevelEdit(index) {
    refreshWarnings(index);
    refreshMini(index);
    markEdited(index);
    refreshCharts();
}

function correctionSlider(index, spec) {
    const level = model.levels[index];
    const advanced = isAdvanced();
    const disabled = spec.key === 'range' && !model.rangeKnown;
    let caption = null;
    const s = bigSlider({
        id: `evdV3-${index}-${spec.key}`, label: spec.label, min: 0, max: 100, step: 1,
        get: () => level[spec.key],
        badge: (v) => (spec.off && v === 0 ? 'wył.' : String(v)),
        sub: (v) => multiplierText(v),
        isDefault: (v) => v === 50,
        numberAria: advanced ? `${spec.label}, poziom ${index + 1}` : null,
        reset: { title: 'wartość fabryczna (50)', value: () => 50 },
        disabled,
        onInput: (raw) => {
            const next = clamp(Math.round(Number(raw)), 0, 100);
            if (!Number.isFinite(next)) return;
            level[spec.key] = next;
            if (caption) caption.textContent = describeEffective(level, spec.key);
            afterLevelEdit(index);
        },
    });
    if (advanced) {
        caption = node('div', 'evd-v3-effective', disabled
            ? 'Obiekt w wersji 1 (bez pola Zakres): sterownik używa e_full trybu.'
            : describeEffective(level, spec.key));
        s.row.appendChild(caption);
    }
    return s.row;
}

// Simple-view power slider: 100..1500 W in 50 W steps, the last stop = no mode limit (65000).
const POWER_MIN = 100;
const POWER_MAX = 1500;
const POWER_HW_POS = POWER_MAX + 50;
const powerPos = (w) => (w === P.HW_POWER_W ? POWER_HW_POS : clamp(w, POWER_MIN, POWER_MAX));

function powerSlider(index) {
    const level = model.levels[index];
    return bigSlider({
        id: `evdV3-${index}-power`, label: 'Moc maks.', min: POWER_MIN, max: POWER_HW_POS, step: 50,
        get: () => powerPos(level.maxPowerW),
        badge: () => (level.maxPowerW === P.HW_POWER_W ? 'bez limitu' : `${level.maxPowerW} W`),
        isDefault: () => level.maxPowerW === P.modeDefaultPowerW(level.mode),
        reset: { title: 'domyślna moc trybu', value: () => powerPos(P.modeDefaultPowerW(level.mode)) },
        onInput: (pos) => {
            level.maxPowerW = pos >= POWER_HW_POS ? P.HW_POWER_W : clamp(Math.round(pos), POWER_MIN, POWER_MAX);
            afterLevelEdit(index);
        },
    }).row;
}

function refreshWarnings(index) {
    const box = el(`evdV3Warn-${index}`);
    if (!box) return;
    const lines = levelWarning(model.levels[index]);
    if (!lines.length) { box.replaceChildren(); return; }
    const badge = helpBadge(lines.join(' '));
    badge.classList.add('evd-warn-badge');
    badge.setAttribute('aria-label', `Uwagi do poziomu ${index + 1}: ${lines.length}`);
    box.replaceChildren(badge);
}

function markEdited(index) {
    el(`evdV3Card-${index}`)?.classList.add('is-edited');
    markUnsavedInRam();
}

function limitsRow(index) {
    const level = model.levels[index];
    const wrap = node('div', 'evd-v3-limits');
    const mode = P.MODES[level.mode];

    const power = node('label', 'evd-v3-limit');
    const hw = level.maxPowerW === P.HW_POWER_W;
    const hwBox = document.createElement('input');
    hwBox.type = 'checkbox'; hwBox.checked = hw;
    hwBox.setAttribute('aria-label', `Moc maks.: limit sprzętu, poziom ${index + 1}`);
    const watts = document.createElement('input');
    watts.type = 'number'; watts.min = '50'; watts.max = '64999'; watts.step = '10';
    watts.className = 'form-input'; watts.disabled = hw;
    watts.value = hw ? '' : String(level.maxPowerW);
    watts.setAttribute('aria-label', `Max Power w watach, poziom ${index + 1}`);
    const onPower = () => {
        if (hwBox.checked) { level.maxPowerW = P.HW_POWER_W; watts.disabled = true; watts.value = ''; }
        else {
            watts.disabled = false;
            if (!watts.value) watts.value = String(P.modeDefaultPowerW(mode.id));
            level.maxPowerW = Math.round(Number(watts.value));
        }
        afterLevelEdit(index);
    };
    hwBox.addEventListener('change', onPower);
    watts.addEventListener('change', onPower);
    power.append(node('span', 'evd-v3-label', 'Moc maks.'), watts, node('span', 'evd-v3-unit', 'W'), hwBox, node('span', 'evd-v3-unit', 'limit sprzętu'));
    power.title = `Domyślnie ${P.modeDefaultPowerW(mode.id)} W (z baterii)`;

    const torque = node('label', 'evd-v3-limit');
    const pct = document.createElement('input');
    pct.type = 'number'; pct.min = '1'; pct.max = '100'; pct.step = '1';
    pct.className = 'form-input'; pct.value = String(level.maxTorquePct);
    pct.setAttribute('aria-label', `Max Torque w procentach, poziom ${index + 1}`);
    pct.addEventListener('change', () => {
        level.maxTorquePct = Math.round(Number(pct.value));
        afterLevelEdit(index);
    });
    torque.append(node('span', 'evd-v3-label', 'Max Torque'), pct, node('span', 'evd-v3-unit', `% (dom. ${mode.torquePct})`));
    wrap.append(power, torque);
    return wrap;
}

/** Tiny SVG of the effort map for one level: solid = now, dashed = same mode at 50. */
function miniChart(index) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'evd-v3-mini');
    svg.setAttribute('viewBox', '0 0 200 56');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.id = `evdV3Mini-${index}`;
    drawMini(svg, index);
    return svg;
}

function drawMini(svg, index) {
    const level = model.levels[index];
    const t0 = model.rider.riderStrengthX10kg / 10;
    const cadence = 60;
    const tMax = P.tMaxKg(cadence, t0);
    const xMax = Math.max(10, tMax * 1.2);
    const factory = { ...level, assist: 50, range: 50, maxTorquePct: P.MODES[level.mode].torquePct };
    const now = sample((f) => P.effortOutput(f, cadence, level, t0).output, xMax, 40);
    const base = sample((f) => P.effortOutput(f, cadence, factory, t0).output, xMax, 40);
    // Common scale (100 % of the full output) so the cards compare at a glance.
    const yMax = Math.max(1, ...now.map((p) => p[1]), ...base.map((p) => p[1])) * 1.04;
    const X = (x) => (x / xMax) * 200;
    const Y = (y) => 54 - (y / yMax) * 50;
    const path = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const color = modeColor(level.mode);
    const mk = (tag, attrs) => {
        const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
        return n;
    };
    const peak = Math.round(100 * Math.max(...now.map((p) => p[1])));
    svg.setAttribute('aria-label', `Miniwykres wsparcia poziomu ${index + 1}: szczyt ${peak} % skali`);
    svg.replaceChildren(
        mk('path', { d: `${path(now)} L200,54 L0,54 Z`, fill: color, 'fill-opacity': 0.14, stroke: 'none' }),
        mk('path', { d: path(base), fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' }),
        mk('path', { d: path(now), fill: 'none', stroke: color, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }),
    );
}

function refreshMini(index) {
    const svg = el(`evdV3Mini-${index}`);
    if (svg) drawMini(svg, index);
}

function modePicker(index) {
    const level = model.levels[index];
    const seg = node('div', 'evd-mode-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', `Tryb dla poziomu ${index + 1}`);
    P.MODES.forEach((mode) => {
        const b = button(mode.name, 'evd-mode-btn', () => {
            if (level.mode === mode.id) return;
            level.mode = mode.id;
            // A new mode brings its own default limits; the corrections stay where the rider put them.
            level.maxPowerW = P.modeDefaultPowerW(mode.id); level.maxTorquePct = mode.torquePct;
            markEdited(index);
            renderPanel();
        }, { title: MODE_STYLE[mode.id]?.line ?? '' });
        b.style.setProperty('--mode-color', modeColor(mode.id));
        b.setAttribute('aria-pressed', String(level.mode === mode.id));
        seg.appendChild(b);
    });
    return seg;
}

function levelCard(index) {
    const level = model.levels[index];
    const advanced = isAdvanced();
    const card = node('section', 'ebics-card evd-v3-card');
    card.id = `evdV3Card-${index}`;
    card.style.setProperty('--evd-accent', modeColor(level.mode));
    if (!model.baseline) card.classList.add('is-preview');

    const head = node('div', 'evd-v3-head');
    const title = node('div', 'evd-v3-level');
    title.append(node('span', 'evd-v3-level-no', String(index + 1)), node('span', 'evd-v3-level-name', `Poziom ${index + 1}`));
    const tags = node('div', 'evd-v3-tags');
    if (!model.baseline) {
        const factory = P.levelsEqual([level], [P.factoryLevels()[index]]);
        tags.appendChild(node('span', 'evd-v3-tag', factory ? 'podgląd fabryczny' : 'nie odczytano'));
    }
    const warn = node('span', 'evd-v3-warn');
    warn.id = `evdV3Warn-${index}`;
    tags.appendChild(warn);
    head.append(title, tags);

    const body = node('div', 'evd-v3-body');
    body.append(modePicker(index), miniChart(index));
    SLIDERS.filter((spec) => advanced || spec.simple).forEach((spec) => {
        body.appendChild(correctionSlider(index, spec));
        if (!advanced && spec.key === 'assist') body.appendChild(powerSlider(index));
    });
    if (advanced) body.appendChild(limitsRow(index));
    card.append(head, body);

    const actions = node('div', 'evd-v3-actions');
    const writable = v3ModelCanWrite();
    const blockedTitle = 'Zablokowane: firmware nie zgłasza zapisu modelu (bit 8 i 10).';
    if (advanced) {
        actions.append(
            button('Fabryczne na ekranie', 'btn btn-secondary btn-sm', () => {
                model.levels[index] = P.factoryLevels()[index];
                markEdited(index);
                renderPanel();
            }, { title: 'Ustawia fabryczny poziom tylko na ekranie. Nic nie wysyła.' }),
            button('Fabryczne w sterowniku', 'btn btn-secondary btn-sm', () => { void restoreLevel(index + 1); },
                { disabled: !writable, title: writable ? 'Sterownik ustawia fabryczny preset tego poziomu w RAM (op 6), potem odczyt.' : blockedTitle }),
        );
    }
    actions.appendChild(button('Zapisz ten poziom (RAM)', 'btn btn-blue btn-sm', () => { void writeLevels(index + 1, 1); },
        { id: `evdV3WriteOne-${index}`, disabled: !writable, title: writable ? 'Zapis jednego poziomu do RAM sterownika, potem odczyt kontrolny.' : blockedTitle }));
    card.appendChild(actions);
    return card;
}

// ---- legend: every setting explained once ------------------------------------------------

function legendSection() {
    const box = section('legend', 'Co oznaczają ustawienia', { id: 'evdV3Legend', className: 'evd-v3-legend' });
    const modes = node('div', 'evd-v3-legend-modes');
    P.MODES.forEach((mode) => {
        const item = node('div', 'evd-v3-legend-mode');
        const chip = node('span', 'evd-v3-chip', mode.name);
        chip.style.setProperty('--mode-color', modeColor(mode.id));
        item.append(chip, node('span', '', MODE_STYLE[mode.id]?.line ?? ''));
        modes.appendChild(item);
    });
    const list = node('dl', 'evd-v3-legend-list');
    LEGEND.filter((item) => isAdvanced() || !item.adv).forEach((item) => {
        const dt = node('dt', '', item.name);
        dt.appendChild(helpBadge(item.full));
        list.append(dt, node('dd', '', item.short));
    });
    box.append(modes, list);
    return box;
}

// ---- rider and hardware (object 5), advanced view only -----------------------------------

function checkRow(id, label, checked, help, onChange) {
    const row = node('div', 'evd-v3-row');
    const line = node('label', 'evd-v3-limit');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = checked; box.id = id;
    box.addEventListener('change', () => onChange(box.checked));
    line.append(box, node('span', 'evd-v3-label', label));
    row.append(line, helpBadge(help));
    return row;
}

function numberRow({ label, unit, min, max, step, value, onChange, help, aria }) {
    const row = node('div', 'evd-v3-row');
    const line = node('label', 'evd-v3-limit');
    const input = document.createElement('input');
    input.type = 'number'; input.className = 'form-input';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    if (aria) input.setAttribute('aria-label', aria);
    input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(v); });
    line.append(node('span', 'evd-v3-label', label), input, node('span', 'evd-v3-unit', unit));
    row.appendChild(line);
    if (help) row.appendChild(helpBadge(help));
    return row;
}

function riderSection() {
    const box = section('rider', 'Rowerzysta i model podtrzymania', {
        id: 'evdV3Rider', className: 'evd-v3-rider',
        help: 'Ustawienia wspólne dla wszystkich poziomów: dotyczą Ciebie i silnika, nie trybu.',
    });
    const r = model.rider;
    const mapRow = checkRow('evdV3EffortMap', 'Mapa wysiłku', r.effortMap,
        'Włączona (domyślnie): wsparcie zależy od tego, jaką część swoich możliwości przy danej kadencji dajesz — liniowo do 60 % wysiłku (80 % wyjścia), dalej łagodnie. Mocniejszy tryb ma krótszy zakres. Wyłączona: stara mapa (nacisk × kadencja, tabela współczynników), jak przed zmianą; Zakres i Siła rowerzysty wtedy nie działają.',
        (v) => { r.effortMap = v; riderEdited(); model.levels.forEach((_, i) => refreshWarnings(i)); });
    const strength = numberRow({
        label: 'Siła rowerzysty T0', unit: 'kg', min: 10, max: 60, step: 0.5,
        value: r.riderStrengthX10kg / 10,
        onChange: (v) => { r.riderStrengthX10kg = Math.round(v * 10); riderEdited(); },
        help: 'Nacisk (kg) przy pełnym wysiłku na małej kadencji. Możliwości przy kadencji liczone są jako T0·(1 − kad/190). Więcej kg = na to samo wsparcie trzeba mocniej naciskać (silny rowerzysta), mniej = pełne wsparcie przy lżejszym nacisku. Domyślnie 30 kg (z logów jazd).',
    });
    const grid = node('div', 'evd-v3-rider-grid');

    // Hold model (OWNER-DEC-20261115-PRESSURE-HOLD, replaces C1). Older firmware (no capability
    // bit 12): the C1 fields are shown read-only with a note to update the firmware.
    if (r.legacy) {
        const note = node('div', 'form-hint ebics-stale-warning', 'Firmware bez modelu podtrzymania (stary obiekt 5 z C1). Minimum Iq i czas bez nacisku po wgraniu nowego firmware; poniżej C1 tylko do odczytu.');
        const c1 = node('div', 'evd-v3-effective', `C1 (stare firmware): Iq_off ${r.lowAssistOffIq}, Iq_on ${r.lowAssistOnIq} — tylko do odczytu.`);
        const errorsLegacy = node('div', 'form-hint'); errorsLegacy.id = 'evdV3RiderErrors';
        const writableLegacy = v3RiderCanWrite();
        const actionsLegacy = node('div', 'evd-v3-actions');
        actionsLegacy.append(button('Zapisz rowerzystę i sprzęt (RAM)', 'btn btn-blue btn-sm', () => { void writeRider(); },
            { id: 'evdV3WriteRider', disabled: !writableLegacy, title: writableLegacy ? 'Zapis siły i mapy wysiłku; C1 bez zmian.' : 'Zablokowane: firmware nie zgłasza obiektu 5 (bit 11).' }));
        grid.append(mapRow, strength);
        box.append(grid, note, c1, errorsLegacy, actionsLegacy);
        return box;
    }
    const pct = (iq) => `${String(P.iqPercent(iq)).replace('.', ',')} % z ${P.PHASE_CURRENT_MAX_IQ}`;
    const holdRow = checkRow('evdV3HoldModel', 'Model podtrzymania', r.holdModel,
        'Włączony (domyślnie): wspomaganie startuje po przekroczeniu progu startu, w czasie jazdy trzyma co najmniej minimum Iq poniżej i gaśnie szybko (w tempie BDE8), gdy przez pełny obrót korby albo przez „Czas bez nacisku” nacisk ani razu nie przekroczy progu „Start w czasie jazdy”. Gaśnie też przy zatrzymaniu korby, cofaniu, hamulcu i poziomie 0. Wyłączony: bez minimum i bez tych warunków końca.',
        (v) => { r.holdModel = v; riderEdited(); });
    const minLow = numberRow({
        label: 'Minimum Iq ≤30 obr/min', unit: 'Iq', min: 0, max: P.RIDER_LIMITS.iqMinMax, step: 1, value: r.iqMinLow,
        aria: 'Minimum Iq przy ≤30 obr/min',
        onChange: (v) => { r.iqMinLow = Math.round(v); riderEdited(); },
        help: `Najmniejszy prąd silnika w czasie jazdy z naciskiem przy kadencji do 30 obr/min (między 30 a 60 obr/min liniowo do wartości ≥60). Trzyma silnik nad pasmem terkotu wolnobiegu; limity mocy, baterii, prędkości i Max Torque i tak go obcinają. 0 = brak minimum. Domyślnie 28 Iq (4 % z ${P.PHASE_CURRENT_MAX_IQ}); teraz ${pct(r.iqMinLow)}. Nie więcej niż przy ≥60 obr/min.`,
    });
    const minHigh = numberRow({
        label: 'Minimum Iq ≥60 obr/min', unit: 'Iq', min: 0, max: P.RIDER_LIMITS.iqMinMax, step: 1, value: r.iqMinHigh,
        aria: 'Minimum Iq przy ≥60 obr/min',
        onChange: (v) => { r.iqMinHigh = Math.round(v); riderEdited(); },
        help: `Najmniejszy prąd silnika w czasie jazdy z naciskiem przy kadencji od 60 obr/min. Do minimum prąd dochodzi płynnie (tempo BDE8, bez skoku). 0 = brak minimum (oba punkty). Maks. 120. Domyślnie 42 Iq (6 % z ${P.PHASE_CURRENT_MAX_IQ}); teraz ${pct(r.iqMinHigh)}.`,
    });
    const tHold = numberRow({
        label: 'Czas bez nacisku', unit: 's', min: P.RIDER_LIMITS.tHoldMin / 10, max: P.RIDER_LIMITS.tHoldMax / 10, step: 0.1, value: r.tHold100ms / 10,
        onChange: (v) => { r.tHold100ms = Math.round(v * 10); riderEdited(); },
        help: 'Jak długo wspomaganie czeka na kolejne „trafienie” (nacisk ≥ próg „Start w czasie jazdy”), zanim zgaśnie. Liczy się dłuższy z: ten czas albo czas jednego obrotu korby, najwyżej 4 s (przy bardzo wolnym kręceniu). Niezależnie od czasu wspomaganie gaśnie po pełnym obrocie korby bez nacisku. Zakres 0,5–4,0 s, domyślnie 2,0 s.',
    });
    grid.append(mapRow, strength, holdRow, minLow, minHigh, tHold);

    const errors = node('div', 'form-hint'); errors.id = 'evdV3RiderErrors';
    const writable = v3RiderCanWrite();
    const actions = node('div', 'evd-v3-actions');
    actions.append(
        button('Fabryczne na ekranie', 'btn btn-secondary btn-sm', () => { model.rider = P.factoryRider(); riderEdited(); renderPanel(); },
            { title: 'Siła 30 kg, minimum 28 / 42 Iq, czas bez nacisku 2,0 s, mapa wysiłku i model podtrzymania włączone. Nic nie wysyła.' }),
        button('Zapisz rowerzystę i sprzęt (RAM)', 'btn btn-blue btn-sm', () => { void writeRider(); },
            { id: 'evdV3WriteRider', disabled: !writable, title: writable ? 'Zapis obiektu 5 do RAM sterownika, potem odczyt kontrolny.' : 'Zablokowane: firmware nie zgłasza obiektu 5 (bit 11).' }),
    );
    box.append(grid, errors, actions);
    return box;
}

// ---- pressure thresholds (TASK-EVD-V3-PRESSURE-ARCH-001) --------------------------------
// The V3 start and hold thresholds live in the profile bank (minimum_pedal_load / riding
// minimum), in the sensor's control domain; the wire and this panel use kg. The firmware converts
// kg -> CLU once when the bank is applied and derives the V3 EB74 thresholds from them on a level
// or bank change, so what is set here is the real trip point (within the sensor's accuracy).
// 2250 CLU is approximately 14.17 kg; round down to the UI step.
const PRESSURE_LIMITS = { min: 0, max: 14.1, step: 0.1 };
function activeBankIndex() { return state.lastBanks?.[0]?.active_bank ?? state.lastBanks?.[1]?.active_bank ?? 0; }
const clampKg = (v) => clamp(Math.round(v * 10) / 10, PRESSURE_LIMITS.min, PRESSURE_LIMITS.max);

function pressureWriteButton(index) {
    return button('Zapisz progi (RAM)', 'btn btn-blue btn-sm', async () => {
        const r = await writeBankAndWait(state.lastBanks[index]);
        addLog(r.ok ? 'ACK' : 'ERROR', r.ok ? `Progi nacisku zapisane w banku ${index + 1} (RAM). Zapis we flash: przycisk globalny.` : `Progi nacisku nie zapisane (${r.reason}).`);
    }, { id: 'evdV3WritePressure', title: 'Zapis aktywnego banku do RAM sterownika (WRITE_BANK). Trwały zapis: globalny „Save”.' });
}

function toAdvancedLink(text) {
    const b = button(text, 'evd-v3-link', () => setProfilesView('advanced'));
    b.id = 'evdV3PressureToAdvanced';
    return b;
}

function pressureSimple(bank, index) {
    const levels = bank.levels || [];
    const starts = levels.map((lv) => lv.minimum_pedal_load_kg ?? 0);
    const rides = levels.map((lv) => lv.riding_minimum_pedal_load_kg ?? 0);
    const same = (arr) => arr.every((v) => v === arr[0]);
    const wrap = node('div', 'evd-v3-pressure-simple');
    if (!levels.length || !same(starts) || !same(rides)) {
        const line = node('div', 'evd-v3-oneline');
        line.append(node('span', '', 'Poziomy mają różne progi — '), toAdvancedLink('edytuj w trybie zaawansowanym'));
        wrap.appendChild(line);
        return wrap;
    }
    const kgText = (v) => `${fmtNum(v, 1)} kg`;
    let rideSlider = null;
    const startSlider = bigSlider({
        id: 'evdV3PressStart', label: 'Start z miejsca', ...PRESSURE_LIMITS,
        get: () => levels[0].minimum_pedal_load_kg ?? 0, badge: kgText,
        onInput: (v) => {
            const kg = clampKg(v);
            levels.forEach((lv) => {
                lv.minimum_pedal_load_kg = kg;
                if ((lv.riding_minimum_pedal_load_kg ?? 0) > kg) lv.riding_minimum_pedal_load_kg = kg;
            });
            rideSlider?.show();
            markUnsavedInRam();
        },
    });
    rideSlider = bigSlider({
        id: 'evdV3PressRide', label: 'Start w jeździe', ...PRESSURE_LIMITS,
        get: () => levels[0].riding_minimum_pedal_load_kg ?? 0, badge: kgText,
        onInput: (v) => {
            levels.forEach((lv) => { lv.riding_minimum_pedal_load_kg = Math.min(clampKg(v), lv.minimum_pedal_load_kg ?? 0); });
            markUnsavedInRam();
        },
    });
    const pair = node('div', 'evd-v3-pressure-pair');
    pair.append(startSlider.row, rideSlider.row);
    const foot = node('div', 'evd-v3-actions evd-v3-pressure-foot');
    foot.append(node('span', 'evd-v3-muted', 'Dla wszystkich poziomów ·'), toAdvancedLink('inne dla poziomów → Zaawansowany'), pressureWriteButton(index));
    wrap.append(pair, foot);
    return wrap;
}

function pressureAdvanced(bank, index) {
    const wrap = node('div');
    const table = node('div', 'evd-v3-pressure-grid');
    table.append(node('span', 'evd-v3-pg-head', 'Poziom'), node('span', 'evd-v3-pg-head', 'Start z miejsca'), node('span', 'evd-v3-pg-head', 'Start w jeździe'));
    const kgInput = (aria, value, onChange) => {
        const box = node('label', 'evd-v3-limit');
        const input = document.createElement('input');
        input.type = 'number'; input.className = 'form-input';
        input.min = String(PRESSURE_LIMITS.min); input.max = String(PRESSURE_LIMITS.max); input.step = String(PRESSURE_LIMITS.step);
        input.value = String(value); input.setAttribute('aria-label', aria);
        input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(v); });
        box.append(input, node('span', 'evd-v3-unit', 'kg'));
        return box;
    };
    (bank.levels || []).forEach((lv, i) => {
        const name = v3ModeNameForLevel(i + 1) ?? `Poziom ${i + 1}`;
        const label = node('span', 'evd-v3-pg-name', `${i + 1} · ${name}`);
        const lm = model.levels[i];
        if (lm) label.style.setProperty('--mode-color', modeColor(lm.mode));
        table.append(label,
            kgInput(`${name}: start z miejsca`, lv.minimum_pedal_load_kg ?? 0, (v) => {
                lv.minimum_pedal_load_kg = clampKg(v);
                if ((lv.riding_minimum_pedal_load_kg ?? 0) > lv.minimum_pedal_load_kg) lv.riding_minimum_pedal_load_kg = lv.minimum_pedal_load_kg;
                markUnsavedInRam(); renderPanel();
            }),
            kgInput(`${name}: start w czasie jazdy`, lv.riding_minimum_pedal_load_kg ?? 0, (v) => {
                lv.riding_minimum_pedal_load_kg = Math.min(clampKg(v), lv.minimum_pedal_load_kg ?? 0);
                markUnsavedInRam(); renderPanel();
            }));
    });
    const actions = node('div', 'evd-v3-actions');
    actions.appendChild(pressureWriteButton(index));
    wrap.append(table, actions);
    return wrap;
}

function pressureSection() {
    const index = activeBankIndex();
    const read = !!(state.lastBanks && state.ebicsReceivedBanks?.[index]);
    if (!read) {
        // Nothing to show before the bank is read: one line, no empty card.
        const line = node('div', 'evd-v3-oneline evd-v3-pressure is-collapsed');
        line.id = 'evdV3Pressure';
        line.append(node('b', '', 'Progi nacisku'), node('span', 'evd-v3-muted', '— pojawią się po odczycie z roweru („Read from bike”).'));
        return line;
    }
    const bank = state.lastBanks[index];
    const legacy = bank.bank_schema_version === 9 || bank.bank_schema_version === 10;
    const box = section('pressure', legacy ? 'Progi nacisku (jednostka wewnętrzna)' : 'Progi nacisku', {
        id: 'evdV3Pressure', className: 'evd-v3-pressure', help: legacy ? undefined : PRESSURE_HELP,
    });
    if (legacy) {
        box.appendChild(node('div', 'form-hint ebics-stale-warning', 'Stary firmware: wartości są w jednostkach wewnętrznych, nie w kg.'));
        const table = node('div', 'evd-v3-pressure-legacy');
        (bank.levels || []).forEach((lv, i) => {
            table.appendChild(node('div', '', `Poziom ${i + 1}: start z miejsca ${lv.minimum_pedal_load_clu}, start w czasie jazdy ${lv.riding_minimum_pedal_load_clu}`));
        });
        box.appendChild(table);
        return box;
    }
    box.appendChild(isAdvanced() ? pressureAdvanced(bank, index) : pressureSimple(bank, index));
    return box;
}

function refreshRiderState() {
    const errors = P.validateRider(model.rider);
    const box = el('evdV3RiderErrors');
    if (box) box.textContent = errors.length ? `Popraw: ${errors.join('; ')}.` : '';
    el('evdV3Rider')?.classList.toggle('is-edited', !!model.riderBaseline && riderDirty());
    const write = el('evdV3WriteRider');
    if (write) write.disabled = !v3RiderCanWrite() || errors.length > 0;
    model.levels.forEach((_, i) => refreshMini(i));
    refreshCharts();
}

function riderEdited() {
    markUnsavedInRam();
    refreshRiderState();
}

// ---- charts (advanced view) ---------------------------------------------------------------

function chartsSection() {
    const box = section('charts', 'Wykresy na żywo', {
        className: 'evd-v3-charts',
        help: 'Wykresy liczą wzory z planu wdrożenia z wartości na ekranie, nie z pomiaru. Odświeżają się przy każdym ruchu suwaka.',
    });
    const controls = node('div', 'evd-v3-chart-controls');
    const levelSel = node('select', 'form-select'); levelSel.id = 'evdV3ChartLevel';
    levelSel.setAttribute('aria-label', 'Poziom na wykresach Start');
    model.levels.forEach((l, i) => levelSel.add(new Option(`Poziom ${i + 1} (${P.MODES[l.mode].name})`, String(i))));
    levelSel.value = String(model.chartLevel);
    levelSel.addEventListener('change', () => { model.chartLevel = Number(levelSel.value); refreshCharts(); });
    const cad = document.createElement('input'); cad.type = 'range'; cad.min = '0'; cad.max = '120'; cad.step = '5'; cad.value = String(model.chartCadence);
    cad.id = 'evdV3ChartCadence'; cad.setAttribute('aria-label', 'Kadencja na wykresie mapy wysiłku');
    const cadText = node('span'); cadText.id = 'evdV3ChartCadenceText';
    cad.addEventListener('input', () => { model.chartCadence = Number(cad.value); refreshCharts(); });
    const force = document.createElement('input'); force.type = 'range'; force.min = '2'; force.max = '50'; force.step = '1'; force.value = String(model.chartForce);
    force.id = 'evdV3ChartForce'; force.setAttribute('aria-label', 'Nacisk na wykresie wygaszania Start');
    const forceText = node('span'); forceText.id = 'evdV3ChartForceText';
    force.addEventListener('input', () => { model.chartForce = Number(force.value); refreshCharts(); });
    const lab = (text, ...nodes) => { const l = node('label', 'evd-v3-limit'); l.append(node('span', '', text), ...nodes); return l; };
    controls.append(lab('Poziom (Start):', levelSel), lab('Kadencja:', cad, cadText), lab('Nacisk:', force, forceText));

    const grid = node('div', 'evd-v3-chart-grid');
    const chart = (id, heading, text) => {
        const fig = node('figure', 'evd-v3-chart');
        const cap = node('figcaption', '', heading);
        cap.appendChild(helpBadge(text));
        const canvas = document.createElement('canvas'); canvas.id = id;
        const note = node('div', 'evd-v3-effective'); note.id = `${id}Note`;
        fig.append(cap, canvas, note);
        return fig;
    };
    grid.append(
        chart('evdV3ChartEffort', 'Mapa wysiłku: wsparcie od nacisku',
            'Oś X: nacisk w kg (szczyt suwu) przy wybranej kadencji. Oś Y: wyjście mapy w % pełnej skali po korekcie Wsparcia, obcięte przez Max Torque. Kolano: 60 % wysiłku daje 80 % wyjścia trybu.'),
        chart('evdV3ChartStart', 'Kop na starcie: cel momentu od nacisku',
            'Iq_start = Max Torque · min(1, F / F_full). Korekta Start skaluje F_full (więcej = pełny kop przy lżejszym nacisku), 0 = wyłączony.'),
        chart('evdV3ChartFade', 'Kop na starcie: wygaszanie z kadencją',
            'Kop pełny do 25 obr/min, zero przy 50 obr/min (gaśnie też przy 12 km/h i po 4 s). Linia: cel przy wybranym nacisku.'),
        chart('evdV3ChartC1', 'Model podtrzymania: minimum Iq od kadencji',
            'Oś X: kadencja. Oś Y: najmniejszy prąd silnika w czasie jazdy z naciskiem (przed limitami mocy, baterii, prędkości i Max Torque). Szare pole: pasmo terkotu wolnobiegu z logów. Linia przerywana: czas bez nacisku do zgaśnięcia (prawa skala w s × 10).'),
    );
    box.append(controls, grid);
    return box;
}

export function refreshCharts() {
    if (!el('evdV3ChartEffort')) return; // simple view: no detailed charts
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
        effortNote.textContent = `${r.effortMap ? '' : 'MAPA WYŁĄCZONA — wykres pokazuje, co dałaby mapa po włączeniu. '}`
            + `Poziom ${model.chartLevel + 1}: pełne wyjście przy ${fmtNum(selOut.eFull * tMax, 1)} kg, kolano przy ${fmtNum(0.6 * selOut.eFull * tMax, 1)} kg. Moc maks. nie jest rysowana (zależy od napięcia).`;
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
        : `F_full trybu ${P.MODES[sel.mode].fFullKg} kg, po korekcie ${fmtNum(fFull, 1)} kg. Start tylko dokłada do zwykłej mapy.`;

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

    // (d) hold model minimum by cadence
    const holdSeries = r.holdModel && r.iqMinHigh
        ? [{ label: 'minimum Iq', color: '#0ea5e9', width: 3, points: sample((c) => P.holdMinimumIq(c, r), 120, 240) }]
        : [{ label: 'model podtrzymania wyłączony / minimum 0', color: '#64748b', width: 2, points: [[0, 0], [120, 0]] }];
    if (r.holdModel) holdSeries.push({ label: 'czas bez nacisku [s × 10]', color: '#f59e0b', dash: true, width: 2, points: sample((c) => 10 * P.holdTimeoutS(c, r), 120, 240) });
    drawLineChart(el('evdV3ChartC1'), {
        xLabel: 'kadencja [obr/min]', yLabel: 'minimum [Iq]', xMax: 120, yMax: Math.max(80, Math.ceil((r.iqMinHigh + 20) / 20) * 20),
        bands: [{ y0: 15, y1: 60, color: 'rgba(148,163,184,0.18)', label: 'pasmo terkotu 15–60' }],
        series: holdSeries,
        vlines: [{ x: P.HOLD_RPM_LOW, label: `${P.HOLD_RPM_LOW}` }, { x: P.HOLD_RPM_HIGH, label: `${P.HOLD_RPM_HIGH}` }],
    });
}

// ---- hardware section: settings that live elsewhere in the app and are NOT part of any mode ----

const HARDWARE = [
    { name: 'Kalibracja czujnika nacisku', where: 'ebics-torque', tab: 'Torque', detail: 'Zero i zakres czujnika. Jeden właściciel przeliczenia nacisku.' },
    { name: 'Bateria i SOC', where: 'ebics-limits', tab: 'Limits', detail: 'Napięcie systemu, prąd baterii, odcięcia napięcia, pojemność, tryb awaryjny (limp) wg SOC.' },
    { name: 'Limit prędkości i koło', where: 'ebics-limits', tab: 'Limits', detail: 'Flaga limitu prawnego, limit prędkości, obwód koła, impulsy czujnika prędkości.' },
    { name: 'Prąd fazy', where: null, tab: '', detail: 'Brak ustawienia w CANable: stały limit w firmware (etap 1). Ograniczenie momentu trybu to Max Torque, nie ten limit.' },
    { name: 'PAS (czujnik pedałowania)', where: 'ebics-system', tab: 'System', detail: 'PAS timeout, progi gazu i dane silnika.' },
    { name: 'Walk Assist', where: 'ebics-walk', tab: 'Walk', detail: 'Prąd, prędkość łańcucha, odcięcie i zatrzask Walk. Osobny tryb funkcjonalny, niezależny od trybów jazdy.' },
];

function hardwareSection() {
    const box = section('hardware', 'Inne ustawienia sprzętu (w innych zakładkach)', {
        id: 'evdV3Hardware', className: 'evd-v3-hardware',
        help: 'Te ustawienia nie należą do żadnego trybu ani poziomu. Edytujesz je w istniejących zakładkach; limity trybu (Moc maks., Max Torque) działają niezależnie.',
    });
    const list = node('ul', 'evd-v3-hw-list');
    HARDWARE.forEach((item) => {
        const li = node('li');
        const text = node('div');
        text.append(node('b', '', item.name));
        if (item.detail) text.appendChild(helpBadge(item.detail));
        li.appendChild(text);
        if (item.where) {
            li.appendChild(button(`Otwórz: ${item.tab}`, 'btn btn-secondary btn-sm', () => document.querySelector(`.tab-button[data-tab="${item.where}"]`)?.click()));
        }
        list.appendChild(li);
    });
    box.appendChild(list);
    return box;
}

// ---- banner and view switch ----------------------------------------------------------------

function connectBanner() {
    const connected = !!state.isCanConnected;
    if (connected && readDone()) return null;
    const banner = node('div', 'evd-v3-banner');
    banner.id = 'evdV3Banner';
    banner.setAttribute('role', 'status');
    if (connected && model.discovered && !model.caps?.model && !model.caps?.rider) {
        banner.classList.add('is-warn');
        banner.append(node('span', 'evd-v3-banner-icon', '!'), node('span', '', 'Sterownik nie obsługuje profili V3 — podgląd fabryczny, zapis zablokowany.'));
        return banner;
    }
    banner.append(node('span', 'evd-v3-banner-icon', 'i'), node('span', '', 'Połącz się i naciśnij ‘Read from bike’'));
    if (connected) {
        banner.appendChild(button('Read from bike', 'btn btn-blue btn-sm', () => el('evdReadAllButton')?.click(), { title: 'Odczyt wszystkiego z roweru (przycisk na górnym pasku).' }));
    }
    return banner;
}

/** Switch between the simple and the advanced view; the choice is remembered. */
export function setProfilesView(view) {
    model.view = view === 'advanced' ? 'advanced' : 'simple';
    saveView(model.view);
    renderPanel();
}

function syncViewToggle() {
    document.querySelectorAll?.('#evdV3ViewToggle [data-view]')?.forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.view === model.view));
    });
    const tab = el('tab-ebics-profiles');
    if (tab) tab.dataset.evdView = model.view;
}

// ---- panel -----------------------------------------------------------------------------

export function renderPanel() {
    const root = el('evdV3Panel');
    if (!root) return;
    const advanced = isAdvanced();
    syncViewToggle();
    root.dataset.view = model.view;
    const status = el('evdV3Status');
    if (status) status.textContent = `${statusText()}${model.note ? ` ${model.note}` : ''}`;
    const stale = !model.baseline && model.caps?.model;
    markReadNeeded('profiles', !!stale);

    const grid = node('div', 'evd-v3-grid');
    model.levels.forEach((_, index) => grid.appendChild(levelCard(index)));
    const parts = [connectBanner(), grid, pressureSection()];
    if (advanced) parts.push(riderSection(), chartsSection(), hardwareSection());
    parts.push(legendSection());
    root.replaceChildren(...parts.filter(Boolean));
    model.levels.forEach((_, index) => refreshWarnings(index));
    refreshRiderState();
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
    return model.baseline ? 'eVistDrive Profiles (jak odczytano)' : 'eVistDrive Profiles (preset fabryczny)';
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
        link.download = `${(preset.name || 'evistdrive-profiles').replace(/[^\w.-]+/g, '_')}.json`;
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
    document.querySelectorAll('#evdV3ViewToggle [data-view]').forEach((b) => {
        b.addEventListener('click', () => setProfilesView(b.dataset.view));
    });
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
export const _loadViewForTests = loadView;
