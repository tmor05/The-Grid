'use strict';
/**
 * clusterd.js (emulator page) - a stand-in for cluster-render (robertnisipeanu/idrive-apps
 * native/cluster-render, PROTOCOL.md) that draws what the app sends to the instrument cluster and
 * the HUD, live, the way the service builds its scenes: effect quads with the app's own GLSL ES
 * 1.00 shaders and uniforms, image quads, r8 / rgba assets, the renderer's own rotations, in the
 * stack's order (class, z, newest on top). The live version of kit/tools/grid_cluster_preview.js.
 *
 * Targets (iDrive 7): map 1088x480 (the middle of the cluster), panel 1920x720, hud 800x480.
 * Every layer that asks for a target is shown at once (the car's KOMBI may park it behind the
 * stock map: not modelled; the page's switch "BMW map view" hides the map target instead).
 */
const net = require('net');
const { Buffer } = require('buffer');

const SOCK = '/dev/shm/cluster-render/render.sock';
const TARGETS = { map: [1088, 480], panel: [1920, 720], hud: [800, 480] };
const KIND = { ambient: 0, content: 1, overlay: 2, alert: 3 };
const VS = 'attribute vec2 a_position; uniform vec4 u_rect; uniform vec3 u_turn; uniform vec2 u_scale; uniform vec2 u_tsize; varying vec2 v_uv;' +
    'void main(){ v_uv = a_position; vec2 p = u_rect.xy + a_position * u_rect.zw; vec2 q = (p - u_turn.xy) * u_scale;' +
    'float a = radians(u_turn.z); p = u_turn.xy + vec2(q.x*cos(a) - q.y*sin(a), q.x*sin(a) + q.y*cos(a));' +
    'gl_Position = vec4(p.x / u_tsize.x * 2.0 - 1.0, 1.0 - p.y / u_tsize.y * 2.0, 0.0, 1.0); }';
const IMG_FS = 'precision mediump float; uniform sampler2D u_img; uniform float u_opacity; varying vec2 v_uv; void main(){ vec4 c = texture2D(u_img, v_uv); gl_FragColor = vec4(c.rgb, c.a * u_opacity); }';

function msg(type, body) { const m = Buffer.alloc(5 + body.length); m.writeUInt32LE(body.length + 1, 0); m[4] = type; body.copy(m, 5); return m; }
const ev = (c, o) => c.write(msg(0x4a, Buffer.from(JSON.stringify(o))));

/** One target's scene drawn into its own canvas (WebGL 1, as the KOMBI's GLES2). */
class Scene {
    constructor(name, canvas) {
        this.name = name; this.cv = canvas;
        [this.w, this.h] = TARGETS[name];
        canvas.width = this.w; canvas.height = this.h;
        const gl = this.gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: true, preserveDrawingBuffer: true });
        this.ok = !!gl;
        this.progs = new Map();
        this.errors = [];
        if (!gl) return;
        this.buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    }
    prog(fs) {
        if (this.progs.has(fs)) return this.progs.get(fs);
        const gl = this.gl, p = gl.createProgram();
        let bad = null;
        [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]].forEach(([k, src]) => {
            const s = gl.createShader(k); gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) bad = gl.getShaderInfoLog(s);
            gl.attachShader(p, s);
        });
        gl.bindAttribLocation(p, 0, 'a_position'); gl.linkProgram(p);
        if (!bad && !gl.getProgramParameter(p, gl.LINK_STATUS)) bad = 'link: ' + gl.getProgramInfoLog(p);
        const entry = { p, bad, locs: new Map() };
        if (bad) this.errors.push(bad);
        this.progs.set(fs, entry);
        return entry;
    }
    loc(e, n) { if (!e.locs.has(n)) e.locs.set(n, this.gl.getUniformLocation(e.p, n)); return e.locs.get(n); }
}

/**
 * start({ map, hud, panel: canvases }, opts) -> { draw(), hidden: { map: false }, stats() }
 * draw() renders every target that changed or animates (call it once per display frame).
 */
