// evistdrive/editable-chart.js — CB-025: making a Plotly chart an INPUT.
//
// Everywhere else in this app a chart is a projection: fields go in, a curve comes out, and
// nothing flows back. Here the curve can be grabbed, and grabbing it changes the setting the
// number box below shows.
//
// WHY AN OVERLAY AND NOT PLOTLY'S OWN EDITING
//
// Plotly's `editable: true` / `config.edits` move annotations, shapes, titles, axis ranges and
// legend entries. They do NOT move scatter data points — there is no such edit in Plotly 2.x.
// The alternatives were to draw every handle as a draggable shape and read `plotly_relayout`
// (which fights back the moment you try to lock one axis), or to let Plotly draw and do the
// pointer work in a transparent layer above it. This is the second.
//
// WHAT THE POINTER MATH DEPENDS ON
//
// Two things: the axis ranges, and the rectangle the plot area occupies inside the graph div.
// The ranges are the CALLER's — every chart using this pins both axes explicitly, so nothing
// Plotly does can move them. The rectangle comes from `_fullLayout._size` when it is there and
// is otherwise recomputed from the very margins the caller handed Plotly, which is exact as
// long as `automargin` stays off. No Plotly CSS class is selected and no node inside Plotly's
// SVG is touched, so a future Plotly dropping `_size` degrades to the fallback instead of
// breaking.
//
// TWO LAYERS LIVE HERE
//
//   createDragOverlay      — the primitive. Knows nothing about assist levels or what a chart
//                            means: it is handed handles at data coordinates and reports the
//                            values they are dragged to. The OWNER draws the plot.
//   createEditableParameterChart
//                          — the common case built on it: one value per category, dragged up
//                            and down, drawn for you.
//
// NEITHER EVER TALKS TO THE CONTROLLER. Edits are reported through a callback; putting
// anything on the CAN bus remains the job of the card's own Write button.
/* global Plotly */
import { el, plotLayout } from './common.js';
// CB-025: the value grid and the pixel transforms live in their own DOM-free module so they
// can be tested against the shipped code (tests/cb025_editable_chart_grid.js) instead of
// being checked by dragging things and squinting.
import {
    decimalsForStep, snapToStep, solveOnGrid, paddedRange, categoryRange,
    valueToPixel, pixelToValue, indexToPixel,
} from './parameter-grid.js';

export { decimalsForStep, snapToStep, solveOnGrid };

const DEFAULT_MARGIN = { l: 66, r: 24, t: 28, b: 48 };
const DEFAULT_HEIGHT = 300;
// How far from a handle you may press and still grab it. Generous, because the same number
// has to work for a fingertip; the grab offset is what keeps a far-away press from jumping.
const HIT_RADIUS_PX = 34;
const MARKER_SIZE = 11;
const MARKER_SIZE_ACTIVE = 17;
const AXIS_PAD_FRACTION = 0.07;

const COLOR = {
    LINE: '#2a78d6',
    BASELINE: '#94a3b8',
    GUIDE: '#cbd5e1',
    LIMIT: '#d03b3b',
    MUTED: '#64748b',
    EDGE: '#0f172a',
};

function resolveElement(element) {
    if (typeof element === 'string') return document.getElementById(element);
    return element instanceof HTMLElement ? element : null;
}

const identity = (value) => value;

/* ══ The primitive ══════════════════════════════════════════════════════════════════════
 *
 * createDragOverlay({ container, graph, margin, grab, onChange })
 *
 * `container` is positioned and gets a transparent layer over `graph`. The caller keeps
 * drawing `graph` however it likes and, after every draw, calls setHandles() to say where the
 * grabbable points ended up.
 *
 * A handle is:
 *   { id, label, unit, axis: 'x'|'y', x, y, value, min, max, step, decimals,
 *     toValue(coord), toCoordinate(value), baseline, disabled }
 *
 * `x`/`y` are where it sits in DATA coordinates. `axis` is the one direction it may move.
 * `value` is the PARAMETER, which need not be the coordinate: on the ramp chart the
 * deceleration handle sits at (rise + hold + fall) but its value is just `fall`, and the two
 * conversion functions are what keep those apart.
 *
 * `grab` picks how a press finds a handle:
 *   'column' — distance along the fixed axis only, so the whole column (or row) is grabbable.
 *              Right when handles are far apart on that axis, and much kinder to a fingertip.
 *   'point'  — plain 2D distance. Needed when two handles share a coordinate, as the rise
 *              handles of the two ramp curves do (both sit at 100%).
 */
