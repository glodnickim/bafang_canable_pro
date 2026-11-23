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
//  - before a read: compact banner, "podgląd fabryczny" tag; pressure fields stay VISIBLE (owner rule:
//    every settable parameter has a field) with factory values, disabled.
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
    replaceWith(n) { const p = this.parent; if (!p) return; const i = p.children.indexOf(this); n.parent = p; p.children[i] = n; this.parent = null; }
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
    './common.js': `export const el = (id) => document.getElementById(id); export const socketReady = () => !!globalThis.__evdSocketReady;
        export const markReadNeeded = () => {}; export const writeBankAndWait = async () => ({ ok: true }); export const saveToFlashAndWait = async () => ({ ok: true });
        export const readBankAndWait = async (i) => (globalThis.__evdBankRead ? globalThis.__evdBankRead(i) : { ok: true });`,
    './global-actions.js': 'export const markUnsavedInRam = () => {}; export const clearUnsavedInRam = () => {};',
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
    for (const mode of P.MODES) for (const key of ['assist', 'attack', 'release', 'start', 'carry', 'range']) {
        for (const correction of [0, 50, 100]) {
            const level = { ...P.factoryLevels()[0], mode: mode.id, [key]: correction };
            const native = panel.nativeValue(level, key);
            const back = panel.nativeToCorrection(level, key, native);
            // Asysta capped at 800 %: the roundtrip returns the lowest correction giving the same value.
            const same = back.correction === correction || (key === 'assist' && native === P.ASSIST_MAX_PCT
                && panel.nativeValue({ ...level, assist: back.correction }, key) === native && back.correction < correction);
            check(`native roundtrip ${mode.name} ${key} ${correction}`, same && !back.clipped);
        }
        const level = { ...P.factoryLevels()[0], mode: mode.id };
        check(`native clipping ${mode.name} ${key}`, panel.nativeToCorrection(level, key, 1e6).clipped && panel.nativeToCorrection(level, key, -1).clipped);
    }
    for (const key of ['assist', 'attack', 'release', 'start', 'carry', 'range']) {
        const ax = panel.nativeAxis(key);
        const eco = { ...P.factoryLevels()[0], mode: 0 }, sport = { ...P.factoryLevels()[0], mode: 2 };
        const v = key === 'start' ? 24 : panel.nativeValue({ ...eco, [key]: 100 }, key);
        const a = panel.nativeValue({ ...eco, [key]: panel.axisToCorrection(eco, key, v) }, key);
        const b = panel.nativeValue({ ...sport, [key]: panel.axisToCorrection(sport, key, v) }, key);
        const stepTol = (x) => Math.abs(x - v) / v < 0.02;
        check(`shared axis ${key}: one axis for all modes, same position = same value where both modes reach it`,
            ax.min < ax.max && (!stepTol(a) || !stepTol(b) || Math.abs(a - b) / v < 0.03));
    }
    const switched = panel.changeModeNative(P.factoryLevels()[0], 2);
    check('ECO 95 to SPORT clamps to 155 percent', switched.clipped && switched.level.assist === 0 && panel.nativeValue(switched.level, 'assist') === 155);

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
    check('simple: angle LS visible before read, greyed, off', !!byId('evdV3AngleSimple') && byId('evdV3AngleLs')?.disabled === true && !byId('evdV3AngleLs').checked
        && byId('evdV3AngleLs').closestClass('evd-v3-row').classList.contains('is-preview'));
    const banner = byId('evdV3Banner');
    check('not connected: compact banner', !!banner && /Read from bike/.test(banner.textContent));
    check('cards show "podgląd fabryczny"', root.all((n) => n.classList.contains('evd-v3-tag')).filter((n) => n.textContent === 'podgląd fabryczny').length === 5);
    check('cards marked as preview', root.all((n) => n.classList.contains('is-preview') && n.classList.contains('evd-v3-card')).length === 5);
    const pressureEmpty = byId('evdV3Pressure');
    const pInputs = pressureEmpty.all((n) => n.tagName === 'INPUT');
    check('pressure fields visible before read (factory preview), all disabled',
        pressureEmpty.classList.contains('is-preview') && pInputs.length >= 2 && pInputs.every((n) => n.disabled)
        && /podgląd fabryczny/.test(pressureEmpty.textContent));
    panel.setProfilesView('advanced');
    const riderPreview = byId('evdV3Rider');
    check('angle LS visible before read, greyed, off', !!byId('evdV3AngleLs') && byId('evdV3AngleLs').disabled && !byId('evdV3AngleLs').checked
        && byId('evdV3AngleLs').closestClass('evd-v3-row').classList.contains('is-preview'));
    check('rider factory preview has all disabled fields', riderPreview.all((n) => n.tagName === 'INPUT').length === 8
        && riderPreview.all((n) => n.tagName === 'INPUT').every((n) => n.disabled)
        && /podgląd fabryczny/.test(riderPreview.textContent));
    panel.setProfilesView('simple');

    // ---- Moc maks. follows the battery power (P1 current x system voltage) ----
    const powerInput = () => byId('evdV3-0-power');
    const powerSub = () => powerInput().parent.children[0].children.find((n) => n.classList.contains('evd-sl-sub'));
    check('before P1: fallback 15 A × 48 V flagged', !panel.v3PowerSourceKnown() && powerSub().classList.contains('is-fallback')
        && /przyjęto 15 A × 48 V/.test(powerSub().textContent) && /odczytaj z roweru/.test(powerSub().title));
    check('before P1: slider max = 720 W + "bez limitu" stop', Number(powerInput().max) === 730 && panel.batteryPowerW() === 720);
    global.__evdTestState.lastControllerP1 = { current_limit: 20, system_voltage: 52 };
    panel.onPowerSourceChanged();
    check('after P1: battery power 20 A × 52 V = 1040 W', panel.batteryPowerW() === 1040 && panel.v3PowerSourceKnown());
    check('after P1: slider max follows (1040 W + "bez limitu" stop)', Number(powerInput().max) === 1050);
    check('after P1: note shows the source, not flagged', /z 20 A × 52 V/.test(powerSub().textContent) && !powerSub().classList.contains('is-fallback'));
    check('after P1: factory levels take the new mode defaults', panel._modelForTests.levels.every((l) => l.maxPowerW === P.modeDefaultPowerW(l.mode))
        && panel._modelForTests.levels[0].maxPowerW === Math.round(1040 * P.MODES[0].powerPct / 100));
    // Limits tab edit (draft after P1 was read) wins over the last read
    global.__evdTestState.ebicsCompatibilityReceived = { p1: true };
    global.__evdTestState.ebicsCompatibilityDraft = { p1: { current_limit: 25, system_voltage: 48 } };
    panel.onPowerSourceChanged();
    check('Limits tab edit (25 A × 48 V) drives the slider', panel.batteryPowerW() === 1200 && Number(powerInput().max) === 1210);
    const hwPos = powerInput(); hwPos.value = hwPos.max; hwPos.dispatch('input');
    check('last slider stop = no mode limit', panel._modelForTests.levels[0].maxPowerW === P.HW_POWER_W);
    panel._modelForTests.levels[0].maxPowerW = P.modeDefaultPowerW(panel._modelForTests.levels[0].mode);
    panel.renderPanel();

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
    check('simple support displays native percent', byId('evdV3-0-assist').getAttribute('aria-valuetext') === '95 %');
    check('simple: angle LS present, greyed without bit 15', simple.has('INPUT:evdV3AngleLs') && byId('evdV3AngleLs').disabled && /brak bitu 15/.test(byId('evdV3AngleSimple').textContent));
    check('simple: no rider, charts, hardware', !byId('evdV3Rider') && !byId('evdV3ChartEffort') && !byId('evdV3Hardware'));
    for (let i = 0; i < 5; i++) {
        // owner 2026-11-18: one save path — the simple view has no per-level send button
        check(`simple level ${i + 1}: mode buttons, 3 big sliders, no per-level send`, P.MODES.every((m) => simple.has(`BUTTON:${m.name}@evdV3Card-${i}`))
            && ['assist', 'power', 'start'].every((k) => simple.has(`INPUT:evdV3-${i}-${k}@evdV3Card-${i}`))
            && !simple.has(`BUTTON:evdV3WriteOne-${i}@evdV3Card-${i}`));
    }
    // shared pressure slider applies to all levels and keeps riding <= start
    const ps = byId('evdV3PressStart'); ps.value = '2.5'; ps.dispatch('input');
    check('shared start applied to all levels, riding clamped', S.lastBanks[0].levels.every((lv) => lv.minimum_pedal_load_kg === 2.5 && lv.riding_minimum_pedal_load_kg === 2.5));

    // ---- one mini chart per card: Asysta + Kop (rise and fade) + Moc bar, redrawn live ----
    for (let i = 0; i < 5; i++) {
        const card = byId(`evdV3Card-${i}`);
        const charts = card.all((n) => n.tagName === 'SVG');
        check(`simple level ${i + 1}: exactly one chart`, charts.length === 1 && charts[0].id === `evdV3Mini-${i}`);
        const series = new Set(charts[0].children.map((n) => n.getAttribute('data-series')));
        check(`level ${i + 1}: chart has support, Kop and power bar`, ['support', 'kop', 'power', 'power-default'].every((k) => series.has(k)));
        check(`level ${i + 1}: inline legend Asysta / Kop / Moc`, /Asysta.*Kop.*Moc/.test(card.all((n) => n.classList.contains('evd-v3-combo-legend'))[0]?.textContent || ''));
    }
    const part = (key) => byId('evdV3Mini-0').children.find((n) => n.getAttribute('data-series') === key);
    const barWidth = () => Number(part('power').getAttribute('width'));
    const pw = byId('evdV3-0-power');
    pw.value = '200'; pw.dispatch('input');
    const narrow = barWidth();
    pw.value = '1000'; pw.dispatch('input');
    check('Moc: bar follows the slider live', barWidth() > narrow, `(${narrow} -> ${barWidth()})`);
    check('Moc: battery power from the mode share', panel.batteryPowerW() === P.modeDefaultPowerW(P.MODES.find((m) => m.powerPct === 100).id));
    const lvl0 = panel._modelForTests.levels[0];
    check('Moc: share of the battery power, no limit = full', Math.abs(panel.powerShare(lvl0) - Math.min(1, 1000 / panel.batteryPowerW())) < 1e-9
        && panel.powerShare({ ...lvl0, maxPowerW: P.HW_POWER_W }) === 1);
    pw.value = String(Math.round(P.modeDefaultPowerW(lvl0.mode) / 50) * 50); pw.dispatch('input');
    // Kop: rises, then falls (time chart), scales with the slider
    const share = (start, t) => panel.startDemoShare({ ...lvl0, start }, t);
    check('Kop: starts at 0, rises, then falls back to 0', share(50, 0) === 0 && share(50, 1) > share(50, 0.1) && share(50, 3.4) === 0 && share(50, 4) === 0
        && share(50, 1) > share(50, 2.5));
    check('Kop: more Kop = higher curve', share(100, 1) > share(50, 1) && share(0, 1) === 0);
    const kopYs = () => part('kop').getAttribute('d').split(/[ML]/).filter((pt) => pt.trim()).map((pt) => Number(pt.split(',')[1]));
    const st = byId('evdV3-0-start');
    // Shared native axis (physical kg): the default ECO Kop is 18.2 kg (35 control kg), 12.5 kg is the strongest ECO Kop.
    st.value = '18.2'; st.dispatch('input');
    const ys = kopYs();
    const top = Math.min(...ys);
    const topAt = ys.indexOf(top);
    check('Kop curve in the chart goes up and then down', top < ys[0] && top < ys[ys.length - 1] && topAt > 0 && topAt < ys.length - 1);
    st.value = '12.6'; st.dispatch('input');
    check('Kop curve higher with the slider', Math.min(...kopYs()) < top);
    st.value = '200'; st.dispatch('input'); // past the strongest-to-weakest band: Kop off
    check('Kop = 0: flat curve', new Set(kopYs()).size === 1);
    st.value = '50'; st.dispatch('input');

    // order: cards first, then pressure
    const order = root.children.map((n) => n.id || n.className);
    check('order: save bar, level cards, then pressure', order[0] === 'evdV3SaveBar' && order[1] === 'evd-v3-grid' && order[2] === 'evdV3Pressure', JSON.stringify(order));
    // save bar (owner 2026-11-18): read -> clean; an edit -> dirty with the field named; one save button
    const bar = () => byId('evdV3SaveBar');
    check('save bar present with the one save button', !!bar() && !!byId('evdV3SaveToBike'));

    advancedBtn.click();
    check('click Zaawansowany -> stored', storage.get('evdProfilesView') === 'advanced' && root.dataset.view === 'advanced');
    const carryCaption = () => byId('evdV3-0-carry').parent.all((n) => n.classList.contains('evd-v3-effective'))[0].textContent;
    check('old carry caption includes time and distance', /tryb:.*%.*s.*m.*%.*s.*m/.test(carryCaption()) && carryCaption().includes('1,2 s'));
    panel._modelForTests.caps.carryV2 = true;
    panel.renderPanel();
    check('new carry caption includes 3 s, 5 m and EN marker', carryCaption().includes('3 s') && carryCaption().includes('5 m') && carryCaption().includes('poza EN 15194'));
    const carryLegend = byId('evdV3Legend').all((n) => n.tagName === 'DT' && n.textContent.includes('Dopych'))[0];
    check('new carry legend mentions 20 km/h', carryLegend.children[0].getAttribute('data-help').includes('20 km/h'));
    panel._modelForTests.caps.carryV2 = false;
    panel.renderPanel();
    // ---- eVistDrive - kat niskich obrotow (object 5 bit 3, capability bit 15) ----
    const ls = () => byId('evdV3AngleLs');
    const lsRow = () => ls().closestClass('evd-v3-row');
    check('old firmware (no bit 15): angle LS visible, greyed, off', ls() && ls().disabled && !ls().checked && /brak bitu 15/.test(lsRow().textContent));
    check('angle LS hint text', lsRow().all(() => true).some((n) => (n.getAttribute('data-help') || '').includes('Nowy sposób liczenia kąta przy ruszaniu. Wył. = jak 0.709. Zmiana działa na postoju.')));
    check('angle LS: requested, active after stop (no DIAG claim)', /aktywne po zatrzymaniu/.test(lsRow().textContent));
    const savedRider = { ...panel._modelForTests.rider };
    panel._modelForTests.caps.angleLs = true;
    for (const v of [false, true]) {
        panel._modelForTests.rider = { ...savedRider, angleLs: v };
        panel._modelForTests.riderBaseline = { ...savedRider, angleLs: v };
        panel.renderPanel();
        check(`new firmware: angle LS read ${v ? 1 : 0} shown, writable`, !ls().disabled && ls().checked === v);
    }
    panel.setProfilesView('simple');
    check('simple: angle LS writable with bit 15, shows read value', !ls().disabled && ls().checked === true && /Zmiana działa na postoju/.test(byId('evdV3AngleSimple').all(() => true).map((n) => n.getAttribute('data-help') || '').join('')));
    ls().checked = false; ls().dispatch('change');
    check('simple: toggling angle LS edits the rider', panel._modelForTests.rider.angleLs === false && panel.pendingChanges().some((t) => t.includes('Kąt niskich obrotów')));
    panel._modelForTests.rider.angleLs = true;
    panel.setProfilesView('advanced');
    ls().checked = false; ls().dispatch('change');
    check('new firmware: toggling angle LS edits rider, other flags kept', panel._modelForTests.rider.angleLs === false
        && panel._modelForTests.rider.effortMap === savedRider.effortMap && panel._modelForTests.rider.holdModel === savedRider.holdModel && panel._modelForTests.rider.mapV2 === savedRider.mapV2);
    check('angle LS change listed as unsaved', panel.pendingChanges().some((t) => t.includes('Kąt niskich obrotów')), JSON.stringify(panel.pendingChanges()));
    panel._modelForTests.rider = { ...savedRider };
    panel._modelForTests.riderBaseline = { ...savedRider };
    panel._modelForTests.caps.angleLs = false;
    panel.renderPanel();
    const advanced = new Set(controls());
    const required = [
        'BUTTON:evdV3WriteRider', 'INPUT:evdV3EffortMap', 'INPUT:evdV3HoldModel', 'INPUT:evdV3AngleLs', 'INPUT:evdV3-iqMinLow', 'INPUT:evdV3-iqMinHigh',
        'BUTTON:Fabryczne na ekranie', 'BUTTON:evdV3WritePressure', 'SELECT:evdV3ChartLevel', 'INPUT:evdV3ChartCadence', 'INPUT:evdV3ChartForce',
        'BUTTON:Otwórz: Torque', 'BUTTON:Otwórz: Limits', 'BUTTON:Otwórz: System', 'BUTTON:Otwórz: Walk',
    ];
    for (let i = 0; i < 5; i++) {
        const c = `@evdV3Card-${i}`;
        P.MODES.forEach((m) => required.push(`BUTTON:${m.name}${c}`));
        ['assist', 'attack', 'release', 'start', 'carry', 'range'].forEach((k) => required.push(`INPUT:evdV3-${i}-${k}${c}`));
        ['Asysta', 'Narastanie', 'Opadanie', 'Kop na starcie', 'Dopych', 'Zakres'].forEach((l) => required.push(`INPUT:${l}, poziom ${i + 1}${c}`));
        required.push(`INPUT:Max Power w watach, poziom ${i + 1}${c}`, `INPUT:Moc maks.: limit sprzętu, poziom ${i + 1}${c}`, `INPUT:Max Torque w procentach, poziom ${i + 1}${c}`,
            `BUTTON:Fabryczne na ekranie${c}`, `BUTTON:Fabryczne w sterowniku${c}`, `BUTTON:evdV3WriteOne-${i}${c}`);
        const name = P.MODES[panel._modelForTests.levels[i].mode].name;
        required.push(`INPUT:${name}: start z miejsca`, `INPUT:${name}: start w czasie jazdy`);
    }
    const missing = required.filter((k) => !advanced.has(k));
    check(`advanced holds every action (${required.length} checked)`, missing.length === 0, JSON.stringify(missing));
    const rider = byId('evdV3Rider');
    check('rider has four live SVG charts', rider.all((n) => n.tagName === 'SVG' && n.getAttribute('class') === 'evd-rider-chart').length === 4);
    for (const [id, value, pathIndex] of [['evdV3RiderStrength', 45, 0], ['evdV3-iqMinLow', 20, 0], ['evdV3-iqMinHigh', 60, 0], ['evdV3HoldTime', 3, 1]]) {
        const input = byId(id);
        const chart = input.parent.parent.all((n) => n.tagName === 'SVG')[0];
        const path = chart.all((n) => n.tagName === 'PATH')[pathIndex];
        const before = path.getAttribute('d');
        input.value = String(value); input.dispatch('input');
        check(`${id}: chart updates`, path.getAttribute('d') !== before);
    }
    const css = require('fs').readFileSync(path.join(__dirname, '..', 'ui', 'style.css'), 'utf8');
    check('rider layout can shrink at 375 px', /\.evd-v3-rider-grid\s*\{[^}]*minmax\(min\(100%,\s*280px\)/.test(css)
        && /\.evd-rider-chart\s*\{[^}]*max-width:\s*100%/.test(css));
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

    // ---- review B: the save needs a fresh successful readback of every written object ----
    {
        const M = panel._modelForTests;
        const capsLs = { model: false, rider: true, riderHold: true, riderMapV2: true, angleLs: true, persistState: 0 };
        const base = { ...P.factoryRider(), angleLs: false };
        const calls = [];
        let readThrows = true;
        M.client = {
            async discover() { calls.push('caps'); return capsLs; },
            async writeRider(r) { calls.push(`writeRider ${r.angleLs}`); return { ok: true, generation: 11 }; },
            async persist() { calls.push('persist'); return { ok: true, generation: 12 }; },
            async readRider() { calls.push('readRider'); if (readThrows) throw new Error('timeout'); return { rider: { ...base, angleLs: true }, generation: 12 }; },
        };
        M.caps = capsLs; M.baseline = P.cloneLevels(M.levels); M.pressureBaseline = null; S.lastBanks = null;
        M.rider = { ...base }; M.riderBaseline = { ...base };
        globalThis.__evdSocketReady = true;
        panel.renderPanel();
        M.rider.angleLs = true;
        const failed = await panel.saveToBike();
        check('readback throws -> save not reported as saved', failed === false && M.saveResult?.ok === false && /niepotwierdzony/.test(M.saveResult.text)
            && calls.includes('writeRider true') && calls.includes('readRider'), JSON.stringify([M.saveResult, calls]));
        readThrows = false;
        M.rider = { ...base, angleLs: true }; M.riderBaseline = { ...base }; M.saveResult = null; M.saving = null;
        const ok = await panel.saveToBike();
        check('fresh readback ok -> saved and checked', ok === true && M.saveResult?.ok === true && /sprawdzono odczytem/.test(M.saveResult.text), JSON.stringify(M.saveResult));
        globalThis.__evdSocketReady = false;
    }

    // ---- review 2, item 2 + 3: partial save is reported, nothing unconfirmed advances its baseline ----
    {
        const M = panel._modelForTests;
        const capsAll = { model: true, modelWritable: true, rider: true, riderHold: true, riderMapV2: true, angleLs: true, persistState: 0 };
        const base = { ...P.factoryRider(), angleLs: false };
        const calls = [];
        let riderFails = true;
        let bikeLevels = P.factoryLevels();
        let bikeRider = { ...base };
        M.client = {
            async discover() { return capsAll; },
            async write(first, levels) { calls.push(`write ${first} ${levels.length}`); bikeLevels = P.cloneLevels(levels); return { ok: true, generation: 21 }; },
            async read() { return { levels: P.cloneLevels(bikeLevels), generation: 21, rangeKnown: true, schemaVersion: 2 }; },
            async writeRider(r) { calls.push('writeRider'); if (riderFails) return { ok: false, text: 'odrzucone' }; bikeRider = { ...r }; return { ok: true, generation: 22 }; },
            async readRider() { return { rider: { ...bikeRider }, generation: 22 }; },
            async persist() { calls.push('persist'); return { ok: true, generation: 23 }; },
        };
        M.caps = capsAll; S.lastBanks = null; M.pressureBaseline = null; M.saveResult = null; M.saving = null;
        M.levels = P.factoryLevels(); M.baseline = P.factoryLevels();
        M.rider = { ...base }; M.riderBaseline = { ...base };
        globalThis.__evdSocketReady = true;
        panel.renderPanel();
        M.levels[0].assist = M.levels[0].assist === 70 ? 60 : 70;
        M.rider.angleLs = true;
        const partial = await panel.saveToBike();
        check('partial save reported explicitly', partial === false && M.saveResult?.partial === true
            && /Zapis częściowy: poziomy zapisane w RAM, rowerzysta nie/.test(M.saveResult.text), JSON.stringify(M.saveResult));
        check('partial save: levels baseline not advanced (still pending)', panel.pendingChanges().some((t) => t.startsWith('P1')) && panel.pendingChanges().some((t) => t.includes('Kąt niskich obrotów')), JSON.stringify(panel.pendingChanges()));
        const bar = () => byId('evdV3SaveBar');
        check('error stays visible next to pending changes', bar().classList.contains('is-error') && /Zapis częściowy/.test(bar().textContent) && /Niezapisane zmiany/.test(bar().textContent), bar().textContent);
        riderFails = false; calls.length = 0;
        const retry = await panel.saveToBike();
        check('retry re-sends the levels and the rider', retry === true && calls.includes('write 1 5') && calls.includes('writeRider') && M.saveResult?.ok === true, JSON.stringify([calls, M.saveResult]));
        check('after confirmed retry nothing pending', panel.pendingChanges().length === 0, JSON.stringify(panel.pendingChanges()));
        globalThis.__evdSocketReady = false;
    }

    // ---- review 2, item 1: thresholds-only save reads the bank back and does not claim flash ----
    {
        const M = panel._modelForTests;
        const capsRider = { model: false, rider: true, riderHold: true, riderMapV2: true, angleLs: true, persistState: 0 };
        M.client = { async discover() { return capsRider; }, async readRider() { return { rider: { ...M.rider }, generation: 30 }; } };
        M.caps = capsRider; M.saveResult = null; M.saving = null; M.riderBaseline = { ...M.rider };
        S.lastBanks = [{ active_bank: 0, bank_schema_version: 11, levels: Array.from({ length: 5 }, () => ({ minimum_pedal_load_kg: 4, riding_minimum_pedal_load_kg: 3 })) }];
        S.ebicsReceivedBanks = [true];
        const resetBank = () => { S.lastBanks[0].levels.forEach((lv) => { lv.minimum_pedal_load_kg = 4; lv.riding_minimum_pedal_load_kg = 3; }); };
        const reads = [];
        const answer = (kg) => (i) => { reads.push(i); const b = JSON.parse(JSON.stringify(S.lastBanks[i])); if (kg !== undefined) b.levels[0].minimum_pedal_load_kg = kg; S.lastBanks[i] = b; return { ok: true }; };
        globalThis.__evdSocketReady = true;
        for (const [name, reader, okWanted, pattern] of [
            ['bank readback equal -> saved, persistence unconfirmed', answer(), true, /sprawdzone odczytem.*trwałość niepotwierdzona/],
            ['bank readback differs -> failed', answer(2), false, /odczyt progów nacisku różni się/],
            ['bank readback missing -> unconfirmed', () => { reads.push('x'); return { ok: false, reason: 'timeout' }; }, false, /niepotwierdzony.*progów nacisku/],
        ]) {
            resetBank(); M.saveResult = null; M.saving = null;
            panel.renderPanel();
            M.pressureBaseline = JSON.stringify(S.lastBanks[0].levels.map((lv) => [lv.minimum_pedal_load_kg, lv.riding_minimum_pedal_load_kg]));
            S.lastBanks[0].levels[0].minimum_pedal_load_kg = 5;
            reads.length = 0; globalThis.__evdBankRead = reader;
            const res = await panel.saveToBike();
            check(name, res === okWanted && reads.length === 1 && pattern.test(M.saveResult?.text || '') && !/Zapisano na stałe/.test(M.saveResult?.text || ''), JSON.stringify([res, reads, M.saveResult]));
            if (!okWanted) check(`${name}: thresholds still pending`, panel.pendingChanges().includes('Progi nacisku'), JSON.stringify(panel.pendingChanges()));
        }
        globalThis.__evdBankRead = null;
        globalThis.__evdSocketReady = false;
    }

    if (failures) { console.error(`profiles_view_toggle: ${failures} failure(s)`); process.exit(1); }
    console.log('profiles_view_toggle: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