function start(canvases, opts) {
    const o = opts || {};
    const log = o.log || ((l, s) => console.log('[cluster] ' + s));
    const scenes = {};
    Object.keys(canvases).forEach((k) => { if (canvases[k]) scenes[k] = new Scene(k, canvases[k]); });
    const layers = new Map();                  // global key 'client:ref' -> layer
    let clientN = 0, order = 0;
    const T0 = performance.now();
    const state = { hidden: { map: false, hud: false, panel: false }, msgs: 0, bytes: 0, clients: 0 };

    net.__listen(SOCK, (c) => {
        const id = ++clientN;
        state.clients++;
        let buf = Buffer.alloc(0);
        const mine = new Set();
        const key = (ref) => id + ':' + ref;
        c.on('data', (d) => {
            buf = buf.length ? Buffer.concat([buf, d]) : Buffer.from(d);
            let off = 0;
            while (buf.length - off >= 5) {
                const len = buf.readUInt32LE(off);
                if (buf.length - off < 4 + len) break;
                const type = buf[off + 4], body = buf.slice(off + 5, off + 4 + len);
                off += 4 + len; state.msgs++; state.bytes += 4 + len;
                try {
                    if (type === 0x4a) onJson(JSON.parse(body.toString('utf8')));
                    else if (type === 0x46) onFrame(body);
                } catch (e) { log('warn', 'bad message: ' + e.message); }
            }
            buf = buf.slice(off);
        });
        c.on('close', () => { state.clients--; mine.forEach((k) => drop(k)); });

        function onJson(m) {
            if (m.op === 'hello') {
                ev(c, { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480', repeat: 1 });
                return;
            }
            if (m.op === 'layer' || m.op === 'asset') {
                const k = key(m.ref);
                drop(k);
                const l = { client: id, ref: m.ref, kind: m.op === 'asset' ? 'asset' : m.kind, msg: m, uniforms: {}, binds: {}, anims: {}, order: order++, t0: performance.now(), dirty: true, tex: null, scene: scenes[m.target] };
                if (l.kind === 'asset') { l.bpp = m.format === 'r8' ? 1 : 4; l.w = m.w; l.h = m.h; l.px = new Uint8Array(m.w * m.h * l.bpp); }
                if (l.kind === 'image') { l.bpp = 4; l.w = m.iw || m.w || 1; l.h = m.ih || m.h || 1; l.px = new Uint8Array(l.w * l.h * 4); }
                layers.set(k, l); mine.add(k);
                if (l.kind !== 'asset') {
                    ev(c, { ev: 'layer', ref: m.ref, state: 'shown' });
                    ev(c, { ev: 'target', target: m.target, state: 'shown' });
                }
                return;
            }
            const l = layers.get(key(m.ref));
            if (!l) return;
            if (m.op === 'set') Object.assign(l.msg, m);
            else if (m.op === 'uniform') l.uniforms[m.name] = { v: String(m.v).trim().split(/\s+/).map(Number), type: m.type || null };
            else if (m.op === 'bind') l.binds[m.sampler] = key(m.asset);
            else if (m.op === 'animate') l.anims[m.anim] = Object.assign({ t0: performance.now() }, m);
            else if (m.op === 'stop') delete l.anims[m.anim];
            else if (m.op === 'drop') { drop(key(m.ref)); mine.delete(key(m.ref)); }
        }
        function onFrame(b) {
            const ref = b.readUInt32LE(0), n = b.readUInt16LE(12), l = layers.get(key(ref));
            if (!l || !l.px) return;
            let p = 14 + n * 8;
            if (!n) { l.px.set(b.subarray(p, p + l.px.length)); l.dirty = true; return; }
            for (let i = 0; i < n; i++) {
                const x = b.readUInt16LE(14 + i * 8), y = b.readUInt16LE(16 + i * 8), w = b.readUInt16LE(18 + i * 8), h = b.readUInt16LE(20 + i * 8);
                for (let r = 0; r < h; r++) { l.px.set(b.subarray(p, p + w * l.bpp), ((y + r) * l.w + x) * l.bpp); p += w * l.bpp; }
            }
            l.dirty = true;
        }
    });

    function drop(k) {
        const l = layers.get(k);
        if (!l) return;
        if (l.tex && l.scene && l.scene.gl) l.scene.gl.deleteTexture(l.tex);
        layers.delete(k);
    }
    function texture(l) {
        const sc = l.scene, gl = sc.gl;
        if (!l.tex) l.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, l.tex);
        if (l.dirty) {
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            const fmt = l.bpp === 1 ? gl.LUMINANCE : gl.RGBA;
            gl.texImage2D(gl.TEXTURE_2D, 0, fmt, l.w, l.h, 0, fmt, gl.UNSIGNED_BYTE, l.px);
            const lin = (l.msg.sampling || 'nearest') === 'bilinear' ? gl.LINEAR : gl.NEAREST;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
            const wrap = l.msg.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
            l.dirty = false;
        }
        return l.tex;
    }
    /** An animation's value now (the renderer plays it: keys 't:v[,v..]', linear or step, looped or held). */
    function animValue(an, now) {
        if (!an._keys) an._keys = String(an.keys).trim().split(/\s+/).map((x) => { const [t, v] = x.split(':'); return [Number(t), v.split(',').map(Number)]; });
        const keys = an._keys, end = keys[keys.length - 1][0];
        let ms = now - an.t0;
        ms = an.loop && end > 0 ? ms % end : Math.min(ms, end);
        if (ms <= keys[0][0]) return keys[0][1];
        for (let i = 1; i < keys.length; i++) {
            if (ms > keys[i][0]) continue;
            if (an.interp === 'step') return keys[i - 1][1];
            const f = (ms - keys[i - 1][0]) / Math.max(1, keys[i][0] - keys[i - 1][0]);
            return keys[i - 1][1].map((v, j) => v + (keys[i][1][j] - v) * f);
        }
        return keys[keys.length - 1][1];
    }
    function angle(l, now) {
        let a = l.msg.rotate || 0;
        Object.keys(l.anims).forEach((k) => { const an = l.anims[k]; if (an.property === 'rotate') a = animValue(an, now)[0]; });
        return a;
    }

    function drawScene(sc, now) {
        const gl = sc.gl;
        gl.viewport(0, 0, sc.w, sc.h);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (state.hidden[sc.name]) return 0;
        gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, sc.buf);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const list = [];
        layers.forEach((l) => { if (l.scene === sc && (l.kind === 'effect' || l.kind === 'image')) list.push(l); });
        list.sort((a, b) => (KIND[a.msg.class || 'content'] - KIND[b.msg.class || 'content']) || ((a.msg.z || 0) - (b.msg.z || 0)) || (a.order - b.order));
        let n = 0;
        list.forEach((l) => {
            const m = l.msg;
            if (m.visible === 0 || m.visible === false) return;
            const x = m.x || 0, y = m.y || 0, w = m.w || sc.w, h = m.h || sc.h;
            const e = sc.prog(l.kind === 'effect' ? m.fs : IMG_FS);
            if (e.bad) return;
            gl.useProgram(e.p);
            gl.uniform4f(sc.loc(e, 'u_rect'), x, y, w, h);
            gl.uniform3f(sc.loc(e, 'u_turn'), x + (m.px != null ? m.px : w / 2), y + (m.py != null ? m.py : h / 2), angle(l, now));
            gl.uniform2f(sc.loc(e, 'u_scale'), m.sx != null ? m.sx : 1, m.sy != null ? m.sy : 1);
            gl.uniform2f(sc.loc(e, 'u_tsize'), sc.w, sc.h);
            let unit = 0;
            if (l.kind === 'image') {
                gl.activeTexture(gl.TEXTURE0); texture(l);
                gl.uniform1i(sc.loc(e, 'u_img'), 0);
                gl.uniform1f(sc.loc(e, 'u_opacity'), m.opacity != null ? m.opacity : 1);
            } else {
                const ut = sc.loc(e, 'u_time');
                if (ut) gl.uniform1f(ut, ((now - l.t0) / 1000) % 3600);
                Object.keys(l.uniforms).forEach((nm) => {
                    const u = l.uniforms[nm], v = u.v;
                    const loc = sc.loc(e, nm + '[0]') || sc.loc(e, nm);
                    if (!loc) return;
                    const t = u.type || [null, 'float', 'vec2', 'vec3', 'vec4'][v.length] || 'vec4';
                    if (t === 'float') gl.uniform1fv(loc, v); else if (t === 'vec2') gl.uniform2fv(loc, v);
                    else if (t === 'vec3') gl.uniform3fv(loc, v); else if (t === 'vec4') gl.uniform4fv(loc, v);
                    else if (t === 'mat4') gl.uniformMatrix4fv(loc, false, v);
                });
                Object.keys(l.anims).forEach((k) => {
                    const an = l.anims[k];
                    if (an.property !== 'uniform' || !an.name) return;
                    const loc = sc.loc(e, an.name), v = animValue(an, now);
                    if (!loc) return;
                    if (v.length === 1) gl.uniform1f(loc, v[0]); else if (v.length === 3) gl.uniform3fv(loc, v); else if (v.length === 4) gl.uniform4fv(loc, v);
                });
                Object.keys(l.binds).forEach((s) => {
                    const a = layers.get(l.binds[s]);
                    if (!a || a.scene !== sc) return;
                    gl.activeTexture(gl.TEXTURE0 + unit); texture(a);
                    gl.uniform1i(sc.loc(e, s), unit); unit++;
                });
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            n++;
        });
        return n;
    }

    return {
        state,
        scenes,
        draw() {
            const now = performance.now();
            const out = {};
            Object.keys(scenes).forEach((k) => { if (scenes[k].ok) out[k] = drawScene(scenes[k], now); });
            return out;
        },
        /** Visible layers with something drawn, per target (what the KOMBI would show). */
        visible(target) {
            let n = 0;
            layers.forEach((l) => { if (l.msg.target === target && l.kind !== 'asset' && !(l.msg.visible === 0 || l.msg.visible === false)) n++; });
            return n;
        },
        /** Layers per target, for the page's status line. */
        count() {
            const out = {};
            layers.forEach((l) => { if (l.kind !== 'asset') out[l.msg.target] = (out[l.msg.target] || 0) + 1; });
            return out;
        },
        errors() { const e = []; Object.keys(scenes).forEach((k) => e.push.apply(e, scenes[k].errors)); return e; },
        T0,
    };
}

module.exports = { start, SOCK, TARGETS };
