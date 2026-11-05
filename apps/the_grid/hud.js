'use strict';
/**
 * hud.js - The Grid's own drawing language: a holographic HUD over a light-grid floor.
 *
 * Pure functions over the kit's drawing surface (kit/runtime/record.js on the GPU renderer,
 * canvas.js in software), built only from what the car's renderer draws: lines, arcs, quads,
 * rounded rects, gradients and text. Colours come from the theme (kit/runtime/themes.js):
 * t.accent is the identity colour (Sam cyan, Flynn white, Rinzler orange, Ares red).
 *
 * Fonts (kit/runtime/fonts/grid*.json, OFL): gridhead (Orbitron, titles), gridnum (Orbitron,
 * numbers; the large sizes carry digits only), gridlbl (Rajdhani, labels), gridmono (Share
 * Tech Mono, system text).
 *
 * Angles are degrees, 0 = up, clockwise (as cv.arc).
 */
const G = require('./kit/gauges');

const W = 1600;
const RAD = Math.PI / 180;
const A = (c, a) => G.withAlpha(c, a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const now = () => Date.now();
const F = { head: 'gridhead', num: 'gridnum', lbl: 'gridlbl', mono: 'gridmono' };

/* ---------- boot: every page draws itself in when it opens ---------- */
let bootAt = now();
/** Start the draw-in again (app start, page change). */
function reboot() { bootAt = now(); }
/** 0..1 (eased) for an element that starts `delay` ms into the draw-in and takes `dur` ms. */
function boot(delay, dur) { return ease((now() - bootAt - (delay || 0)) / (dur || 500)); }

/* ---------- small pieces ---------- */
const pol = (cx, cy, r, a) => [cx + Math.sin(a * RAD) * r, cy - Math.cos(a * RAD) * r];

function radial(cv, cx, cy, r0, r1, a, width, c) {
    const p = pol(cx, cy, r0, a), q = pol(cx, cy, r1, a);
    cv.line(p[0], p[1], q[0], q[1], width, c);
}

/** Upper-case system text (Share Tech Mono) with wide tracking. */
function mono(cv, s, x, y, size, c, align) {
    return cv.text(String(s).toUpperCase(), x, y, size || 16, c, { font: F.mono, align: align || 'left', spacing: 2, literal: true });
}
/** Label text (Rajdhani). */
function lbl(cv, s, x, y, size, c, align, spacing) {
    return cv.text(String(s).toUpperCase(), x, y, size || 20, c, { font: F.lbl, align: align || 'left', spacing: spacing == null ? 2 : spacing, literal: true });
}
/** Title text (Orbitron). */
function head(cv, s, x, y, size, c, align, spacing) {
    return cv.text(String(s).toUpperCase(), x, y, size || 20, c, { font: F.head, align: align || 'left', spacing: spacing == null ? 3 : spacing, literal: true });
}
/** Numbers (Orbitron); `glow` draws a soft halo in that colour behind them. */
function num(cv, s, x, y, size, c, align, glow) {
    const o = { font: F.num, align: align || 'left', literal: true, spacing: size > 60 ? 2 : 1 };
    if (glow) {
        const g = A(glow, 0.16), d = Math.max(1.5, size / 60);
        cv.text(s, x - d, y, size, g, o); cv.text(s, x + d, y, size, g, o);
        cv.text(s, x, y - d, size, g, o); cv.text(s, x, y + d, size, g, o);
    }
    return cv.text(s, x, y, size, c, o);
}

/** Four L-shaped corner brackets around a box. */
function brackets(cv, x, y, w, h, len, width, c) {
    const l = Math.min(len, w / 2, h / 2), s = width || 2;
    cv.fillRect(x, y, l, s, c); cv.fillRect(x, y, s, l, c);
    cv.fillRect(x + w - l, y, l, s, c); cv.fillRect(x + w - s, y, s, l, c);
    cv.fillRect(x, y + h - s, l, s, c); cv.fillRect(x, y + h - l, s, l, c);
    cv.fillRect(x + w - l, y + h - s, l, s, c); cv.fillRect(x + w - s, y + h - l, s, l, c);
}

/** A glowing horizontal light line (a light-cycle trail): bright core, soft halo. */
function lightLine(cv, x, y, w, c, core) {
    cv.fillRect(x, y - 4, w, 8, A(c, 0.06));
    cv.fillRect(x, y - 2, w, 4, A(c, 0.14));
    cv.fillRect(x, y - 0.75, w, 1.5, core || c);
}

/**
 * Segmented arc: n segments over a0..a1, the first `lit` (fractional) of them lit.
 * col(i, f) gives a lit segment's colour (f = its position 0..1), dim the unlit colour.
 */
function segArc(cv, cx, cy, r0, r1, a0, a1, n, gap, lit, col, dim) {
    const step = (a1 - a0) / n;
    for (let i = 0; i < n; i++) {
        const s = a0 + i * step + gap / 2, e = a0 + (i + 1) * step - gap / 2;
        const part = clamp(lit - i, 0, 1);
        if (part >= 1) cv.arc(cx, cy, r0, r1, s, e, col(i, i / Math.max(1, n - 1)));
        else {
            cv.arc(cx, cy, r0, r1, s, e, dim);
            if (part > 0) cv.arc(cx, cy, r0, r1, s, s + (e - s) * part, col(i, i / Math.max(1, n - 1)));
        }
    }
}

/** n ticks from r0 to r1 over a0..a1, every `major`-th one long and bright. */
function ticks(cv, cx, cy, r0, r1, a0, a1, n, c, opts) {
    const o = opts || {};
    for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * i / n, maj = o.major && i % o.major === 0;
        radial(cv, cx, cy, maj ? r0 - (o.majorLen || 8) : r0, r1, a, maj ? (o.majorW || 2.5) : (o.w || 1.2), maj ? (o.majorC || c) : c);
    }
}

