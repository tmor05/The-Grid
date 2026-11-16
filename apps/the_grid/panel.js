'use strict';
/**
 * panel.js - The Grid over the whole instrument cluster: cluster-render's `panel` target
 * (iDrive 7: slot 0x203, a 1920 x 720 scene drawn OVER BMW's gauges and UNDER the telltales;
 * cluster-render.conf: "over the gauges and under the telltales (VERIFIED on the car)").
 *
 *   left     The Grid's speedometer: a segmented arc, the speed in Orbitron, ethanol and intake
 *            air under it
 *   right    the tach: a segmented arc with the red zone (the warm-up redline moves it), the
 *            gear and programme in the middle, oil / coolant / gearbox under it
 *   middle   the identity disc (boost inside, shift light on its rim) over the light-grid floor
 *   bottom   left alone: everything under y = CUT stays transparent, so BMW's bottom strip
 *            (range, clock, street, outside air) shows, and a port over the speed-limit sign
 *
 * BMW's warning lights stay on top whatever we draw (the KOMBI draws them over this slot).
 *
 * The panel covers BMW's speedometer, so it shows only while the car's own speed comes in
 * (src.values().live): no car data, demo data or a lost vehicle service and every layer is
 * hidden; cluster-render releases the slot after its linger (3 s) and BMW's gauges come back.
 * If the app or the service dies, the KOMBI drops the scene by itself.
 *
 * Pictures go once (again on a new identity or new units); live values are uniforms, only what
 * changed, about 15 updates a second at most.
 */
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client');
const { DIAL_FS, BAR_FS, TEXT_FS, HIGHP, PAD, TRACK, buildAtlas, picture, col3 } = require('./cluster');
const G = require('./kit/gauges');
const H = require('./hud');

const W = 1920, HT = 720;
const CUT = 636, FADE = 20;                    // opaque above CUT - FADE, transparent from CUT down
const UPDATE_MS = 66;
const A0 = -125, A1 = 125;                     // the dials' sweep (degrees, 0 = up, clockwise)
const SP = { cx: 300, cy: 318, R: 262 };       // speedometer
const TA = { cx: 1620, cy: 318, R: 262 };      // tach
const DIAL_PAD = 30, DS2 = (SP.R + DIAL_PAD) * 2;
const MID = { x: 520, w: 880 };                // the floor between the dials (under the dial pictures' soft inner edges)
const HY = 430;                                // its horizon (scene y)
const DISC = { cx: 960, cy: 238, R: 146 };
const DS = Math.ceil(DISC.R * 1.3) * 2;
const DX = DISC.cx - DS / 2, DY = DISC.cy - DS / 2;
const LEFT_W = 600, RIGHT_X = 1320;            // the dial pictures: 0..600 and 1320..1920
const SOFT = 60;                               // their inner edges fade into the floor over this many px
// the port over BMW's speed-limit sign (measured on the car's cluster, generous on every side)
const LIMIT = { x: 492, y: 546, w: 112, h: CUT - 546 };
const BIGCHARS = '0123456789', LETTERS = 'DMNPRS';   // two atlases: one wide one would pass the 2048 px limit

/* The floor between the dials: dot matrix and rays above the horizon, the light-grid floor below
 * running with road speed (as cluster.js's), its sides melting into the background, transparent
 * from CUT down so BMW's bottom strip shows. */