export function createDragOverlay(options = {}) {
    const container = resolveElement(options.container);
    const graph = resolveElement(options.graph);
    if (!container || !graph) return null;

    const margin = { ...DEFAULT_MARGIN, ...(options.margin || {}) };
    const hitRadius = Number.isFinite(options.hitRadiusPx) ? options.hitRadiusPx : HIT_RADIUS_PX;
    const grabMode = options.grab === 'point' ? 'point' : 'column';
    let onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

    container.classList.add('evd-editable-chart');
    const layer = document.createElement('div');
    layer.className = 'evd-editable-chart-layer';
    layer.tabIndex = 0;
    layer.setAttribute('role', 'application');
    const tip = document.createElement('div');
    tip.className = 'evd-editable-chart-tip';
    tip.style.display = 'none';
    container.append(layer, tip);

    let handles = [];
    let xRange = [0, 1];
    let yRange = [0, 1];
    let height = DEFAULT_HEIGHT;
    let activeId = null;
    let drag = null; // { id, pointerId, grabOffsetPx }
    let destroyed = false;

    const handleById = (id) => handles.find((handle) => handle.id === id) || null;

    // The plot rectangle inside the graph div — Plotly's own figure when it is available, the
    // caller's margins when it is not. See the file header.
    function plotArea() {
        const size = graph._fullLayout && graph._fullLayout._size;
        if (size && Number.isFinite(size.l) && Number.isFinite(size.t)
            && Number.isFinite(size.w) && Number.isFinite(size.h)
            && size.w > 0 && size.h > 0) {
            return { left: size.l, top: size.t, width: size.w, height: size.h };
        }
        const width = graph.clientWidth || container.clientWidth || 0;
        return {
            left: margin.l,
            top: margin.t,
            width: Math.max(1, width - margin.l - margin.r),
            height: Math.max(1, height - margin.t - margin.b),
        };
    }

    /*
     * The rectangle ONE handle lives in.
     *
     * Several of the preview charts are two panels side by side (Plotly x/y and x2/y2), and a
     * handle on the right panel must be measured against that panel's own range and its own
     * slice of the plot area. A handle therefore may carry `xRange`/`yRange` and the paper
     * domains its axes occupy; without them it falls back to the overlay-wide single panel,
     * which is what every ordinary chart uses.
     */
    function handleFrame(handle, area) {
        const xd = handle.xDomain || [0, 1];
        const yd = handle.yDomain || [0, 1];
        return {
            xRange: handle.xRange || xRange,
            yRange: handle.yRange || yRange,
            // Plotly's y domain is measured from the BOTTOM of the plot area; pixels are
            // measured from the top, hence the flip on `top`.
            left: area.left + xd[0] * area.width,
            width: Math.max(1, (xd[1] - xd[0]) * area.width),
            top: area.top + (1 - yd[1]) * area.height,
            height: Math.max(1, (yd[1] - yd[0]) * area.height),
        };
    }

    const dataToPixel = (handle, area) => {
        const frame = handleFrame(handle, area);
        return {
            x: indexToPixel(handle.x, frame.xRange, frame),
            y: valueToPixel(handle.y, frame.yRange, frame),
        };
    };

    function localPoint(event) {
        const rect = graph.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    /** Which handle a press at `point` grabs, or null. */
    function handleAt(point, area) {
        let best = null;
        let bestDistance = hitRadius;
        handles.forEach((handle) => {
            if (handle.disabled) return;
            const pixel = dataToPixel(handle, area);
            const dx = point.x - pixel.x;
            const dy = point.y - pixel.y;
            // 'column' ignores the distance along the direction the handle can travel: the
            // grab offset below is what stops that from teleporting anything.
            const distance = grabMode === 'point'
                ? Math.hypot(dx, dy)
                : Math.abs(handle.axis === 'y' ? dx : dy);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = handle;
            }
        });
        return best;
    }

    /** Where a handle's own axis currently puts it, in pixels. */
    const axisPixel = (handle, area) => {
        const pixel = dataToPixel(handle, area);
        return handle.axis === 'y' ? pixel.y : pixel.x;
    };

    /** A pixel on the handle's axis -> the parameter value it stands for. */
    function pixelToParameter(handle, pixel, area) {
        const frame = handleFrame(handle, area);
        const coordinate = handle.axis === 'y'
            ? pixelToValue(pixel, frame.yRange, frame)
            : frame.xRange[0]
                + ((pixel - frame.left) / frame.width) * (frame.xRange[1] - frame.xRange[0]);
        return (handle.toValue || identity)(coordinate);
    }

    function showTip(handle, area) {
        const decimals = Number.isFinite(handle.decimals)
            ? handle.decimals : decimalsForStep(handle.step);
        const unit = handle.unit ? ` ${handle.unit}` : '';
        const format = (value) => `${Number(value).toFixed(decimals)}${unit}`;
        const lines = [`${handle.label} — ${format(handle.value)}`];
        if (Number.isFinite(handle.baseline)) {
            lines.push(Math.abs(handle.baseline - handle.value) > 10 ** -(decimals + 3)
                ? `Controller: ${format(handle.baseline)} · Edited: ${format(handle.value)}`
                : `Controller: ${format(handle.baseline)} — unchanged`);
        }
        lines.push(`Allowed ${Number(handle.min).toFixed(decimals)}–${format(handle.max)}, step ${handle.step}`);

        tip.textContent = '';
        lines.forEach((text, position) => {
            const row = document.createElement('div');
            if (position === 0) row.className = 'evd-editable-chart-tip-head';
            row.textContent = text;
            tip.appendChild(row);
        });
        tip.style.display = '';
        const pixel = dataToPixel(handle, area);
        const width = tip.offsetWidth;
        const flip = pixel.x + 16 + width > graph.clientWidth;
        tip.style.left = `${Math.max(4, flip ? pixel.x - 16 - width : pixel.x + 16)}px`;
        tip.style.top = `${Math.max(4, pixel.y - tip.offsetHeight - 12)}px`;
    }

    const hideTip = () => { tip.style.display = 'none'; };

    function applyValue(handle, raw, committed) {
        const next = snapToStep(raw, handle);
        const changed = next !== handle.value;
        if (changed) handle.value = next;
        if (changed || committed) onChange(handle.id, next, { committed, handle });
        return changed;
    }

    function nudge(handle, direction, multiplier) {
        const stride = (Number.isFinite(handle.step) && handle.step > 0 ? handle.step : 1) * multiplier;
        applyValue(handle, handle.value + direction * stride, true);
    }

    // ── pointer ─────────────────────────────────────────────────────────────
    // Pointer Events cover mouse, touch and pen in one code path, and pointer capture keeps a
    // drag alive when the finger leaves the chart — which it will, because the useful part of
    // a drag is often past the edge of the plot.
    layer.addEventListener('pointerdown', (event) => {
        if (!handles.length) return;
        const area = plotArea();
        const point = localPoint(event);
        const handle = handleAt(point, area);
        if (!handle) return;
        event.preventDefault();
        layer.focus({ preventScroll: true });
        // Remember where on the handle it was grabbed, so pressing 40 px away does not
        // teleport it to the finger. Pressing on the handle itself gives an offset of ~0.
        drag = {
            id: handle.id,
            pointerId: event.pointerId,
            grabOffsetPx: (handle.axis === 'y' ? point.y : point.x) - axisPixel(handle, area),
        };
        activeId = handle.id;
        layer.classList.add('is-dragging');
        // Capture can be refused (a pointer the browser no longer considers active). The drag
        // still works while the pointer is over the layer, so this is not worth failing on.
        try { layer.setPointerCapture(event.pointerId); } catch { /* best effort */ }
        onChange(handle.id, handle.value, { committed: false, handle, activated: true });
        showTip(handle, area);
    });

    layer.addEventListener('pointermove', (event) => {
        const area = plotArea();
        const point = localPoint(event);
        if (drag && drag.pointerId === event.pointerId) {
            // A button released off-window never delivers its pointerup. Without this the
            // overlay would stay latched in "dragging" for good, and the caller would go on
            // refusing outside updates because it believes a finger is still down.
            if (event.buttons === 0) { finishDrag(event.pointerId); return; }
            event.preventDefault();
            const handle = handleById(drag.id);
            if (!handle) return;
            const pixel = (handle.axis === 'y' ? point.y : point.x) - drag.grabOffsetPx;
            applyValue(handle, pixelToParameter(handle, pixel, area), false);
            showTip(handle, area);
            return;
        }
        const handle = handleAt(point, area);
        layer.style.cursor = handle ? (handle.axis === 'y' ? 'ns-resize' : 'ew-resize') : 'default';
        if (handle) showTip(handle, area); else hideTip();
    });

    function finishDrag(pointerId) {
        if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
        const handle = handleById(drag.id);
        const id = drag.id;
        drag = null;
        layer.classList.remove('is-dragging');
        if (pointerId !== undefined && layer.hasPointerCapture?.(pointerId)) {
            layer.releasePointerCapture(pointerId);
        }
        // Report the settled value even when the last frame did not move it, so the caller
        // gets exactly one committed edit per drag.
        if (handle) onChange(id, handle.value, { committed: true, handle });
    }

    layer.addEventListener('pointerup', (event) => finishDrag(event.pointerId));
    layer.addEventListener('pointercancel', (event) => finishDrag(event.pointerId));
    // The browser can take a capture away (a context menu, a scroll gesture, focus loss).
    // Ending the drag here is what stops the overlay from latching.
    layer.addEventListener('lostpointercapture', (event) => finishDrag(event.pointerId));
    layer.addEventListener('pointerleave', () => { if (!drag) hideTip(); });

    // ── keyboard ────────────────────────────────────────────────────────────
    layer.addEventListener('keydown', (event) => {
        if (!handles.length) return;
        const usable = handles.filter((handle) => !handle.disabled);
        if (!usable.length) return;
        let position = usable.findIndex((handle) => handle.id === activeId);
        if (position < 0) position = 0;
        const handle = usable[position];
        const stride = event.shiftKey ? 10 : 1;
        // Up/right raise the value whichever way the handle travels, so the key that means
        // "more" is the same key on every chart.
        let handled = true;
        switch (event.key) {
            case 'ArrowUp': nudge(handle, 1, stride); break;
            case 'ArrowDown': nudge(handle, -1, stride); break;
            case 'PageUp': nudge(handle, 1, 10); break;
            case 'PageDown': nudge(handle, -1, 10); break;
            case 'Home': applyValue(handle, handle.min, true); break;
            case 'End': applyValue(handle, handle.max, true); break;
            case 'ArrowRight':
                if (handle.axis === 'x') { nudge(handle, 1, stride); break; }
                activeId = usable[Math.min(usable.length - 1, position + 1)].id;
                onChange(activeId, handleById(activeId)?.value, { committed: false, activated: true });
                break;
            case 'ArrowLeft':
                if (handle.axis === 'x') { nudge(handle, -1, stride); break; }
                activeId = usable[Math.max(0, position - 1)].id;
                onChange(activeId, handleById(activeId)?.value, { committed: false, activated: true });
                break;
            case 'Tab':
                handled = false;
                break;
            default: handled = false;
        }
        if (handled) event.preventDefault();
    });
    layer.addEventListener('blur', hideTip);

    return {
        /** Tell the overlay where the handles ended up after the owner redrew the plot. */
        setHandles(next = {}) {
            if (destroyed) return;
            if (Array.isArray(next.handles)) {
                handles = next.handles.map((handle) => ({
                    toValue: identity,
                    toCoordinate: identity,
                    axis: 'y',
                    ...handle,
                    decimals: Number.isFinite(handle.decimals)
                        ? handle.decimals : decimalsForStep(handle.step),
                }));
            }
            if (Array.isArray(next.xRange)) xRange = next.xRange;
            if (Array.isArray(next.yRange)) yRange = next.yRange;
            if (Number.isFinite(next.height)) height = next.height;
            // Only used by the geometry fallback, but charts in this app do not all share one
            // margin, so it has to be updatable rather than fixed when the overlay is built.
            if (next.margin) Object.assign(margin, next.margin);
            if (next.activeId !== undefined) activeId = next.activeId;
            if (activeId === null && handles.length) activeId = handles[0].id;
            layer.setAttribute('aria-label', next.description
                || 'Editable chart. Drag a point, or use the arrow keys to change the value.');
        },
        setActive(id) { activeId = id; },
        activeHandleId: () => activeId,
        isDragging: () => !!drag,
        setOnChange(callback) { if (typeof callback === 'function') onChange = callback; },
        destroy() {
            destroyed = true;
            layer.remove();
            tip.remove();
            container.classList.remove('evd-editable-chart');
        },
    };
}

