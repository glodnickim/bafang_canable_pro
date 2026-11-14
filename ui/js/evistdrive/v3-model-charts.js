// evistdrive/v3-model-charts.js — plain-canvas line charts for the "Tryby V3" panel.
// No library and no network: the panel redraws on every slider move, so the charts stay cheap.

const PALETTE = {
    axis: '#94a3b8', grid: '#e2e8f0', text: '#334155', muted: '#64748b',
};

function setupCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 360;
    const height = canvas.clientHeight || 220;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
}

const niceStep = (span, target) => {
    const raw = span / target;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
};
const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1).replace('.', ','));

/**
 * spec: { xLabel, yLabel, xMax, yMax, yUnit, series: [{ label, color, points: [[x,y]...], dash, width }],
 *         vlines: [{ x, label, color }], hlines: [{ y, label, color }], bands: [{ y0, y1, color, label }] }
 */
export function drawLineChart(canvas, spec) {
    if (!canvas || !canvas.getContext) return;
    const { ctx, width, height } = setupCanvas(canvas);
    const pad = { left: 44, right: 12, top: 10, bottom: 34 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const xMax = spec.xMax || 1;
    const yMax = spec.yMax || 1;
    const X = (x) => pad.left + (Math.min(Math.max(x, 0), xMax) / xMax) * w;
    const Y = (y) => pad.top + h - (Math.min(Math.max(y, 0), yMax) / yMax) * h;
    ctx.font = '11px system-ui, sans-serif';

    (spec.bands || []).forEach((band) => {
        ctx.fillStyle = band.color;
        ctx.fillRect(pad.left, Y(band.y1), w, Y(band.y0) - Y(band.y1));
        if (band.label) { ctx.fillStyle = PALETTE.muted; ctx.textAlign = 'right'; ctx.fillText(band.label, pad.left + w - 4, Y(band.y1) + 12); }
    });

    // grid and axes
    ctx.strokeStyle = PALETTE.grid; ctx.lineWidth = 1; ctx.fillStyle = PALETTE.muted;
    const xs = niceStep(xMax, 6);
    ctx.textAlign = 'center';
    for (let x = 0; x <= xMax + 1e-9; x += xs) {
        ctx.beginPath(); ctx.moveTo(X(x), pad.top); ctx.lineTo(X(x), pad.top + h); ctx.stroke();
        ctx.fillText(fmt(x), X(x), pad.top + h + 13);
    }
    const ys = niceStep(yMax, 5);
    ctx.textAlign = 'right';
    for (let y = 0; y <= yMax + 1e-9; y += ys) {
        ctx.beginPath(); ctx.moveTo(pad.left, Y(y)); ctx.lineTo(pad.left + w, Y(y)); ctx.stroke();
        ctx.fillText(`${fmt(y)}${spec.yUnit || ''}`, pad.left - 4, Y(y) + 4);
    }
    ctx.strokeStyle = PALETTE.axis;
    ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + h); ctx.lineTo(pad.left + w, pad.top + h); ctx.stroke();
    ctx.fillStyle = PALETTE.text; ctx.textAlign = 'center';
    ctx.fillText(spec.xLabel || '', pad.left + w / 2, height - 6);
    ctx.save(); ctx.translate(11, pad.top + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.yLabel || '', 0, 0); ctx.restore();

    const dashed = (dash) => ctx.setLineDash(dash ? [5, 4] : []);
    (spec.hlines || []).forEach((line) => {
        ctx.strokeStyle = line.color || PALETTE.muted; dashed(true);
        ctx.beginPath(); ctx.moveTo(pad.left, Y(line.y)); ctx.lineTo(pad.left + w, Y(line.y)); ctx.stroke();
        if (line.label) { ctx.fillStyle = line.color || PALETTE.muted; ctx.textAlign = 'left'; ctx.fillText(line.label, pad.left + 4, Y(line.y) - 3); }
    });
    (spec.vlines || []).forEach((line) => {
        ctx.strokeStyle = line.color || PALETTE.muted; dashed(true);
        ctx.beginPath(); ctx.moveTo(X(line.x), pad.top); ctx.lineTo(X(line.x), pad.top + h); ctx.stroke();
        if (line.label) { ctx.fillStyle = line.color || PALETTE.muted; ctx.textAlign = 'left'; ctx.fillText(line.label, X(line.x) + 3, pad.top + 11); }
    });
    dashed(false);

    (spec.series || []).forEach((s) => {
        if (!s.points?.length) return;
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; dashed(s.dash);
        ctx.beginPath();
        s.points.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
        ctx.stroke();
    });
    dashed(false); ctx.lineWidth = 1;

    // legend (top-left, inside the plot)
    let ly = pad.top + 14;
    ctx.textAlign = 'left';
    (spec.series || []).filter((s) => s.label).forEach((s) => {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; dashed(s.dash);
        ctx.beginPath(); ctx.moveTo(pad.left + 8, ly - 4); ctx.lineTo(pad.left + 26, ly - 4); ctx.stroke();
        dashed(false); ctx.lineWidth = 1;
        ctx.fillStyle = PALETTE.text; ctx.fillText(s.label, pad.left + 30, ly);
        ly += 14;
    });
}

/** Sample f over [0, xMax] in n steps -> [[x, f(x)]...]. */
export function sample(f, xMax, n = 120) {
    return Array.from({ length: n + 1 }, (_, i) => { const x = (xMax * i) / n; return [x, f(x)]; });
}