const MIDFLOOR_FS = `#version 100
${HIGHP}uniform float u_time;
uniform vec2 u_floor;
uniform vec3 u_streak;
uniform float u_bend;
uniform float u_pulse;
uniform float u_hot;
uniform vec3 u_c;
uniform vec3 u_c2;
uniform vec3 u_bg;
varying vec2 v_uv;
const vec2 SIZE = vec2(${MID.w}.0, ${CUT}.0);
const float HY = ${HY}.0;
const float FADE = ${FADE}.0;
const vec3 PORT = vec3(${LIMIT.x - MID.x}.0, ${LIMIT.y}.0, ${LIMIT.x + LIMIT.w - MID.x}.0);   // the speed-limit port (x0, y0, x1)
void main() {
    vec2 p = v_uv * SIZE;
    vec3 col = vec3(0.0);
    float vp = SIZE.x * 0.5 - u_bend;
    float hot = clamp(u_hot + u_pulse, 0.0, 1.4);
    if (p.y < HY) {
        vec2 g = mod(p - vec2(16.0, 12.0), 32.0);
        col += u_c * 0.10 * step(g.x, 2.0) * step(g.y, 2.0) * step(p.y, HY - 12.0);
        float th = atan(p.x - vp, (HY - p.y) / 0.42 + 0.001);
        float r = abs(fract(th / 0.21 + 0.5) - 0.5) * 0.21;
        col += u_c * 0.03 * (1.0 + hot * 0.8) * (1.0 - smoothstep(0.0, 0.02 + 0.03 * (HY - p.y) / HY, r));
        col += u_c * (0.13 + 0.12 * hot) * smoothstep(HY - 90.0, HY, p.y);
    } else {
        float D = SIZE.y + 40.0 - HY;
        float yy = max(p.y - HY, 0.5);
        float s = yy / D;
        col += u_c * mix(0.10 + 0.08 * hot, 0.03, smoothstep(0.0, 0.5, s));
        float xc = vp + (SIZE.x * 0.5 - vp) * s;
        float u = (p.x - xc) / (128.0 * (0.18 + 0.82 * s));
        float du = 1.0 / (128.0 * (0.18 + 0.82 * s));
        float dv = abs(fract(u + 0.5) - 0.5) / du;
        col += u_c * 0.18 * (1.0 - smoothstep(0.4, 1.4, dv));
        float z = D / yy;
        float phase = fract(u_time * u_floor.x + u_floor.y);
        float v = (z - 0.85) / 0.55 + phase;
        float dvdy = D / (0.55 * yy * yy);
        float dh = abs(fract(v + 0.5) - 0.5) / dvdy;
        col += u_c * clamp(0.36 / z, 0.02, 0.3) * (1.0 - smoothstep(0.5, 1.5, dh));
        if (u_streak.x > 0.0) {
            float li = floor(u + 0.5);
            float hs = fract(sin(li * 91.7 + 3.1) * 43758.5453);
            float ph = fract(fract(u_time * u_streak.y + u_streak.z) * (1.0 + hs * 0.8) + hs * 7.0);
            float f0 = pow(ph, 2.2), f1 = min(1.0, f0 + 0.05 + 0.2 * ph);
            float inSeg = step(f0, s) * step(s, f1);
            float lit = step(hs, u_streak.x) * step(0.5, abs(li));
            float a = clamp(ph * 1.6, 0.0, 1.0) * (0.25 + 0.55 * u_streak.x);
            col += mix(u_c, u_c2, step(0.75, hs)) * a * lit * inSeg * (1.0 - smoothstep(0.5, 1.0 + 3.0 * ph, dv));
        }
    }
    float h = abs(p.y - HY);
    float mid = 1.0 - abs(p.x - SIZE.x * 0.5) / (SIZE.x * 0.5);
    col += u_c * (0.05 + 0.12 * u_pulse) * (1.0 - smoothstep(0.0, 6.0 + 10.0 * u_pulse, h));
    col += mix(u_c * 0.3, u_c2, mid) * (1.0 - smoothstep(0.5, 1.5, h)) * (0.4 + 0.6 * mid) * (1.0 + 0.4 * hot);
    float side = smoothstep(0.0, 90.0, p.x) * smoothstep(0.0, 90.0, SIZE.x - p.x) * smoothstep(0.0, 20.0, p.y);
    float port = step(PORT.x, p.x) * step(p.x, PORT.z) * step(PORT.y, p.y);
    gl_FragColor = vec4(u_bg + col * side, (1.0 - smoothstep(SIZE.y - FADE, SIZE.y, p.y)) * (1.0 - port));
}`;

/* A dial's arc: n segments over A0..A1 between 0.86 R and 0.95 R, lit up to u_val (0..1); from
 * u_red on the segments are the red zone (dim red unlit, red lit); u_over flashes the lit ones
 * (renderer clock). A bright marker at the value. */
const ARC_FS = `#version 100
${HIGHP}uniform float u_time;
uniform float u_val;
uniform float u_red;
uniform float u_over;
uniform float u_n;
uniform vec3 u_c;
uniform vec3 u_warn;
uniform vec3 u_crit;
varying vec2 v_uv;
const float R = ${SP.R}.0;
const float S = ${DS2}.0;
const float A0 = ${A0}.0, A1 = ${A1}.0;
float band(float r, float a, float b) { return smoothstep(a - 1.0, a, r) * (1.0 - smoothstep(b, b + 1.0, r)); }
void main() {
    vec2 p = (v_uv - 0.5) * S;
    float r = length(p);
    float a = degrees(atan(p.x, -p.y));
    vec4 o = vec4(0.0);
    if (a >= A0 && a <= A1) {
        float f = (a - A0) / (A1 - A0);
        float x = f * u_n, seg = floor(x), fr = fract(x);
        float gap = smoothstep(0.0, 0.10, fr) * smoothstep(0.0, 0.10, 1.0 - fr);
        float body = band(r, 0.86 * R, 0.95 * R);
        float glow = band(r, 0.83 * R, 0.98 * R) * (1.0 - body);
        bool red = (seg + 0.5) / u_n >= u_red;
        float lit = clamp(u_val * u_n - seg, 0.0, 1.0);
        vec3 col = red ? u_crit : f > u_red - 0.12 ? u_warn : u_c;
        if (u_over > 0.5 && lit > 0.0) { col = u_crit; lit *= fract(u_time * 6.25) < 0.5 ? 1.0 : 0.15; }
        float al = lit > 0.0 ? body * (0.3 + 0.7 * lit) + glow * 0.25 * lit : body * (red ? 0.28 : 0.09);
        o = vec4(col, al * gap);
        // the marker: a white bar across the arc at the value
        float da = abs(a - (A0 + (A1 - A0) * clamp(u_val, 0.0, 1.0))) * 3.14159 / 180.0 * r;
        if (u_val > 0.002 && da < 2.2 && r > 0.80 * R && r < 1.0 * R) o = vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(1.2, 2.2, da));
    }
    gl_FragColor = o;
}`;