/** Rotating arc segments on one ring: segs = [[start, length], ...] in degrees, turned by rot. */
function spinner(cv, cx, cy, r0, r1, rot, segs, c) {
    segs.forEach((s) => cv.arc(cx, cy, r0, r1, rot + s[0], rot + s[0] + s[1], c));
}

/** Filled triangle (a quad with a doubled corner). */
function tri(cv, a, b, c, col) { cv.quad([a, b, c, c], col); }

/** A chevron pointing at angle a toward the centre, its tip at radius r. */
function pointer(cv, cx, cy, r, a, size, c) {
    const tip = pol(cx, cy, r, a), l = pol(cx, cy, r + size * 1.4, a - size * 0.35), rr = pol(cx, cy, r + size * 1.4, a + size * 0.35);
    tri(cv, tip, l, rr, c);
}

/**
 * Horizontal bar of n slanted segments (parallelograms), the first frac*n lit.
 * col(f) gives a lit segment's colour by its position.
 */
function segBar(cv, x, y, w, h, n, frac, col, dim, skew) {
    const gap = 3, sw = (w - gap * (n - 1)) / n, k = skew == null ? h * 0.45 : skew, lit = clamp(frac || 0, 0, 1) * n;
    for (let i = 0; i < n; i++) {
        const x0 = x + i * (sw + gap), part = clamp(lit - i, 0, 1);
        const c = part > 0 ? A(col(i / Math.max(1, n - 1)), 0.25 + 0.75 * part) : dim;
        cv.quad([[x0 + k, y], [x0 + sw + k, y], [x0 + sw, y + h], [x0, y + h]], c);
    }
}

/** A trace of the last values (sparkline) with a faint fill under it. */
function trace(cv, x, y, w, h, vals, lo, hi, c) {
    const pts = [];
    const n = vals.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (!G.isNum(v)) { if (pts.length > 1) { cv.fillUnder(pts, y + h, A(c, 0.08)); cv.polyline(pts, 1.5, A(c, 0.8)); } pts.length = 0; continue; }
        pts.push([x + w * i / (n - 1), y + h - h * clamp((v - lo) / Math.max(1e-6, hi - lo), 0, 1)]);
    }
    if (pts.length > 1) { cv.fillUnder(pts, y + h, A(c, 0.08)); cv.polyline(pts, 1.5, A(c, 0.8)); }
}

