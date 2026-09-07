// tab-sniffer.js — ES Module
import {
    socket,
    snifferElements,
    addLog,
} from './shared.js';
import { getFrameTooltip, DIAG_FRAME_PATTERNS_ALL, RIDE_TELEMETRY_PATTERNS, ALL_TRAFFIC_TOKEN, DEFAULT_TRAFFIC_TOKEN } from './can-frame-info.js';

function resetDiagStatusUI() {
    snifferElements.diagStatus.className = 'diag-status diag-status--idle';
    snifferElements.diagStatus.textContent = 'DIAG: —';
}

snifferElements.startButton.onclick = () => {
    snifferElements.logArea.innerHTML = '';
    resetDiagStatusUI();
    snifferElements.startButton.disabled = true;
    snifferElements.stopButton.disabled = false;
    const items = snifferElements.activeFiltersList.querySelectorAll('.item span');
    const itemsJoined = Array.from(items).map(item => item.textContent).join(';');
    socket.send(`SNIFFER_START:${snifferElements.snifferLogToFileCheckbox.checked}:${itemsJoined}`);
};

snifferElements.stopButton.onclick = () => {
    snifferElements.startButton.disabled = false;
    snifferElements.stopButton.disabled = true;
    socket.send(`SNIFFER_STOP`);
};

snifferElements.clearButton.onclick = () => {
    snifferElements.logArea.innerHTML = '';
    resetDiagStatusUI();
};

// Presentation-only: sniffer.js appends " [DIAG XXXX]" to a log line's raw text for a frame
// it recognised as part of the eVistDrive Ride Diagnostics dump (see sniffer.js
// _decodeDiagFrame). Split it back out here and render it as a badge instead of plain text —
// the raw CAN data the rest of the line carries is never touched. This dump-completion
// tracker is independent of ACTIVE FILTERS entirely — it runs server-side on every received
// frame, before filtering, regardless of what the live view is currently showing.
const DIAG_BADGE_RE = /\s\[(DIAG (?:REQUEST|START|DATA|END))\]$/;
const DIAG_BADGE_CLASS = {
    'DIAG REQUEST': 'diag-badge--request',
    'DIAG START': 'diag-badge--start',
    'DIAG DATA': 'diag-badge--data',
    'DIAG END': 'diag-badge--end',
};

export function addSnifferLog(data) {
    const entry = document.createElement('div'); entry.classList.add('log-entry');
    const dataSpan = document.createElement('span'); dataSpan.classList.add('log-data');

    const text = String(data);
    const badgeMatch = text.match(DIAG_BADGE_RE);
    if (badgeMatch) {
        dataSpan.textContent = text.slice(0, badgeMatch.index);
        const badge = document.createElement('span');
        badge.classList.add('diag-badge', DIAG_BADGE_CLASS[badgeMatch[1]]);
        badge.textContent = badgeMatch[1];
        entry.appendChild(dataSpan);
        entry.appendChild(badge);
    } else {
        dataSpan.textContent = text;
        entry.appendChild(dataSpan);
    }

    snifferElements.logArea.appendChild(entry);
    snifferElements.logArea.scrollTop = snifferElements.logArea.scrollHeight;
}

// Diag status is pushed separately from the scrolling log (SNIFFER_DIAG_STATUS, routed here
// from websocket.js) so "did the dump complete" stays visible without hunting through the log.
export function updateSnifferDiagStatus(raw) {
    let status;
    try { status = JSON.parse(raw); } catch { return; }
    const el = snifferElements.diagStatus;
    if (!el) return;

    // DATA and END are kept as distinct, separately-labelled counts — never summed into one
    // ambiguous "N frames" figure — matching what sniffer.js#_diagStatusPayload actually
    // tracked (dataFrameCount, hasEnd), not a hardcoded count.
    const dataFrames = status.dataFrameCount ?? 0;
    const dataWord = dataFrames === 1 ? 'DATA frame' : 'DATA frames';
    const framesPart = status.hasEnd ? `${dataFrames} DATA + END` : `${dataFrames} ${dataWord}`;
    const lenSuffix = Number.isFinite(status.expectedLength) ? ` — ${status.expectedLength} B` : '';
    const suspiciousSuffix = status.suspicious ? ' (sequence anomaly)' : '';

    if (status.state === 'active') {
        el.className = 'diag-status diag-status--active';
        el.textContent = `DIAG: … receiving${lenSuffix}`;
    } else if (status.state === 'complete') {
        el.className = 'diag-status diag-status--complete';
        el.textContent = `DIAG: ✓ COMPLETE${lenSuffix} — ${framesPart}`;
    } else if (status.state === 'incomplete') {
        el.className = 'diag-status diag-status--incomplete';
        const receivedSuffix = status.hasEnd ? '' : ' received';
        el.textContent = `DIAG: ⚠ INCOMPLETE${lenSuffix} — ${framesPart}${receivedSuffix}${suspiciousSuffix}`;
    } else {
        resetDiagStatusUI();
    }
}

