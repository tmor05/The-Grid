'use strict';
/**
 * grid_cluster_preview.js - what The Grid sends to the instrument cluster, drawn on the PC.
 *
 *   node kit/tools/grid_cluster_preview.js <out.png> [--set key=value ...] [--seconds N] [--at T,T2]
 *
 * Builds nothing: run kit/tools/build.py the_grid first. It stands in for cluster-render
 * (idrive-apps native/cluster-render, PROTOCOL.md): a socket that answers hello and reports the
 * map target shown, and records every layer, asset, picture, uniform, bind and animation the
 * app's cluster client sends while kit/tools/preview.js runs the app (demo data) for N seconds
 * (default 4). Then a WebGL page plays that back the way the service builds its scene: effect
 * quads with the app's own GLSL ES 1.00 shaders and its uniforms, image quads, the r8 glyph
 * atlas, the renderer's rotations, in the stack's order (class, z, newest on top), at T seconds
 * of renderer time (default 1). The map area is drawn into a mock of the cluster (BMW's gauges
 * as grey placeholders) at (416, 120), as on iDrive 7. --raw writes the 1088 x 480 area alone.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'cluster.png');
const sets = [];
let seconds = 4, at = [1], raw = false;
for (let i = 1; i < args.length; i++) {
    if (args[i] === '--set') sets.push('--set', args[++i]);
    else if (args[i] === '--seconds') seconds = Number(args[++i]);
    else if (args[i] === '--at') at = args[++i].split(',').map(Number);
    else if (args[i] === '--raw') raw = true;
}

/* ---------- the stand-in service ---------- */
const sock = path.join(os.tmpdir(), 'grid-cr-' + process.pid + '.sock');
const layers = new Map();
let order = 0, msgs = 0, bytes = 0;
function msg(type, body) { const m = Buffer.alloc(5 + body.length); m.writeUInt32LE(body.length + 1, 0); m[4] = type; body.copy(m, 5); return m; }
const ev = (c, o) => c.write(msg(0x4a, Buffer.from(JSON.stringify(o))));

function onJson(c, o) {
    if (o.op === 'hello') { ev(c, { ev: 'hello', proto: 1, backend: 'id7', targets: 'map 1088x480, panel 1920x720, hud 800x480' }); return; }
    if (o.op === 'layer' || o.op === 'asset') {
        const l = { kind: o.op === 'asset' ? 'asset' : o.kind, msg: o, uniforms: {}, binds: {}, anims: {}, order: order++ };
        if (l.kind === 'asset') { l.bpp = o.format === 'r8' ? 1 : 4; l.w = o.w; l.h = o.h; l.px = Buffer.alloc(o.w * o.h * l.bpp); }
        if (l.kind === 'image') { l.bpp = 4; l.w = o.iw; l.h = o.ih; l.px = Buffer.alloc(o.iw * o.ih * 4); }
        layers.set(o.ref, l);
        if (l.kind !== 'asset') { ev(c, { ev: 'layer', ref: o.ref, state: 'shown' }); ev(c, { ev: 'target', target: o.target, state: 'shown' }); }
    } else if (o.op === 'set') { const l = layers.get(o.ref); if (l) Object.assign(l.msg, o); }
    else if (o.op === 'uniform') { const l = layers.get(o.ref); if (l) l.uniforms[o.name] = { v: o.v.split(' ').map(Number), type: o.type || null }; }
    else if (o.op === 'bind') { const l = layers.get(o.ref); if (l) l.binds[o.sampler] = o.asset; }
    else if (o.op === 'animate') { const l = layers.get(o.ref); if (l) l.anims[o.anim] = o; }
    else if (o.op === 'drop') layers.delete(o.ref);
}
function onFrame(b) {
    const ref = b.readUInt32LE(0), n = b.readUInt16LE(12), l = layers.get(ref);
    if (!l || !l.px) return;
    let off = 14 + n * 8;
    if (!n) { b.copy(l.px, 0, off, off + l.px.length); return; }
    for (let i = 0; i < n; i++) {
        const x = b.readUInt16LE(14 + i * 8), y = b.readUInt16LE(16 + i * 8), w = b.readUInt16LE(18 + i * 8), h = b.readUInt16LE(20 + i * 8);
        for (let r = 0; r < h; r++) { b.copy(l.px, ((y + r) * l.w + x) * l.bpp, off, off + w * l.bpp); off += w * l.bpp; }
    }
}
const server = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        let o = 0;
        while (buf.length - o >= 5) {
            const len = buf.readUInt32LE(o);
            if (buf.length - o < 4 + len) break;
            const type = buf[o + 4], body = buf.slice(o + 5, o + 4 + len);
            o += 4 + len; msgs++; bytes += 4 + len;
            if (type === 0x4a) { try { onJson(c, JSON.parse(body.toString('utf8'))); } catch (e) { console.error('bad json', e.message); } }
            else if (type === 0x46) onFrame(body);
        }
        buf = buf.slice(o);
    });
    c.on('error', () => {});
});