/* ---------- neon: a bright core with a soft halo ---------- */
/** A neon polyline: halo passes under a hot core. */
function neon(cv, pts, w, c, glow) {
    const g = glow == null ? 1 : glow;
    if (g > 0) { cv.polyline(pts, w * 6, A(c, 0.05 * g)); cv.polyline(pts, w * 3, A(c, 0.12 * g)); }
    cv.polyline(pts, w, c);
    if (w >= 2.5) cv.polyline(pts, Math.max(1, w * 0.35), A('#ffffff', 0.55));
}
/** A neon ring segment at radius r (degrees a0..a1). */
function neonArc(cv, cx, cy, r, w, a0, a1, c, glow) {
    const g = glow == null ? 1 : glow;
    if (g > 0) { cv.arc(cx, cy, r - w * 3, r + w * 3, a0, a1, A(c, 0.05 * g)); cv.arc(cx, cy, r - w * 1.5, r + w * 1.5, a0, a1, A(c, 0.12 * g)); }
    cv.arc(cx, cy, r - w / 2, r + w / 2, a0, a1, c);
    if (w >= 3) cv.arc(cx, cy, r - w * 0.18, r + w * 0.18, a0, a1, A('#ffffff', 0.5));
}
/** A small ring node (the end of a light line). */
function node(cv, x, y, r, c) {
    cv.circle(x, y, r * 2.4, A(c, 0.10));
    cv.arc(x, y, r - 1.2, r + 1.2, 0, 360, c);
    cv.circle(x, y, r * 0.45, c);
}

/**
 * A dotted leader line routed through pts (right angles), a node at the end, an optional
 * code next to it, and a data packet running along it.
 */
function leader(cv, pts, c, code, phase) {
    const b = boot(500, 600);
    if (b <= 0) return;
    let total = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
    let drawn = 0;
    const lim = total * b;
    for (let i = 1; i < pts.length && drawn < lim; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], l = seg[i - 1];
        for (let d = 0; d < l && drawn + d < lim; d += 7) {
            const f = d / l;
            cv.fillRect(x0 + (x1 - x0) * f - 1, y0 + (y1 - y0) * f - 1, 2.2, 2.2, A(c, 0.55));
        }
        drawn += l;
    }
    if (b < 1) return;
    const e = pts[pts.length - 1];
    node(cv, e[0], e[1], 4, c);
    if (code) mono(cv, code, e[0] + 10, e[1] - 8, 12, A(c, 0.7));
    // packet
    let p = ((phase == null ? now() / 1400 : phase) % 1) * total;
    for (let i = 1; i < pts.length; i++) {
        if (p <= seg[i - 1]) {
            const f = p / seg[i - 1], x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
            cv.circle(x, y, 6, A(c, 0.18)); cv.circle(x, y, 2.4, '#ffffff');
            break;
        }
        p -= seg[i - 1];
    }
}

/** Chevrons stacked along a line, lit one after the other (a flow indicator). */
function chevrons(cv, x, y, n, step, size, dir, c, phase) {
    for (let i = 0; i < n; i++) {
        const lit = ((phase - i / n) % 1 + 1) % 1, a = 0.12 + 0.75 * Math.pow(1 - lit, 3);
        const cx = x + (dir === 'right' ? i * step : dir === 'left' ? -i * step : 0), cy = y + (dir === 'up' ? -i * step : dir === 'down' ? i * step : 0);
        const s = size;
        if (dir === 'up' || dir === 'down') {
            const sg = dir === 'up' ? -1 : 1;
            cv.line(cx - s, cy - sg * s * 0.4, cx, cy + sg * s * 0.4, 3, A(c, a)); cv.line(cx, cy + sg * s * 0.4, cx + s, cy - sg * s * 0.4, 3, A(c, a));
        } else {
            const sg = dir === 'left' ? -1 : 1;
            cv.line(cx - sg * s * 0.4, cy - s, cx + sg * s * 0.4, cy, 3, A(c, a)); cv.line(cx + sg * s * 0.4, cy, cx - sg * s * 0.4, cy + s, 3, A(c, a));
        }
    }
}