// --- Filter token vocabulary ---------------------------------------------------------------
// A filter entry is either a concrete 8-hex-digit ID, a wildcard pattern ("822Dxxxx", 'x' =
// any hex digit), or one of the two reserved meta tokens below. sniffer.js's idMatchesPattern
// treats a pattern with no 'x' as a plain exact match, so all three kinds go through one
// mechanism there; here they go through one shared validate/normalize pair.
const META_TOKENS = new Set([ALL_TRAFFIC_TOKEN, DEFAULT_TRAFFIC_TOKEN]);
const FILTER_TEXT_RE = /^[0-9A-Fx]{1,8}$/;

// Canonical on-screen form for a concrete ID/pattern: trimmed, hex digits upper-cased, the
// wildcard marker kept as a lowercase 'x' — the exact shape every tile already uses
// ("822Dxxxx"), so a tile restored from storage renders and compares identically to one
// created by hand, regardless of how it happened to be cased when it was saved.
function normalizeFilterText(raw) {
    return String(raw ?? '').trim().split('').map((ch) => (ch === 'x' || ch === 'X') ? 'x' : ch.toUpperCase()).join('');
}
// Same idea, but also recognises (and canonicalises the case of) the two meta tokens.
function normalizeFilterToken(raw) {
    const trimmed = String(raw ?? '').trim();
    const upper = trimmed.toUpperCase();
    if (META_TOKENS.has(upper)) return upper;
    return normalizeFilterText(trimmed);
}
function isValidFilterToken(text) {
    return META_TOKENS.has(text) || FILTER_TEXT_RE.test(text);
}

// --- Custom filter metadata (name/description a user typed in "+ Add Filter") --------------
// Separate from the filter tokens themselves (which live only in the Active/Available cookies,
// same as before) — this is purely tooltip content, keyed by the normalized token, so it
// survives reload without needing to touch the filter-matching data path at all.
const CUSTOM_FILTER_META_STORAGE_KEY = 'canSnifferCustomFilterMeta';

function loadCustomFilterMeta() {
    let raw;
    try { raw = localStorage.getItem(CUSTOM_FILTER_META_STORAGE_KEY); } catch (e) {
        console.warn('Sniffer: localStorage is unavailable, custom filter descriptions will not persist.', e);
        return {};
    }
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (!value || typeof value !== 'object') continue;
            const token = normalizeFilterToken(key);
            if (!isValidFilterToken(token) || META_TOKENS.has(token)) continue;
            const name = typeof value.name === 'string' ? value.name.trim() : '';
            const description = typeof value.description === 'string' ? value.description.trim() : '';
            if (!name && !description) continue;
            out[token] = { name, description };
        }
        return out;
    } catch (e) {
        console.warn('Sniffer: custom filter descriptions are corrupted JSON — ignoring.', e);
        return {};
    }
}
function saveCustomFilterMeta() {
    try { localStorage.setItem(CUSTOM_FILTER_META_STORAGE_KEY, JSON.stringify(customFilterMeta)); }
    catch (e) { console.error('Sniffer: failed to save custom filter descriptions.', e); }
}
let customFilterMeta = loadCustomFilterMeta();

function setCustomFilterMeta(token, name, description) {
    if (!name && !description) return; // nothing worth remembering
    customFilterMeta[token] = { name, description };
    saveCustomFilterMeta();
}

// User-supplied metadata wins (it is the most specific, deliberately-provided information);
// otherwise fall back to the central dictionary (can-frame-info.js), which already covers the
// two meta tokens, known background/diag IDs, and an honest "not described" default.
function getTileTooltip(text) {
    const meta = customFilterMeta[text];
    if (meta) {
        const label = meta.name || text;
        return `${label}\n${meta.description}\nCustom CAN filter — user-defined rule`.trim();
    }
    return getFrameTooltip(text);
}

// The ID text lives ONLY in this <span> — server.js/tab-sniffer.js read filter tokens back out
// via `.item span`, so nothing else may be added inside it. The tooltip goes on the <li> as a
// data attribute instead (see .item[data-tooltip] in style.css), never touching this text.
function createFilterTile(text) {
    const li = document.createElement('li');
    li.className = 'item' + (META_TOKENS.has(text) ? ' item--meta' : '');
    li.draggable = true;
    li.tabIndex = 0;
    li.setAttribute('data-tooltip', getTileTooltip(text));
    li.innerHTML = `<span>${text}</span>`;

    li.addEventListener('dragstart', () => li.classList.add('dragging'));
    li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        snifferElements.zones.forEach(z => z.classList.remove('drag-over'));
    });

    return li;
}

