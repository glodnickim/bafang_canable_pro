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
    { name: 'Wsparcie (Assist)', short: 'Ile silnik dokłada do Twojego nacisku.', full: 'Przełożenie wspomagania w % (ta sama liczba co na HMI): mnoży to, co daje mapa. W prawo więcej wsparcia przy tym samym nacisku. Tryb pozwala na ×0,5…×2 swojej wartości domyślnej.' },
    { name: 'Moc maks. (Max Power)', short: 'Sufit mocy z baterii na tym poziomie.', full: 'Sufit mocy pobieranej z baterii na tym poziomie. Limit baterii i prądu fazy zostają nadrzędne. Skrajnie w prawo albo „limit sprzętu” (65000) = bez limitu trybu. Mniej W = spokojniej przy wysokiej kadencji i prędkości. Zmiana trybu ustawia jego domyślną moc.' },
    { name: 'Kop na starcie (Start)', short: 'Dodatkowa siła przy ruszaniu z miejsca. 0 = wyłączony.', full: 'Kop przy ruszaniu (stan Start: tylko z postoju, poniżej 6 km/h, gaśnie do 50 obr/min). Liczba = nacisk, przy którym kop jest pełny: w lewo (mniej kg) mocniejszy kop, w prawo słabszy. Skrajnie w prawo = Start wyłączony.' },
    { name: 'Narastanie (Attack)', adv: true, short: 'Jak szybko silnik dochodzi do mocy.', full: 'Jak szybko silnik dochodzi do mocy po naciśnięciu pedału. Liczba = czas od zera do pełnej mocy: w lewo szybciej, w prawo łagodniej.' },
    { name: 'Opadanie (Release)', adv: true, short: 'Jak szybko wsparcie gaśnie, gdy odpuszczasz.', full: 'Jak szybko wspomaganie opada, gdy odpuszczasz nacisk. Liczba = czas opadania: w lewo szybciej gaśnie, w prawo silnik dłużej trzyma moc.' },
    { name: 'Podtrzymanie (Carry)', adv: true, short: 'Wsparcie w krótkiej przerwie pedałowania. 0 = wył.', full: 'Podtrzymanie wspomagania po chwilowym przerwaniu pedałowania (np. zmiana biegu, przeszkoda). Siła % · czas · droga podtrzymania: w prawo mocniej i dłużej. Skrajnie w lewo (0) = wyłączone.' },
    { name: 'Zakres (Range)', adv: true, short: 'Przy jakim nacisku wsparcie dochodzi do 100 %.', full: 'Jaki wysiłek daje pełne wyjście mapy wysiłku. Liczba = nacisk (przy 60 obr/min), przy którym wsparcie dochodzi do 100 %: w lewo pełne wsparcie przy lżejszym nacisku, w prawo trzeba mocniej nacisnąć. Działa tylko z włączoną mapą wysiłku.' },
    { name: 'Max Torque', adv: true, short: 'Sufit momentu silnika (% dozwolonego Iq, nie Nm).', full: 'Sufit momentu silnika: ułamek dozwolonego prądu Iq. Obcina mapę i kop Start; najbardziej czuć go pod górę i przy ruszaniu. Zmiana trybu ustawia jego domyślny Max Torque.' },
    { name: 'Miniwykres', short: 'Wsparcie, Kop i pasek Mocy w jednym polu (ilustracja).', full: 'Jeden wykres w karcie, poglądowy (serie nie mają wspólnej osi). Wsparcie (kolor trybu): wyjście mapy wysiłku od nacisku przy 60 obr/min, po korekcie Wsparcia i Zakresu, obcięte przez Max Torque. Kop (żółta przerywana linia z polem): dodatkowy prąd przy przykładowym ruszaniu z miejsca w czasie 0–4 s — nacisk 12 kg, kadencja rośnie o 15 obr/min na sekundę; narasta w ok. 0,3 s, gaśnie z kadencją między 25 a 50 obr/min (w firmware także przy 12 km/h) i kończy się najpóźniej po 4 s; wysokość zależy od Max Torque i korekty Kopu. Moc (szary pasek „W” na dole): ustawiona Moc maks. na tle mocy baterii (skonfigurowany prąd × napięcie; przed odczytem 15 A × 48 V); pionowa kreska = domyślna moc trybu; „bez limitu” = pełny, jaśniejszy pasek. Liczone z wartości na ekranie, nie z pomiaru.' },
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
    chartForce: 12,
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
/** Effort map v2 active (firmware 0.709+ with the flag on; the factory preview shows v2). */
const mapV2 = () => model.rider?.mapV2 === true;

// Native values are derived from the same model helpers used by the charts.
export function nativeValue(level, key, t0 = 30) {
    const eff = P.effectiveValues(level);
    if (key === 'assist') return eff.ratioPct;
    if (key === 'attack') return eff.attackMs / 1000;
    if (key === 'release') return eff.releaseMs / 1000;
    if (key === 'start') return P.startFullForceKg(level) ?? 0;
    if (key === 'carry') return level.carry === 0 ? 0 : P.MODES[level.mode].carry * P.multiplier(level.carry);
    return P.fullEffortKg(60, level, t0);
}