/** Diagonal hatch stripes in a box (a warning-tape accent). */
function hatch(cv, x, y, w, h, c, gap) {
    const g = gap || 7;
    for (let i = 0; i * g < w; i++) { const x0 = x + i * g; cv.quad([[x0, y + h], [x0 + h * 0.8, y], [x0 + h * 0.8 + 3, y], [x0 + 3, y + h]], c); }
}

/* ---------- the backdrop: dot matrix, light rays, horizon, light-grid floor ---------- */
let floorPhase = 0, floorT = now();

/**
 * The world behind every page. hy = horizon line; the floor's cross lines run toward the
 * viewer at the car's speed (km/h, null = parked). Drawn to the page's bottom edge and a
 * little below it (the screen's bar sits over that).
 */
function backdrop(cv, t, bottom, hy, speedKmh, opts) {
    const o = opts || {};
    cv.clear(t.bg);
    const b = bottom + 40;
    cv.clip(0, 0, W, b);
    // dot matrix above the horizon
    const dot = A(t.accent, 0.10);
    for (let y = 68; y < hy - 12; y += 32) for (let x = 16; x < W; x += 32) cv.fillRect(x, y, 2, 2, dot);
    cv.gradientRect(0, 0, W, 120, [[0, A('#000000', 0.55)], [1, A('#000000', 0)]]);
    if (o.noFloor) { cv.noclip(); return; }
    const vp = o.vp || W / 2, grow = boot(0, 700);
    // light rays fanning up out of the horizon
    for (let i = -7; i <= 7; i++) {
        const a = i * 0.21, len = 900, w0 = 2, w1 = 26 + Math.abs(i) * 4;
        const x1 = vp + Math.sin(a) * len, y1 = hy - Math.cos(a) * len * 0.42;
        const nx = Math.cos(a), ny = Math.sin(a) * 0.42;
        cv.quad([[vp - nx * w0, hy], [vp + nx * w0, hy], [x1 + nx * w1, y1 + ny * w1], [x1 - nx * w1, y1 - ny * w1]], A(t.accent, (i === 0 ? 0.05 : 0.025) * grow));
    }
    // horizon glow
    cv.gradientRect(0, hy - 90, W, 90, [[0, A(t.accent, 0)], [1, A(t.accent, 0.13)]]);
    cv.gradientRect(0, hy, W, b - hy, [[0, A(t.accent, 0.10)], [0.4, A(t.accent, 0.02)], [1, A(t.accent, 0.05)]]);
    // floor: lines converging on a point above the horizon
    const rise = 0.18;
    for (let i = -14; i <= 14; i++) {
        const xb = vp + i * 128, xh = vp + i * 128 * rise;
        const yb = hy + (b - hy) * grow, xe = xh + (xb - xh) * grow;
        cv.line(xh, hy, xe, yb, i === 0 ? 1.6 : 1.1, A(t.accent, i === 0 ? 0.26 : 0.16));
    }
    // cross lines flowing toward the viewer with the car's speed
    const tn = now(), dt = Math.min(0.2, (tn - floorT) / 1000);
    floorT = tn;
    floorPhase = (floorPhase + (G.isNum(speedKmh) ? speedKmh : 0) * dt * 0.045 + dt * 0.04) % 1;
    const D = b - hy;
    for (let k = 0; k < 16; k++) {
        const z = 0.85 + (k + 1 - floorPhase) * 0.55, y = hy + D / z;
        if (y > b || y < hy + 2) continue;
        cv.fillRect(0, y - 0.7, W, 1.4, A(t.accent, clamp(0.36 / z, 0.02, 0.3) * grow));
    }
    // the horizon itself: a light line, hottest in the middle
    cv.fillRect(0, hy - 6, W, 12, A(t.accent, 0.05));
    cv.rampRect(0, hy - 3, W, 6, 0, [A(t.accent, 0.05), A(t.accent, 0.35), A(t.accent, 0.05)]);
    cv.rampRect(0, hy - 1, W, 2, 0, [A(t.accent, 0.3), A(t.accent2 || t.accent, 1), A(t.accent, 0.3)]);
    cv.noclip();
}