// --- The two columns -------------------------------------------------------------------
//
// ACTIVE FILTERS is the single source of truth for what live CAN shows: sniffer.js ORs every
// entry in it (see sniffer.js#_isFrameVisible) — an exact ID, a wildcard pattern, or one of
// the two meta tokens. AVAILABLE FILTERS is simply "every known tile that isn't in Active
// right now" — there is no separate hidden/show-only/preset state anywhere else; a preset is
// just code that rearranges these same two lists and then calls syncFilterState(), the exact
// same call a manual drag or Add makes.

const ZONES = [
    () => snifferElements.activeFiltersList,
    () => snifferElements.availableFiltersList,
];

function findTileByText(text) {
    const upper = text.toUpperCase();
    for (const getZone of ZONES) {
        for (const li of getZone().querySelectorAll('.item')) {
            if (li.querySelector('span').textContent.toUpperCase() === upper) return li;
        }
    }
    return null;
}

// Returns the tile for `text`, creating it (with its tooltip) if no column has it yet.
// Appending an existing DOM node elsewhere in the document MOVES it — it is never duplicated.
function ensureTile(text) {
    return findTileByText(text) || createFilterTile(text);
}

function getZoneTexts(zone) {
    return new Set(Array.from(zone.querySelectorAll('.item span')).map(s => s.textContent.toUpperCase()));
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

// Every tile currently existing anywhere, deduped by text (upper-cased) -> its <li>. The
// single place that reads "what tiles already exist", so nothing can ever end up duplicated
// across the two columns.
function collectAllTiles() {
    const seen = new Map();
    for (const getZone of ZONES) {
        for (const li of getZone().querySelectorAll('.item')) {
            const key = li.querySelector('span').textContent.toUpperCase();
            if (!seen.has(key)) seen.set(key, li);
        }
    }
    return seen;
}

// Every filter that actually changes what the live CAN log shows must go through here: it
// persists both columns to cookies, pushes the live activeFilters set to a running sniffer
// session (same live-update path drag-and-drop already used), and refreshes which preset (if
// any) the current Active Filters match. There is deliberately no other path that can affect
// filtering — a preset only rearranges tiles and then calls this same function.
function syncFilterState() {
    const activeItems = snifferElements.activeFiltersList.querySelectorAll('.item span');
    const activeJoined = Array.from(activeItems).map(item => item.textContent).join(';');
    document.cookie = `ActiveCanFilters=${Array.from(activeItems).map(item => item.textContent).join(',')}; path=/; max-age=31536000; `;

    const availableItems = snifferElements.availableFiltersList.querySelectorAll('.item span');
    document.cookie = `AvailableCanFilters=${Array.from(availableItems).map(item => item.textContent).join(',')}; path=/; max-age=31536000; `;

    // Guarded: syncFilterState() now also runs during page-load population (fresh install /
    // migration, before the socket has finished connecting) — server.js ignores this command
    // anyway when no sniffer session is running yet (Start Sniffing sends the current Active
    // Filters itself), so skipping the send here when the socket isn't OPEN loses nothing.
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(`SNIFFER_ACTIVEFILTERS_SET:${activeJoined}`);
    }

    updateFilterModeIndicator();
}

snifferElements.zones.forEach(zone => {
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');

        const draggingItem = document.querySelector('.dragging');
        if (!draggingItem) return;

        const afterElement = getDragAfterElement(zone, e.clientX);

        if (afterElement == null) {
            zone.appendChild(draggingItem);
        } else {
            zone.insertBefore(draggingItem, afterElement);
        }
    });

    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', () => {
        zone.classList.remove('drag-over');
        syncFilterState();
    });
});

