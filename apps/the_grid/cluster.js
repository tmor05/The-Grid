'use strict';
/**
 * cluster.js - The Grid in the middle of the instrument cluster: the map area between BMW's
 * speedometer and tach (cluster-render's `map` target, 1088 x 480), drawn by the cluster's
 * own GPU through cluster-render (robertnisipeanu/idrive-apps native/cluster-render, the
 * service waze-on-cluster uses).
 *
 *   floor      an effect (shader): the light-grid floor, its lines running with road speed
 *   chrome     an image drawn here once with hud.js: panels, labels, the disc's body
 *   rings a/b  images of the identity disc's two ring sets, turned by the renderer's own
 *              animations (nothing sent per frame)
 *   core       an image: the disc's dark core and its labels
 *   dial       an effect: the shift light on the disc's rim and the boost sweep inside it
 *   bars       effects: the segment bars under each value
 *   values     effects over a glyph atlas of the Orbitron digits
 *
 * Pictures go once (again when the identity or the units change); live values are a few
 * uniforms per update, about 15 a second at most and only what changed.
 *
 * The layers contend for the map area (they take it from the stock map, as the Waze map
 * does) and leave the stock guidance box alone (guide_hold 0), so Apple Maps' next turn
 * still shows. BMW's warnings are drawn over everything by the cluster itself.
 */
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client');
const { Recorder, play } = require('./kit/record');
const { Canvas, rgba } = require('./kit/canvas');
const fonts = require('./kit/fonts');
const G = require('./kit/gauges');
const H = require('./hud');

const TW = 1088, TH = 480;                     // the map target
const HY = 330;                                // horizon
const DISC = { cx: 544, cy: 236, R: 140 };
const DS = Math.ceil(DISC.R * 1.3) * 2;        // the disc pictures' size (square)
const DX = DISC.cx - DS / 2, DY = DISC.cy - DS / 2;
const UPDATE_MS = 66;

const HIGHP = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

/* The floor: dot matrix and light rays above the horizon, the light-grid floor below, its cross
 * lines running toward the viewer (phase = u_time x rate + offset, rate from road speed),
 * edges fading into the cluster's black. Same geometry as hud.backdrop. */
const FLOOR_FS = `#version 100
${HIGHP}uniform float u_time;
uniform vec2 u_floor;
uniform vec3 u_c;
uniform vec3 u_c2;
uniform vec3 u_bg;
varying vec2 v_uv;
const vec2 SIZE = vec2(${TW}.0, ${TH}.0);
const float HY = ${HY}.0;
void main() {
    vec2 p = v_uv * SIZE;
    vec3 col = u_bg;
    float vp = SIZE.x * 0.5;
    if (p.y < HY) {
        vec2 g = mod(p - vec2(16.0, 12.0), 32.0);
        col += u_c * 0.10 * step(g.x, 2.0) * step(g.y, 2.0) * step(p.y, HY - 12.0);
        float th = atan(p.x - vp, (HY - p.y) / 0.42 + 0.001);
        float r = abs(fract(th / 0.21 + 0.5) - 0.5) * 0.21;
        col += u_c * 0.03 * (1.0 - smoothstep(0.0, 0.02 + 0.03 * (HY - p.y) / HY, r));
        col += u_c * 0.13 * smoothstep(HY - 90.0, HY, p.y);
    } else {
        float D = SIZE.y + 40.0 - HY;
        float yy = max(p.y - HY, 0.5);
        float s = yy / D;
        col += u_c * mix(0.10, 0.03, smoothstep(0.0, 0.5, s));
        float u = (p.x - vp) / (128.0 * (0.18 + 0.82 * s));
        float du = 1.0 / (128.0 * (0.18 + 0.82 * s));
        float dv = abs(fract(u + 0.5) - 0.5) / du;
        col += u_c * 0.18 * (1.0 - smoothstep(0.4, 1.4, dv));
        float z = D / yy;
        float phase = fract(u_time * u_floor.x + u_floor.y);
        float v = (z - 0.85) / 0.55 + phase;
        float dvdy = D / (0.55 * yy * yy);
        float dh = abs(fract(v + 0.5) - 0.5) / dvdy;
        col += u_c * clamp(0.36 / z, 0.02, 0.3) * (1.0 - smoothstep(0.5, 1.5, dh));
    }
    float h = abs(p.y - HY);
    float mid = 1.0 - abs(p.x - vp) / vp;
    col += u_c * 0.05 * (1.0 - smoothstep(0.0, 6.0, h));
    col += mix(u_c * 0.3, u_c2, mid) * (1.0 - smoothstep(0.5, 1.5, h)) * (0.4 + 0.6 * mid);
    float vig = smoothstep(0.0, 70.0, p.x) * smoothstep(0.0, 70.0, SIZE.x - p.x) * smoothstep(0.0, 36.0, p.y) * smoothstep(0.0, 30.0, SIZE.y - p.y);
    gl_FragColor = vec4(mix(vec3(0.0), col, vig), 1.0);
}`;