/* ---------- holo panel: cut corners, neon edge ---------- */
/** The panel outline: a box with its top-left and bottom-right corners cut by k. */
function cutBox(x, y, w, h, k) {
    return [[x + k, y], [x + w, y], [x + w, y + h - k], [x + w - k, y + h], [x, y + h], [x, y + k], [x + k, y]];
}
/** Fill of a cut-corner box, as plain triangles (no anti-aliased seam inside; the outline covers the edge). */
function fillCut(cv, x, y, w, h, k, c) {
    cv.fillUnder([[x, y + k], [x + k, y], [x + w - k, y]], y + h, c);
    cv.fillUnder([[x + w - k, y + h], [x + w, y + h - k]], y, c);
}
/**
 * A floating panel: smoked glass with cut corners, a neon edge, the label in a lit tab and
 * an optional code on the right. Returns the inner content box { x, y, w, h }.
 */
function panel(cv, t, x, y, w, h, label, opts) {
    const o = opts || {}, c = o.color || (o.hot ? t.crit : t.accent), k = boot(o.delay || 0, 450), cut = o.cut || 14;
    const box = { x: x + 16, y: y + 30, w: w - 32, h: h - 38 };
    if (k <= 0) return box;
    cv.alpha(k);
    fillCut(cv, x, y, w, h, cut, A('#000000', 0.6));
    fillCut(cv, x, y, w, h, cut, A(c, 0.045));
    cv.gradientRect(x + cut, y + 1, w - cut, 26, [[0, A(c, 0.10)], [1, A(c, 0)]]);
    neon(cv, cutBox(x, y, w, h, cut), 1.2, A(c, o.hot ? 0.9 : 0.45), 0.6);
    // bright corner accents on the cuts
    cv.line(x, y + cut + 18, x, y + cut, 3, c); cv.line(x, y + cut, x + cut, y, 3, c); cv.line(x + cut, y, x + cut + 30, y, 3, c);
    cv.line(x + w, y + h - cut - 18, x + w, y + h - cut, 3, c); cv.line(x + w, y + h - cut, x + w - cut, y + h, 3, c); cv.line(x + w - cut, y + h, x + w - cut - 30, y + h, 3, c);
    if (label) mono(cv, label, x + cut + 10, y + 19, 15, A(c, 0.95));
    if (o.code) mono(cv, o.code, x + w - 12, y + 19, 12, A(c, 0.5), 'right');
    if (o.hatch !== false && w > 220) hatch(cv, x + w - 60, y + h - 9, 40, 5, A(c, 0.35), 8);
    cv.alpha(1);
    return box;
}

/* ---------- reactor: the big rotating dial ---------- */
/**
 * A JARVIS-style reactor dial. f = value 0..1 on the sweep a0..a1; zone(f) = colour of a
 * lit segment at f; spin = how fast the inner rings turn (0..1).
 */