function getDragAfterElement(container, x) {
    const draggableElements = [...container.querySelectorAll('.item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = x - box.left - box.width / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

snifferElements.snifferLogToFileCheckbox.addEventListener('change', (e) => {
    socket.send(`SNIFFER_LOG_ENABLE:${e.target.checked}`);
});

// --- "+ Add Filter" — the one way to create a new filter tile ------------------------------
// It always lands in Available and never starts filtering anything by itself — the user drags
// it into Active (or a preset picks it up later) when they actually want it live.
snifferElements.addFilterButton.onclick = () => {
    openFilterFormModal({
        onSubmit: (pattern, name, description) => {
            const li = ensureTile(pattern); // reuse+move if it already exists somewhere; never duplicate
            snifferElements.availableFiltersList.appendChild(li);
            if (name || description) {
                setCustomFilterMeta(pattern, name, description);
                li.setAttribute('data-tooltip', getTileTooltip(pattern));
            }
            syncFilterState();
        },
    });
};

function openFilterFormModal({ onSubmit }) {
    const modal = snifferElements.filterModal;
    const patternInput = document.getElementById('snifferFilterModalPattern');
    const nameInput = document.getElementById('snifferFilterModalName');
    const descInput = document.getElementById('snifferFilterModalDescription');
    const errorEl = modal.querySelector('.preset-modal-error');
    const cancelBtn = modal.querySelector('.filter-modal-cancel');
    const saveBtn = modal.querySelector('.filter-modal-save');

    patternInput.value = '';
    nameInput.value = '';
    descInput.value = '';
    errorEl.textContent = '';
    modal.hidden = false;
    patternInput.focus();

    function close() {
        modal.hidden = true;
        cancelBtn.removeEventListener('click', onCancelClick);
        saveBtn.removeEventListener('click', onSaveClick);
    }
    function onCancelClick() { close(); }
    function onSaveClick() {
        const raw = patternInput.value.trim();
        if (!raw || !FILTER_TEXT_RE.test(raw)) {
            errorEl.textContent = 'ID / Pattern must be hex (x allowed as a wildcard digit), e.g. 82F833xx.';
            patternInput.focus();
            return;
        }
        const pattern = normalizeFilterText(raw);
        if (META_TOKENS.has(pattern)) {
            errorEl.textContent = 'That value is reserved for a system filter.';
            patternInput.focus();
            return;
        }
        const name = nameInput.value.trim();
        const description = descInput.value.trim();
        close();
        onSubmit(pattern, name, description);
    }
    cancelBtn.addEventListener('click', onCancelClick);
    saveBtn.addEventListener('click', onSaveClick);
}

// --- Built-in presets: pure GUI shortcuts, nothing else -------------------------------------
//
// A preset never talks to the backend about "which preset is active" — there is no such
// concept server-side. It only sets ACTIVE FILTERS to an exact list and calls
// syncFilterState(), the exact same call a manual drag or Add makes.

// The standard 0x32xx background telemetry — spammy, excluded by DEFAULT TRAFFIC. Must match
// sniffer.js's DEFAULT_EXCLUDED_IDS exactly (kept in sync by hand; it's a fixed protocol
// constant, not something expected to drift).
const DEFAULT_EXCLUDED_PATTERNS = [
    '82F83200', '82F83201', '82F83202', '82F83203', '82F83204', '82F83205',
    '82F83206', '82F83207', '82F83208', '82F83209', '82F8320A', '82F8320B',
];

// The tiles the "Dump Only" preset sets Active to — read from the same canonical
// library the tooltips come from (can-frame-info.js), so the preset and the tooltip
// text can never drift apart. The library now covers the eVistDrive dump tiles AND the
// QS-1 command/status/export tiles, so the preset captures a QS download too.
const DUMP_ONLY_PATTERNS = DIAG_FRAME_PATTERNS_ALL.map(p => p.pattern);
const DUMP_ONLY_SIGNATURE = new Set(DUMP_ONLY_PATTERNS.map(p => p.toUpperCase()));
const DEFAULT_TRAFFIC_SIGNATURE = new Set([DEFAULT_TRAFFIC_TOKEN]);
const ALL_TRAFFIC_SIGNATURE = new Set([ALL_TRAFFIC_TOKEN]);

// Every tile a built-in preset or a saved custom preset might ever need — ensured to exist (in
// Available) once at startup, so e.g. Dump Only never has to create its own tiles the very
// first time it's clicked, and every one of them always has a proper tooltip.
// FW-145 ride telemetry is seeded as an Available tile so it is one drag away with a proper
// tooltip, but it stays out of DUMP_ONLY_PATTERNS on purpose - see can-frame-info.js.
const RIDE_TELEMETRY_TOKENS = RIDE_TELEMETRY_PATTERNS.map((p) => p.pattern);
const LIBRARY_SEED_TOKENS = [ALL_TRAFFIC_TOKEN, DEFAULT_TRAFFIC_TOKEN, ...DEFAULT_EXCLUDED_PATTERNS, ...DUMP_ONLY_PATTERNS, ...RIDE_TELEMETRY_TOKENS];

function ensureLibrarySeeded() {
    LIBRARY_SEED_TOKENS.forEach((token) => {
        if (!findTileByText(token)) snifferElements.availableFiltersList.appendChild(createFilterTile(token));
    });
}

// The one function every preset (built-in or custom) is built from: Active becomes EXACTLY
// `tokens` (creating any tile that doesn't exist yet), and everything else currently anywhere
// in the GUI settles in Available — never deleted, just no longer an active filter.
function setActiveToExactly(tokens) {
    ensureLibrarySeeded();
    const remaining = collectAllTiles();
    tokens.forEach((token) => {
        const key = token.toUpperCase();
        const li = remaining.get(key) || createFilterTile(token);
        remaining.delete(key);
        snifferElements.activeFiltersList.appendChild(li);
    });
    remaining.forEach((li) => snifferElements.availableFiltersList.appendChild(li));
    syncFilterState();
}

function applyDefaultPreset() { setActiveToExactly([DEFAULT_TRAFFIC_TOKEN]); }
function applyAllTrafficPreset() { setActiveToExactly([ALL_TRAFFIC_TOKEN]); }
function applyDumpOnlyPreset() { setActiveToExactly(DUMP_ONLY_PATTERNS); }

const PRESET_HANDLERS = {
    default: applyDefaultPreset,
    all: applyAllTrafficPreset,
    dump: applyDumpOnlyPreset,
};
const presetButtons = [snifferElements.presetDefaultButton, snifferElements.presetAllButton, snifferElements.presetDumpButton];

presetButtons.forEach(btn => btn.addEventListener('click', () => {
    const handler = PRESET_HANDLERS[btn.dataset.presetMode];
    if (handler) handler();
}));

// Derives which preset (if any) the CURRENT Active Filters match — never stored, always
// recomputed from the actual tile contents, so a manual edit after a preset click is reflected
// immediately and honestly (falls through to "Custom"). Compared as a set: entry order in
// Active never affects Mode (ACTIVE FILTERS is a logical OR, order-independent by definition).
//
// Returns { type: 'builtin', key } | { type: 'custom', key: presetId, label } | null (Custom).
// Custom presets are checked in library order (creation order — no reordering UI yet) and the
// FIRST exact match wins; two custom presets can legitimately end up with an identical
// activeFilters list (nothing stops a user from saving the same filters twice under different
// names), and array order is the simplest deterministic tie-break. A custom preset can also
// coincide exactly with a built-in (e.g. "Update from Current" while All Traffic is active) —
// built-ins are checked first, so the built-in's name wins; this is a deliberate, documented
// precedence, not an accident.
function computeActiveFilterMode() {
    const active = getZoneTexts(snifferElements.activeFiltersList);

    if (setsEqual(active, DEFAULT_TRAFFIC_SIGNATURE)) return { type: 'builtin', key: 'default' };
    if (setsEqual(active, ALL_TRAFFIC_SIGNATURE)) return { type: 'builtin', key: 'all' };
    if (setsEqual(active, DUMP_ONLY_SIGNATURE)) return { type: 'builtin', key: 'dump' };

    for (const preset of customPresets) {
        if (setsEqual(active, new Set(preset.activeFilters.map((t) => t.toUpperCase())))) {
            return { type: 'custom', key: preset.id, label: preset.name };
        }
    }
    return null; // Custom (unnamed) — nothing built-in or saved defines this exact combination
}

const PRESET_LABEL = { default: 'Default', all: 'All Traffic', dump: 'Dump Only' };

function updateFilterModeIndicator() {
    const mode = computeActiveFilterMode();
    presetButtons.forEach(btn => {
        const isActive = !!mode && mode.type === 'builtin' && btn.dataset.presetMode === mode.key;
        btn.classList.toggle('btn-primary', isActive);
        btn.classList.toggle('btn-secondary', !isActive);
    });
    snifferElements.customPresetList.querySelectorAll('.preset-chip').forEach((chip) => {
        const isActive = !!mode && mode.type === 'custom' && chip.dataset.presetId === mode.key;
        chip.classList.toggle('preset-chip--active', isActive);
        const loadBtn = chip.querySelector('.preset-chip-load');
        loadBtn.classList.toggle('btn-primary', isActive);
        loadBtn.classList.toggle('btn-secondary', !isActive);
    });
    if (snifferElements.filterMode) {
        const label = !mode ? 'Custom' : (mode.type === 'builtin' ? PRESET_LABEL[mode.key] : mode.label);
        snifferElements.filterMode.textContent = `Mode: ${label}`;
    }
}

// --- Custom presets: named, user-created ACTIVE FILTERS snapshots --------------------------
//
// A custom preset is nothing more than { id, name, description, activeFilters, createdAt,
// updatedAt } sitting in localStorage. Loading one calls setActiveToExactly() — the exact same
// mechanism the built-in presets use. There is no separate "which custom preset is active"
// flag anywhere: computeActiveFilterMode above re-derives it every time, exactly like the
// built-ins.

const CUSTOM_PRESETS_STORAGE_KEY = 'canSnifferCustomPresets';
const CUSTOM_PRESETS_VERSION = 2;

function generatePresetId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// De-duplicates + validates a single activeFilters array (order doesn't matter — see
// computeActiveFilterMode — but is preserved for a stable, readable Mode-detection order).
function normalizeActiveFiltersList(list) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const token = normalizeFilterToken(raw);
        if (!token || !isValidFilterToken(token) || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
    }
    return out;
}

function arraysSetEqual(a, b) {
    return setsEqual(new Set(a.map((t) => t.toUpperCase())), new Set(b.map((t) => t.toUpperCase())));
}

// v1->v2 migration for a single stored preset ({notHidden, hidden, showOnly} -> activeFilters).
// showOnly, when non-empty, was already a positive filter list and maps across unchanged. An
// empty hidden+showOnly was the old "All Traffic" shape. A hidden list matching exactly the
// standard spam was the old "Default" shape. Anything else was an arbitrary custom Hidden
// Frames list, which the new model has no way to express positively (there is no "match
// everything except this hand-picked list" rule besides DEFAULT TRAFFIC's FIXED exclusion) —
// see the report for why DEFAULT_TRAFFIC, not ALL_TRAFFIC, was chosen as that safe fallback.
function migratePresetEntryV1(entry) {
    const showOnly = Array.isArray(entry.showOnly) ? entry.showOnly.filter((t) => typeof t === 'string' && t.trim()) : [];
    const hidden = Array.isArray(entry.hidden) ? entry.hidden.filter((t) => typeof t === 'string' && t.trim()) : [];
    if (showOnly.length > 0) return showOnly;
    if (hidden.length === 0) return [ALL_TRAFFIC_TOKEN];
    if (arraysSetEqual(hidden, DEFAULT_EXCLUDED_PATTERNS)) return [DEFAULT_TRAFFIC_TOKEN];
    return [DEFAULT_TRAFFIC_TOKEN];
}

// Reads + validates + (if needed) migrates the whole library in one pass. Never throws:
// corrupted JSON, an unexpected top-level shape, or an individual malformed entry all degrade
// to "skip it and keep going" rather than losing every other, still-valid preset (or the
// user's live CAN filters, which this never touches either way).
function loadCustomPresetLibrary() {
    let raw;
    try { raw = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY); } catch (e) {
        console.warn('Sniffer: localStorage is unavailable, custom presets will not persist.', e);
        return { presets: [], migrated: false };
    }
    if (!raw) return { presets: [], migrated: false };

    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
        console.warn('Sniffer: custom preset library is corrupted JSON — starting with an empty library.', e);
        addLog('WARN', 'Saved CAN filter presets were corrupted and could not be read. Starting with none.');
        return { presets: [], migrated: false };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) {
        console.warn('Sniffer: custom preset library has an unexpected shape — starting with an empty library.', parsed);
        addLog('WARN', 'Saved CAN filter presets were in an unexpected format and could not be read. Starting with none.');
        return { presets: [], migrated: false };
    }

    const schemaVersion = Number.isInteger(parsed.version) ? parsed.version : 1;
    const seenIds = new Set();
    const seenNames = new Set();
    const result = [];
    let skipped = 0;
    let migratedCount = 0;
    for (const entry of parsed.presets) {
        if (!entry || typeof entry !== 'object') { skipped++; continue; }
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!id || !name || seenIds.has(id) || seenNames.has(name.toLowerCase())) { skipped++; continue; }
        const description = typeof entry.description === 'string' ? entry.description.trim() : '';

        let activeFilters;
        if (schemaVersion >= 2 && Array.isArray(entry.activeFilters)) {
            activeFilters = normalizeActiveFiltersList(entry.activeFilters);
        } else {
            activeFilters = normalizeActiveFiltersList(migratePresetEntryV1(entry));
            migratedCount++;
        }
        if (activeFilters.length === 0) { skipped++; continue; }

        const createdAt = typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt))
            ? entry.createdAt : new Date().toISOString();
        const updatedAt = typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
            ? entry.updatedAt : createdAt;
        seenIds.add(id);
        seenNames.add(name.toLowerCase());
        result.push({ id, name, description, activeFilters, createdAt, updatedAt });
    }
    if (skipped > 0) {
        console.warn(`Sniffer: skipped ${skipped} malformed/duplicate stored preset(s).`);
        addLog('WARN', `${skipped} saved CAN filter preset(s) were malformed or duplicated and were skipped.`);
    }
    if (migratedCount > 0) {
        console.warn(`Sniffer: migrated ${migratedCount} custom preset(s) from the old Hidden/Show Only schema to Active Filters.`);
        addLog('INFO', `${migratedCount} saved CAN filter preset(s) were upgraded to the new Active/Available filter format.`);
    }
    return { presets: result, migrated: migratedCount > 0 };
}