/* The dial over the disc: shift light on the rim's top arc (17 segments over -66..66 deg,
 * u_shift 0..1, u_over flashes it on the renderer's clock) and the boost sweep inside the
 * rings (-135..135 deg; u_boost: zero, value and peak as positions 0..1 on the scale, w = 1
 * with a value). Same look as hud.discShift. */
const DIAL_FS = `#version 100
${HIGHP}uniform float u_time;
uniform float u_shift;
uniform float u_over;
uniform vec4 u_boost;
uniform vec3 u_c;
uniform vec3 u_warn;
uniform vec3 u_crit;
uniform vec3 u_cold;
varying vec2 v_uv;
const float R = ${DISC.R}.0;
const float S = ${DS}.0;
float band(float r, float a, float b) { return smoothstep(a - 1.0, a, r) * (1.0 - smoothstep(b, b + 1.0, r)); }
void main() {
    vec2 p = (v_uv - 0.5) * S;
    float r = length(p);
    float a = degrees(atan(p.x, -p.y));
    vec4 o = vec4(0.0);
    if (a > -66.0 && a < 66.0 && r > 1.09 * R && r < 1.23 * R) {
        float x = (a + 66.0) / 132.0 * 17.0, seg = floor(x), f = fract(x);
        float gap = smoothstep(0.0, 0.08, f) * smoothstep(0.0, 0.08, 1.0 - f);
        float pos = seg / 16.0;
        bool over = u_over > 0.5;
        vec3 col = over ? u_crit : pos < 0.55 ? u_c : pos < 0.8 ? u_warn : u_crit;
        float part = over ? (fract(u_time * 6.25) < 0.5 ? 1.0 : 0.12) : clamp(u_shift * 17.0 - seg, 0.0, 1.0);
        float core = band(r, 1.13 * R, 1.19 * R);
        float glow = band(r, 1.11 * R, 1.21 * R) * (1.0 - core);
        float al = core * (part > 0.0 ? 0.25 + 0.75 * part : 0.07) + glow * 0.22 * part;
        o = vec4(col, al * gap);
    }
    float rb = band(r, 0.545 * R, 0.585 * R);
    if (rb > 0.0 && a > -135.0 && a < 135.0) {
        float f = (a + 135.0) / 270.0;
        float seg = fract(f * 54.0);
        float gap = smoothstep(0.0, 0.12, seg) * smoothstep(0.0, 0.12, 1.0 - seg);
        float lo = min(u_boost.x, u_boost.y), hi = max(u_boost.x, u_boost.y);
        bool lit = u_boost.w > 0.5 && f >= lo && f <= hi;
        bool vac = u_boost.y < u_boost.x;
        float q = (f - u_boost.x) / max(1.0 - u_boost.x, 0.01);
        vec3 col = vac ? u_cold : q > 0.85 ? u_crit : q > 0.6 ? u_warn : u_c;
        o = vec4(lit ? col : u_c, rb * gap * (lit ? 0.95 : 0.08));
        if (u_boost.w > 0.5 && abs(f - u_boost.y) * 270.0 < 1.2) o = vec4(1.0, 1.0, 1.0, rb);
        if (u_boost.z > u_boost.x && abs(f - u_boost.z) * 270.0 < 0.9) o = vec4(u_warn, rb);
    }
    gl_FragColor = o;
}`;