/* ══ Hosting an editable chart ══════════════════════════════════════════════════════════
 *
 * Everything below is what a card needs to turn a chart it already draws into an editor. It
 * is here rather than in any one card because four different screens use it — the profile
 * level curve, the six engine-preview charts, the two engine curves and the Limits limp
 * chart — and drag logic copied four times is drag logic that will disagree with itself.
 */

const chartHosts = new Map();

/**
 * A container's inner graph div, plus a slot for its overlay.
 *
 * Plotly owns the element it draws into, so an overlay cannot be a child of it: the graph gets
 * an inner div and the overlay becomes its sibling. Several of these containers are rebuilt
 * by their card on every render, so a host is discarded whenever its container is replaced.
 */
export function chartHost(containerId) {
    const container = el(containerId);
    if (!container) return null;
    let host = chartHosts.get(containerId);
    if (!host || host.container !== container || host.graph.parentElement !== container) {
        host?.overlay?.destroy();
        container.innerHTML = '';
        const graph = document.createElement('div');
        container.appendChild(graph);
        host = { id: containerId, container, graph, overlay: null, axis: new Map() };
        chartHosts.set(containerId, host);
    }
    return host;
}

/**
 * An axis end that does not move under the pointer.
 *
 * Charts routinely size an axis from the very values being dragged. Left alone that is a
 * feedback loop: dragging right lengthens the curve, which widens the axis, which makes the
 * same pixel stand for more, which lengthens the curve again — measured at 670 ms of travel
 * for a 400 ms drag before this existed. So the end is quantized to `quantum` (coarse enough
 * that ordinary edits never move it at all) and frozen outright while a drag is in progress.
 */