function reactor(cv, t, cx, cy, R, o) {
    const a0 = o.a0, a1 = o.a1, b = boot(o.delay || 0, 900), tn = now() / 1000;
    const spin = o.spin || 0;
    const ac = t.accent;
    // core glow
    for (let i = 5; i >= 1; i--) cv.circle(cx, cy, R * (0.35 + i * 0.07), A(ac, 0.012 * i * b));
    cv.circle(cx, cy, R * 0.52, A(t.bg, 0.92));
    cv.arc(cx, cy, R * 0.52, R * 0.53, 0, 360, A(ac, 0.35 * b));
    // inner counter-rotating tick ring
    const rot1 = -(tn * (8 + spin * 50)) % 360;
    for (let i = 0; i < 60; i++) {
        const a = rot1 + i * 6;
        radial(cv, cx, cy, R * 0.56, R * (i % 5 === 0 ? 0.6 : 0.58), a, i % 5 === 0 ? 1.6 : 1, A(ac, (i % 5 === 0 ? 0.45 : 0.22) * b));
    }
    // rotating bright segments
    const rot2 = (tn * (14 + spin * 160)) % 360;
    cv.arc(cx, cy, R * 0.63, R * 0.645, 0, 360, A(ac, 0.12 * b));
    spinner(cv, cx, cy, R * 0.625, R * 0.66, rot2, [[0, 34], [120, 34], [240, 34]], A(ac, 0.75 * b));
    spinner(cv, cx, cy, R * 0.61, R * 0.675, rot2, [[30, 4], [150, 4], [270, 4]], A(t.accent2 || ac, 0.9 * b));
    // main segmented band
    const sweep = a0 + (a1 - a0) * b;
    const n = o.segments || 54, lit = clamp(o.f || 0, 0, 1) * n * b;
    const r0 = R * 0.77, r1 = R * 0.9;
    const step = (a1 - a0) / n;
    // glow behind the lit part
    if (lit > 0.01) cv.arc(cx, cy, r0 - 6, r1 + 6, a0, a0 + step * lit, A(o.zone(clamp(o.f, 0, 1)), 0.13));
    for (let i = 0; i < n; i++) {
        const s = a0 + i * step + 0.7, e = a0 + (i + 1) * step - 0.7;
        if (s > sweep) break;
        const f = i / (n - 1), part = clamp(lit - i, 0, 1);
        const zc = o.zone(f);
        cv.arc(cx, cy, r0, r1, s, e, A(zc, part > 0 ? 0.3 + 0.7 * part : (f >= (o.redFrom || 2) ? 0.16 : 0.07)));
    }
    // outer scale ticks
    if (b > 0.2) {
        ticks(cv, cx, cy, R * 0.93, R * 0.97, a0, a0 + (a1 - a0) * b, o.ticks || 70, A(ac, 0.3), { major: o.major || 10, majorLen: R * 0.04, majorC: A(ac, 0.8), majorW: 2.5 });
    }
    // outer bracket arcs and end caps
    neonArc(cv, cx, cy, R * 1.005, 2, a0 - 6, a0 + (a1 - a0) * b + 6, A(ac, 0.55 * b), 0.7);
    // data dust drifting around the core
    for (let i = 0; i < 40; i++) {
        const h = Math.sin(i * 12.9898) * 43758.5453, fr = h - Math.floor(h);
        const a = (i * 37 + tn * (6 + fr * 14) * (i % 2 ? 1 : -1)) % 360, rr = R * (0.69 + fr * 0.06);
        const p = pol(cx, cy, rr, a);
        cv.fillRect(p[0] - 1, p[1] - 1, 2, 2, A(i % 5 ? ac : '#ffffff', (0.25 + 0.5 * fr) * b));
    }
    [a0 - 6, a1 + 6].forEach((a) => { if (b > 0.95) radial(cv, cx, cy, R * 0.95, R * 1.04, a, 3, A(ac, 0.7)); });
    // the leading edge: a white light with a trail
    if (G.isNum(o.f) && b > 0.5) {
        const a = a0 + (a1 - a0) * clamp(o.f, 0, 1);
        const zc = o.zone(clamp(o.f, 0, 1));
        cv.arc(cx, cy, r0, r1, Math.max(a0, a - 26), a, zc, { ramp: o.trailRamp, rampFrom: a - 26, rampTo: a });
        radial(cv, cx, cy, r0 - R * 0.07, R * 1.02, a, 9, A(zc, 0.22));
        radial(cv, cx, cy, r0 - R * 0.07, R * 1.02, a, 3, '#ffffff');
    }
}

/* ---------- identity discs: the speedometer's backdrop, one per identity ---------- */
/** Points of a regular n-gon (closed). */
function ngon(cx, cy, r, n, rot) {
    const p = [];
    for (let i = 0; i <= n; i++) p.push(pol(cx, cy, r, rot + i * 360 / n));
    return p;
}
/** A small square block on the ring at angle a (a quad turned with the ring). */
function block(cv, cx, cy, r, a, s, c) {
    const u = s / 2, d = s / 2 / r / RAD;
    cv.quad([pol(cx, cy, r - u, a - d), pol(cx, cy, r - u, a + d), pol(cx, cy, r + u, a + d), pol(cx, cy, r + u, a - d)], c);
}

/**
 * The identity disc behind the speed. id: 'sam' | 'flynn' | 'rinzler' | 'ares'. o.rot = turn
 * (degrees, grows with road speed); o.shift = 0..1 toward the shift point (lights the rim's top
 * arc); o.over = at the shift point (the rim flashes).
 */
