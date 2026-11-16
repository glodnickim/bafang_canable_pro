// eVistDrive Profiles panel: the Prosty / Zaawansowany switch must not lose any action.
// Renders the real v3-model-panel.js into a tiny in-memory DOM (no browser, no jsdom) with
// shared.js / common.js / global-actions.js replaced by stubs, then checks:
//  - default view is Prosty, the choice is stored in localStorage (and a throwing localStorage
//    does not break loading);
//  - the advanced view holds every control of the panel (buttons and fields per level, rider,
//    pressure thresholds, charts, hardware links), and nothing shown in Prosty is missing there;
//  - switching back and forth keeps the same set;
//  - order: level cards first (after the banner), then pressure thresholds;
//  - level cards carry no explanatory text: settings are explained once (no help text twice);
//  - before a read: compact banner, "podgląd fabryczny" tag, pressure collapsed to one line.
const path = require('path');
const { pathToFileURL } = require('url');
const mod = require('module');

let failures = 0;
function check(name, ok, detail = '') {
    if (ok) console.log(`  PASS ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

// ---- minimal DOM ---------------------------------------------------------------------------
class ClassList {
    constructor(owner) { this.owner = owner; }
    get set() { return new Set(this.owner.className.split(/\s+/).filter(Boolean)); }
    write(set) { this.owner.className = [...set].join(' '); }
    add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.write(s); }
    remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.write(s); }
    contains(c) { return this.set.has(c); }
    toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; }
}
class Node {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parent = null;
        this.attributes = {};
        this.listeners = {};
        this.className = '';
        this.classList = new ClassList(this);
        this.dataset = {};
        this.style = { setProperty(k, v) { this[k] = v; } };
        this._text = '';
        this.id = '';
        this.value = '';
        this.disabled = false;
        this.open = false;
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children = []; this._text = String(v); }
    append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === 'string' ? Object.assign(new Node('#text'), { _text: n }) : n)); }
    appendChild(n) { n.parent = this; this.children.push(n); return n; }
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
    add(option) { this.appendChild(option); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({ type, target: this, preventDefault() {}, stopPropagation() {} })); }
    click() { if (!this.disabled) this.dispatch('click'); }
    walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
    all(pred) { const out = []; this.walk((n) => { if (pred(n)) out.push(n); }); return out; }
    closestClass(c) { let n = this; while (n) { if (n.classList.contains(c)) return n; n = n.parent; } return null; }
}
const body = new Node('body');
const byId = (id) => { let hit = null; body.walk((n) => { if (!hit && n.id === id) hit = n; }); return hit; };
global.document = {
    body,
    createElement: (tag) => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: (sel) => {
        const m = /^#(\S+) \[data-view\]$/.exec(sel);
        if (!m) return [];
        const root = byId(m[1]);
        return root ? root.all((n) => n.dataset.view !== undefined) : [];
    },
};
global.window = { addEventListener() {}, devicePixelRatio: 1 };
global.Option = class extends Node { constructor(text, value) { super('option'); this._text = text; this.value = value; } };
const storage = new Map();
let storageThrows = false;
global.localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('blocked'); return storage.has(k) ? storage.get(k) : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); storage.set(k, String(v)); },
};
global.__evdTestState = { isCanConnected: false, lastBanks: null, ebicsReceivedBanks: null };

// ---- module stubs --------------------------------------------------------------------------
const dataUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
    '../shared.js': `export const socket = { readyState: 1 }; export const state = globalThis.__evdTestState;
        export function addLog() {}
        export function helpBadge(text) { const b = document.createElement('button'); b.className = 'ebics-help'; b.textContent = '?'; b.setAttribute('data-help', text); return b; }`,
    './common.js': `export const el = (id) => document.getElementById(id); export const socketReady = () => false;
        export const markReadNeeded = () => {}; export const writeBankAndWait = async () => ({ ok: true });`,
    './global-actions.js': 'export const markUnsavedInRam = () => {};',
};
mod.registerHooks({
    resolve(specifier, context, next) {
        if (STUBS[specifier] && context.parentURL?.endsWith('v3-model-panel.js')) return { url: dataUrl(STUBS[specifier]), shortCircuit: true };
        return next(specifier, context);
    },
});

(async () => {
    const dir = path.join(__dirname, '..', 'ui', 'js', 'evistdrive');
    const P = await import(pathToFileURL(path.join(dir, 'v3-model-protocol.js')).href);
    const tab = new Node('div'); tab.id = 'tab-ebics-profiles';
    const toggle = new Node('div'); toggle.id = 'evdV3ViewToggle';
    const simpleBtn = new Node('button'); simpleBtn.dataset.view = 'simple';
    const advancedBtn = new Node('button'); advancedBtn.dataset.view = 'advanced';
    toggle.append(simpleBtn, advancedBtn);
    const root = new Node('div'); root.id = 'evdV3Panel';
    tab.append(toggle, root);
    body.appendChild(tab);

    const panel = await import(pathToFileURL(path.join(dir, 'v3-model-panel.js')).href);
    panel.bindModelPanel();

    // ---- view choice and storage ----
    check('default view is Prosty', root.dataset.view === 'simple' && tab.dataset.evdView === 'simple');
    check('toggle shows Prosty pressed', simpleBtn.getAttribute('aria-pressed') === 'true' && advancedBtn.getAttribute('aria-pressed') === 'false');
    storageThrows = true;
    check('throwing localStorage -> Prosty, no exception', panel._loadViewForTests() === 'simple');
    panel.setProfilesView('advanced'); // must not throw either
    check('switch works while localStorage throws', root.dataset.view === 'advanced');
    storageThrows = false;
    panel.setProfilesView('simple');

    // ---- before a read ----
    const banner = byId('evdV3Banner');
    check('not connected: compact banner', !!banner && /Read from bike/.test(banner.textContent));
    check('cards show "podgląd fabryczny"', root.all((n) => n.classList.contains('evd-v3-tag')).filter((n) => n.textContent === 'podgląd fabryczny').length === 5);
    check('cards marked as preview', root.all((n) => n.classList.contains('is-preview')).length === 5);
    const pressureEmpty = byId('evdV3Pressure');
    check('pressure collapsed to one line, no fields', pressureEmpty.classList.contains('is-collapsed') && pressureEmpty.all((n) => n.tagName === 'INPUT').length === 0);

    // ---- with a read: baseline and a bank with equal thresholds ----
    const S = global.__evdTestState;
    S.isCanConnected = true;
    S.lastBanks = [{ active_bank: 0, bank_schema_version: 11, levels: Array.from({ length: 5 }, () => ({ minimum_pedal_load_kg: 4, riding_minimum_pedal_load_kg: 3 })) }];
    S.ebicsReceivedBanks = [true];
    panel._modelForTests.baseline = P.cloneLevels(panel._modelForTests.levels);
    panel._modelForTests.riderBaseline = { ...panel._modelForTests.rider };
    panel._modelForTests.caps = { model: true, modelWritable: true, rider: true, riderHold: true };

    // A control's identity: id, else aria-label, else button text.
    const controls = () => root.all((n) => ['BUTTON', 'INPUT', 'SELECT'].includes(n.tagName) && !n.classList.contains('ebics-help'))
        .map((n) => `${n.tagName}:${n.id || n.getAttribute('aria-label') || n.textContent}${n.closestClass('evd-v3-card') ? `@${n.closestClass('evd-v3-card').id}` : ''}`);

    panel.renderPanel();
    check('read + connected: no banner', !byId('evdV3Banner'));
    const simple = new Set(controls());
    check('simple: shared pressure sliders', simple.has('INPUT:evdV3PressStart') && simple.has('INPUT:evdV3PressRide'));
    check('simple: link to advanced thresholds', simple.has('BUTTON:evdV3PressureToAdvanced'));
    check('simple: no attack/release/carry/range', ![0, 1, 2, 3, 4].some((i) => ['attack', 'release', 'carry', 'range'].some((k) => byId(`evdV3-${i}-${k}`))));
    check('simple: no rider, charts, hardware', !byId('evdV3Rider') && !byId('evdV3ChartEffort') && !byId('evdV3Hardware'));
    for (let i = 0; i < 5; i++) {
        check(`simple level ${i + 1}: mode buttons, 3 big sliders, write`, P.MODES.every((m) => simple.has(`BUTTON:${m.name}@evdV3Card-${i}`))
            && ['assist', 'power', 'start'].every((k) => simple.has(`INPUT:evdV3-${i}-${k}@evdV3Card-${i}`))
            && simple.has(`BUTTON:evdV3WriteOne-${i}@evdV3Card-${i}`));
    }
    // shared pressure slider applies to all levels and keeps riding <= start
    const ps = byId('evdV3PressStart'); ps.value = '2.5'; ps.dispatch('input');
    check('shared start applied to all levels, riding clamped', S.lastBanks[0].levels.every((lv) => lv.minimum_pedal_load_kg === 2.5 && lv.riding_minimum_pedal_load_kg === 2.5));

    // ---- one mini chart per card: Wsparcie + Moc cap + Kop overlay, redrawn live ----
    for (let i = 0; i < 5; i++) {
        const card = byId(`evdV3Card-${i}`);
        const charts = card.all((n) => n.tagName === 'SVG');
        check(`simple level ${i + 1}: exactly one chart`, charts.length === 1 && charts[0].id === `evdV3Mini-${i}`);
        const series = new Set(charts[0].children.map((n) => n.getAttribute('data-series')));
        check(`level ${i + 1}: chart has support, power cap and Kop`, ['support', 'power', 'kop'].every((k) => series.has(k)));
        check(`level ${i + 1}: inline legend Wsparcie / Moc / Kop`, /Wsparcie.*Moc.*Kop/.test(card.all((n) => n.classList.contains('evd-v3-combo-legend'))[0]?.textContent || ''));
    }
    const part = (key) => byId('evdV3Mini-0').children.find((n) => n.getAttribute('data-series') === key);
    const capY = () => Number(part('power').getAttribute('y1'));
    const pw = byId('evdV3-0-power');
    pw.value = '200'; pw.dispatch('input');
    const lowCap = capY();
    pw.value = '1000'; pw.dispatch('input');
    check('Moc: cap line follows the slider live (higher W = higher line)', capY() < lowCap, `(${lowCap} -> ${capY()})`);
    check('Moc: "W" label follows the cap', byId('evdV3MiniW-0').style.top === `${(capY() / 56) * 100}%`);
    check('Moc: battery power from the mode share', panel.batteryPowerW() === P.modeDefaultPowerW(P.MODES.find((m) => m.powerPct === 100).id));
    const lvl0 = panel._modelForTests.levels[0];
    check('Moc: share of the battery power', Math.abs(panel.powerShare(lvl0) - Math.min(1, 1000 / panel.batteryPowerW())) < 1e-9
        && panel.powerShare({ ...lvl0, maxPowerW: P.HW_POWER_W }) === 1);
    // BOOST level (5): a low cap cuts the support off
    const part4 = (key) => byId('evdV3Mini-4').children.find((n) => n.getAttribute('data-series') === key);
    const pw4 = byId('evdV3-4-power');
    pw4.value = '100'; pw4.dispatch('input');
    check('Moc: support above a low cap is shown as cut off', !!part4('support-cut'));
    const cap4 = Number(part4('power').getAttribute('y1'));
    const supportYs = part4('support').getAttribute('d').split(/[ML]/).filter((pt) => pt.trim()).map((pt) => Number(pt.split(',')[1]));
    check('Moc: delivered support never above the cap', supportYs.every((y) => y >= cap4 - 0.05));
    pw4.value = String(Math.round(P.modeDefaultPowerW(panel._modelForTests.levels[4].mode) / 50) * 50); pw4.dispatch('input');
    const kopD = () => part('kop').getAttribute('d');
    const st = byId('evdV3-0-start');
    st.value = '0'; st.dispatch('input');
    check('Kop: Kop = 0 draws a flat line', kopD().split(/[ML]/).filter((pt) => pt.trim()).every((pt) => pt.trim().endsWith(',54.0')), kopD().slice(0, 80));
    st.value = '50'; st.dispatch('input');
    const kop50 = kopD();
    st.value = '100'; st.dispatch('input');
    check('Kop: overlay changes with the slider', kopD() !== kop50 && kopD() !== '');
    st.value = '50'; st.dispatch('input');
    pw.value = String(Math.round(P.modeDefaultPowerW(lvl0.mode) / 50) * 50); pw.dispatch('input');

    // order: cards first, then pressure
    const order = root.children.map((n) => n.id || n.className);
    check('order: level cards first, then pressure', order[0] === 'evd-v3-grid' && order[1] === 'evdV3Pressure', JSON.stringify(order));

    advancedBtn.click();
    check('click Zaawansowany -> stored', storage.get('evdProfilesView') === 'advanced' && root.dataset.view === 'advanced');
    const advanced = new Set(controls());
    const required = [
        'BUTTON:evdV3WriteRider', 'INPUT:evdV3EffortMap', 'INPUT:evdV3HoldModel', 'INPUT:Minimum Iq przy ≤30 obr/min', 'INPUT:Minimum Iq przy ≥60 obr/min',
        'BUTTON:Fabryczne na ekranie', 'BUTTON:evdV3WritePressure', 'SELECT:evdV3ChartLevel', 'INPUT:evdV3ChartCadence', 'INPUT:evdV3ChartForce',
        'BUTTON:Otwórz: Torque', 'BUTTON:Otwórz: Limits', 'BUTTON:Otwórz: System', 'BUTTON:Otwórz: Walk',
    ];
    for (let i = 0; i < 5; i++) {
        const c = `@evdV3Card-${i}`;
        P.MODES.forEach((m) => required.push(`BUTTON:${m.name}${c}`));
        ['assist', 'attack', 'release', 'start', 'carry', 'range'].forEach((k) => required.push(`INPUT:evdV3-${i}-${k}${c}`));
        ['Wsparcie', 'Narastanie', 'Opadanie', 'Kop na starcie', 'Podtrzymanie', 'Zakres'].forEach((l) => required.push(`INPUT:${l}, poziom ${i + 1}${c}`));
        required.push(`INPUT:Max Power w watach, poziom ${i + 1}${c}`, `INPUT:Moc maks.: limit sprzętu, poziom ${i + 1}${c}`, `INPUT:Max Torque w procentach, poziom ${i + 1}${c}`,
            `BUTTON:Fabryczne na ekranie${c}`, `BUTTON:Fabryczne w sterowniku${c}`, `BUTTON:evdV3WriteOne-${i}${c}`);
        const name = P.MODES[panel._modelForTests.levels[i].mode].name;
        required.push(`INPUT:${name}: start z miejsca`, `INPUT:${name}: start w czasie jazdy`);
    }
    const missing = required.filter((k) => !advanced.has(k));
    check(`advanced holds every action (${required.length} checked)`, missing.length === 0, JSON.stringify(missing));
    check('advanced: 4 detailed charts', ['evdV3ChartEffort', 'evdV3ChartStart', 'evdV3ChartFade', 'evdV3ChartC1'].every((id) => byId(id)));
    // Everything in Prosty exists in Zaawansowany, except the simple-only shortcuts
    // (shared pressure pair, link, power slider) whose function the advanced fields cover.
    const simpleOnly = (k) => /evdV3PressStart|evdV3PressRide|evdV3PressureToAdvanced|evdV3-\d-power|^BUTTON:Moc maks\.|↺/.test(k);
    const lost = [...simple].filter((k) => !simpleOnly(k) && !advanced.has(k));
    check('nothing from Prosty is lost in Zaawansowany', lost.length === 0, JSON.stringify(lost));

    simpleBtn.click();
    advancedBtn.click();
    const again = new Set(controls());
    check('simple -> advanced -> simple -> advanced keeps the same controls', again.size === advanced.size && [...advanced].every((k) => again.has(k)));

    // ---- explained once ----
    for (const view of ['simple', 'advanced']) {
        panel.setProfilesView(view);
        const cards = root.all((n) => n.classList.contains('evd-v3-card'));
        const helpInCards = cards.flatMap((c) => c.all((n) => n.classList.contains('ebics-help') && !n.classList.contains('evd-warn-badge')));
        check(`${view}: no help badges in level cards`, helpInCards.length === 0);
        check(`${view}: no long text in level cards`, cards.every((c) => c.all((n) => n._text.length > 80).length === 0));
        const helps = root.all((n) => n.getAttribute('data-help') && !n.classList.contains('evd-warn-badge')).map((n) => n.getAttribute('data-help'));
        const dup = helps.filter((t, i) => helps.indexOf(t) !== i);
        check(`${view}: every help text appears once`, dup.length === 0, JSON.stringify(dup));
        check(`${view}: legend present`, !!byId('evdV3Legend'));
    }

    // ---- different thresholds per level ----
    panel.setProfilesView('simple');
    S.lastBanks[0].levels[2].minimum_pedal_load_kg = 6;
    panel.renderPanel();
    check('different thresholds: "różne" line, no shared sliders', /różne progi/.test(byId('evdV3Pressure').textContent) && !byId('evdV3PressStart'));

    if (failures) { console.error(`profiles_view_toggle: ${failures} failure(s)`); process.exit(1); }
    console.log('profiles_view_toggle: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