/* A segment bar: u_bar.x = lit fraction (below 0: no value), y = segments; the segments lean
 * like hud.segBar; colour by position: accent, warn from u_zone.x, crit from u_zone.y. */
const BAR_FS = `#version 100
${HIGHP}uniform vec2 u_bar;
uniform vec2 u_zone;
uniform vec4 u_size;
uniform vec3 u_c;
uniform vec3 u_warn;
uniform vec3 u_crit;
varying vec2 v_uv;
void main() {
    float k = u_size.y * 0.45 / u_size.x;
    float xs = (v_uv.x - (1.0 - v_uv.y) * k) / (1.0 - k);
    float n = u_bar.y;
    float seg = floor(xs * n), f = fract(xs * n);
    float gapW = 3.0 / (u_size.x / n);
    if (xs < 0.0 || xs >= 1.0 || f > 1.0 - gapW) { gl_FragColor = vec4(0.0); return; }
    float pos = seg / max(n - 1.0, 1.0);
    vec3 col = pos >= u_zone.y ? u_crit : pos >= u_zone.x ? u_warn : u_c;
    float lit = clamp(u_bar.x * n - seg, 0.0, 1.0);
    gl_FragColor = lit > 0.0 ? vec4(col, 0.25 + 0.75 * lit) : vec4(u_c, 0.08);
}`;

/* Numbers over the glyph atlas: glyph i (code u_code[i], 99 none) starts at u_pos[i] and is
 * u_wid[i] wide, in atlas pixels across the layer (u_w wide); each atlas cell is CW wide with
 * the glyph PAD in from its left. A soft halo in u_glow. */
const TEXT_FS = `#version 100
${HIGHP}uniform sampler2D u_font;
uniform vec4 u_code[2];
uniform vec4 u_pos[2];
uniform vec4 u_wid[2];
uniform float u_w;
uniform vec4 u_color;
uniform vec3 u_glow;
varying vec2 v_uv;
const float CW = %CW%.0, PAD = %PAD%.0, AW = %AW%.0, AH = %AH%.0;
float pick(vec4 a, vec4 b, int i) {
    if (i == 0) return a.x; if (i == 1) return a.y; if (i == 2) return a.z; if (i == 3) return a.w;
    if (i == 4) return b.x; if (i == 5) return b.y; if (i == 6) return b.z; return b.w;
}
float ink(vec2 uv) { return texture2D(u_font, uv).r; }
void main() {
    float lx = v_uv.x * u_w;
    float ax = -1.0;
    for (int i = 0; i < 8; i++) {
        float c = pick(u_code[0], u_code[1], i);
        float p = pick(u_pos[0], u_pos[1], i), w = pick(u_wid[0], u_wid[1], i);
        if (ax < 0.0 && c < 90.0 && lx >= p - PAD && lx < p + w + PAD) ax = c * CW + PAD + (lx - p);
    }
    if (ax < 0.0) { gl_FragColor = vec4(0.0); return; }
    vec2 uv = vec2(ax / AW, v_uv.y);
    float k = ink(uv);
    vec2 d = vec2(3.0 / AW, 3.0 / AH);
    float g = (ink(uv + vec2(d.x, 0.0)) + ink(uv - vec2(d.x, 0.0)) + ink(uv + vec2(0.0, d.y)) + ink(uv - vec2(0.0, d.y))) * 0.25;
    gl_FragColor = vec4(mix(u_glow, u_color.rgb, k), max(k * u_color.a, g * 0.4));
}`;

