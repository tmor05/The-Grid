'use strict';
/**
 * headup.js - The Grid in the head-up display: cluster-render's `hud` target (iDrive 7: slot 0x323,
 * an 800 x 480 scene; the part a driver sees for sure is the box the HUD's own map uses, 453 x 200
 * at 173,140, cluster-render's map_upload_test). Everything is drawn inside that box:
 *
 *   shift   an effect: slanted shift-light segments across the top, toward the shift point, then
 *           flashing (the renderer's clock: nothing sent while it flashes)
 *   gear    Orbitron over a glyph atlas (digits and D M N P R S), centred: the gear (or P, R, N), the
 *           programme (D, S, M) small beside it
 *   boost   left: the value and a segment bar;  oil  right: the value and a segment bar, its colour
 *           by state (cold / ok / hot)
 *   floor   a strip of the light-grid floor along the bottom, running with road speed, leaning into
 *           corners and flaring on a shift (setting "HUD grid strip")
 *   chrome  a picture sent once (again on a new identity or units): brackets, labels, units
 *
 * On a HUD light is drawn on the road: black (and transparent) is nothing. The layers give way to
 * the HMI's HUD lists (yield 1) and never cover BMW's own HUD content, which has slots of its own
 * (README "The HUD"). Live values are uniforms, about 15 a second at most and only what changed.
 */
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client');
const { TEXT_FS, BAR_FS, HIGHP, PAD, TRACK, buildAtlas, picture, col3 } = require('./cluster');
const G = require('./kit/gauges');
const H = require('./hud');

const BOX = { x: 173, y: 140, w: 453, h: 200 };           // the HUD's map box in the 800 x 480 scene
const UPDATE_MS = 66;
const HCHARS = '0123456789.-DMNPRS';

/* Shift lights: n slanted segments over the strip, u_shift 0..1 lit, u_over flashes them (renderer clock). */
const SHIFT_FS = `#version 100
${HIGHP}uniform float u_time;
uniform float u_shift;
uniform float u_over;
uniform vec2 u_size;
uniform vec3 u_c;
uniform vec3 u_warn;
uniform vec3 u_crit;
varying vec2 v_uv;
const float N = 17.0;
void main() {
    float k = u_size.y * 0.8 / u_size.x;
    float xs = (v_uv.x - (1.0 - v_uv.y) * k) / (1.0 - k);
    float seg = floor(xs * N), f = fract(xs * N);
    float gap = 4.0 / (u_size.x / N);
    if (xs < 0.0 || xs >= 1.0 || f > 1.0 - gap) { gl_FragColor = vec4(0.0); return; }
    float pos = seg / (N - 1.0);
    bool over = u_over > 0.5;
    vec3 col = over ? u_crit : pos < 0.6 ? u_c : pos < 0.85 ? u_warn : u_crit;
    float part = over ? (fract(u_time * 6.25) < 0.5 ? 1.0 : 0.15) : clamp(u_shift * N - seg, 0.0, 1.0);
    gl_FragColor = vec4(col, part > 0.0 ? 0.2 + 0.8 * part : 0.09);
}`;

/* The floor strip: a horizon light line at the top, lanes converging on it, cross lines running toward
 * the viewer (phase = u_time x rate + offset), the far end leaning (u_bend, px), flaring on u_pulse. */
const STRIP_FS = `#version 100
${HIGHP}uniform float u_time;
uniform vec2 u_floor;
uniform float u_bend;
uniform float u_pulse;
uniform vec2 u_size;
uniform vec3 u_c;
uniform vec3 u_c2;
varying vec2 v_uv;
void main() {
    vec2 p = v_uv * u_size;
    float HY = 3.0, D = u_size.y + 18.0 - HY;
    vec3 col = vec3(0.0);
    float a = 0.0;
    float h = abs(p.y - HY);
    float mid = 1.0 - abs(p.x - u_size.x * 0.5) / (u_size.x * 0.5);
    float line = (1.0 - smoothstep(0.4, 1.4, h)) * (0.35 + 0.65 * mid) * (1.0 + 0.8 * u_pulse);
    col += mix(u_c, u_c2, mid) * line; a = max(a, line);
    if (p.y > HY) {
        float yy = max(p.y - HY, 0.5), s = yy / D;
        float vp = u_size.x * 0.5 - u_bend;
        float xc = vp + (u_size.x * 0.5 - vp) * s;
        float u = (p.x - xc) / (44.0 * (0.18 + 0.82 * s));
        float du = 1.0 / (44.0 * (0.18 + 0.82 * s));
        float dv = abs(fract(u + 0.5) - 0.5) / du;
        float lane = 0.35 * (1.0 - smoothstep(0.4, 1.3, dv));
        float z = D / yy;
        float v = (z - 0.85) / 0.55 + fract(u_time * u_floor.x + u_floor.y);
        float dh = abs(fract(v + 0.5) - 0.5) / (D / (0.55 * yy * yy));
        float cross = clamp(0.5 / z, 0.03, 0.45) * (1.0 - smoothstep(0.5, 1.5, dh));
        float fade = (1.0 - smoothstep(0.55, 1.0, abs(p.x - u_size.x * 0.5) / (u_size.x * 0.5))) * (1.0 - smoothstep(0.6, 1.0, s));
        float g = (lane + cross) * fade * (0.7 + 0.5 * u_pulse);
        col += u_c * g; a = max(a, g);
    }
    gl_FragColor = vec4(col / max(a, 0.001), clamp(a, 0.0, 1.0));
}`;