function disc(cv, t, cx, cy, R, o) {
    const id = o.id || 'sam', c = t.accent, b = boot(o.delay || 100, 900), rot = o.rot || 0;
    if (b <= 0) return;
    R *= 0.86 + 0.14 * b;
    cv.alpha(b);
    // body
    cv.circle(cx, cy, R * 1.22, A(c, 0.025));
    cv.circle(cx, cy, R * 1.08, A(c, 0.04));
    cv.circle(cx, cy, R, A(t.bg, 0.94));
    cv.circle(cx, cy, R * 0.99, A(c, 0.04));
    if (id === 'flynn') {
        [[0.97, 1.5], [0.93, 3.5], [0.89, 1.5]].forEach(([f, w]) => {
            for (let k = 0; k < 8; k++) neonArc(cv, cx, cy, R * f, w, rot + k * 45 + 3, rot + k * 45 + 42, A(c, w > 2 ? 1 : 0.7), w > 2 ? 1 : 0.4);
        });
        for (let i = 0; i < 48; i++) radial(cv, cx, cy, R * 0.79, R * 0.85, rot * 0.5 + i * 7.5, 4, A(c, i % 6 === 0 ? 0.8 : 0.32));
        neonArc(cv, cx, cy, R * 0.71, 4, 0, 360, c);
        spinner(cv, cx, cy, R * 0.645, R * 0.655, -rot * 0.8, Array.from({ length: 72 }, (_, i) => [i * 5, 2.5]), A(c, 0.45));
    } else if (id === 'rinzler') {
        for (let k = 0; k < 3; k++) neonArc(cv, cx, cy, R * 0.95, 9, rot * 1.3 + k * 120 + 8, rot * 1.3 + k * 120 + 112, c);
        for (let k = 0; k < 3; k++) neonArc(cv, cx, cy, R * 1.05, 2.5, -rot * 1.3 + k * 120 + 40, -rot * 1.3 + k * 120 + 100, A(c, 0.85), 0.6);
        for (let i = 0; i < 60; i++) {
            const a = rot * 0.6 + i * 6;
            cv.arc(cx, cy, R * (i % 2 ? 0.80 : 0.78), R * (i % 2 ? 0.84 : 0.87), a, a + 3.6, A(c, i % 2 ? 0.3 : 0.65));
        }
        for (let k = 0; k < 3; k++) neonArc(cv, cx, cy, R * 0.66, 3, -rot + k * 120, -rot + k * 120 + 96, A(c, 0.9));
    } else if (id === 'ares') {
        neon(cv, ngon(cx, cy, R * 0.97, 12, rot), 4.5, c);
        neon(cv, ngon(cx, cy, R * 0.9, 12, rot + 15), 1.5, A(c, 0.55), 0.4);
        for (let i = 0; i < 30; i++) {
            if (i % 7 === 3) continue;
            block(cv, cx, cy, R * 0.8, -rot * 0.7 + i * 12, i % 3 === 0 ? 11 : 7, A(c, i % 3 === 0 ? 0.85 : 0.35));
        }
        neon(cv, ngon(cx, cy, R * 0.67, 8, -rot), 3, A(c, 0.9));
    } else {
        for (let k = 0; k < 4; k++) neonArc(cv, cx, cy, R * 0.95, 7, rot + k * 90 + 6, rot + k * 90 + 84, c);
        neonArc(cv, cx, cy, R * 0.88, 1.5, 0, 360, A(c, 0.6), 0.4);
        for (let i = 0; i < 36; i++) radial(cv, cx, cy, R * 0.74, R * 0.82, rot * 0.5 + i * 10, 3, A(c, 0.28));
        neonArc(cv, cx, cy, R * 0.66, 3.5, -rot * 0.7 + 10, -rot * 0.7 + 170, A(c, 0.95));
        neonArc(cv, cx, cy, R * 0.66, 3.5, -rot * 0.7 + 190, -rot * 0.7 + 350, A(c, 0.95));
    }
    // core: dark under the digits
    cv.circle(cx, cy, R * 0.6, A(t.bg, 0.9));
    cv.circle(cx, cy, R * 0.6, A(c, 0.03));
    // shift lights: the rim's top arc
    const n = 17, lit = clamp(o.shift || 0, 0, 1) * n, flash = o.over && Math.floor(now() / 80) % 2 === 0;
    for (let i = 0; i < n; i++) {
        const a = -66 + i * 132 / n + 1.2, e = -66 + (i + 1) * 132 / n - 1.2, f = i / (n - 1);
        const col = o.over ? t.crit : f < 0.55 ? c : f < 0.8 ? t.warn : t.crit;
        const part = o.over ? (flash ? 1 : 0.12) : clamp(lit - i, 0, 1);
        if (part > 0) cv.arc(cx, cy, R * 1.11, R * 1.21, a, e, A(col, 0.22 * part));
        cv.arc(cx, cy, R * 1.13, R * 1.19, a, e, A(col, part > 0 ? 0.25 + 0.75 * part : 0.07));
    }
    cv.alpha(1);
}