/* ---------- the glyph atlas: Orbitron digits from The Grid's own font ---------- */
const CHARS = '0123456789.-';
const PAD = 6, TRACK = 6;
function buildAtlas() {
    const f = fonts.get('gridnum', 90, '0123456789');
    const gl = CHARS.split('').map((ch) => f.glyphs[ch.charCodeAt(0)]);
    const cw = Math.ceil(Math.max.apply(null, gl.map((g) => g[2]))) + 2 * PAD;
    const top = Math.max.apply(null, gl.map((g) => -g[5]));
    const ch = top + 2 * PAD + 2, base = PAD + top;
    const aw = cw * CHARS.length, px = Buffer.alloc(aw * ch);
    gl.forEach((g, i) => {
        for (let y = 0; y < g[3]; y++) {
            for (let x = 0; x < g[2]; x++) {
                const v = f.alpha[(g[1] + y) * f.atlasW + g[0] + x];
                const ty = base + g[5] + y, tx = i * cw + PAD + x;
                if (ty >= 0 && ty < ch) px[ty * aw + tx] = v;
            }
        }
    });
    return { px, aw, ah: ch, cw, base, adv: gl.map((g) => g[2]), size: 90 };
}

/* ---------- pictures: drawn with hud.js into a recording, played into pixels ---------- */
function picture(w, h, draw) {
    const r = new Recorder(w, h, { textScale: 1 });
    H.drawn(() => draw(r));
    const c = new Canvas(w, h);
    play(r.words(), c);
    return Buffer.from(c.d.buffer, c.d.byteOffset, c.d.length);
}

const col3 = (c) => { const v = rgba(c); return [v[0] / 255, v[1] / 255, v[2] / 255]; };

/* The readouts round the disc: where each sits, its value text and its bar. */
const LEFT = 22, RIGHT = 766, COLW = 300;
const READOUTS = [
    { key: 'ethanol', label: 'ETHANOL', code: 'E-CONTENT', x: LEFT, y: 64, w: COLW, h: 150, size: 70, cells: 3, segs: 20, zone: [2, 2] },
    { key: 'iat', label: 'INTAKE', code: 'IAT', x: LEFT, y: 226, w: COLW, h: 104, size: 46, cells: 3, segs: 16, zone: [0.7, 0.88] },
    { key: 'oil', label: 'OIL', code: 'ENG.OIL', x: RIGHT, y: 64, w: COLW, h: 104, size: 46, cells: 3, segs: 16, zone: [0.7, 0.88] },
    { key: 'coolant', label: 'COOLANT', code: 'H2O', x: RIGHT, y: 180, w: COLW, h: 104, size: 46, cells: 3, segs: 16, zone: [0.7, 0.88] },
    { key: 'trans', label: 'TRANS', code: 'ZF8HP', x: RIGHT, y: 296, w: COLW, h: 104, size: 46, cells: 3, segs: 16, zone: [0.7, 0.88] },
];
const BOOST_TEXT = { size: 56, cells: 5 };

class GridCluster {
    /**
     * src: { values() -> { ethanol, iat, oil, coolant, trans: { text, frac, state } ,
     *                      boost: { text, zero, pos, peak }, shift, over, kmh, units: { temp, press } },
     *        theme() -> theme object }
     */
    constructor(ctx, src, socketPath) {
        this.ctx = ctx; this.log = ctx.log; this.src = src;
        this.path = socketPath || process.env.CLUSTER_RENDER_SOCK || DEFAULT_PATH;
        this.cr = null;
        this.sent = {};
        this.timer = null;
        this.atlas = null;
        this.picKey = '';
        this.floor = { rate: 0.04, off: 0, t0: Date.now() };
    }