/* Where each piece sits in the scene (x, y: top-left). */
const L_SHIFT = { x: BOX.x + 12, y: BOX.y + 6, w: BOX.w - 24, h: 20 };
const L_STRIP = { x: BOX.x, y: BOX.y + 158, w: BOX.w, h: 42 };
const GEAR = { cx: BOX.x + BOX.w / 2, y: BOX.y + 40, size: 84, cells: 1 };
const MODE = { size: 30, cells: 1 };
const SIDE = [
    { key: 'boost', label: 'BOOST', x: BOX.x + 14, y: BOX.y + 40, w: 124, size: 36, cells: 5, segs: 12 },
    { key: 'oil', label: 'OIL', x: BOX.x + BOX.w - 14 - 124, y: BOX.y + 40, w: 124, size: 36, cells: 3, segs: 12 },
];

class GridHud {
    /**
     * src: { values() -> as the cluster's (boost, oil, shift, over, kmh, gLat, calm, gear: { letter, num },
     *                     units), theme(), strip() -> true to draw the grid strip }
     */
    constructor(ctx, src, socketPath) {
        this.ctx = ctx; this.log = ctx.log; this.src = src;
        this.path = socketPath || process.env.CLUSTER_RENDER_SOCK || DEFAULT_PATH;
        this.cr = null; this.sent = {}; this.timer = null; this.atlas = null; this.picKey = '';
        this.floor = { rate: 0.04, off: 0, t0: Date.now() };
        this.bend = 0; this.bendT = Date.now();
        this.shown = false;
        H.onPulse(() => {
            if (!this.cr || !this.cr.ready || !this.L || !this.stripOn) return;
            if (this.pulseAnim) this.cr.stop(this.L.strip, this.pulseAnim);
            this.pulseAnim = this.cr.animate(this.L.strip, { property: 'uniform', name: 'u_pulse', keys: '0:1 140:0.65 450:0', loop: 0 });
        });
    }