/* ---------- shift lights: slanted light bars ---------- */
function shiftBar(cv, t, x, y, w, h, rpm, red) {
    const n = 22, gap = 5, sw = (w - gap * (n - 1)) / n, k = h * 0.8, start = red - 2600, top = red - 200;
    const lit = G.isNum(rpm) ? clamp((rpm - start) / (top - start), 0, 1) * n : 0;
    const over = G.isNum(rpm) && rpm >= top, flash = over && Math.floor(now() / 80) % 2 === 0;
    for (let i = 0; i < n; i++) {
        const f = i / (n - 1), col = over ? t.crit : f < 0.6 ? t.accent : f < 0.85 ? t.warn : t.crit;
        const lx = x + i * (sw + gap), part = over ? (flash ? 1 : 0.15) : clamp(lit - i, 0, 1);
        const pts = [[lx + k, y], [lx + sw + k, y], [lx + sw, y + h], [lx, y + h]];
        if (part > 0) cv.quad([[lx + k - 2, y - 3], [lx + sw + k + 2, y - 3], [lx + sw + 2, y + h + 3], [lx - 2, y + h + 3]], A(col, 0.22 * part));
        cv.quad(pts, A(col, part > 0 ? 0.2 + 0.8 * part : 0.08));
    }
}

/* ---------- buttons ---------- */
/**
 * A holo button: angled corners, lit when `on`. Registers the touch / controller target.
 * Returns its width.
 */
function button(cv, t, x, y, w, h, label, run, opts) {
    const o = opts || {}, c = o.color || t.accent, on = !!o.on, busy = !!o.busy;
    const k = 12;
    fillCut(cv, x, y, w, h, k, on ? A(c, busy ? 0.45 : 0.9) : A(c, 0.08));
    // outline
    const e = A(c, on ? 1 : busy ? 0.25 : 0.6), lw = 1.5;
    cv.line(x + k, y, x + w, y, lw, e); cv.line(x + w, y, x + w, y + h - k, lw, e);
    cv.line(x + w, y + h - k, x + w - k, y + h, lw, e); cv.line(x + w - k, y + h, x, y + h, lw, e);
    cv.line(x, y + h, x, y + k, lw, e); cv.line(x, y + k, x + k, y, lw, e);
    if (on) cv.fillRect(x + k + 6, y + h + 5, w - 2 * k - 12, 2, A(c, 0.6));
    head(cv, label, x + w / 2, o.sub ? y + h / 2 + 1 : y + h / 2 + 7, 18, on ? t.bg : busy ? A(c, 0.4) : c, 'center', 2);
    if (o.sub) mono(cv, o.sub, x + w / 2, y + h - 9, 11, on ? A(t.bg, 0.8) : A(c, 0.55), 'center');
    if (!busy && run && cv.own) cv.target(x, y, w, h, run, o.key || label);
    return w;
}

module.exports = {
    F, A, clamp, ease, reboot, boot, pol, radial, mono, lbl, head, num, brackets, lightLine, segArc, ticks, spinner, tri,
    pointer, segBar, trace, backdrop, panel, reactor, shiftBar, button, neon, neonArc, node, leader, chevrons, hatch, cutBox, fillCut, disc, ngon,
};