function saveCustomPresetLibrary() {
    try {
        localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify({ version: CUSTOM_PRESETS_VERSION, presets: customPresets }));
    } catch (e) {
        console.error('Sniffer: failed to save the custom preset library.', e);
        alert('Could not save the preset — browser storage may be full or unavailable.');
    }
}

const loadedPresetLibrary = loadCustomPresetLibrary();
let customPresets = loadedPresetLibrary.presets;
if (loadedPresetLibrary.migrated) saveCustomPresetLibrary(); // persist the v1->v2 upgrade once, immediately

function findPresetById(id) {
    return customPresets.find((p) => p.id === id) || null;
}

// trim + case-insensitive, per spec — "Soft Stop" / "soft stop" / "SOFT STOP" are the same name.
function findPresetByName(name, excludeId = null) {
    const key = name.trim().toLowerCase();
    return customPresets.find((p) => p.id !== excludeId && p.name.toLowerCase() === key) || null;
}

function captureCurrentActiveFilters() {
    return Array.from(snifferElements.activeFiltersList.querySelectorAll('.item span')).map((s) => normalizeFilterToken(s.textContent));
}

function applyCustomPreset(id) {
    const preset = findPresetById(id);
    if (!preset) return;
    setActiveToExactly(preset.activeFilters);
}