export function nativeToCorrection(level, key, value, t0 = 30) {
    const off = key === 'start' || key === 'carry';
    if (off && value === 0) return { correction: 0, clipped: false };
    const first = off ? 1 : 0;
    const values = Array.from({ length: 101 - first }, (_, i) => {
        const correction = i + first;
        return { correction, value: nativeValue({ ...level, [key]: correction }, key, t0) };
    });
    const min = Math.min(...values.map((v) => v.value));
    const max = Math.max(...values.map((v) => v.value));
    const closest = values.reduce((a, b) => Math.abs(b.value - value) < Math.abs(a.value - value) ? b : a);
    return { correction: closest.correction, clipped: value < min - 1e-9 || value > max + 1e-9 };
}

export function changeModeNative(level, mode, t0 = 30) {
    const next = { ...level, mode };
    let clipped = false;
    for (const { key } of SLIDERS) {
        const result = nativeToCorrection(next, key, nativeValue(level, key, t0), t0);
        next[key] = result.correction;
        clipped ||= result.clipped;
    }
    return { level: next, clipped };
}

const nativeDigits = (key) => key === 'assist' || key === 'carry' ? 0 : key === 'start' || key === 'range' ? 1 : 2;
const nativeText = (level, key, t0 = 30) => {
    const value = nativeValue(level, key, t0);
    if ((key === 'start' || key === 'carry') && value === 0) return 'wył.';
    const n = (v, digits = nativeDigits(key)) => String(Number(v.toFixed(digits))).replace('.', ',');
    if (key === 'carry') return `${n(value)} % · ${n(1.2 * P.multiplier(level.carry), 1)} s · ${n(1.5 * P.multiplier(level.carry), 1)} m`;
    return `${n(value)} ${key === 'assist' ? '%' : key === 'attack' || key === 'release' ? 's' : 'kg'}`;
};
export function describeEffective(level, key) { return nativeText(level, key); }