function runApp() {
    return new Promise((resolve) => {
        const pv = path.join(os.tmpdir(), 'grid-cr-pv-' + process.pid);
        const ch = spawn(process.execPath, [path.join(ROOT, 'kit', 'tools', 'preview.js'), path.join(ROOT, 'dist', 'the_grid'), pv, 'wait=' + seconds].concat(sets),
            { env: Object.assign({}, process.env, { CLUSTER_RENDER_SOCK: sock }), stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        ch.stdout.on('data', (d) => { log += d; });
        ch.stderr.on('data', (d) => { log += d; });
        ch.on('exit', () => resolve(log));
    });
}

/* ---------- the page: the service's scene in WebGL ---------- */
const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="gl" width="1088" height="480"></canvas><canvas id="out" width="1920" height="720"></canvas>
<script>
const KIND = { ambient: 0, content: 1, overlay: 2, alert: 3 };
const VS = 'attribute vec2 a_position; uniform vec4 u_rect; uniform vec3 u_turn; varying vec2 v_uv;' +
  'void main(){ v_uv = a_position; vec2 p = u_rect.xy + a_position * u_rect.zw; vec2 q = p - u_turn.xy;' +
  'float a = radians(u_turn.z); p = u_turn.xy + vec2(q.x*cos(a) - q.y*sin(a), q.x*sin(a) + q.y*cos(a));' +
  'gl_Position = vec4(p.x / 1088.0 * 2.0 - 1.0, 1.0 - p.y / 480.0 * 2.0, 0.0, 1.0); }';
const IMG_FS = 'precision mediump float; uniform sampler2D u_img; varying vec2 v_uv; void main(){ gl_FragColor = texture2D(u_img, v_uv); }';
function angle(l, t) {
  let a = l.msg.rotate || 0;
  Object.values(l.anims).forEach((an) => {
    if (an.property !== 'rotate') return;
    const keys = an.keys.trim().split(/\\s+/).map((k) => k.split(':').map(Number));
    const end = keys[keys.length - 1][0]; let ms = t * 1000; if (an.loop) ms = ms % end; else ms = Math.min(ms, end);
    for (let i = 1; i < keys.length; i++) if (ms <= keys[i][0]) { const f = (ms - keys[i-1][0]) / (keys[i][0] - keys[i-1][0]); a = keys[i-1][1] + (keys[i][1] - keys[i-1][1]) * f; break; }
  });
  return a;
}
window.draw = function (state, t) {
  const cv = document.getElementById('gl'), gl = cv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  const errs = [];
  function prog(fs) {
    const p = gl.createProgram();
    [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]].forEach(([k, src]) => {
      const s = gl.createShader(k); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) errs.push(gl.getShaderInfoLog(s) + '\\n' + src.split('\\n').slice(0, 3).join(' '));
      gl.attachShader(p, s);
    });
    gl.bindAttribLocation(p, 0, 'a_position'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) errs.push('link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  const tex = {};
  function texture(ref) {
    if (tex[ref]) return tex[ref];
    const a = state.layers[ref], t2 = gl.createTexture(), px = Uint8Array.from(atob(a.px), (c) => c.charCodeAt(0));
    gl.bindTexture(gl.TEXTURE_2D, t2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const fmt = a.bpp === 1 ? gl.LUMINANCE : gl.RGBA;
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, a.w, a.h, 0, fmt, gl.UNSIGNED_BYTE, px);
    const lin = (a.msg.sampling || 'nearest') === 'bilinear' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return (tex[ref] = t2);
  }
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, 1088, 480); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const list = Object.keys(state.layers).map((r) => Object.assign({ ref: r }, state.layers[r])).filter((l) => l.kind === 'effect' || l.kind === 'image');
  list.sort((a, b) => (KIND[a.msg.class || 'content'] - KIND[b.msg.class || 'content']) || ((a.msg.z || 0) - (b.msg.z || 0)) || (a.order - b.order));
  list.forEach((l) => {
    if (l.msg.visible === 0) return;
    const m = l.msg, x = m.x || 0, y = m.y || 0, w = m.w || 1088, h = m.h || 480;
    const p = prog(l.kind === 'effect' ? m.fs : IMG_FS); gl.useProgram(p);
    gl.uniform4f(gl.getUniformLocation(p, 'u_rect'), x, y, w, h);
    gl.uniform3f(gl.getUniformLocation(p, 'u_turn'), x + (m.px != null ? m.px : w / 2), y + (m.py != null ? m.py : h / 2), angle(l, t));
    let unit = 0;
    if (l.kind === 'image') { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture(l.ref)); gl.uniform1i(gl.getUniformLocation(p, 'u_img'), 0); }
    else {
      const ut = gl.getUniformLocation(p, 'u_time'); if (ut) gl.uniform1f(ut, t);
      Object.keys(l.uniforms).forEach((n) => {
        const u = l.uniforms[n], v = u.v;
        if (u.type) { const loc = gl.getUniformLocation(p, n + '[0]') || gl.getUniformLocation(p, n); if (!loc) return;
          ({ float: () => gl.uniform1fv(loc, v), vec2: () => gl.uniform2fv(loc, v), vec3: () => gl.uniform3fv(loc, v), vec4: () => gl.uniform4fv(loc, v), mat4: () => gl.uniformMatrix4fv(loc, false, v) })[u.type]();
        } else { const loc = gl.getUniformLocation(p, n); if (!loc) return; [null, gl.uniform1fv, gl.uniform2fv, gl.uniform3fv, gl.uniform4fv][v.length].call(gl, loc, v); }
      });
      Object.keys(l.binds).forEach((s) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture(l.binds[s])); gl.uniform1i(gl.getUniformLocation(p, s), unit); unit++; });
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  });
  // the cluster round it: BMW's gauges as grey placeholders, the map area at (416, 120)
  const o = document.getElementById('out').getContext('2d');
  o.fillStyle = '#000'; o.fillRect(0, 0, 1920, 720);
  o.strokeStyle = '#2a2d33'; o.lineWidth = 18;
  o.beginPath(); o.arc(220, 380, 190, Math.PI * 0.75, Math.PI * 2.25); o.stroke();
  o.beginPath(); o.arc(1700, 380, 190, Math.PI * 0.75, Math.PI * 2.25); o.stroke();
  o.fillStyle = '#3a3e45'; o.font = '22px sans-serif'; o.textAlign = 'center';
  o.fillText("BMW speedometer", 220, 390); o.fillText("BMW tachometer", 1700, 390);
  o.drawImage(cv, 416, 120);
  return errs;
};
</script></body></html>`;

async function render(state) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 720 } });
    await page.setContent(PAGE);
    for (let i = 0; i < at.length; i++) {
        const errs = await page.evaluate(([s, t]) => window.draw(s, t), [state, at[i]]);
        if (errs.length) console.log('shader errors:\n' + errs.join('\n'));
        const file = at.length > 1 ? out.replace(/\.png$/, '-' + at[i] + 's.png') : out;
        const el = await page.$(raw ? '#gl' : '#out');
        await el.screenshot({ path: file });
        console.log('wrote ' + file);
    }
    await browser.close();
}

server.listen(sock, async () => {
    const log = await runApp();
    server.close();
    try { fs.unlinkSync(sock); } catch (e) { /* gone */ }
    const errors = log.split('\n').filter((l) => /cluster|Error|error/.test(l) && !/TASU|preview\)/.test(l));
    if (errors.length) console.log(errors.slice(0, 12).join('\n'));
    const state = { layers: {} };
    layers.forEach((l, ref) => {
        state.layers[ref] = { kind: l.kind, msg: l.msg, uniforms: l.uniforms, binds: l.binds, anims: l.anims, order: l.order, w: l.w, h: l.h, bpp: l.bpp,
            px: l.px ? l.px.toString('base64') : null };
    });
    const kinds = {};
    layers.forEach((l) => { kinds[l.kind] = (kinds[l.kind] || 0) + 1; });
    console.log('recorded ' + msgs + ' messages, ' + Math.round(bytes / 1024) + ' KiB: ' + JSON.stringify(kinds));
    if (!layers.size) { console.log('nothing reached the stand-in service'); process.exit(1); }
    await render(state);
});