    start() {
        if (this.cr) return;
        const cr = this.cr = new ClusterRender('the_grid', this.path);
        if (!this.atlas) this.atlas = buildAtlas();
        const A = this.atlas;
        const L = this.L = {};
        const base = { target: 'map', contend: 1, guide_hold: 0 };
        L.font = cr.asset({ target: 'map', format: 'r8', w: A.aw, h: A.ah, sampling: 'bilinear' });
        L.floor = cr.effect(Object.assign({ klass: 'ambient', x: 0, y: 0, w: TW, h: TH, fs: FLOOR_FS, time_fps: 30 }, base));
        L.chrome = cr.image(Object.assign({ klass: 'content', z: 0, x: 0, y: 0, w: TW, h: TH }, base));
        L.ringA = cr.image(Object.assign({ klass: 'content', z: 1, x: DX, y: DY, w: DS, h: DS, sampling: 'bilinear' }, base));
        L.ringB = cr.image(Object.assign({ klass: 'content', z: 2, x: DX, y: DY, w: DS, h: DS, sampling: 'bilinear' }, base));
        L.core = cr.image(Object.assign({ klass: 'content', z: 3, x: DX, y: DY, w: DS, h: DS }, base));
        L.dial = cr.effect(Object.assign({ klass: 'content', z: 4, x: DX, y: DY, w: DS, h: DS, fs: DIAL_FS, time: true }, base));
        const textFs = TEXT_FS.replace('%CW%', A.cw).replace('%PAD%', PAD).replace('%AW%', A.aw).replace('%AH%', A.ah);
        L.bars = {}; L.texts = {};
        READOUTS.forEach((r) => {
            L.bars[r.key] = cr.effect(Object.assign({ klass: 'overlay', z: 0, x: r.x + 16, y: r.y + r.h - 24, w: r.w - 32, h: 8, fs: BAR_FS }, base));
            L.texts[r.key] = this._textLayer(cr, textFs, r.x + 16, r.y + 30, r.size, r.cells, base);
        });
        const bw = this._textWidth(BOOST_TEXT.cells) * BOOST_TEXT.size / A.size;
        L.texts.boost = this._textLayer(cr, textFs, DISC.cx - bw / 2, DISC.cy - 26, BOOST_TEXT.size, BOOST_TEXT.cells, base);
        L.texts.boost.align = 'center';
        cr.animate(L.ringA, { anim: 1, property: 'rotate', keys: '0:0 40000:360', loop: 1 });
        cr.animate(L.ringB, { anim: 1, property: 'rotate', keys: '0:0 60000:-360', loop: 1 });
        Object.keys(L.texts).forEach((k) => cr.bind(L.texts[k].ref, 'u_font', L.font));
        cr.pixels(L.font, null, A.px);
        cr.on('ready', () => {
            this.sent = {};
            this.floor.t0 = Date.now();
            this.floor.off = 0;
            this._pictures(true);
            this._update(true);
            this.log.info('cluster: connected (' + cr.backend + ': ' + cr.targets + ')');
        });
        cr.on('target', (name, state) => { if (name === 'map') this.shown = state === 'shown'; if (this.onShown) this.onShown(this.shown); });
        cr.on('target', (name, state, holder, reason) => this.log.info('cluster: ' + name + ' ' + state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : '')));
        cr.on('refused', (op, ref, reason) => this.log.warn('cluster: refused ' + op + ' ' + ref + ': ' + reason));
        cr.connect();
        this.timer = setInterval(() => { try { this._update(false); } catch (e) { this.log.warn('cluster update: ' + e); } }, UPDATE_MS);
        this.log.info('cluster: started (' + this.path + ')');
    }

    stop() {
        if (!this.cr) return;
        clearInterval(this.timer); this.timer = null;
        this.shown = false;
        this.cr.close(); this.cr = null;
        this.log.info('cluster: stopped');
    }

    /** Units or the identity changed: the pictures go again. */
    refresh() { if (this.cr && this.cr.ready) { this._pictures(false); this._update(true); } }

    _textWidth(cells) { return cells * this.atlas.adv[0] + (cells - 1) * TRACK + 2 * PAD; }
    _textLayer(cr, fs, x, y, size, cells, base) {
        const A = this.atlas, s = size / A.size, w = this._textWidth(cells);
        const ref = cr.effect(Object.assign({ klass: 'overlay', z: 1, x: Math.round(x), y: Math.round(y), w: Math.round(w * s), h: Math.round(A.ah * s), fs }, base));
        cr.uniform(ref, 'u_w', [w]);
        return { ref, w, cells, align: 'right' };
    }

    /** Uniforms for a string: codes, starts and widths in atlas pixels, aligned in the layer. */
    _glyphs(str, t) {
        const A = this.atlas, codes = [], wid = [];
        String(str).slice(0, 8).split('').forEach((ch) => { const i = CHARS.indexOf(ch); if (i >= 0) { codes.push(i); wid.push(A.adv[i]); } });
        const total = wid.reduce((s, w) => s + w, 0) + Math.max(0, wid.length - 1) * TRACK;
        let x = t.align === 'center' ? (t.w - total) / 2 : t.align === 'left' ? PAD : t.w - PAD - total;
        const pos = wid.map((w) => { const p = x; x += w + TRACK; return p; });
        while (codes.length < 8) { codes.push(99); pos.push(-1000); wid.push(0); }
        return { codes, pos, wid };
    }

    _uni(ref, name, v, type) {
        const key = ref + ':' + name, s = v.map((x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)).join(' ');
        if (this.sent[key] === s) return;
        this.sent[key] = s;
        this.cr.uniform(ref, name, v, type ? { type } : undefined);
    }

    _pictures(force) {
        const t = this.src.theme(), v = this.src.values(), id = (t.name || 'sam').toLowerCase();
        const key = [t.name, v.units.temp, v.units.press].join('|');
        if (!force && key === this.picKey) return;
        this.picKey = key;
        const cr = this.cr, L = this.L, c = DISC.cx - DX, R = DISC.R;
        cr.pixels(L.chrome, null, picture(TW, TH, (cv) => {
            READOUTS.forEach((r) => {
                H.panel(cv, t, r.x, r.y, r.w, r.h, r.label, { code: r.code });
                const unit = r.key === 'ethanol' ? '% E' : v.units.temp;
                const s = r.size / this.atlas.size;
                H.lbl(cv, unit, r.x + 16 + this._textWidth(r.cells) * s + 6, r.y + 30 + this.atlas.base * s, Math.max(18, r.size * 0.36), H.A(t.accent, 0.85), 'left', 2);
            });
            H.discBody(cv, t, DISC.cx, DISC.cy, R);
            H.leader(cv, [[LEFT + COLW, 139], [LEFT + COLW + 30, 139], [LEFT + COLW + 30, 236], [DISC.cx - R * 1.15, 236]], t.accent, null, 0.5);
            H.leader(cv, [[RIGHT, 232], [RIGHT - 30, 232], [RIGHT - 30, 300], [DISC.cx + R * 0.9, 300]], t.accent, null, 0.5);
            H.mono(cv, 'GRID//OS  ' + id.toUpperCase(), LEFT + 4, TH - 34, 13, H.A(t.accent, 0.45));
            H.mono(cv, 'CLUSTER 0x100', RIGHT + COLW - 4, TH - 34, 13, H.A(t.accent, 0.35), 'right');
        }));
        cr.pixels(L.ringA, null, picture(DS, DS, (cv) => H.discRings(cv, t, id, c, c, R, 'a', 0)));
        cr.pixels(L.ringB, null, picture(DS, DS, (cv) => H.discRings(cv, t, id, c, c, R, 'b', 0)));
        cr.pixels(L.core, null, picture(DS, DS, (cv) => {
            H.discCore(cv, t, c, c, R);
            H.mono(cv, 'BOOST', c, c - 38, 14, H.A(t.accent, 0.8), 'center');
            H.lbl(cv, v.units.press.toUpperCase(), c, c + 50, 18, H.A(t.accent, 0.85), 'center', 4);
        }));
        // colours follow the identity
        const ac = col3(t.accent), a2 = col3(t.accent2 || t.accent), warn = col3(t.warn), crit = col3(t.crit), cold = col3(t.cold || t.accent);
        this._uni(L.floor, 'u_c', ac); this._uni(L.floor, 'u_c2', a2); this._uni(L.floor, 'u_bg', col3(t.bg));
        this._uni(L.dial, 'u_c', ac); this._uni(L.dial, 'u_warn', warn); this._uni(L.dial, 'u_crit', crit); this._uni(L.dial, 'u_cold', cold);
        READOUTS.forEach((r) => {
            const b = L.bars[r.key];
            this._uni(b, 'u_c', ac); this._uni(b, 'u_warn', warn); this._uni(b, 'u_crit', crit);
            this._uni(b, 'u_zone', r.zone); this._uni(b, 'u_size', [r.w - 32, 8, 0, 0]);
        });
        Object.keys(L.texts).forEach((k) => this._uni(L.texts[k].ref, 'u_glow', ac));
    }

    _update(force) {
        if (!this.cr || !this.cr.ready) return;
        const t = this.src.theme(), v = this.src.values(), L = this.L;
        this._pictures(false);
        // floor: the phase keeps running smoothly when the rate changes with the speed
        const rate = 0.04 + (G.isNum(v.kmh) ? v.kmh : 0) * 0.045, f = this.floor;
        if (force || Math.abs(rate - f.rate) > 0.02 * Math.max(f.rate, 0.05)) {
            const tc = (Date.now() - f.t0) / 1000;
            f.off = ((tc * f.rate + f.off) - tc * rate) % 1;
            f.rate = rate;
            this._uni(L.floor, 'u_floor', [f.rate, f.off]);
        }
        this._uni(L.dial, 'u_shift', [Math.round(G.clamp(v.shift || 0, 0, 1) * 34) / 34]);
        this._uni(L.dial, 'u_over', [v.over ? 1 : 0]);
        const b = v.boost;
        this._uni(L.dial, 'u_boost', [b.zero, G.isNum(b.pos) ? b.pos : b.zero, G.isNum(b.peak) ? b.peak : -1, G.isNum(b.pos) ? 1 : 0]);
        const white = col3(t.text);
        const dim = col3(t.accent).concat([0.3]);
        const text = (k, str, color) => {
            const tl = L.texts[k], g = this._glyphs(str, tl);
            this._uni(tl.ref, 'u_code', g.codes, 'vec4'); this._uni(tl.ref, 'u_pos', g.pos, 'vec4'); this._uni(tl.ref, 'u_wid', g.wid, 'vec4');
            this._uni(tl.ref, 'u_color', color.length === 4 ? color : color.concat([1]));
        };
        text('boost', b.text == null ? '--' : b.text, b.text == null ? dim : white);
        READOUTS.forEach((r) => {
            const x = v[r.key] || {};
            const c = x.text == null ? dim : x.state === 'HOT' ? col3(t.crit) : x.state === 'COLD' ? col3(t.cold || t.accent) : white;
            text(r.key, x.text == null ? '--' : x.text, c);
            this._uni(L.bars[r.key], 'u_bar', [G.isNum(x.frac) ? Math.round(G.clamp(x.frac, 0, 1) * 100) / 100 : -1, r.segs]);
        });
    }
}

module.exports = { GridCluster, READOUTS, DISC, TW, TH, FLOOR_FS, DIAL_FS, BAR_FS, TEXT_FS, buildAtlas };