    start() {
        if (this.cr) return;
        const cr = this.cr = new ClusterRender('the_grid_hud', this.path);
        if (!this.atlas) this.atlas = buildAtlas(90, HCHARS);
        const A = this.atlas, L = this.L = {};
        this.pulseAnim = 0;
        const base = { target: 'hud' };
        this.stripOn = this.src.strip();
        L.font = cr.asset({ target: 'hud', format: 'r8', w: A.aw, h: A.ah, sampling: 'bilinear' });
        L.chrome = cr.image(Object.assign({ klass: 'content', z: 0, x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h }, base));
        L.shift = cr.effect(Object.assign({ klass: 'content', z: 1, x: L_SHIFT.x, y: L_SHIFT.y, w: L_SHIFT.w, h: L_SHIFT.h, fs: SHIFT_FS, time: true }, base));
        L.strip = cr.effect(Object.assign({ klass: 'ambient', z: 0, x: L_STRIP.x, y: L_STRIP.y, w: L_STRIP.w, h: L_STRIP.h, fs: STRIP_FS, time_fps: 30, visible: this.stripOn ? 1 : 0 }, base));
        const textFs = TEXT_FS.replace('%CW%', A.cw).replace('%PAD%', PAD).replace('%AW%', A.aw).replace('%AH%', A.ah);
        L.texts = {}; L.bars = {};
        const gw = this._w(GEAR.cells) * GEAR.size / A.size;
        L.texts.gear = this._textLayer(cr, textFs, GEAR.cx - gw / 2, GEAR.y, GEAR.size, GEAR.cells, base, 'center');
        const mw = this._w(MODE.cells) * MODE.size / A.size;
        L.texts.mode = this._textLayer(cr, textFs, GEAR.cx - gw / 2 - mw + 4, GEAR.y + 8, MODE.size, MODE.cells, base, 'right');
        SIDE.forEach((r) => {
            const w = this._w(r.cells) * r.size / A.size;
            L.texts[r.key] = this._textLayer(cr, textFs, r.key === 'boost' ? r.x - 6 : r.x + r.w - w + 6, r.y + 20, r.size, r.cells, base, r.key === 'boost' ? 'left' : 'right');
            L.bars[r.key] = cr.effect(Object.assign({ klass: 'overlay', z: 0, x: r.x, y: r.y + 72, w: r.w, h: 7, fs: BAR_FS }, base));
        });
        Object.keys(L.texts).forEach((k) => cr.bind(L.texts[k].ref, 'u_font', L.font));
        cr.pixels(L.font, null, A.px);
        cr.on('ready', () => {
            this.sent = {}; this.picKey = '';
            this.floor.t0 = Date.now(); this.floor.off = 0;
            this._pictures(true);
            this._update(true);
            this.log.info('hud: connected (' + cr.backend + ': ' + cr.targets + ')');
        });
        cr.on('target', (name, state, holder, reason) => {
            if (name !== 'hud') return;
            this.shown = state === 'shown';
            this.log.info('hud: ' + state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : ''));
        });
        cr.on('refused', (op, ref, reason) => this.log.warn('hud: refused ' + op + ' ' + ref + ': ' + reason));
        cr.connect();
        this.timer = setInterval(() => { try { this._update(false); } catch (e) { this.log.warn('hud update: ' + e); } }, UPDATE_MS);
        this.log.info('hud: started');
    }

    stop() {
        if (!this.cr) return;
        clearInterval(this.timer); this.timer = null;
        this.shown = false;
        this.cr.close(); this.cr = null;
        this.log.info('hud: stopped');
    }

    /** Units, the identity or the strip setting changed. */
    refresh() {
        if (!this.cr || !this.cr.ready) return;
        const on = this.src.strip();
        if (on !== this.stripOn) { this.stripOn = on; this.cr.set(this.L.strip, { visible: on ? 1 : 0 }); }
        this._pictures(false); this._update(true);
    }

    _w(cells) { return cells * this.atlas.adv[0] + (cells - 1) * TRACK + 2 * PAD; }
    _textLayer(cr, fs, x, y, size, cells, base, align) {
        const A = this.atlas, s = size / A.size, w = this._w(cells);
        const ref = cr.effect(Object.assign({ klass: 'overlay', z: 1, x: Math.round(x), y: Math.round(y), w: Math.round(w * s), h: Math.round(A.ah * s), fs }, base));
        cr.uniform(ref, 'u_w', [w]);
        return { ref, w, cells, align };
    }
    _glyphs(str, tl) {
        const A = this.atlas, codes = [], wid = [];
        String(str).slice(0, 8).split('').forEach((ch) => { const i = A.chars.indexOf(ch); if (i >= 0) { codes.push(i); wid.push(A.adv[i]); } });
        const total = wid.reduce((s, w) => s + w, 0) + Math.max(0, wid.length - 1) * TRACK;
        let x = tl.align === 'center' ? (tl.w - total) / 2 : tl.align === 'left' ? PAD : tl.w - PAD - total;
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
        const t = this.src.theme(), v = this.src.values();
        const key = [t.name, v.units.temp, v.units.press].join('|');
        if (!force && key === this.picKey) return;
        this.picKey = key;
        const L = this.L, A = H.A;
        this.cr.pixels(L.chrome, null, picture(BOX.w, BOX.h, (cv) => {
            const c = t.accent;
            // corner brackets round the field, a hairline under the shift lights
            H.brackets(cv, 2, 2, BOX.w - 4, BOX.h - 4, 16, 2, A(c, 0.55));
            SIDE.forEach((r) => {
                const x = r.x - BOX.x, y = r.y - BOX.y;
                H.mono(cv, r.label, r.key === 'boost' ? x : x + r.w, y + 12, 13, A(c, 0.8), r.key === 'boost' ? 'left' : 'right');
                const unit = r.key === 'boost' ? v.units.press.toUpperCase() : v.units.temp;
                H.lbl(cv, unit, r.key === 'boost' ? x : x + r.w, y + 100, 16, A(c, 0.75), r.key === 'boost' ? 'left' : 'right', 2);
            });
        }));
        const ac = col3(t.accent), a2 = col3(t.accent2 || t.accent), warn = col3(t.warn), crit = col3(t.crit);
        this._uni(L.shift, 'u_c', ac); this._uni(L.shift, 'u_warn', warn); this._uni(L.shift, 'u_crit', crit); this._uni(L.shift, 'u_size', [L_SHIFT.w, L_SHIFT.h]);
        this._uni(L.strip, 'u_c', ac); this._uni(L.strip, 'u_c2', a2); this._uni(L.strip, 'u_size', [L_STRIP.w, L_STRIP.h]);
        SIDE.forEach((r) => {
            const b = L.bars[r.key];
            this._uni(b, 'u_c', ac); this._uni(b, 'u_warn', warn); this._uni(b, 'u_crit', crit);
            this._uni(b, 'u_zone', r.key === 'boost' ? [0.6, 0.85] : [0.7, 0.88]); this._uni(b, 'u_size', [r.w, 7, 0, 0]);
        });
        Object.keys(L.texts).forEach((k) => this._uni(L.texts[k].ref, 'u_glow', ac));
    }

    _update(force) {
        if (!this.cr || !this.cr.ready) return;
        const t = this.src.theme(), v = this.src.values(), L = this.L;
        this._pictures(false);
        this._uni(L.shift, 'u_shift', [Math.round(G.clamp(v.shift || 0, 0, 1) * 34) / 34]);
        this._uni(L.shift, 'u_over', [v.over ? 1 : 0]);
        if (this.stripOn) {
            const kmh = G.isNum(v.kmh) ? Math.max(0, v.kmh) : 0, rate = 0.04 + kmh * 0.045, f = this.floor;
            if (force || Math.abs(rate - f.rate) > 0.02 * Math.max(f.rate, 0.05)) {
                const tc = (Date.now() - f.t0) / 1000;
                f.off = ((tc * f.rate + f.off) - tc * rate) % 1;
                f.rate = rate;
                this._uni(L.strip, 'u_floor', [f.rate, f.off]);
            }
            const now = Date.now(), dt = Math.min(0.3, (now - this.bendT) / 1000);
            this.bendT = now;
            const bt = v.calm || !G.isNum(v.gLat) ? 0 : G.clamp(v.gLat, -1.2, 1.2) * G.clamp(kmh / 40, 0, 1);
            this.bend += (bt - this.bend) * Math.min(1, dt * 4);
            this._uni(L.strip, 'u_bend', [Math.round(this.bend * 60)]);
            if (force) this._uni(L.strip, 'u_pulse', [0]);
        }
        const white = col3(t.text), dim = col3(t.accent).concat([0.3]);
        const text = (k, str, color) => {
            const tl = L.texts[k], g = this._glyphs(str, tl);
            this._uni(tl.ref, 'u_code', g.codes, 'vec4'); this._uni(tl.ref, 'u_pos', g.pos, 'vec4'); this._uni(tl.ref, 'u_wid', g.wid, 'vec4');
            this._uni(tl.ref, 'u_color', color.length === 4 ? color : color.concat([1]));
        };
        const gr = v.gear;
        text('gear', gr ? gr.num || gr.letter : '-', gr ? (v.over ? col3(t.crit) : white) : dim);
        text('mode', gr && gr.num ? gr.letter : '', col3(gr && gr.letter === 'M' ? t.crit : t.accent).concat([0.9]));
        const b = v.boost || {};
        text('boost', b.text == null ? '--' : b.text, b.text == null ? dim : white);
        const bf = G.isNum(b.pos) && G.isNum(b.zero) ? (b.pos - b.zero) / Math.max(0.01, 1 - b.zero) : -1;
        this._uni(L.bars.boost, 'u_bar', [bf < 0 ? (G.isNum(b.pos) ? 0 : -1) : Math.round(G.clamp(bf, 0, 1) * 100) / 100, 12]);
        const o = v.oil || {};
        text('oil', o.text == null ? '--' : o.text, o.text == null ? dim : o.state === 'HOT' ? col3(t.crit) : o.state === 'COLD' ? col3(t.cold || t.accent) : white);
        this._uni(L.bars.oil, 'u_bar', [G.isNum(o.frac) ? Math.round(G.clamp(o.frac, 0, 1) * 100) / 100 : -1, 12]);
    }
}

module.exports = { GridHud, BOX, SHIFT_FS, STRIP_FS };