function updatePresetFromCurrent(id) {
    const preset = findPresetById(id);
    if (!preset) return;
    if (!confirm(`Replace filters stored in "${preset.name}"\nwith the current filter configuration?`)) return;
    preset.activeFilters = captureCurrentActiveFilters();
    preset.updatedAt = new Date().toISOString();
    saveCustomPresetLibrary();
    refreshPresetUI();
}

function deleteCustomPreset(id) {
    const preset = findPresetById(id);
    if (!preset) return;
    if (!confirm(`Delete preset "${preset.name}"?\n\nThis removes only the saved preset. Current CAN filters will not be changed.`)) return;
    customPresets = customPresets.filter((p) => p.id !== id);
    saveCustomPresetLibrary();
    refreshPresetUI();
}

// --- Save/Edit dialog (shared markup, see #snifferPresetModal in index.html) --------------
function openPresetFormModal({ title, initialName, initialDescription, excludeId, onSubmit }) {
    const modal = snifferElements.presetModal;
    const nameInput = document.getElementById('snifferPresetModalName');
    const descInput = document.getElementById('snifferPresetModalDescription');
    const errorEl = modal.querySelector('.preset-modal-error');
    const cancelBtn = modal.querySelector('.preset-modal-cancel');
    const saveBtn = modal.querySelector('.preset-modal-save');

    document.getElementById('snifferPresetModalTitle').textContent = title;
    nameInput.value = initialName;
    descInput.value = initialDescription;
    errorEl.textContent = '';
    modal.hidden = false;
    nameInput.focus();

    function close() {
        modal.hidden = true;
        cancelBtn.removeEventListener('click', onCancelClick);
        saveBtn.removeEventListener('click', onSaveClick);
    }
    function onCancelClick() { close(); }
    function onSaveClick() {
        const name = nameInput.value.trim();
        if (!name) { errorEl.textContent = 'Name is required.'; nameInput.focus(); return; }
        if (findPresetByName(name, excludeId)) {
            errorEl.textContent = `A preset named "${name}" already exists.`;
            nameInput.focus();
            return;
        }
        const description = descInput.value.trim();
        close();
        onSubmit(name, description);
    }
    cancelBtn.addEventListener('click', onCancelClick);
    saveBtn.addEventListener('click', onSaveClick);
}

