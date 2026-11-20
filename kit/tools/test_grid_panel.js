'use strict';
/*
 * The Grid's whole-cluster panel (apps/the_grid/panel.js), with a recording stand-in for the
 * cluster-render client:
 *   - every layer is on the panel target and inside its 1920 x 720 scene, above BMW's bottom strip
 *   - nothing drawn under the cut (setting "Cluster bottom edge"): only the ground shader reaches it
 *   - pixel memory well under cluster-render's shared 16 MB
 *   - the fuel tile: litres -> gallons, warn / crit colours when low
 *   - the dials' numbers clear the tick marks and each other, for mph, km/h and every tach top
 *   - every glyph atlas fits cluster-render's 2048 px asset limit, and its width is a multiple of 4
 *     (the KOMBI reads r8 rows 4 bytes at a time; an 810 px atlas drew the gear letters sheared)
 *   - the safety gate: no live speed from the car -> every layer hidden; live again -> shown
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

const { GridPanel, CUTS, CUT_MAX, FADE, BIGCHARS, LETTERS } = require(path.join(dir, 'panel.js'));
const { buildAtlas } = require(path.join(dir, 'cluster.js'));
const { theme } = require(path.join(ROOT, 'kit', 'runtime', 'themes.js'));

let live = true, cut = 660, fuel = { text: '12.4', unit: 'GAL', frac: 0.72, low: false, empty: false };
const vals = () => ({
    live, cut, fuel, rpmMax: 8000, speed: 69, mph: true, rpm: 6300, red: 7000, fullRed: 7000, kmh: 111, gLat: 0, boostBar: 1.3, calm: false,
    gear: { letter: 'S', num: '3' }, shift: 0.8, over: false,
    boost: { text: '19.1', zero: 0.4, pos: 0.8, peak: 0.85 },
    fuelTile: { text: '2320', frac: 0.6, label: 'HPFP', code: 'RAIL', unit: 'psi' }, iat: { text: '88', frac: 0.4, state: 'OK' }, oil: { text: '219', frac: 0.6, state: 'OK' },
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
    assert(l.o.x >= 0 && l.o.y >= 0 && l.o.x + l.o.w <= 1920 && l.o.y + l.o.h <= CUT_MAX, 'layer ' + l.ref + ' inside the panel above the lowest cut: ' + JSON.stringify([l.o.x, l.o.y, l.o.w, l.o.h]));
    assert.strictEqual(l.o.visible, false, 'layer ' + l.ref + ' starts hidden');
});
// atlases fit (a refused asset is ref 0: its text would be garbage)
sent.filter((m) => m.op === 'bind').forEach((b) => assert(b.a > 0, 'a text layer bound to a refused atlas'));
[[90, undefined], [132, BIGCHARS], [132, LETTERS]].forEach(([s, ch]) => { const a = buildAtlas(s, ch); assert(a.aw <= 2048 && a.ah <= 2048, 'atlas ' + s + ' ' + ch + ': ' + a.aw); });
// r8 rows a multiple of 4 bytes: the KOMBI uploads with GL's default unpack alignment (4), so an
// 810 px atlas (0.4.1-0.4.8's gear letters) is read 2 bytes late each row and draws sheared on the car
const HCHARS = fs.readFileSync(path.join(APP, 'headup.js'), 'utf8').match(/HCHARS = '([^']+)'/)[1];
[[90, undefined], [132, BIGCHARS], [132, LETTERS], [90, HCHARS]].forEach(([s, ch]) => {
    const a = buildAtlas(s, ch);
    assert.strictEqual(a.aw % 4, 0, 'atlas ' + s + ' ' + (ch || 'digits') + ' width ' + a.aw + ' is not a multiple of 4: it shears on the car');
    assert.strictEqual(a.px.length, a.aw * a.ah, 'atlas ' + s + ' pixels match its size');
});
sent.filter((m) => m.op === 'layer' && m.kind === 'asset' && m.o.format === 'r8').forEach((m) => assert.strictEqual(m.o.w % 4, 0, 'r8 asset ' + m.ref + ' width ' + m.o.w + ' shears on the car'));
// the gear letters, as the car's GPU reads them: each glyph's own cell, nothing sheared into the next
{
    const a = buildAtlas(132, LETTERS), stride = Math.ceil(a.aw / 4) * 4;
    assert.strictEqual(stride, a.aw, 'letters atlas read row for row');
}

// the gate
const visibleNow = () => {
    const vis = {};
    layers.forEach((l) => { vis[l.ref] = false; });
    sent.filter((m) => m.op === 'set' && 'visible' in m.o).forEach((m) => { vis[m.ref] = m.o.visible; });
    return Object.keys(vis).filter((k) => vis[k]).length;
};
assert.strictEqual(visibleNow(), layers.length, 'live speed: every layer shown');
live = false; p._update(false);
assert.strictEqual(visibleNow(), 0, 'no live speed: every layer hidden');
assert(logs.some((s) => /hidden \(no live speed/.test(s)), 'the hide is logged');
live = true; p._update(false);
assert.strictEqual(visibleNow(), layers.length, 'live again: shown');

// the cut: only the ground shader reaches it (transparent from u_cut down); every picture and
// every other layer ends above the highest cut's fade, so nothing of ours is under the cut
const { GROUND_FS } = require(path.join(dir, 'panel.js'));
assert(/1\.0 - smoothstep\(u_cut - FADE, u_cut, q\.y\)/.test(GROUND_FS), 'the ground fades out at u_cut');
const ground = layers.find((l) => l.kind === 'effect' && l.o.fs === GROUND_FS);
assert(ground && ground.o.x === 0 && ground.o.w === 1920, 'the ground is the panel wide');
layers.filter((l) => l !== ground).forEach((l) => assert(l.o.y + l.o.h <= Math.min.apply(null, CUTS) - FADE, 'layer ' + l.ref + ' ends above the cut: ' + (l.o.y + l.o.h)));
const lastCut = () => sent.filter((m) => m.op === 'uniform' && m.ref === ground.ref && m.name === 'u_cut').pop().v[0];
assert.strictEqual(lastCut(), 660);
cut = 672; p._update(false); assert.strictEqual(lastCut(), 672);
cut = 648; p._update(false); assert.strictEqual(lastCut(), 648);
cut = 999; p._update(false); assert.strictEqual(lastCut(), 660, 'an unknown value: the default');
cut = 660; p._update(false);
// pixel memory: cluster-render's 16 MB is shared by every client (the HUD, other apps); image layers
// and uncompressed assets count twice. 0.4.3 at ~15.5 MB lost its letter atlas on the car.
const assets = sent.filter((m) => m.op === 'layer' && m.kind === 'asset');
const imgBytes = layers.filter((l) => l.kind === 'image').reduce((n, l) => n + l.o.w * l.o.h * 4 * 2, 0);
const assetBytes = assets.reduce((n, a) => n + a.o.w * a.o.h * (a.o.format === 'r8' ? 1 : 4) * 2, 0);
const MB = (imgBytes + assetBytes) / 1e6;
assert(MB < 11, 'pixel memory ' + MB.toFixed(2) + ' MB (keep well under the shared 16 MB)');
// the pictures are transparent round what they hold (the ground is under them)
const left = layers.find((l) => l.kind === 'image' && l.o.x < 100), pxL = sent.filter((m) => m.op === 'pixels' && m.ref === left.ref).pop().px;
assert.strictEqual(pxL[(2 * left.o.w + 2) * 4 + 3], 0, 'the speedometer picture is transparent in its corner');
// the fuel tile
const lastU = (ref, name) => sent.filter((m) => m.op === 'uniform' && m.ref === ref && m.name === name).pop();
const fuelText = sent.find((m) => m.op === 'layer' && m.kind === 'effect' && m.o.x === 384 + 14 && m.o.h > 8);
assert(fuelText, 'the fuel tile has a value');
const fuelBar = sent.find((m) => m.op === 'layer' && m.kind === 'effect' && m.o.x === 384 + 14 && m.o.h === 8);
assert(fuelBar, 'the fuel tile has a bar');
assert.deepStrictEqual(lastU(fuelBar.ref, 'u_bar').v, [0.72, 12]);
const ac = require(path.join(dir, 'cluster.js')).col3(theme('rinzler').accent), warnC = require(path.join(dir, 'cluster.js')).col3(theme('rinzler').warn);
assert.deepStrictEqual(lastU(fuelBar.ref, 'u_c').v, ac, 'fuel bar in the accent when not low');
fuel = { text: '1.9', unit: 'GAL', frac: 0.11, low: true, empty: false }; p._update(false);
assert.deepStrictEqual(lastU(fuelBar.ref, 'u_c').v, warnC, 'fuel bar warns when low');
fuel = { text: null, frac: null }; p._update(false);
assert.strictEqual(lastU(fuelBar.ref, 'u_bar').v[0], -1, 'no tank value: an empty bar');
// the dials read the right values
const last = (name) => sent.filter((m) => m.op === 'uniform' && m.name === name).pop();
assert(Math.abs(last('u_val') ? 1 : 0) === 1, 'dial values sent');
p.stop();

// main.js: the setting and the gate
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
assert(/s === 'off' \? 'off' : s === 'middle' \? 'middle' : 'whole'/.test(main), 'cluster modes: off / middle / whole (an older "on" is whole)');
assert(/vehicleLive = \(\) => !usingDemo\(\) && G\.isNum\(live\.speed\) && subs\.some\(\(s\) => \/\\\.Vehicle2\$\/\.test\(s\.iface\) && s\.available\)/.test(main), 'the gate: vehicle service, real speed, no demo');
assert(/'de\.bmw\.infotainment\.KombiIF', \{\s*statusRangeTankStatus/.test(main) && /numOf\(deepField\(v, 'fluidLevelFuelTank'\)\)/.test(main), 'the tank level from the KOMBI, at any depth, text numbers too');
assert(/TANK_L = 65/.test(main) && /\(l \* 0\.264172\)\.toFixed\(1\)/.test(main), 'the X4 M tank, gallons with mph');
assert(/\.\(TPMS\|KombiIF\)\$/.test(main), 'the KOMBI is read every 10 s too');
const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const cl = spec.settings.find((s) => s.key === 'cluster');
assert.strictEqual(cl.default, 'whole');
assert.deepStrictEqual(cl.options.map((o) => o[0]), ['whole', 'middle', 'off']);
const edge = spec.settings.find((s) => s.key === 'clusterEdge');
assert.strictEqual(edge.default, '660');
assert.deepStrictEqual(edge.options.map((o) => parseInt(o[0], 10)).sort(), CUTS.slice().sort(), 'the edge options are the panel\'s cuts');
// every interface main.js watches is declared in app.json "signals" (0.4.3 / 0.4.4 left the KOMBI out: no fuel on the car)
const watched = Array.from(main.matchAll(/^\s*\['((?:de|com)\.[A-Za-z0-9.]+)', \{/gm)).map((m) => m[1]);
assert(watched.length >= 8, 'found the watch list');
watched.forEach((i) => assert(spec.signals[i], i + ' is watched but not in app.json "signals"'));
assert(spec.signals['de.bmw.infotainment.KombiIF'].statusRangeTankStatus, 'the tank field is declared');
// the gearbox temperature is read in fast rounds too (the cluster keeps the poll fast; 0.4.1 - 0.4.4 never read it)
assert(/if \(fast && pollFuel\.n % 8 === 4\) fast = fast\.concat\(want\('egs'\) \? \['egs'\] : \[\]/.test(main), 'EGS in fast rounds');
assert(/if \(!pidsAsked\) await logObdPids\(\);/.test(main), 'the OBD PID list goes to the log once');
// the fuel-content tile: a setting swaps the ethanol slot (no standard ethanol PID on this car) for HPFP rail
const fuelTile = spec.settings.find((s) => s.key === 'fuelTile');
assert(fuelTile && fuelTile.default === 'hpfp', 'fuelTile setting defaults to HPFP rail');
assert.deepStrictEqual(fuelTile.options.map((o) => o[0]).sort(), ['ethanol', 'hpfp'], 'fuelTile options: ethanol / hpfp');
assert(/function fuelTileDesc\(d\)/.test(main) && /settings\.get\('fuelTile'\) === 'ethanol'/.test(main), 'the fuel tile chooses by setting');
assert(/key: 'fuelTile'/.test(fs.readFileSync(path.join(APP, 'panel.js'), 'utf8')), 'the panel fuel slot is generic (fuelTile)');

// the fuel-content tile holds four digits (HPFP rail in psi runs to ~5000): every glyph inside its text layer,
// the layer inside its tile (Tyson, 2026-11-20: "doesn't have enough room for four digits")
const ftL = p.L.texts.fuelTile;
assert(ftL && ftL.cells >= 4, 'the fuel tile has 4 cells: ' + (ftL && ftL.cells));
['4980', '2320', '725', '300', '85'].forEach((s) => {
    const g = p._glyphs(s, ftL);
    for (let i = 0; i < s.length; i++) assert(g.pos[i] >= 0 && g.pos[i] + g.wid[i] <= ftL.w + 0.01, s + ': glyph ' + i + ' inside the layer');
});
const ftLay = layers.find((l) => l.ref === ftL.ref);
assert(ftLay && ftLay.o.x >= 36 && ftLay.o.x + ftLay.o.w <= 36 + 166 - 10, 'the fuel tile text inside its tile: ' + JSON.stringify(ftLay && [ftLay.o.x, ftLay.o.w]));

fs.rmSync(dir, { recursive: true, force: true });
// the dials' numbers clear the tick marks (0.4.8: 3-digit speeds and the tach's 10 ran into them) and each other
{
    const P = require(path.join(dir, 'panel.js'));
    const { Recorder } = require(path.join(dir, 'kit', 'record.js'));
    const rec = new Recorder(10, 10, { textScale: 1 });
    const sets = [];
    [true, false].forEach((mph) => { const sc = P.speedScale(mph), t = []; for (let x = 0; x <= sc.max; x += sc.major) t.push(String(x)); sets.push(t); });
    [6000, 7000, 8000, 9000, 10000].forEach((top) => { const t = []; for (let i = 0; i <= top / 1000; i++) t.push(String(i)); sets.push(t); });
    sets.forEach((txt) => {
        const boxes = txt.map((s, i) => {
            const a = P.A0 + (P.A1 - P.A0) * i / (txt.length - 1), w = rec.textWidth(s, P.LABEL_SIZE, { font: 'gridhead', literal: true, spacing: 1 });
            const r = P.labelRadius(P.SP.R, a, w), rad = a * Math.PI / 180;
            const reach = Math.abs(Math.sin(rad)) * w / 2 + Math.abs(Math.cos(rad)) * P.LABEL_CAP / 2;
            assert(P.SP.R * 0.76 - P.TICK_MAJOR - (r + reach) >= 5, 'label ' + s + ' clears the ticks');
            const x = r * Math.sin(rad), y = -r * Math.cos(rad);
            return { s, x0: x - w / 2, x1: x + w / 2, y0: y - P.LABEL_CAP / 2, y1: y + P.LABEL_CAP / 2 };
        });
        boxes.forEach((b, i) => { const n = boxes[i + 1]; if (n) assert(b.x1 + 4 <= n.x0 || n.x1 + 4 <= b.x0 || b.y1 + 4 <= n.y0 || n.y1 + 4 <= b.y0, 'labels ' + b.s + ' and ' + n.s + ' apart'); });
        if (sets.indexOf(txt) > 1) return;
        // the big speed, scaled as _update scales it, stays inside the speedometer's numbers at every speed
        const big = buildAtlas(132, BIGCHARS), ink = P.speedInk(big), room = P.speedRoom(boxes, ink);
        assert(room >= (sets.indexOf(txt) === 0 ? 220 : 180), 'room for the speed: ' + room);   // mph 228 px, km/h 188 px (its numbers sit at other angles)
        for (let v = 0; v <= Number(txt[txt.length - 1]); v++) {
            const w = P.speedInkWidth(big, String(v)), k = Math.min(1, Math.floor(room / w * 100) / 100);
            const half = w * k / 2, mid = (ink.top + ink.bottom) / 2, top = mid - (mid - ink.top) * k, bot = mid + (ink.bottom - mid) * k;
            boxes.forEach((b) => assert(b.y1 < top || b.y0 > bot || b.x0 >= half + 4 || b.x1 <= -half - 4, 'speed ' + v + ' clear of ' + b.s));
            if (v < 10) assert.strictEqual(k, 1, 'a 1-digit speed at full size');
        }
    });
    // and the panel sends that scale (the test's car does 69 mph: full size)
    const sx = sent.filter((m) => m.op === 'set' && 'sx' in m.o);
    assert(sx.length >= 1 && sx[sx.length - 1].o.sx > 0 && sx[sx.length - 1].o.sx <= 1, 'the speed layer gets its scale');
}

console.log('test_grid_panel: ok (' + layers.length + ' layers, ' + MB.toFixed(1) + ' MB of pixel memory)');