/* The readouts under the dials. */
const TILE_H = 112, TILE_Y = 494;
const READOUTS = [
    { key: 'ethanol', label: 'ETHANOL', code: 'E%', x: 52, w: 200, size: 46, cells: 3, segs: 14, zone: [2, 2] },
    { key: 'iat', label: 'INTAKE', code: 'IAT', x: 264, w: 200, size: 46, cells: 3, segs: 14, zone: [0.7, 0.88] },
    { key: 'oil', label: 'OIL', code: 'ENG', x: 1384, w: 148, size: 40, cells: 3, segs: 10, zone: [0.7, 0.88] },
    { key: 'coolant', label: 'COOLANT', code: 'H2O', x: 1540, w: 148, size: 40, cells: 3, segs: 10, zone: [0.7, 0.88] },
    { key: 'trans', label: 'TRANS', code: 'ZF', x: 1696, w: 148, size: 40, cells: 3, segs: 10, zone: [0.7, 0.88] },
];
const SPEED_TEXT = { cx: SP.cx, y: SP.cy - 92, size: 150, cells: 3 };
const GEAR_TEXT = { cx: TA.cx, y: TA.cy - 92, size: 150, cells: 1 };
const MODE_TEXT = { size: 56, cells: 1 };
const BOOST_TEXT = { size: 56, cells: 5 };

/** The speedometer's scale in the display unit. */
function speedScale(mph) { return mph ? { max: 200, major: 20, minor: 10 } : { max: 320, major: 40, minor: 20 }; }
/** The tach's top in rpm: the redline plus at least 800, in whole thousands. */
function rpmTop(red) { return Math.max(6000, Math.ceil(((G.isNum(red) ? red : 7000) + 800) / 1000) * 1000); }

class GridPanel {
    /**
     * src: { values() -> as the cluster's, plus live, speed (display unit), mph, rpm, red (now),
     *                    fullRed, gear: { letter, num } ; theme() -> theme object }
     */
    constructor(ctx, src, socketPath) {
        this.ctx = ctx; this.log = ctx.log; this.src = src;
        this.path = socketPath || process.env.CLUSTER_RENDER_SOCK || DEFAULT_PATH;
        this.cr = null; this.sent = {}; this.timer = null; this.picKey = ''; this.visible = null;
        this.small = null; this.big = null; this.letters = null;
        this.floor = { rate: 0.04, off: 0, t0: Date.now() };
        this.streak = { rate: 0, off: 0, n: -1 };
        this.bend = 0; this.bendT = Date.now(); this.hot = 0;
        this.rings = { a: { deg: 0, rate: 9, t0: Date.now() }, b: { deg: 0, rate: -6, t0: Date.now() } };
        this.shown = false;
        this.onPulse = () => this._pulse();
        H.onPulse(this.onPulse);
    }