function openEditPresetModal(id) {
    const preset = findPresetById(id);
    if (!preset) return;
    openPresetFormModal({
        title: 'Edit Preset',
        initialName: preset.name,
        initialDescription: preset.description,
        excludeId: id,
        onSubmit: (name, description) => {
            // activeFilters and createdAt are deliberately untouched — Edit only changes the label.
            preset.name = name;
            preset.description = description;
            preset.updatedAt = new Date().toISOString();
            saveCustomPresetLibrary();
            refreshPresetUI();
        },
    });
}

snifferElements.saveCurrentButton.onclick = () => {
    openPresetFormModal({
        title: 'Save CAN Filter Preset',
        initialName: '',
        initialDescription: '',
        excludeId: null,
        onSubmit: (name, description) => {
            const now = new Date().toISOString();
            customPresets.push({
                id: generatePresetId(),
                name,
                description,
                activeFilters: captureCurrentActiveFilters(),
                createdAt: now,
                updatedAt: now,
            });
            saveCustomPresetLibrary();
            refreshPresetUI();
        },
    });
};

// --- Preset chip: a "load" button glued to a small "..." menu (Edit / Update / Delete) ----
function closeAllPresetMenus() {
    snifferElements.customPresetList.querySelectorAll('.preset-chip-menu').forEach((m) => { m.hidden = true; });
}
document.addEventListener('click', closeAllPresetMenus);
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAllPresetMenus();
    if (snifferElements.presetModal && !snifferElements.presetModal.hidden) snifferElements.presetModal.hidden = true;
    if (snifferElements.filterModal && !snifferElements.filterModal.hidden) snifferElements.filterModal.hidden = true;
});

function makeMenuItem(label, onClick, danger = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-chip-menu-item' + (danger ? ' preset-chip-menu-item--danger' : '');
    btn.textContent = label;
    // stopPropagation: the document-level click listener above closes every open menu on any
    // click; without this, choosing a menu item would immediately re-close the menu we're
    // reading from before onClick runs (harmless either way, but avoids relying on ordering).
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeAllPresetMenus(); onClick(); });
    return btn;
}