function capsSummary(caps) {
    const yes = (b, text) => `${text}: ${b ? 'tak' : 'nie'}`;
    return [yes(caps.model, 'model (bit 8)'), yes(caps.modelWritable, 'zapis modelu (bit 10)'), yes(caps.rider, 'rowerzysta i sprzęt (bit 11)'), yes(caps.riderHold, 'model podtrzymania (bit 12)'), yes(caps.riderMapV2, 'mapa nacisku v2 (bit 13)')].join(', ');
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
    if (!model.rider.effortMap && level.range !== 50) out.push('Mapa wysiłku jest wyłączona: ustawienie zakresu nie działa.');
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
        badge.min = String(o.numberMin ?? o.min); badge.max = String(o.numberMax ?? o.max); badge.step = String(o.numberStep ?? o.step);
        badge.setAttribute('aria-label', o.numberAria);
    } else {
        badge = node('span', 'evd-sl-badge');
        badge.setAttribute('aria-hidden', 'true');
    }
    const sub = o.sub ? node('span', 'evd-sl-sub') : null;
    const reset = o.reset ? button('↺', 'evd-sl-reset', () => { if (o.onReset) o.onReset(); else o.onInput(o.reset.value()); show(); }, { title: o.reset.title }) : null;
    if (reset) reset.setAttribute('aria-label', `${o.label}: ${o.reset.title}`);
    head.append(label, ...(sub ? [sub] : []), ...(reset ? [reset] : []), badge);
    row.append(head, input);
    function show() {
        const pos = o.get();
        input.value = String(pos);
        input.style.setProperty('--fill', `${((clamp(pos, o.min, o.max) - o.min) / (o.max - o.min)) * 100}%`);
        if (o.band) { const [lo, hi] = o.band(); input.style.setProperty('--band-lo', `${lo}%`); input.style.setProperty('--band-hi', `${hi}%`); input.classList.add('has-band'); }
        if (o.numberAria) badge.value = String(o.numberValue ? o.numberValue(pos) : pos); else badge.textContent = o.badge(pos);
        input.setAttribute('aria-valuetext', o.badge(pos));
        if (sub) {
            sub.textContent = o.sub(pos);
            if (o.subTitle) sub.title = o.subTitle();
            sub.classList.toggle('is-fallback', !!o.subFlag?.());
        }
        row.classList.toggle('is-default', !!o.isDefault?.(pos));
    }
    input.addEventListener('input', () => { o.onInput(Number(input.value)); show(); });
    if (o.numberAria) {
        badge.addEventListener('change', () => {
            const v = Number(badge.value);
            if (badge.value !== '' && Number.isFinite(v)) { if (o.onNumber) o.onNumber(v); else o.onInput(clamp(v, o.min, o.max)); }
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

/** Slider step in native units per setting. */
const NATIVE_STEP = { assist: 1, attack: 0.01, release: 0.01, start: 0.1, carry: 1, range: 0.1 };
/** Room past the strongest/weakest value where the slider means "off" (Start: right end, Carry: 0). */
const START_OFF_ROOM_KG = 6;

/**
 * One axis per setting, the same for every level and mode (owner 2026-11-17: the same slider
 * position must mean the same value on every level). It spans every value any mode can reach
 * (x0.5..x2 of each mode default); the band a level's mode can reach is drawn on the track.
 */
export function nativeAxis(key, t0 = 30) {
    const first = key === 'start' || key === 'carry' ? 1 : 0;
    const values = P.MODES.flatMap((mode) => [first, 100].map((c) => nativeValue({ ...P.factoryLevels()[0], mode: mode.id, [key]: c }, key, t0)));
    const step = NATIVE_STEP[key];
    let min = Math.floor(Math.min(...values) / step) * step;
    let max = Math.ceil(Math.max(...values) / step) * step;
    if (key === 'carry') min = 0;
    if (key === 'start') max = Math.ceil(max + START_OFF_ROOM_KG);
    return { min, max, step };
}

/** Slider position (native) -> correction for this level; snaps to the mode's band, handles "off". */
export function axisToCorrection(level, key, value, t0 = 30) {
    const first = key === 'start' || key === 'carry' ? 1 : 0;
    const ends = [first, 100].map((c) => nativeValue({ ...level, [key]: c }, key, t0));
    const lo = Math.min(...ends), hi = Math.max(...ends);
    if (key === 'carry' && value < lo / 2) return 0;
    if (key === 'start' && value > hi + START_OFF_ROOM_KG / 2) return 0;
    return nativeToCorrection(level, key, clamp(value, lo, hi), t0).correction;
}

function correctionSlider(index, spec) {
    const level = model.levels[index];
    const t0 = model.riderBaseline ? model.rider.riderStrengthX10kg / 10 : 30;
    const disabled = spec.key === 'range' && !model.rangeKnown;
    const at = (v) => ({ ...level, [spec.key]: v });
    const first = spec.off ? 1 : 0;
    const axis = nativeAxis(spec.key, t0);
    const pos = () => {
        if (spec.off && level[spec.key] === 0) return spec.key === 'start' ? axis.max : 0;
        return nativeValue(level, spec.key, t0);
    };
    const pct = (v) => ((clamp(v, axis.min, axis.max) - axis.min) / (axis.max - axis.min)) * 100;
    const band = () => {
        const ends = [first, 100].map((c) => nativeValue(at(c), spec.key, t0));
        return [pct(Math.min(...ends)), pct(Math.max(...ends))];
    };
    const endpoint = (v) => nativeText(at(v), spec.key, t0);
    let caption;
    const s = bigSlider({
        id: `evdV3-${index}-${spec.key}`, label: spec.label, min: axis.min, max: axis.max, step: axis.step,
        get: pos, badge: () => nativeText(level, spec.key, t0), band,
        numberAria: isAdvanced() ? `${spec.label}, poziom ${index + 1}` : null,
        numberStep: 'any',
        numberValue: () => (spec.off && level[spec.key] === 0 ? 0 : Number(nativeValue(level, spec.key, t0).toFixed(nativeDigits(spec.key)))),
        onNumber: (v) => {
            level[spec.key] = spec.off && v === 0 ? 0 : nativeToCorrection(level, spec.key, v, t0).correction;
            update();
        },
        isDefault: () => level[spec.key] === 50,
        reset: { title: 'domyślna wartość trybu', value: () => null },
        onReset: () => { level[spec.key] = 50; update(); },
        disabled,
        onInput: (raw) => { level[spec.key] = axisToCorrection(level, spec.key, Number(raw), t0); update(); },
    });
    function update() {
        if (caption) caption.textContent = details();
        afterLevelEdit(index);
    }
    function details() {
        const label = spec.key === 'start' ? 'pełny kop przy ' : spec.key === 'range' ? 'pełne wsparcie przy ' : '';
        const span = (v) => spec.key === 'carry' ? `${Number(nativeValue(at(v), 'carry', t0).toFixed(0))} %` : endpoint(v);
        const ends = [first, 100].sort((a, b) => nativeValue(at(a), spec.key, t0) - nativeValue(at(b), spec.key, t0));
        const preview = spec.key === 'range' && !model.riderBaseline ? ' · podgląd: siła domyślna' : '';
        const warning = spec.key === 'assist' && nativeValue(level, 'assist', t0) > 1000 ? ' · HMI: maks. 1000%' : '';
        return `${label}${nativeText(level, spec.key, t0)}${spec.key === 'range' ? ' @60' : ''} · tryb: ${span(ends[0])}–${span(ends[1])}${preview}${warning}`;
    }
    if (isAdvanced()) {
        caption = node('div', 'evd-v3-effective', details());
        s.row.appendChild(caption);
    }
    return s.row;
}

// ---- battery power source: configured battery current x selected system voltage (P1) ------
// The firmware derives every mode's default Max Power from it (share x battery power). Until P1
// is read the panel uses the firmware fallback 15 A x 48 V and says so next to the slider.
const powerSource = { currentA: P.POWER_SOURCE_DEFAULT.currentMa / 1000, voltageV: P.POWER_SOURCE_DEFAULT.voltageV, known: false };

/** P1 values the panel follows: the Limits tab draft once P1 was read (edits included), else the last read. */
function p1Source() {
    const received = state.ebicsCompatibilityReceived?.p1 ? state.ebicsCompatibilityDraft?.p1 : null;
    const p1 = received || state.lastControllerP1 || state.controllerParams1;
    const currentA = Number(p1?.current_limit);
    const voltageV = Number(p1?.system_voltage);
    return currentA > 0 && voltageV > 0 ? { currentA, voltageV, known: true }
        : { currentA: P.POWER_SOURCE_DEFAULT.currentMa / 1000, voltageV: P.POWER_SOURCE_DEFAULT.voltageV, known: false };
}

/**
 * Take the battery power from P1 (P.setPowerSource) and return true when it changed. Levels not
 * read from the bike that still sit on the old mode default follow the new default.
 */
export function syncV3PowerSource() {
    const next = p1Source();
    if (next.currentA === powerSource.currentA && next.voltageV === powerSource.voltageV && next.known === powerSource.known) return false;
    const before = P.MODES.map((m) => P.modeDefaultPowerW(m.id));
    P.setPowerSource(Math.round(next.currentA * 1000), next.voltageV);
    Object.assign(powerSource, next);
    if (!model.baseline) {
        model.levels.forEach((level) => {
            if (level.maxPowerW === before[level.mode]) level.maxPowerW = P.modeDefaultPowerW(level.mode);
        });
    }
    return true;
}
/** Called on a fresh P1 frame (index.js) and when the Limits tab edits it: redraw if it changed. */
export function onPowerSourceChanged() {
    if (syncV3PowerSource()) renderPanel();
}
const fmtSource = () => `${String(powerSource.currentA).replace('.', ',')} A × ${powerSource.voltageV} V`;
export const v3PowerSourceKnown = () => powerSource.known;

// Simple-view power slider: POWER_MIN .. battery power in 10 W steps; one stop past it = no mode
// limit (65000), where only the battery and phase current limit.
const POWER_MIN = 100;
const POWER_STEP = 10;
const powerMax = () => Math.max(POWER_MIN + POWER_STEP, Math.floor(batteryPowerW() / POWER_STEP) * POWER_STEP);
const powerHwPos = () => powerMax() + POWER_STEP;
const powerPos = (w) => (w === P.HW_POWER_W ? powerHwPos() : clamp(w, POWER_MIN, powerMax()));

function powerSlider(index) {
    const level = model.levels[index];
    return bigSlider({
        id: `evdV3-${index}-power`, label: 'Moc maks.', min: POWER_MIN, max: powerHwPos(), step: POWER_STEP,
        get: () => powerPos(level.maxPowerW),
        badge: () => (level.maxPowerW === P.HW_POWER_W ? 'bez limitu' : `${level.maxPowerW} W`),
        sub: () => (powerSource.known ? `z ${fmtSource()}` : `przyjęto ${fmtSource()}`),
        subTitle: () => (powerSource.known
            ? `Moc baterii ${batteryPowerW()} W = prąd baterii × napięcie systemu (zakładka Limits).`
            : `Przyjęto ${fmtSource()} (wartość zastępcza firmware) — odczytaj z roweru, żeby suwak i domyślne moce liczyły się z Twojej baterii.`),
        subFlag: () => !powerSource.known,
        isDefault: () => level.maxPowerW === P.modeDefaultPowerW(level.mode),
        reset: { title: 'domyślna moc trybu', value: () => powerPos(P.modeDefaultPowerW(level.mode)) },
        onInput: (pos) => {
            level.maxPowerW = pos >= powerHwPos() ? P.HW_POWER_W : clamp(Math.round(pos), POWER_MIN, powerMax());
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
    power.title = `Domyślnie ${P.modeDefaultPowerW(mode.id)} W (${powerSource.known ? 'z' : 'przyjęto'} ${fmtSource()}, bateria ${batteryPowerW()} W)`;

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

// ---- one mini chart per level card: Wsparcie + Kop na starcie + Moc maks. -----------------
// Illustrative, not one physical axis (owner 2026-11-16). In one box:
//  - Wsparcie: effort map output vs pedal force at 60 rpm (mode colour);
//  - Kop: extra start current over 0..4 s of an example start — rises, then fades with cadence
//    (yellow, dashed, translucent fill), its own time axis across the same width;
//  - Moc: thin horizontal bar along the bottom — set Max Power against the battery power
//    (configured current x voltage), tick = mode default, labelled "W".

const SVG_NS = 'http://www.w3.org/2000/svg';
const MINI_W = 200;
const MINI_H = 70;
const PLOT_BOTTOM = 52; // curves live in 0..52, the power bar below
const PLOT_YMAX = 1.08;
const BAR_Y = 59;
const BAR_H = 6;
const BAR_X0 = 6;
const BAR_X1 = 182; // room for the "W" label on the right
const POWER_COLOR = '#475569';
const KOP_COLOR = '#ca8a04';
function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    return n;
}
const plotY = (y) => PLOT_BOTTOM - (clamp(y, 0, PLOT_YMAX) / PLOT_YMAX) * (PLOT_BOTTOM - 3);
function plotPath(pts, xMax) {
    return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${((x / xMax) * MINI_W).toFixed(1)},${plotY(y).toFixed(1)}`).join(' ');
}
const areaOf = (d) => `${d} L${MINI_W},${PLOT_BOTTOM} L0,${PLOT_BOTTOM} Z`;

/** Battery power = the default of a mode with a 100 % share (configured current x voltage). */
export function batteryPowerW() {
    const full = P.MODES.find((m) => m.powerPct === 100) ?? P.MODES[0];
    return Math.round((P.modeDefaultPowerW(full.id) * 100) / full.powerPct);
}
/** Set power as a share of the battery power (no mode limit = 1). */
export function powerShare(level) {
    if (level.maxPowerW === P.HW_POWER_W) return 1;
    return clamp(level.maxPowerW / Math.max(1, batteryPowerW()), 0, 1);
}

// Kop: example start from standstill — pedal force 12 kg, cadence rising 15 rpm per second; the
// extra start target rises in ~0.3 s, fades with cadence 25 -> 50 rpm and ends at 4 s.
const START_DEMO = { forceKg: 12, rpmPerS: 15, riseS: 0.3, endS: 4 };
export function startDemoShare(level, tS) {
    if (tS >= START_DEMO.endS) return 0;
    const rise = Math.min(1, tS / START_DEMO.riseS);
    return P.startTarget(START_DEMO.forceKg, level) * rise * P.startFade(tS * START_DEMO.rpmPerS);
}

function miniChart(index) {
    const wrap = node('div', 'evd-v3-combo');
    const box = node('div', 'evd-v3-combo-plot');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'evd-v3-mini');
    svg.setAttribute('viewBox', `0 0 ${MINI_W} ${MINI_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.id = `evdV3Mini-${index}`;
    const w = node('span', 'evd-v3-combo-w', 'W');
    w.setAttribute('aria-hidden', 'true');
    box.append(svg, w);
    const legend = node('div', 'evd-v3-combo-legend');
    legend.setAttribute('aria-hidden', 'true');
    [['is-support', 'Wsparcie'], ['is-kop', 'Kop'], ['is-power', 'Moc']].forEach(([cls, text]) => {
        const item = node('span', cls);
        item.append(node('i'), text);
        legend.appendChild(item);
    });
    wrap.append(box, legend);
    drawMini(svg, index);
    return wrap;
}

function drawMini(svg, index) {
    const level = model.levels[index];
    const color = modeColor(level.mode);
    const thin = { 'vector-effect': 'non-scaling-stroke' };
    // Wsparcie
    const t0 = model.rider.riderStrengthX10kg / 10;
    const xMaxF = Math.max(10, P.effortOutput(0, 60, level, t0, mapV2()).tMax * 1.2);
    const support = sample((f) => P.effortOutput(f, 60, level, t0, mapV2()).output, xMaxF, 48);
    const supportD = plotPath(support, xMaxF);
    // Kop (time axis 0..4.4 s)
    const xMaxT = START_DEMO.endS + 0.4;
    const kop = sample((t) => startDemoShare(level, t), xMaxT, 66);
    const kopD = plotPath(kop, xMaxT);
    // Moc bar
    const battery = Math.max(1, batteryPowerW());
    const noLimit = level.maxPowerW === P.HW_POWER_W;
    const span = BAR_X1 - BAR_X0;
    const fill = Math.max(BAR_H, powerShare(level) * span);
    const defX = BAR_X0 + clamp(P.modeDefaultPowerW(level.mode) / battery, 0, 1) * span;
    svg.replaceChildren(
        svgEl('path', { 'data-series': 'support-area', d: areaOf(supportD), fill: color, 'fill-opacity': 0.14, stroke: 'none' }),
        svgEl('path', { 'data-series': 'kop-area', d: areaOf(kopD), fill: KOP_COLOR, 'fill-opacity': 0.14, stroke: 'none' }),
        svgEl('path', { 'data-series': 'support', d: supportD, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', ...thin }),
        svgEl('path', { 'data-series': 'kop', d: kopD, fill: 'none', stroke: KOP_COLOR, 'stroke-width': 2, 'stroke-dasharray': '4 3', 'stroke-linejoin': 'round', ...thin }),
        svgEl('rect', { 'data-series': 'power-track', x: BAR_X0, y: BAR_Y, width: span, height: BAR_H, rx: 3, fill: '#e2e8f0' }),
        svgEl('rect', { 'data-series': 'power', x: BAR_X0, y: BAR_Y, width: fill.toFixed(1), height: BAR_H, rx: 3, fill: POWER_COLOR, 'fill-opacity': noLimit ? 0.45 : 0.85 }),
        svgEl('line', { 'data-series': 'power-default', x1: defX.toFixed(1), x2: defX.toFixed(1), y1: BAR_Y - 3, y2: BAR_Y + BAR_H + 3, stroke: '#0f172a', 'stroke-width': 1.5, ...thin }),
    );
    const supportPeak = Math.round(100 * Math.max(...support.map((p) => p[1])));
    const kopPeak = Math.round(100 * Math.max(...kop.map((p) => p[1])));
    const watts = noLimit ? 'bez limitu trybu' : `${level.maxPowerW} W`;
    svg.setAttribute('aria-label', `Poziom ${index + 1}: wsparcie do ${supportPeak} % skali, Kop do ${kopPeak} % i gaśnie, Moc maks. ${watts} z ${battery} W baterii`);
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
            const changed = changeModeNative(level, mode.id, model.riderBaseline ? model.rider.riderStrengthX10kg / 10 : 30);
            Object.assign(level, changed.level);
            model.clipIndex = changed.clipped ? index : null;
            // A new mode brings its own default limits.
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
    if (model.clipIndex === index) body.appendChild(node('div', 'evd-v3-effective', 'przycięto do zakresu trybu'));
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
    box.appendChild(node('p', '', 'Wartości rzeczywiste na wspólnej skali: to samo miejsce suwaka = ta sama wartość na każdym poziomie. Ciemniejszy pas = zakres trybu. ↺ = domyślne dla trybu.'));
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

function riderChart(kind, r) {
    const svg = svgEl('svg', { viewBox: '0 0 200 70', class: 'evd-rider-chart', role: 'img', 'aria-label': kind === 'strength' ? 'Nacisk do pełnego wsparcia a kadencja' : kind === 'minimum' ? 'Minimalne wsparcie a kadencja' : 'Nacisk i czas wyłączenia przy 60 obr/min' });
    const path = svgEl('path', { fill: 'none', stroke: '#2563eb', 'stroke-width': 2 });
    svg.appendChild(path);
    const labels = svgEl('text', { x: 4, y: 68, fill: '#64748b', 'font-size': 9 });
    labels.textContent = kind === 'timeout' ? 'nacisk → brak nacisku · 60 obr/min' : 'kadencja (obr/min)';
    svg.appendChild(labels);
    const marks = [];
    if (kind !== 'timeout') [30, 60, 90].forEach((cad) => {
        const x = 4 + cad / (kind === 'strength' ? 150 : 90) * 192;
        const text = svgEl('text', { x, y: 63, 'text-anchor': 'middle', fill: '#64748b', 'font-size': 8 });
        text.textContent = String(cad); svg.appendChild(text);
        if (kind === 'strength') { const dot = svgEl('circle', { cx: x, r: 2, fill: '#2563eb' }); svg.appendChild(dot); marks.push([cad, dot]); }
    });
    let motor;
    if (kind === 'timeout') {
        motor = svgEl('path', { fill: 'none', stroke: '#ca8a04', 'stroke-width': 5 });
        svg.appendChild(motor);
    }
    function update() {
        if (kind === 'strength') {
            const kgAt = (cad) => P.ctrlKgToKg(P.tMaxKg(cad, r.riderStrengthX10kg / 10));
            const pts = [0, 30, 60, 90, 120, 150].map((cad) => [cad / 150 * 192 + 4, 55 - kgAt(cad) / 30 * 50]);
            path.setAttribute('d', pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
            marks.forEach(([cad, dot]) => dot.setAttribute('cy', 55 - kgAt(cad) / 30 * 50));
        } else if (kind === 'minimum') {
            const y = (iq) => 55 - iq / P.RIDER_LIMITS.iqMinMax * 48;
            path.setAttribute('d', `M4,${y(r.iqMinLow)} L68,${y(r.iqMinLow)} L132,${y(r.iqMinHigh)} L196,${y(r.iqMinHigh)}`);
        } else {
            path.setAttribute('d', 'M4,40 Q12,8 20,40 Q28,8 36,40 Q44,8 52,40 L196,40');
            const end = 52 + Math.min(4, Math.max(r.tHold100ms / 10, 1)) / 4 * 140;
            motor.setAttribute('d', `M4,52 L${end.toFixed(1)},52`);
        }
    }
    update();
    return { svg, update };
}

function riderSection() {
    const box = section('rider', 'Rowerzysta i model podtrzymania', { id: 'evdV3Rider', className: 'evd-v3-rider' });
    const read = !!model.riderBaseline;
    const supported = !!model.caps?.rider;
    const holdSupported = supported && !!model.caps?.riderHold && !model.rider.legacy;
    const r = read ? model.rider : P.factoryRider();
    const hold = holdSupported ? r : P.factoryRider();
    const grid = node('div', 'evd-v3-rider-grid');
    const charts = [];
    const refresh = () => { charts.forEach((c) => c.update()); riderEdited(); };
    const toggle = (id, label, technical, checked, help, effect, disabled, change) => {
        const row = checkRow(id, label, checked, help, (v) => { change(v); refresh(); });
        row.classList.add('evd-rider-toggle');
        row.append(node('div', 'evd-v3-effective', technical), node('div', 'evd-v3-effective', effect));
        if (disabled) lockPreview(row, '');
        return row;
    };
    const slider = ({ id, label, technical, help, min, max, step, get, set, badge, aria, kind, disabled }) => {
        const item = node('div', 'evd-rider-item');
        const s = bigSlider({ id, label, min, max, step, get, badge, onInput: (v) => { set(v); refresh(); }, disabled });
        if (aria) s.row.children[1].setAttribute('aria-label', aria);
        s.row.children[0].appendChild(helpBadge(help));
        const chart = riderChart(kind, kind === 'strength' ? r : hold); charts.push(chart);
        item.append(s.row, node('div', 'evd-v3-effective', technical), chart.svg);
        if (disabled) item.classList.add('is-preview');
        return item;
    };
    grid.appendChild(toggle('evdV3EffortMap', 'Wsparcie wg wysiłku (zalecane)', 'Mapa wysiłku', r.effortMap,
        'Wsparcie zależy od nacisku względem Twojej siły i kadencji. Po wyłączeniu działa stara mapa nacisk × kadencja; siła i Zakres nie działają.',
        'wyłączone: stara mapa nacisk × kadencja', !read || !supported, (v) => { r.effortMap = v; model.levels.forEach((_, i) => refreshWarnings(i)); }));
    const mapV2Supported = supported && !!model.caps?.riderMapV2 && !model.rider.legacy;
    grid.appendChild(toggle('evdV3MapV2', 'Nowa mapa nacisku (zalecane)', 'Mapa v2 · firmware 0.709+', read ? r.mapV2 === true : true,
        'Mniej wsparcia przy lekkim nacisku, mocne szczyty dają więcej, pełny nacisk sięga pełnego prądu silnika. Wyłączona: stara krzywa (maks. 65% prądu przy Wsparciu domyślnym).',
        'wyłączona: stara krzywa, sufit 65%', !read || !mapV2Supported, (v) => { r.mapV2 = v; model.levels.forEach((_, i) => refreshWarnings(i)); }));
    grid.appendChild(slider({ id: 'evdV3RiderStrength', label: 'Twoja siła (kg)', technical: 'nacisk na pedał do pełnego wsparcia przy stojącej korbie',
        help: 'Prawdziwe kg na pedale (tabela czujnika). Większa wartość wymaga mocniejszego nacisku do pełnego wsparcia; z kadencją próg maleje. Najwyżej ok. 26 kg = granica czujnika.', min: P.RIDER_LIMITS.strengthMin / 10, max: P.RIDER_LIMITS.strengthMax / 10, step: 0.5,
        get: () => r.riderStrengthX10kg / 10, set: (v) => { r.riderStrengthX10kg = Math.round(v * 10); }, badge: (v) => `${fmtNum(P.ctrlKgToKg(v), 1)} kg`, kind: 'strength', disabled: !read || !supported }));
    grid.appendChild(toggle('evdV3HoldModel', 'Bez terkotu: stałe minimum + szybkie wyłączenie', 'Model podtrzymania', hold.holdModel,
        'Po starcie utrzymuje minimum prądu i szybko wyłącza wsparcie po braku nacisku. Limity i hamulec nadal działają.',
        'wyłączone: brak minimum i szybkiego wyłączenia', !read || !holdSupported, (v) => { hold.holdModel = v; }));
    for (const [key, label, aria] of [['iqMinLow', 'Minimalne wsparcie przy wolnym kręceniu', 'Minimum Iq przy ≤30 obr/min'], ['iqMinHigh', 'Minimalne wsparcie przy szybkim kręceniu', 'Minimum Iq przy ≥60 obr/min']]) {
        grid.appendChild(slider({ id: `evdV3-${key}`, label, aria, technical: key === 'iqMinLow' ? 'Iq · do 30 obr/min' : 'Iq · od 60 obr/min',
            help: key === 'iqMinLow' ? 'Minimum do 30 obr/min, dalej rośnie liniowo do wartości przy 60 obr/min. Procent odnosi się do 700 Iq; pozostałe limity nadal działają.' : 'Minimum od 60 obr/min. Procent odnosi się do 700 Iq; pozostałe limity nadal ograniczają prąd.',
            min: 0, max: P.RIDER_LIMITS.iqMinMax, step: 1, get: () => hold[key], set: (v) => { hold[key] = Math.round(v); },
            badge: (v) => `${String(P.iqPercent(v)).replace('.', ',')} % (${v} Iq)`, kind: 'minimum', disabled: !read || !holdSupported }));
    }
    grid.appendChild(slider({ id: 'evdV3HoldTime', label: 'Wyłącz po … s bez nacisku', technical: 'Czas bez nacisku · przykład: 60 obr/min',
        help: 'Czas oczekiwania to dłuższy z ustawionego czasu i jednego obrotu, najwyżej 4 s. Pełny obrót bez nacisku może też zakończyć wsparcie.',
        min: P.RIDER_LIMITS.tHoldMin / 10, max: P.RIDER_LIMITS.tHoldMax / 10, step: 0.1, get: () => hold.tHold100ms / 10,
        set: (v) => { hold.tHold100ms = Math.round(v * 10); }, badge: (v) => `${fmtNum(v, 1)} s`, kind: 'timeout', disabled: !read || !holdSupported }));
    const errors = node('div', 'form-hint'); errors.id = 'evdV3RiderErrors';
    const actions = node('div', 'evd-v3-actions');
    actions.append(button('Fabryczne na ekranie', 'btn btn-secondary btn-sm', () => { model.rider = model.rider.legacy ? P.factoryLegacyRider() : P.factoryRider(); riderEdited(); renderPanel(); }, { disabled: !read || !supported }),
        button('Zapisz rowerzystę i sprzęt (RAM)', 'btn btn-blue btn-sm', () => { void writeRider(); }, { id: 'evdV3WriteRider', disabled: !read || !supported }));
    box.append(grid, errors, actions);
    if (model.caps && !supported) box.appendChild(node('div', 'evd-v3-muted', 'Ten firmware nie obsługuje ustawień rowerzysty — podgląd fabryczny.'));
    else if (!read) box.appendChild(node('div', 'evd-v3-muted', 'podgląd fabryczny — odczytaj ustawienia z roweru.'));
    else if (!holdSupported) box.appendChild(node('div', 'evd-v3-muted', `Ten firmware nie obsługuje modelu podtrzymania. C1: Iq_off ${r.lowAssistOffIq}, Iq_on ${r.lowAssistOnIq} — tylko do odczytu.`));
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

// Firmware factory thresholds in kg (bank v11): start 70 CLU ~ 2.5 kg; riding is floored at the 10 mV
// sensor noise (41 CLU ~ 1.5 kg) by the firmware, so that is the effective default.
const PRESSURE_DEFAULT_KG = Object.freeze({ start: 2.5, ride: 1.5 });

function pressurePreviewBank() {
    return { levels: Array.from({ length: P.LEVEL_COUNT }, () => ({
        minimum_pedal_load_kg: PRESSURE_DEFAULT_KG.start, riding_minimum_pedal_load_kg: PRESSURE_DEFAULT_KG.ride,
    })) };
}

/** Owner rule: a parameter CANable can set is always visible - before a read, or on firmware that cannot
 *  take it, the fields stay on screen greyed (factory values), only editing and writing are blocked. */
function lockPreview(box, note) {
    box.classList.add('is-preview');
    const walk = (e) => {
        const tag = (e.tagName || '').toUpperCase();
        if ((tag === 'INPUT' || tag === 'BUTTON') && e.id !== 'evdV3PressureToAdvanced') e.disabled = true;
        Array.from(e.children || e.childNodes || []).forEach(walk);
    };
    walk(box);
    box.appendChild(node('div', 'evd-v3-oneline evd-v3-muted', note));
}

function pressureSection() {
    const index = activeBankIndex();
    const read = !!(state.lastBanks && state.ebicsReceivedBanks?.[index]);
    const bank = read ? state.lastBanks[index] : null;
    const legacy = !!bank && (bank.bank_schema_version === 9 || bank.bank_schema_version === 10);
    const box = section('pressure', 'Progi nacisku', {
        id: 'evdV3Pressure', className: 'evd-v3-pressure', help: PRESSURE_HELP,
    });
    const shown = read && !legacy ? bank : pressurePreviewBank();
    box.appendChild(isAdvanced() ? pressureAdvanced(shown, index) : pressureSimple(shown, index));
    if (!read) {
        lockPreview(box, `podgląd fabryczny (${fmtNum(PRESSURE_DEFAULT_KG.start, 1)} / ${fmtNum(PRESSURE_DEFAULT_KG.ride, 1)} kg) — odczytaj z roweru („Read from bike”), żeby zmienić.`);
    } else if (legacy) {
        const raw = (bank.levels || []).map((lv, i) => `P${i + 1}: ${lv.minimum_pedal_load_clu}/${lv.riding_minimum_pedal_load_clu}`).join(', ');
        lockPreview(box, `Ten firmware nie obsługuje progów w kg (wymaga 0.707 lub nowszego). Odczytane jednostki wewnętrzne: ${raw}.`);
    }
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
    const force = document.createElement('input'); force.type = 'range'; force.min = '2'; force.max = '30'; force.step = '1'; force.value = String(model.chartForce);
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
    const v2 = mapV2();
    const tMax = P.effortOutput(0, cadence, model.levels[0], t0, v2).tMax;
    const xMax = Math.max(10, Math.ceil(tMax * 1.3 / 5) * 5);
    const effortSeries = model.levels.map((level, i) => ({
        label: `P${i + 1} ${P.MODES[level.mode].short}`,
        color: LEVEL_COLORS[i],
        width: i === model.chartLevel ? 3 : 1.5,
        points: sample((f) => 100 * P.effortOutput(f, cadence, level, t0, v2).output, xMax),
    }));
    const sel = model.levels[model.chartLevel];
    const selOut = P.effortOutput(tMax, cadence, sel, t0, v2);
    const yMaxEffort = Math.max(100, Math.ceil(Math.max(...effortSeries.flatMap((s) => s.points.map((p) => p[1]))) / 10) * 10);
    drawLineChart(el('evdV3ChartEffort'), {
        xLabel: `nacisk [kg] przy ${cadence} obr/min (T_max = ${fmtNum(tMax, 1)} kg)`, yLabel: 'prąd [% maks.]', yUnit: '%',
        xMax, yMax: yMaxEffort,
        series: [...effortSeries, {
            label: `P${model.chartLevel + 1} bez Assist (s·u)`, color: LEVEL_COLORS[model.chartLevel], dash: true, width: 1.5,
            points: sample((f) => 100 * P.effortOutput(f, cadence, sel, t0, v2).base, xMax),
        }],
        vlines: [
            { x: selOut.kneeKg, label: 'kolano', color: '#64748b' },
            { x: selOut.fullKg, label: `pełne wsparcie ${fmtNum(selOut.fullKg, 1)} kg`, color: LEVEL_COLORS[model.chartLevel] },
            { x: tMax, label: 'T_max', color: '#94a3b8' },
        ],
        hlines: [{ y: sel.maxTorquePct, label: `Max Torque P${model.chartLevel + 1}`, color: '#dc2626' }],
    });
    const effortNote = el('evdV3ChartEffortNote');
    if (effortNote) {
        effortNote.textContent = `${r.effortMap ? '' : 'MAPA WYŁĄCZONA — wykres pokazuje, co dałaby mapa po włączeniu. '}`
            + `Poziom ${model.chartLevel + 1}: pełne wyjście przy ${fmtNum(selOut.fullKg, 1)} kg, kolano przy ${fmtNum(selOut.kneeKg, 1)} kg (${v2 ? 'mapa v2' : 'stara mapa, sufit 65%'}). Moc maks. nie jest rysowana (zależy od napięcia).`;
    }

    // (b) Start target vs force, selected level
    const fFull = P.startFullForceKg(sel);
    drawLineChart(el('evdV3ChartStart'), {
        xLabel: 'nacisk [kg]', yLabel: 'Iq_start [% maks.]', yUnit: '%', xMax: 30, yMax: 100,
        series: [
            { label: `P${model.chartLevel + 1} ${P.MODES[sel.mode].name}`, color: LEVEL_COLORS[model.chartLevel], width: 3, points: sample((f) => 100 * P.startTarget(f, sel), 30) },
            { label: 'Kop domyślny trybu', color: '#94a3b8', dash: true, points: sample((f) => 100 * P.startTarget(f, { ...sel, start: 50 }), 30) },
        ],
        vlines: fFull ? [{ x: fFull, label: `F_full ${fmtNum(fFull, 1)} kg`, color: LEVEL_COLORS[model.chartLevel] }] : [],
        hlines: [{ y: sel.maxTorquePct, label: 'Max Torque', color: '#dc2626' }],
    });
    const startNote = el('evdV3ChartStartNote');
    if (startNote) startNote.textContent = sel.start === 0 ? 'Kop wyłączony, przy ruszaniu działa tylko zwykła mapa.'
        : `Pełny kop trybu przy ${fmtNum(P.ctrlKgToKg(P.MODES[sel.mode].fFullKg), 1)} kg, po korekcie ${fmtNum(fFull, 1)} kg. Start tylko dokłada do zwykłej mapy.`;

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
    syncV3PowerSource();
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