    start() {
        if (this.cr) return;
        const cr = this.cr = new ClusterRender('the_grid_panel', this.path);
        if (!this.small) this.small = buildAtlas(90);
        if (!this.big) this.big = buildAtlas(132, BIGCHARS);
        if (!this.letters) this.letters = buildAtlas(132, LETTERS);
        const S = this.small, B = this.big, LT = this.letters, L = this.L = {};
        this.rings.a.anim = this.rings.b.anim = this.pulseAnim = 0;
        this.visible = null;
        const base = { target: 'panel', contend: 1, visible: false };
        L.fontS = cr.asset({ target: 'panel', format: 'r8', w: S.aw, h: S.ah, sampling: 'bilinear' });
        L.fontB = cr.asset({ target: 'panel', format: 'r8', w: B.aw, h: B.ah, sampling: 'bilinear' });
        L.fontL = cr.asset({ target: 'panel', format: 'r8', w: LT.aw, h: LT.ah, sampling: 'bilinear' });
        L.floor = cr.effect(Object.assign({ klass: 'ambient', x: MID.x, y: 0, w: MID.w, h: CUT, fs: MIDFLOOR_FS, time_fps: 30 }, base));
        L.left = cr.image(Object.assign({ klass: 'content', z: 0, x: 0, y: 0, w: LEFT_W, h: CUT }, base));
        L.right = cr.image(Object.assign({ klass: 'content', z: 0, x: RIGHT_X, y: 0, w: W - RIGHT_X, h: CUT }, base));
        L.mid = cr.image(Object.assign({ klass: 'content', z: 0, x: MID.x, y: 0, w: MID.w, h: CUT }, base));
        L.ringA = cr.image(Object.assign({ klass: 'content', z: 1, x: DX, y: DY, w: DS, h: DS, sampling: 'bilinear' }, base));
        L.ringB = cr.image(Object.assign({ klass: 'content', z: 2, x: DX, y: DY, w: DS, h: DS, sampling: 'bilinear' }, base));
        L.core = cr.image(Object.assign({ klass: 'content', z: 3, x: DX, y: DY, w: DS, h: DS }, base));
        L.dial = cr.effect(Object.assign({ klass: 'content', z: 4, x: DX, y: DY, w: DS, h: DS, fs: DIAL_FS, time: true }, base));
        L.spArc = cr.effect(Object.assign({ klass: 'content', z: 4, x: SP.cx - DS2 / 2, y: SP.cy - DS2 / 2, w: DS2, h: DS2, fs: ARC_FS }, base));
        L.taArc = cr.effect(Object.assign({ klass: 'content', z: 4, x: TA.cx - DS2 / 2, y: TA.cy - DS2 / 2, w: DS2, h: DS2, fs: ARC_FS, time: true }, base));
        const fsFor = (A) => TEXT_FS.replace('%CW%', A.cw).replace('%PAD%', PAD).replace('%AW%', A.aw).replace('%AH%', A.ah);
        const fsS = fsFor(S), fsB = fsFor(B), fsL = fsFor(LT);
        L.bars = {}; L.texts = {};
        READOUTS.forEach((r) => {
            L.bars[r.key] = cr.effect(Object.assign({ klass: 'overlay', z: 0, x: r.x + 14, y: TILE_Y + TILE_H - 22, w: r.w - 28, h: 8, fs: BAR_FS }, base));
            L.texts[r.key] = this._textLayer(cr, S, fsS, r.x + 14, TILE_Y + 32, r.size, r.cells, base, 'right');
        });
        const bw = this._textWidth(S, BOOST_TEXT.cells) * BOOST_TEXT.size / S.size;
        L.texts.boost = this._textLayer(cr, S, fsS, DISC.cx - bw / 2, DISC.cy - 26, BOOST_TEXT.size, BOOST_TEXT.cells, base, 'center');
        const sw = this._textWidth(B, SPEED_TEXT.cells) * SPEED_TEXT.size / B.size;
        L.texts.speed = this._textLayer(cr, B, fsB, SPEED_TEXT.cx - sw / 2, SPEED_TEXT.y, SPEED_TEXT.size, SPEED_TEXT.cells, base, 'center');
        const gw = this._textWidth(B, GEAR_TEXT.cells) * GEAR_TEXT.size / B.size;
        L.texts.gear = this._textLayer(cr, B, fsB, GEAR_TEXT.cx - gw / 2, GEAR_TEXT.y, GEAR_TEXT.size, GEAR_TEXT.cells, base, 'center');
        const lw = this._textWidth(LT, GEAR_TEXT.cells) * GEAR_TEXT.size / LT.size;
        L.texts.gearL = this._textLayer(cr, LT, fsL, GEAR_TEXT.cx - lw / 2, GEAR_TEXT.y, GEAR_TEXT.size, GEAR_TEXT.cells, base, 'center');
        const mw = this._textWidth(LT, MODE_TEXT.cells) * MODE_TEXT.size / LT.size;
        L.texts.mode = this._textLayer(cr, LT, fsL, GEAR_TEXT.cx - gw / 2 - mw - 2, GEAR_TEXT.y + 70, MODE_TEXT.size, MODE_TEXT.cells, base, 'right');
        const fontOf = (A) => (A === B ? L.fontB : A === LT ? L.fontL : L.fontS);
        Object.keys(L.texts).forEach((k) => cr.bind(L.texts[k].ref, 'u_font', fontOf(L.texts[k].A)));
        cr.pixels(L.fontS, null, S.px);
        cr.pixels(L.fontB, null, B.px);
        cr.pixels(L.fontL, null, LT.px);
        this._spin(true);
        cr.on('ready', () => {
            this.sent = {}; this.visible = null;
            this.floor.t0 = Date.now(); this.floor.off = 0; this.streak.n = -1;
            this._spin(true);
            this._pictures(true);
            this._update(true);
            this.log.info('cluster panel: connected (' + cr.backend + ': ' + cr.targets + ')');
        });
        cr.on('target', (name, state, holder, reason) => {
            if (name !== 'panel') return;
            this.shown = state === 'shown';
            if (this.onShown) this.onShown(this.shown);
            this.log.info('cluster panel: ' + state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : ''));
        });
        cr.on('refused', (op, ref, reason) => this.log.warn('cluster panel: refused ' + op + ' ' + ref + ': ' + reason));
        cr.connect();
        this.timer = setInterval(() => { try { this._update(false); } catch (e) { this.log.warn('cluster panel update: ' + e); } }, UPDATE_MS);
        this.log.info('cluster panel: started (' + this.path + ')');
    }

    stop() {
        if (!this.cr) return;
        clearInterval(this.timer); this.timer = null;
        this.shown = false;
        if (this.onShown) this.onShown(false);
        this.cr.close(); this.cr = null;
        this.log.info('cluster panel: stopped');
    }

    refresh() { if (this.cr && this.cr.ready) { this._pictures(false); this._update(true); } }

    /** Every layer shown or hidden at once (hidden: the slot goes back to BMW after the linger). */
    _show(on) {
        if (this.visible === on) return;
        this.visible = on;
        const L = this.L, refs = [L.floor, L.left, L.right, L.mid, L.ringA, L.ringB, L.core, L.dial, L.spArc, L.taArc]
            .concat(Object.keys(L.bars).map((k) => L.bars[k]), Object.keys(L.texts).map((k) => L.texts[k].ref));
        refs.forEach((ref) => this.cr.set(ref, { visible: on }));
        this.log.info('cluster panel: ' + (on ? 'over BMW\'s gauges' : 'hidden (no live speed from the car): BMW\'s gauges'));
    }

    _spin(force) {
        if (!this.cr) return;
        const v = this.src.values ? this.src.values() : {}, kmh = G.isNum(v.kmh) ? Math.max(0, v.kmh) : 0, now = Date.now();
        const want = { a: 9 + kmh * 1.1, b: -(6 + kmh * 0.75) };
        ['a', 'b'].forEach((k) => {
            const r = this.rings[k], deg = (r.deg + r.rate * (now - r.t0) / 1000) % 360;
            if (!force && Math.abs(want[k] - r.rate) < Math.max(2, Math.abs(r.rate) * 0.12)) return;
            Object.assign(r, { deg, rate: want[k], t0: now });
            const ms = Math.round(360 / Math.abs(r.rate) * 1000), end = deg + (r.rate > 0 ? 360 : -360), ref = k === 'a' ? this.L.ringA : this.L.ringB;
            if (r.anim) this.cr.stop(ref, r.anim);
            r.anim = this.cr.animate(ref, { property: 'rotate', keys: '0:' + deg.toFixed(2) + ' ' + ms + ':' + end.toFixed(2), loop: 1 });
        });
    }
    _pulse() {
        if (!this.cr || !this.cr.ready || !this.L) return;
        if (this.pulseAnim) this.cr.stop(this.L.floor, this.pulseAnim);
        this.pulseAnim = this.cr.animate(this.L.floor, { property: 'uniform', name: 'u_pulse', keys: '0:1 140:0.65 450:0', loop: 0 });
    }

    _textWidth(A, cells) { return cells * A.adv[0] + (cells - 1) * TRACK + 2 * PAD; }
    _textLayer(cr, A, fs, x, y, size, cells, base, align) {
        const s = size / A.size, w = this._textWidth(A, cells);
        const ref = cr.effect(Object.assign({ klass: 'overlay', z: 1, x: Math.round(x), y: Math.round(y), w: Math.round(w * s), h: Math.round(A.ah * s), fs }, base));
        cr.uniform(ref, 'u_w', [w]);
        return { ref, w, cells, align: align || 'right', A };
    }
    _glyphs(str, t) {
        const A = t.A, codes = [], wid = [];
        String(str).slice(0, 8).split('').forEach((ch) => { const i = A.chars.indexOf(ch); if (i >= 0) { codes.push(i); wid.push(A.adv[i]); } });
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

    /** The background of a dial picture: opaque down to the fade, then nothing (BMW's strip). */
    /**
     * The background of a dial picture, in 4 px columns: opaque down to the fade, then nothing
     * (BMW's strip); the inner edge (soft: 'right' or 'left') fades into the floor; over the port
     * only the part above it is drawn (BMW's speed-limit sign shows inside).
     */
    static _ground(cv, t, w, port, soft) {
        for (let x = 0; x < w; x += 4) {
            const e = soft === 'right' ? w - x - 2 : x + 2;                      // distance from the inner edge
            const k = e >= SOFT ? 1 : Math.max(0, e / SOFT);
            if (k <= 0) continue;
            const inPort = port && x + 4 > port.x && x < port.x + port.w;
            const solid = inPort ? port.y : CUT - FADE;
            cv.fillRect(x, 0, 4, solid, H.A(t.bg, k));
            if (!inPort) for (let i = 0; i < FADE; i += 2) cv.fillRect(x, CUT - FADE + i, 4, 2, H.A(t.bg, k * (1 - (i + 1) / FADE)));
        }
    }

    _dialFace(cv, t, d, labels, unitText, code) {
        const c = t.accent;
        cv.circle(d.cx, d.cy, d.R * 1.02, H.A(c, 0.03));
        cv.circle(d.cx, d.cy, d.R * 0.80, H.A(t.bg, 0.9));
        H.neonArc(cv, d.cx, d.cy, d.R * 1.0, 2, A0 - 3, A1 + 3, H.A(c, 0.6), 0.8);
        H.neonArc(cv, d.cx, d.cy, d.R * 0.80, 1, A0, A1, H.A(c, 0.25), 0);
        H.ticks(cv, d.cx, d.cy, d.R * 0.76, d.R * 0.79, A0, A1, labels.minor, H.A(c, 0.45), { major: labels.every, majorLen: 10, majorW: 2.5, majorC: H.A(c, 0.9) });
        labels.text.forEach((s, i) => {
            const a = A0 + (A1 - A0) * i / (labels.text.length - 1), p = H.pol(d.cx, d.cy, d.R * 0.66, a);
            H.head(cv, s, p[0], p[1] + 10, 26, labels.red && labels.red(i) ? t.crit : H.A(t.text, 0.85), 'center', 1);
        });
        H.lbl(cv, unitText, d.cx, d.cy + 92, 24, H.A(c, 0.9), 'center', 6);
        H.mono(cv, code, d.cx, d.cy - d.R * 0.44, 13, H.A(c, 0.5), 'center');
        H.brackets(cv, d.cx - d.R - 22, d.cy - d.R - 22, (d.R + 22) * 2, (d.R + 22) * 2 - 70, 26, 2, H.A(c, 0.35));
    }

    _pictures(force) {
        const t = this.src.theme(), v = this.src.values(), id = (t.name || 'sam').toLowerCase();
        const sc = speedScale(v.mph), top = rpmTop(v.fullRed);
        const key = [t.name, v.units.temp, v.units.press, v.mph ? 'mph' : 'kmh', top, v.fullRed].join('|');
        if (!force && key === this.picKey) return;
        this.picKey = key;
        const cr = this.cr, L = this.L, S = this.small;
        const tile = (cv, r, ox) => {
            H.panel(cv, t, r.x - ox, TILE_Y, r.w, TILE_H, r.label, { code: r.code, hatch: false, cut: 12 });
            const unit = r.key === 'ethanol' ? '%' : v.units.temp, s = r.size / S.size;
            H.lbl(cv, unit, r.x - ox + 14 + this._textWidth(S, r.cells) * s + 4, TILE_Y + 32 + S.base * s, Math.max(16, r.size * 0.4), H.A(t.accent, 0.85), 'left', 1);
        };
        // left: the speedometer
        cr.pixels(L.left, null, picture(LEFT_W, CUT, (cv) => {
            GridPanel._ground(cv, t, LEFT_W, LIMIT, 'right');
            const n = sc.max / sc.minor, every = sc.major / sc.minor, txt = [];
            for (let s = 0; s <= sc.max; s += sc.major) txt.push(String(s));
            this._dialFace(cv, t, SP, { minor: n, every, text: txt }, v.mph ? 'MPH' : 'KM/H', 'SPEED // VEH 0x30');
            READOUTS.filter((r) => r.x < LEFT_W).forEach((r) => tile(cv, r, 0));
            // the port's frame: BMW's speed-limit sign shows inside it
            H.brackets(cv, LIMIT.x, LIMIT.y, LIMIT.w, LIMIT.h + 4, 14, 2, H.A(t.accent, 0.6));
            H.mono(cv, 'LIMIT', LIMIT.x + LIMIT.w / 2, LIMIT.y - 8, 12, H.A(t.accent, 0.6), 'center');
        }));
        // right: the tach
        cr.pixels(L.right, null, picture(W - RIGHT_X, CUT, (cv) => {
            GridPanel._ground(cv, t, W - RIGHT_X, null, 'left');
            const d = { cx: TA.cx - RIGHT_X, cy: TA.cy, R: TA.R }, k = top / 1000, txt = [];
            for (let i = 0; i <= k; i++) txt.push(String(i));
            this._dialFace(cv, t, d, { minor: k * 2, every: 2, text: txt, red: (i) => i * 1000 >= (v.fullRed || 7000) }, 'x1000 RPM', 'ENGINE // DME 0x12');
            READOUTS.filter((r) => r.x >= RIGHT_X).forEach((r) => tile(cv, r, RIGHT_X));
        }));
        // middle: the disc's body, the ties to the dials, the identity line
        cr.pixels(L.mid, null, picture(MID.w, CUT, (cv) => {
            const cx = DISC.cx - MID.x;
            H.discBody(cv, t, cx, DISC.cy, DISC.R);
            const e = LEFT_W - MID.x;
            H.leader(cv, [[e, 200], [e + 60, 200], [e + 60, DISC.cy], [cx - DISC.R * 1.15, DISC.cy]], t.accent, null, 0.5);
            H.leader(cv, [[MID.w - e, 200], [MID.w - e - 60, 200], [MID.w - e - 60, DISC.cy], [cx + DISC.R * 1.15, DISC.cy]], t.accent, null, 0.5);
            H.mono(cv, 'GRID//OS  ' + id.toUpperCase(), cx, 30, 14, H.A(t.accent, 0.55), 'center');
            H.mono(cv, 'CLUSTER 0x203', cx, HY - 14, 11, H.A(t.accent, 0.3), 'center');
        }));
        const c = DISC.cx - DX, R = DISC.R;
        cr.pixels(L.ringA, null, picture(DS, DS, (cv) => H.discRings(cv, t, id, c, c, R, 'a', 0)));
        cr.pixels(L.ringB, null, picture(DS, DS, (cv) => H.discRings(cv, t, id, c, c, R, 'b', 0)));
        cr.pixels(L.core, null, picture(DS, DS, (cv) => {
            H.discCore(cv, t, c, c, R);
            H.mono(cv, 'BOOST', c, c - 38, 14, H.A(t.accent, 0.8), 'center');
            H.lbl(cv, v.units.press.toUpperCase(), c, c + 50, 18, H.A(t.accent, 0.85), 'center', 4);
        }));
        const ac = col3(t.accent), a2 = col3(t.accent2 || t.accent), warn = col3(t.warn), crit = col3(t.crit), cold = col3(t.cold || t.accent);
        this._uni(L.floor, 'u_c', ac); this._uni(L.floor, 'u_c2', a2); this._uni(L.floor, 'u_bg', col3(t.bg));
        this._uni(L.dial, 'u_c', ac); this._uni(L.dial, 'u_warn', warn); this._uni(L.dial, 'u_crit', crit); this._uni(L.dial, 'u_cold', cold);
        [L.spArc, L.taArc].forEach((a) => { this._uni(a, 'u_c', ac); this._uni(a, 'u_warn', warn); this._uni(a, 'u_crit', crit); });
        this._uni(L.spArc, 'u_n', [sc.max / sc.minor * 2]);
        this._uni(L.spArc, 'u_red', [2]);
        this._uni(L.spArc, 'u_over', [0]);
        this._uni(L.taArc, 'u_n', [top / 250]);
        READOUTS.forEach((r) => {
            const b = L.bars[r.key];
            this._uni(b, 'u_c', ac); this._uni(b, 'u_warn', warn); this._uni(b, 'u_crit', crit);
            this._uni(b, 'u_zone', r.zone); this._uni(b, 'u_size', [r.w - 28, 8, 0, 0]);
        });
        Object.keys(L.texts).forEach((k) => this._uni(L.texts[k].ref, 'u_glow', ac));
    }

    _update(force) {
        if (!this.cr || !this.cr.ready) return;
        const t = this.src.theme(), v = this.src.values(), L = this.L;
        this._show(!!v.live);
        if (!v.live) return;
        this._pictures(false);
        const kmh = G.isNum(v.kmh) ? Math.max(0, v.kmh) : 0;
        // the floor (as cluster.js): pace from road speed, streaks, the bend into corners, boost heat
        const rate = 0.04 + kmh * 0.045, f = this.floor;
        if (force || Math.abs(rate - f.rate) > 0.02 * Math.max(f.rate, 0.05)) {
            const tc = (Date.now() - f.t0) / 1000;
            f.off = ((tc * f.rate + f.off) - tc * rate) % 1;
            f.rate = rate;
            this._uni(L.floor, 'u_floor', [f.rate, f.off]);
        }
        const sk = this.streak, n = Math.round(G.clamp((kmh - 30) / 170, 0, 1) * 16) / 16, srate = kmh * 0.012;
        if (force || n !== sk.n || Math.abs(srate - sk.rate) > 0.08 * Math.max(sk.rate, 0.1)) {
            const tc = (Date.now() - f.t0) / 1000;
            sk.off = ((tc * sk.rate + sk.off) - tc * srate) % 1;
            sk.rate = srate; sk.n = n;
            this._uni(L.floor, 'u_streak', [n, sk.rate, sk.off]);
        }
        const now = Date.now(), dt = Math.min(0.3, (now - this.bendT) / 1000);
        this.bendT = now;
        const bt = v.calm || !G.isNum(v.gLat) ? 0 : G.clamp(v.gLat, -1.2, 1.2) * G.clamp(kmh / 40, 0, 1);
        this.bend += (bt - this.bend) * Math.min(1, dt * 4);
        this._uni(L.floor, 'u_bend', [Math.round(this.bend * 76)]);
        this.hot += ((G.isNum(v.boostBar) ? G.clamp(v.boostBar / 2, 0, 1) : 0) * 0.8 - this.hot) * Math.min(1, dt * 6);
        this._uni(L.floor, 'u_hot', [Math.round(this.hot * 20) / 20]);
        if (force) this._uni(L.floor, 'u_pulse', [0]);
        this._spin(false);
        // the disc: shift light on the rim, boost inside
        this._uni(L.dial, 'u_shift', [Math.round(G.clamp(v.shift || 0, 0, 1) * 34) / 34]);
        this._uni(L.dial, 'u_over', [v.over ? 1 : 0]);
        const b = v.boost;
        this._uni(L.dial, 'u_boost', [b.zero, G.isNum(b.pos) ? b.pos : b.zero, G.isNum(b.peak) ? b.peak : -1, G.isNum(b.pos) ? 1 : 0]);
        // the dials
        const sc = speedScale(v.mph), top = rpmTop(v.fullRed);
        const spd = G.isNum(v.speed) ? Math.max(0, v.speed) : null;
        this._uni(L.spArc, 'u_val', [spd === null ? 0 : Math.round(G.clamp(spd / sc.max, 0, 1) * 1000) / 1000]);
        this._uni(L.taArc, 'u_val', [G.isNum(v.rpm) ? Math.round(G.clamp(v.rpm / top, 0, 1) * 1000) / 1000 : 0]);
        this._uni(L.taArc, 'u_red', [G.isNum(v.red) ? Math.round(v.red / top * 1000) / 1000 : 2]);
        this._uni(L.taArc, 'u_over', [v.over ? 1 : 0]);
        const white = col3(t.text), dim = col3(t.accent).concat([0.3]);
        const text = (k, str, color) => {
            const tl = L.texts[k], g = this._glyphs(str, tl);
            this._uni(tl.ref, 'u_code', g.codes, 'vec4'); this._uni(tl.ref, 'u_pos', g.pos, 'vec4'); this._uni(tl.ref, 'u_wid', g.wid, 'vec4');
            this._uni(tl.ref, 'u_color', color.length === 4 ? color : color.concat([1]));
        };
        text('speed', spd === null ? '' : String(Math.round(spd)), white);
        const gr = v.gear;
        const gc = gr ? (v.over ? col3(t.crit) : white) : dim;
        text('gear', gr && gr.num ? gr.num : '', gc);
        text('gearL', gr && !gr.num ? gr.letter : '', gc);
        text('mode', gr && gr.num ? gr.letter : '', col3(gr && gr.letter === 'M' ? t.crit : t.accent).concat([0.9]));
        text('boost', b.text == null ? '--' : b.text, b.text == null ? dim : white);
        READOUTS.forEach((r) => {
            const x = v[r.key] || {};
            const c = x.text == null ? dim : x.state === 'HOT' ? col3(t.crit) : x.state === 'COLD' ? col3(t.cold || t.accent) : white;
            text(r.key, x.text == null ? '--' : x.text, c);
            this._uni(L.bars[r.key], 'u_bar', [G.isNum(x.frac) ? Math.round(G.clamp(x.frac, 0, 1) * 100) / 100 : -1, r.segs]);
        });
    }
}

module.exports = { GridPanel, CUT, LIMIT, SP, TA, READOUTS, speedScale, rpmTop, ARC_FS, MIDFLOOR_FS, BIGCHARS, LETTERS };