function createPresetChip(preset) {
    const wrap = document.createElement('span');
    wrap.className = 'preset-chip';
    wrap.dataset.presetId = preset.id;

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn btn-secondary btn-sm preset-chip-load';
    loadBtn.textContent = preset.name;
    if (preset.description) loadBtn.setAttribute('data-tooltip', `${preset.name}\n\n${preset.description}`);
    loadBtn.addEventListener('click', () => applyCustomPreset(preset.id));

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'preset-chip-menu-btn';
    menuBtn.setAttribute('aria-label', `${preset.name} options`);
    menuBtn.setAttribute('aria-haspopup', 'true');
    menuBtn.textContent = '⋮';
    // Clicking the menu trigger must never load the preset — only the name button does that.
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = wrap.querySelector('.preset-chip-menu');
        const willOpen = menu.hidden;
        closeAllPresetMenus();
        menu.hidden = !willOpen;
    });

    const menu = document.createElement('div');
    menu.className = 'preset-chip-menu';
    menu.hidden = true;
    menu.appendChild(makeMenuItem('Edit', () => openEditPresetModal(preset.id)));
    menu.appendChild(makeMenuItem('Update from Current', () => updatePresetFromCurrent(preset.id)));
    menu.appendChild(makeMenuItem('Delete', () => deleteCustomPreset(preset.id), true));

    wrap.appendChild(loadBtn);
    wrap.appendChild(menuBtn);
    wrap.appendChild(menu);
    return wrap;
}

function renderCustomPresetChips() {
    snifferElements.customPresetList.innerHTML = '';
    customPresets.forEach((preset) => snifferElements.customPresetList.appendChild(createPresetChip(preset)));
}

function refreshPresetUI() {
    renderCustomPresetChips();
    updateFilterModeIndicator();
}

// --- Live filter-state persistence + one-time migration from the old 3-column cookies ------
//
// readCookie distinguishes "cookie never set" (null) from "cookie set to an empty value" ('')
// — the plain regex trick used everywhere else in this app can't tell those apart, which would
// otherwise make a deliberately-emptied ACTIVE FILTERS (see index.html's empty-state message)
// silently revert to Default on the next reload instead of staying empty.
function readCookie(name) {
    const match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]*)');
    return match ? match.pop() : null;
}

// One-time upgrade from the old negative Hidden/Not Hidden/Show Only columns (see the
// migratePresetEntryV1 comment above for the identical reasoning applied here): a non-empty
// old Show Only was already a positive filter list and maps across unchanged; empty
// hidden+showOnly was "All Traffic"; a hidden list matching exactly the standard spam was
// "Default"; anything else has no positive equivalent and safely falls back to Default
// Traffic. Every tile the old cookies ever mentioned is preserved as a library tile (nothing
// is lost), even if it ends up in Available rather than Active.
function migrateFromOldColumnCookies() {
    const oldHidden = readCookie('FilteredIdsOn');
    const oldNotHidden = readCookie('FilteredIdsOff');
    const oldShowOnly = readCookie('FilteredIdsShowOnly');
    if (oldHidden === null && oldNotHidden === null && oldShowOnly === null) return false;

    const hidden = oldHidden ? oldHidden.split(',').map(normalizeFilterText).filter(Boolean) : [];
    const notHidden = oldNotHidden ? oldNotHidden.split(',').map(normalizeFilterText).filter(Boolean) : [];
    const showOnly = oldShowOnly ? oldShowOnly.split(',').map(normalizeFilterText).filter(Boolean) : [];

    let activeFilters;
    if (showOnly.length > 0) activeFilters = showOnly;
    else if (hidden.length === 0) activeFilters = [ALL_TRAFFIC_TOKEN];
    else if (arraysSetEqual(hidden, DEFAULT_EXCLUDED_PATTERNS)) activeFilters = [DEFAULT_TRAFFIC_TOKEN];
    else activeFilters = [DEFAULT_TRAFFIC_TOKEN]; // arbitrary custom Hidden list — no positive equivalent, see comment above

    [...hidden, ...notHidden, ...showOnly].forEach((token) => {
        if (isValidFilterToken(token) && !findTileByText(token)) {
            snifferElements.availableFiltersList.appendChild(createFilterTile(token));
        }
    });

    setActiveToExactly(activeFilters); // also writes the new cookies via syncFilterState()

    console.warn('Sniffer: migrated the old Hidden/Not Hidden/Show Only filter state to Active/Available Filters.');
    addLog('INFO', 'CAN sniffer filters were upgraded to the new Active/Available Filters format.');
    return true;
}

const savedActive = readCookie('ActiveCanFilters');
const savedAvailable = readCookie('AvailableCanFilters');

if (savedActive !== null || savedAvailable !== null) {
    // Already on the new schema — restore verbatim (an empty saved value legitimately means
    // an empty column, not "nothing was ever saved").
    if (savedActive) savedActive.split(',').forEach((t) => snifferElements.activeFiltersList.appendChild(createFilterTile(t)));
    if (savedAvailable) savedAvailable.split(',').forEach((t) => snifferElements.availableFiltersList.appendChild(createFilterTile(t)));
    ensureLibrarySeeded();
} else if (!migrateFromOldColumnCookies()) {
    // True fresh install: nothing old to migrate either — start at Default, same as this app
    // has always defaulted to.
    applyDefaultPreset();
}

refreshPresetUI();