export function frozenAxis(host, key, natural, quantum) {
    const snapped = Math.max(quantum, Math.ceil(natural / quantum) * quantum);
    if (!host || !host.axis) return snapped;
    if (!host.overlay?.isDragging() || !host.axis.has(key)) host.axis.set(key, snapped);
    return host.axis.get(key);
}

/** Chart geometry falls back to the layout margins, so `automargin` must stay off. */
export const pinned = (axis, range) => ({ ...axis, range, fixedrange: true, automargin: false });

export const descriptorOf = (edit, key) =>
    edit?.descriptors?.find((field) => field.key === key) || null;

// Field labels carry their firmware breakpoints and their "0 = off" notes, which belong in the
// field grid and are far too long for a chart. Keep the part before the first dash or bracket.
export const shortLabel = (label) => String(label || '').split(' — ')[0].split(' (')[0];

// A descriptor's fromNative may return a formatted string (the kg fields do). Charts need
// numbers.
export function toDisplayValue(descriptor, native) {
    if (native === undefined || native === null) return undefined;
    const raw = descriptor?.fromNative ? descriptor.fromNative(native) : native;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * One draggable handle, described by the project's OWN field descriptor.
 *
 * The range, the step, the unit and the label all come from the same descriptor the number box
 * is built from, and the handle works in the same display units. That is what stops a chart
 * from allowing a value the box would refuse, or from rounding one differently.
 *
 * `extra` says where it sits: { axis, x, y, value, xRange, yRange, xDomain, yDomain, … }.
 */
export function fieldHandle(edit, key, extra = {}) {
    const descriptor = descriptorOf(edit, key);
    if (!descriptor) return null;
    const step = descriptor.step ?? 1;
    return {
        id: key,
        label: extra.label || shortLabel(descriptor.label),
        unit: descriptor.unit || '',
        min: Number(descriptor.min),
        max: Number(descriptor.max),
        step,
        decimals: decimalsForStep(step),
        baseline: edit?.baselineLevel
            ? toDisplayValue(descriptor, edit.baselineLevel[key]) : undefined,
        disabled: !edit?.onEdit || !!extra.disabled,
        ...extra,
    };
}

/*
 * The handles, drawn. Nobody can be expected to guess that a corner of a line or the end of a
 * dotted rule is draggable, so they always get a marker of their own.
 *
 * Grouped by which pair of Plotly axes they sit on, because the two-panel charts put some
 * handles on x2/y2 and one trace cannot span both. Only the first group carries a legend
 * entry, so a two-panel chart does not list "Drag these" twice.
 */
export function handleTraces(handles, name) {
    const live = handles.filter((handle) => handle && !handle.disabled);
    if (!live.length) return [];
    const groups = new Map();
    live.forEach((handle) => {
        const key = `${handle.plotX || 'x'}|${handle.plotY || 'y'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(handle);
    });
    return [...groups.entries()].map(([key, items], index) => {
        const [xaxis, yaxis] = key.split('|');
        return {
            x: items.map((handle) => handle.x),
            y: items.map((handle) => handle.y),
            xaxis,
            yaxis,
            name,
            legendgroup: 'evd-handles',
            showlegend: index === 0,
            type: 'scatter',
            mode: 'markers',
            marker: {
                size: 13,
                symbol: 'circle',
                color: items.map((handle) => handle.color || COLOR.LINE),
                line: { width: 2, color: '#ffffff' },
            },
            hoverinfo: 'skip',
        };
    });
}

// One redraw per animation frame. Plotly cannot keep up with one per pointermove, and the
// queued frames are exactly what makes a drag feel like it is fighting back. A single slot is
// enough because only one handle can be dragged at a time.
let editFramePending = 0;
export function scheduleChartRender(render) {
    if (editFramePending) return;
    const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    editFramePending = raf(() => { editFramePending = 0; render(); });
}

/**
 * The write path shared by every editable chart: display value -> stored value -> report it.
 * NEVER touches the socket — that is the card's Write button, and only the Write button.
 */
export function handleEditor(target, edit, rerender) {
    return (key, value, meta) => {
        if (meta.activated || !target) return;
        const descriptor = descriptorOf(edit, key);
        const stored = descriptor?.toNative ? descriptor.toNative(value) : value;
        target[key] = stored;
        edit?.onEdit?.(key, stored, { committed: meta.committed });
        scheduleChartRender(rerender);
    };
}

/**
 * drawEditable(containerId, traces, layout, editable)
 *
 * `editable` is optional: { handles, xRange, yRange, grab, description, onChange }.
 * With no handles the chart is drawn as an ordinary read-only plot and any overlay is removed.
 */
export function drawEditable(containerId, traces, layout, editable) {
    if (typeof Plotly === 'undefined') return;
    const host = chartHost(containerId);
    if (!host) return;
    const handles = (editable?.handles || []).filter(Boolean);
    const live = handles.some((handle) => !handle.disabled)
        && typeof editable.onChange === 'function';

    Plotly.react(host.graph, traces, layout, {
        // The overlay owns the pointer on an editable chart; Plotly's own drag rect and hover
        // layer underneath would only be something to fight with.
        staticPlot: live,
        displayModeBar: false,
        displaylogo: false,
        responsive: !live,
    });

    if (!live) {
        host.overlay?.destroy();
        host.overlay = null;
        return;
    }
    if (!host.overlay) {
        host.overlay = createDragOverlay({
            container: host.container,
            graph: host.graph,
            margin: layout.margin,
            grab: editable.grab || 'point',
            onChange: (...args) => host.onChange?.(...args),
        });
    }
    // Kept in a slot rather than rebound, so the overlay always calls the freshest closure
    // without being torn down and rebuilt on every render.
    host.onChange = editable.onChange;
    host.overlay.setHandles({
        handles,
        xRange: editable.xRange,
        yRange: editable.yRange,
        margin: layout.margin,
        height: layout.height,
        description: editable.description,
    });
}

/* ══ The common case ════════════════════════════════════════════════════════════════════
 *
 * createEditableParameterChart({ element, labels, values, min, max, step, onChange })
 *
 * One value per category, dragged up and down — five assist levels and one setting. Values are
 * in DISPLAY units, whatever the number box shows: the caller owns the conversion to and from
 * what the controller stores, so the chart and the box can never quantize a value differently.
 *
 * onChange(index, value, { committed }) fires on every frame of a drag with committed=false,
 * and once more with committed=true when the pointer is released. Use the cheap path to keep
 * the number box in step and the committed one for anything expensive.
 */
export function createEditableParameterChart(config = {}) {
    const container = resolveElement(config.element);
    if (!container || typeof Plotly === 'undefined') return null;

    container.classList.add('evd-editable-chart');
    const graph = document.createElement('div');
    container.innerHTML = '';
    container.appendChild(graph);

    const model = {
        labels: [],
        values: [],
        baseline: null,
        colors: [],
        min: 0,
        max: 100,
        step: 1,
        decimals: 0,
        unit: '',
        xTitle: '',
        yTitle: '',
        valueLabel: '',
        baselineLabel: 'As read from the controller',
        height: DEFAULT_HEIGHT,
        activeIndex: 0,
        disabled: false,
    };
    let onChange = typeof config.onChange === 'function' ? config.onChange : () => {};
    let framePending = 0;
    let destroyed = false;

    const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    const cancelRaf = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame : clearTimeout;

    const yRange = () => paddedRange(model.min, model.max, AXIS_PAD_FRACTION);
    const xRange = () => categoryRange(model.values.length);

    const overlay = createDragOverlay({
        container,
        graph,
        margin: DEFAULT_MARGIN,
        grab: 'column',
        onChange: (id, value, meta) => {
            const index = Number(id);
            if (!Number.isFinite(index)) return;
            model.activeIndex = index;
            if (model.values[index] !== value) {
                model.values[index] = value;
                scheduleRedraw();
            } else if (meta.activated) {
                scheduleRedraw();
            }
            if (!meta.activated || meta.committed) onChange(index, value, meta);
        },
    });

    const formatValue = (value) => Number(value).toFixed(model.decimals);
    const withUnit = (value) => `${formatValue(value)}${model.unit ? ` ${model.unit}` : ''}`;
    const isModified = (index) => !!model.baseline
        && Number.isFinite(model.baseline[index])
        && Math.abs(model.baseline[index] - model.values[index]) > 10 ** -(model.decimals + 3);

    function buildTraces() {
        const x = model.values.map((_, index) => index);
        const traces = [];
        if (model.baseline) {
            traces.push({
                x,
                y: model.baseline.slice(),
                name: model.baselineLabel,
                type: 'scatter',
                mode: 'lines+markers',
                line: { color: COLOR.BASELINE, width: 2, dash: 'dash' },
                marker: { color: COLOR.BASELINE, size: 7, symbol: 'circle-open' },
                hoverinfo: 'skip',
            });
        }
        traces.push({
            x,
            y: model.values.slice(),
            name: model.valueLabel || 'On screen',
            type: 'scatter',
            mode: 'lines+markers',
            line: { color: COLOR.LINE, width: 3 },
            marker: {
                size: model.values.map((_, index) =>
                    (index === model.activeIndex ? MARKER_SIZE_ACTIVE : MARKER_SIZE)),
                color: model.values.map((_, index) => model.colors[index] || COLOR.LINE),
                // A changed point gets a dark ring. The dashed baseline already shows where it
                // came from; the ring is what makes it findable at a glance.
                line: {
                    width: model.values.map((_, index) => (isModified(index) ? 3 : 1)),
                    color: model.values.map((_, index) =>
                        (isModified(index) ? COLOR.EDGE : '#ffffff')),
                },
            },
            hoverinfo: 'skip',
        });
        return traces;
    }

    function buildLayout() {
        const layout = plotLayout(model.xTitle, model.yTitle);
        layout.height = model.height;
        layout.margin = { ...DEFAULT_MARGIN };
        layout.hovermode = false;
        layout.showlegend = !!model.baseline;
        layout.legend = { orientation: 'h', y: 1.02, yanchor: 'bottom', font: { size: 10 } };
        layout.xaxis = {
            ...layout.xaxis,
            range: xRange(),
            fixedrange: true,
            automargin: false, // the geometry fallback depends on the margins staying put
            tickmode: 'array',
            tickvals: model.values.map((_, index) => index),
            ticktext: model.labels.slice(),
            zeroline: false,
        };
        layout.yaxis = {
            ...layout.yaxis, range: yRange(), fixedrange: true, automargin: false,
            rangemode: 'normal',
        };
        // The allowed range, drawn. Someone who drags a point to the ceiling should be able to
        // see that it IS the ceiling and not just where the drag happened to stop.
        layout.shapes = [model.max, model.min].map((edge) => ({
            type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: edge, y1: edge,
            line: { color: COLOR.LIMIT, width: 1, dash: 'dot' },
        }));
        layout.annotations = [
            {
                xref: 'paper', x: 1, xanchor: 'right', yref: 'y', y: model.max, yanchor: 'bottom',
                text: `max ${withUnit(model.max)}`,
                showarrow: false, font: { color: COLOR.LIMIT, size: 10 },
            },
            {
                xref: 'paper', x: 1, xanchor: 'right', yref: 'y', y: model.min, yanchor: 'top',
                text: `min ${withUnit(model.min)}`,
                showarrow: false, font: { color: COLOR.LIMIT, size: 10 },
            },
        ];
        if (model.activeIndex >= 0 && model.activeIndex < model.values.length) {
            layout.shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: model.activeIndex, x1: model.activeIndex, y0: 0, y1: 1,
                line: { color: COLOR.GUIDE, width: 1, dash: 'dot' },
            });
        }
        // Values printed on the points: this is a settings editor, not an exploratory plot, so
        // the exact number has to be readable without hovering anything.
        model.values.forEach((value, index) => {
            layout.annotations.push({
                xref: 'x', x: index, yref: 'y', y: value, yanchor: 'bottom', yshift: 12,
                text: formatValue(value),
                showarrow: false,
                font: {
                    size: index === model.activeIndex ? 12 : 11,
                    color: isModified(index) ? COLOR.EDGE : COLOR.MUTED,
                },
            });
        });
        return layout;
    }

    function publishHandles() {
        overlay?.setHandles({
            handles: model.values.map((value, index) => ({
                id: index,
                label: model.labels[index] ?? `#${index + 1}`,
                axis: 'y',
                x: index,
                y: value,
                value,
                min: model.min,
                max: model.max,
                step: model.step,
                decimals: model.decimals,
                unit: model.unit,
                baseline: model.baseline?.[index],
                disabled: model.disabled,
            })),
            xRange: xRange(),
            yRange: yRange(),
            height: model.height,
            activeId: model.activeIndex,
            description: `${model.yTitle || 'Parameter'} per ${model.xTitle || 'entry'}. `
                + 'Drag a point, or use the arrow keys to move between points and change the value.',
        });
    }

    // Five points and a dozen annotations redraw fast enough that a full react per animation
    // frame is the right trade: restyle would be cheaper but would leave the value labels and
    // the modified rings a frame behind the line they belong to.
    function redraw() {
        if (destroyed) return;
        Plotly.react(graph, buildTraces(), buildLayout(), {
            // No Plotly interaction at all: the overlay owns the pointer, and a Plotly drag
            // rect or hover layer underneath would only be something to fight with.
            staticPlot: true,
            displayModeBar: false,
            responsive: false,
        });
        publishHandles();
    }

    function scheduleRedraw() {
        if (framePending) return;
        framePending = raf(() => { framePending = 0; redraw(); });
    }

    let observer = null;
    let lastWidth = 0;
    if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => {
            // Width only. The height is fixed by the layout, and reacting to the height change
            // that Plotly's own resize causes is how a ResizeObserver loop starts.
            const width = graph.clientWidth;
            if (destroyed || !width || width === lastWidth) return;
            lastWidth = width;
            Plotly.Plots.resize(graph).then(publishHandles);
        });
        observer.observe(container);
    }

    function update(next = {}) {
        // A CAN frame arriving mid-drag must not yank the point out from under the finger.
        // Everything else (labels, colours, the active index) may still change.
        const dragging = !!overlay?.isDragging();
        const frozen = new Set(['values', 'min', 'max', 'step', 'decimals']);
        Object.entries(next).forEach(([key, value]) => {
            if (value === undefined || key === 'onChange') return;
            if (dragging && frozen.has(key)) return;
            if (key in model) model[key] = value;
        });
        if (typeof next.onChange === 'function') onChange = next.onChange;
        if (!dragging) {
            if (next.step !== undefined && next.decimals === undefined) {
                model.decimals = decimalsForStep(model.step);
            }
            if (Array.isArray(next.values)) {
                model.values = next.values.map((value) => snapToStep(value, model));
            }
        }
        model.activeIndex = Math.min(Math.max(0, model.activeIndex),
            Math.max(0, model.values.length - 1));
        redraw();
    }

    update(config);
    return {
        update,
        setActive(index) {
            if (!Number.isFinite(index) || index === model.activeIndex) return;
            model.activeIndex = Math.min(Math.max(0, index), Math.max(0, model.values.length - 1));
            scheduleRedraw();
        },
        getValues: () => model.values.slice(),
        isDragging: () => !!overlay?.isDragging(),
        destroy() {
            destroyed = true;
            if (framePending) cancelRaf(framePending);
            observer?.disconnect();
            overlay?.destroy();
            Plotly.purge(graph);
            container.innerHTML = '';
            container.classList.remove('evd-editable-chart');
        },
    };
}
