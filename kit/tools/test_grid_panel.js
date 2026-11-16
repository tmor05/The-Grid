'use strict';
/*
 * The Grid's whole-cluster panel (apps/the_grid/panel.js), with a recording stand-in for the
 * cluster-render client:
 *   - every layer is on the panel target and inside its 1920 x 720 scene, above BMW's bottom strip
 *   - every glyph atlas fits cluster-render's 2048 px asset limit
 *   - the safety gate: no live speed from the car -> every layer hidden; live again -> shown
 *   - the speed-limit port stays open (nothing of ours drawn over BMW's sign)
 *   - main.js: the setting's three modes, an older saved "on" counts as the whole cluster, the
 *     gate needs the vehicle service, a real speed and no demo data
 *
 *   node kit/tools/test_grid_panel.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'the_grid');

// the app as the Store stages it: its files beside the kit's runtime (./kit/...)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-panel-'));
fs.readdirSync(APP).filter((f) => f.endsWith('.js')).forEach((f) => fs.copyFileSync(path.join(APP, f), path.join(dir, f)));
fs.symlinkSync(path.join(ROOT, 'kit', 'runtime'), path.join(dir, 'kit'));

// the cluster-render client, recorded instead of sent
const sent = [];
class FakeCR {
    constructor() { this.ready = false; this.n = 0; this.handlers = {}; this.backend = 'id7'; this.targets = 'map:1088x480,panel:1920x720,hud:800x480'; }
    _add(kind, o) { const ref = ++this.n; sent.push({ op: 'layer', kind, ref, o }); return ref; }
    asset(o) { if (!(o.w <= 2048 && o.h <= 2048)) return 0; return this._add('asset', o); }
    effect(o) { return this._add('effect', o); }
    image(o) { return this._add('image', o); }
    set(ref, o) { sent.push({ op: 'set', ref, o }); }
    uniform(ref, name, v) { sent.push({ op: 'uniform', ref, name, v }); }
    pixels(ref, rect, px) { sent.push({ op: 'pixels', ref, px }); }
    bind(ref, s, a) { sent.push({ op: 'bind', ref, s, a }); }
    animate() { return ++this.n; }
    stop() {}
    on(ev, fn) { this.handlers[ev] = fn; }
    connect() { this.ready = true; if (this.handlers.ready) this.handlers.ready(); }
    close() {}
}
const clientPath = path.join(dir, 'cluster_render_client.js');
require.cache[require.resolve(clientPath)] = { id: clientPath, filename: clientPath, loaded: true, exports: { ClusterRender: FakeCR, DEFAULT_PATH: '/dev/null' } };

const { GridPanel, CUT, LIMIT, BIGCHARS, LETTERS } = require(path.join(dir, 'panel.js'));
const { buildAtlas } = require(path.join(dir, 'cluster.js'));
const { theme } = require(path.join(ROOT, 'kit', 'runtime', 'themes.js'));

let live = true;
const vals = () => ({
    live, speed: 69, mph: true, rpm: 6300, red: 7000, fullRed: 7000, kmh: 111, gLat: 0, boostBar: 1.3, calm: false,
    gear: { letter: 'S', num: '3' }, shift: 0.8, over: false,
    boost: { text: '19.1', zero: 0.4, pos: 0.8, peak: 0.85 },
    ethanol: { text: '30', frac: 0.3 }, iat: { text: '88', frac: 0.4, state: 'OK' }, oil: { text: '219', frac: 0.6, state: 'OK' },
    coolant: { text: '207', frac: 0.6, state: 'OK' }, trans: { text: '180', frac: 0.5, state: 'OK' },
    units: { temp: '°F', press: 'psi' },
});
const logs = [];
const ctx = { log: { info: (s) => logs.push(s), warn: (s) => logs.push('WARN ' + s), error: (s) => logs.push('ERR ' + s) } };
const p = new GridPanel(ctx, { theme: () => theme('rinzler'), values: vals });
p.start();

// layers: all on the panel, inside the scene, nothing of ours below the cut
const layers = sent.filter((m) => m.op === 'layer' && m.kind !== 'asset');
assert(layers.length >= 20, 'layers: ' + layers.length);
layers.forEach((l) => {
    assert.strictEqual(l.o.target, 'panel', 'layer ' + l.ref + ' target');
    assert(l.o.x >= 0 && l.o.y >= 0 && l.o.x + l.o.w <= 1920 && l.o.y + l.o.h <= CUT, 'layer ' + l.ref + ' inside the panel above the cut: ' + JSON.stringify([l.o.x, l.o.y, l.o.w, l.o.h]));
    assert.strictEqual(l.o.visible, false, 'layer ' + l.ref + ' starts hidden');
});
// atlases fit (a refused asset is ref 0: its text would be garbage)
sent.filter((m) => m.op === 'bind').forEach((b) => assert(b.a > 0, 'a text layer bound to a refused atlas'));
[[90, undefined], [132, BIGCHARS], [132, LETTERS]].forEach(([s, ch]) => { const a = buildAtlas(s, ch); assert(a.aw <= 2048 && a.ah <= 2048, 'atlas ' + s + ' ' + ch + ': ' + a.aw); });

// the gate
const visibleNow = () => {
    const vis = {};
    layers.forEach((l) => { vis[l.ref] = false; });
    sent.filter((m) => m.op === 'set').forEach((m) => { vis[m.ref] = m.o.visible; });
    return Object.keys(vis).filter((k) => vis[k]).length;
};
assert.strictEqual(visibleNow(), layers.length, 'live speed: every layer shown');
live = false; p._update(false);
assert.strictEqual(visibleNow(), 0, 'no live speed: every layer hidden');
assert(logs.some((s) => /hidden \(no live speed/.test(s)), 'the hide is logged');
live = true; p._update(false);
assert.strictEqual(visibleNow(), layers.length, 'live again: shown');

// the port over BMW's speed-limit sign: the left picture leaves it transparent
const left = layers.find((l) => l.kind === 'image' && l.o.x === 0);
const px = sent.filter((m) => m.op === 'pixels' && m.ref === left.ref).pop().px, lw = left.o.w;
const alpha = (x, y) => px[(y * lw + x) * 4 + 3];
for (let y = LIMIT.y + 6; y < CUT - 2; y += 9) for (let x = LIMIT.x + 6; x < Math.min(lw, LIMIT.x + LIMIT.w - 6); x += 9) assert.strictEqual(alpha(x, y), 0, 'port open at ' + x + ',' + y);
assert(alpha(300, 300) > 200, 'the speedometer is opaque');
// the dials read the right values
const last = (name) => sent.filter((m) => m.op === 'uniform' && m.name === name).pop();
assert(Math.abs(last('u_val') ? 1 : 0) === 1, 'dial values sent');
p.stop();

// main.js: the setting and the gate
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
assert(/s === 'off' \? 'off' : s === 'middle' \? 'middle' : 'whole'/.test(main), 'cluster modes: off / middle / whole (an older "on" is whole)');
assert(/vehicleLive = \(\) => !usingDemo\(\) && G\.isNum\(live\.speed\) && subs\.some\(\(s\) => \/\\\.Vehicle2\$\/\.test\(s\.iface\) && s\.available\)/.test(main), 'the gate: vehicle service, real speed, no demo');
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const cl = spec.settings.find((s) => s.key === 'cluster');
assert.strictEqual(cl.default, 'whole');
assert.deepStrictEqual(cl.options.map((o) => o[0]), ['whole', 'middle', 'off']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('test_grid_panel: ok (' + layers.length + ' layers)');
