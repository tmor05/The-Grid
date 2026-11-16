/**
 * main.js (emulator page) - boots the services the car would have (the GPU renderer, cluster-render,
 * the head unit with its signals and the DME behind the diagnostic link), then The Grid itself,
 * and drives the simulated car from the page.
 */
import { createGfx } from './gfx.js';

const fs = require('fs');
const { Buffer } = require('buffer');
const files = require('GEN/files');
const WASM = require('GEN/wasm');
const BUILD = require('GEN/build');
const renderd = require('./renderd');
const clusterd = require('./clusterd');
const host = require('./host');
const { Car, MAPS, signals, ecus } = require('./sim');
const stock = require('./stock');
const sfxOut = require('./sound_out');

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ---------- the app's log, for the panel ---------- */
const LOG = [];
let logDirty = false;
const fmt = (a) => a.map((x) => (x && x.stack ? x.stack : x && typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })() : String(x))).join(' ');
function addLog(l, s) {
    LOG.push([l, new Date().toTimeString().slice(0, 8) + ' ' + s]);
    if (LOG.length > 400) LOG.splice(0, LOG.length - 300);
    logDirty = true;
    if (l === 'error') console.error('[app] ' + s);
}
const log = { info: (...a) => addLog('info', fmt(a)), warn: (...a) => addLog('warn', fmt(a)), error: (...a) => addLog('error', fmt(a)), debug: () => {} };

/* ---------- what would reach a car ---------- */
const writes = [];
function onWrite(w) {
    writes.unshift(Object.assign({ t: new Date().toTimeString().slice(0, 8) }, w));
    if (writes.length > 40) writes.pop();
    const ol = $('#writes');
    ol.innerHTML = writes.map((x) => '<li class="' + (/^7F/.test(x.reply) ? 'bad' : '') + '">' + x.t + '  ' + x.req + '  →  ' + x.reply + '<em>' + x.what + '</em></li>').join('');
}

async function boot() {
    fs.__preload(files);
    $('#ver').textContent = 'v' + BUILD.version + (BUILD.rev ? ' · ' + BUILD.rev : '');

    // the car's GPU renderer and cluster-render, before the app looks for their sockets
    let gfx;
    try { gfx = await createGfx($('#cid'), Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0))); } catch (e) {
        $('#boot').classList.add('err');
        $('#boot').textContent = 'This browser could not start the renderer (WebGL 2 is needed):\n' + (e && e.message || e);
        throw e;
    }
    const rd = renderd.start(gfx, {
        log: (l, s) => addLog(l, 'renderer: ' + s),
        onHmi: (a) => hu.hmi(a),
        onHmiTap: (x, y) => hu.hmiTap(x, y),
    });
    const mapCv = document.createElement('canvas'), hudCv = document.createElement('canvas'), panelCv = document.createElement('canvas');
    const cl = clusterd.start({ map: mapCv, hud: hudCv, panel: panelCv }, { log: (l, s) => addLog(l, 'cluster-render: ' + s) });
    const clOpts = () => ({ gridOn: cl.visible('map') > 0, panel: panelCv, panelOn: cl.visible('panel') > 0, hu });

    // the head unit, then the app (its mgu.run lands in hu.run)
    // the HMI's own image of the app's screen (software path): what the car shows without the renderer
    const softCv = $('#soft').getContext('2d');
    let softImg = null;
    const onSoft = (cv) => {
        if (!softImg || softImg.width !== cv.w || softImg.height !== cv.h) softImg = softCv.createImageData(cv.w, cv.h);
        softImg.data.set(cv.d);
        softCv.putImageData(softImg, 0, 0);
    };
    const hu = host.headUnit({ log, onSoft });
    globalThis.__GRID_HU__ = hu;
    // the app ships Sounds Off; the emulator starts On until it is changed here (the saved choice wins)
    try {
        const saved = fs.existsSync(hu.settings.file) ? JSON.parse(fs.readFileSync(hu.settings.file, 'utf8')) : {};
        if (!('sounds' in saved)) hu.settings.values.sounds = 'on';
    } catch (e) { hu.settings.values.sounds = 'on'; }
    const car = new Car();
    globalThis.__GRID_CAR__ = car;
    const cfg = hu.spec.config || {};
    hu.sig.setEcu(ecus(car, cfg.dme, cfg.xdrive, onWrite));
    const feed = signals(car, hu.sig.feed, cfg.scaling);
    require('APPDIR/app.js');

    /* ---------- screens shown ---------- */
    hu.on('screens', (stack) => { $('#closed').hidden = stack.length > 0; });
    hu.on('hmiscreen', (n) => addLog('info', 'HMI: the car would open its own ' + n + ' screen here'));
    $('#closed').addEventListener('click', () => hu.hmi('open'));
    setTimeout(() => { $('#boot').hidden = true; }, 900);

    /* ---------- the loop: physics, signals, the cluster, the views ---------- */
    const pilot = makePilot(car);
    const clv = $('#clview').getContext('2d'), hv = $('#hudview').getContext('2d');
    let last = performance.now(), acc = 0, sigAcc = 0, uiAcc = 0, frames = 0, fpsT = last, fps = 0;
    const input = { gas: false, brake: false, left: false, right: false };
    // ctl.hold: the car stays as it is set (no driver, no physics) while its signals keep going out (for stills)
    const ctl = { hold: false };
    function frame(now) {
        requestAnimationFrame(frame);
        let dt = Math.min(0.06, (now - last) / 1000);
        last = now;
        if (ctl.hold) { uiAcc += dt; if (uiAcc > 0.1) { uiAcc = 0; panel(); } car.settle(); sigAcc += dt; while (sigAcc > 0.04) { feed(); sigAcc -= 0.04; } cl.draw(); stock.cluster(clv, car, mapCv, clOpts()); stock.hud(hv, car, hudCv, { gridOn: cl.visible('hud') > 0, hu }); return; }
        // the driver: autopilot or the keys / pads
        const manualInput = input.gas || input.brake || input.left || input.right;
        if (manualInput && pilot.on()) pilot.stop('you took over');
        if (pilot.on()) pilot.drive(dt);
        else {
            const cap = Number($('#cap').value) / 100;
            car.throttle = clamp(car.throttle + (input.gas ? 4 : -6) * dt, 0, input.gas ? cap : 1);
            if (!input.gas) car.throttle = Math.max(0, car.throttle);
            car.brake = clamp(car.brake + (input.brake ? 5 : -8) * dt, 0, 1);
            const sv = Number($('#steer').value) / 100;
            const want = input.left ? -1 : input.right ? 1 : sv;
            car.steer += (want - car.steer) * Math.min(1, dt * 6);
        }
        acc += dt;
        while (acc > 0.005) { car.step(0.005); acc -= 0.005; }
        sigAcc += dt;
        while (sigAcc > 0.04) { feed(); sigAcc -= 0.04; }
        // the cluster's and the HUD's scenes, then the views round them
        cl.draw();
        stock.cluster(clv, car, mapCv, clOpts());
        stock.hud(hv, car, hudCv, { gridOn: cl.visible('hud') > 0, hu });
        frames++;
        if (now - fpsT > 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
        uiAcc += dt;
        if (uiAcc > 0.1) { uiAcc = 0; panel(); }
    }
    requestAnimationFrame(frame);

    /* ---------- the HMI's own button bar (under the app's surface: seen in the Standard layout / software path) ---------- */
    let barKey = '';
    function hmiBar() {
        const d = hu.display;
        if (!d || !d.screen) return;
        const btns = d.buttons(), key = JSON.stringify(btns) + d.barOff + d.focused;
        if (key === barKey) return;
        barKey = key;
        $('#hmibar').innerHTML = btns.map((b) => '<span class="' + (d.focused === b.id ? 'f' : '') + '" style="left:' + ((b.x - d.barOff) / 19.2) + '%;width:' + (b.w / 19.2) + '%">' + b.label.replace(/[<>&]/g, '') + '</span>').join('');
    }

    /* ---------- the panel's readouts ---------- */
    const mph = () => hu.settings.get('speedUnit') === 'mph';
    function panel() {
        hmiBar();
        const sp = Math.abs(car.v) * 3.6 * (mph() ? 0.621371 : 1);
        const gear = !car.running ? '—' : car.sel !== 'D' ? car.sel : (car.prog === 'D' ? 'D' : car.prog) + car.gear;
        const boostPsi = car.boost * 14.5038;
        $('#truth').textContent =
            'SPEED ' + sp.toFixed(0).padStart(3) + (mph() ? ' mph' : ' km/h') + '   RPM ' + Math.round(car.rpm).toString().padStart(4) + '   ' + gear.padEnd(3) + '\n' +
            'BOOST ' + (boostPsi >= 0 ? '+' : '') + boostPsi.toFixed(1).padStart(4) + ' psi  TQ ' + Math.round(Math.max(0, car.torque) * 0.7376).toString().padStart(3) + ' lb-ft  ' + Math.round(car.power * 1.341).toString().padStart(3) + ' hp\n' +
            'OIL ' + Math.round(car.oil * 1.8 + 32) + '°F  H2O ' + Math.round(car.coolant * 1.8 + 32) + '°F  TRANS ' + Math.round(car.trans * 1.8 + 32) + '°F  G ' + car.gLat.toFixed(2);
        $('#engine').textContent = car.running ? 'STOP ENGINE' : 'START ENGINE';
        $('#engine').classList.toggle('on', car.running);
        $$('#gears button').forEach((b) => {
            const g = b.dataset.g;
            b.classList.toggle('on', car.running && (g === car.sel || (car.sel === 'D' && ((g === 'S' && car.prog === 'S') || (g === 'M' && car.prog === 'M')))));
        });
        $$('#awd button').forEach((b) => b.classList.toggle('on', b.dataset.a === car.awd));
        const th = hu.settings.get('theme');
        $$('#ids button').forEach((b) => b.classList.toggle('on', b.dataset.id === th));
        $('#mapnote').textContent = 'Engine map in the simulated DME: ' + car.env.map + ' (' + MAPS[car.env.map - 1].label + ', ' + (MAPS[car.env.map - 1].boost * 14.5).toFixed(0) + ' psi)';
        const c = rd.conn, s = gfx.stats();
        $('#st-cid').textContent = (c.on ? (c.shown ? 'shown' : 'hidden') + (c.grab ? ' · controller held' : '') : 'no app') + ' · ' + fps + ' fps · JS ' + hu.jsMs.toFixed(1) + ' ms · GPU ' + s.avgMs.toFixed(2) + ' ms';
        const n = cl.count();
        const vp = cl.visible('panel'), vm = cl.visible('map');
        $('#st-cl').textContent = vp ? 'The Grid over the whole cluster (' + vp + ' layers); BMW\'s warning lights and bottom strip on top / below'
            : n.panel ? 'Whole cluster: hidden (no live speed from the car), BMW\'s gauges'
            : vm ? 'The Grid in the middle (' + vm + ' layers), BMW\'s dials round it' : 'BMW\'s own cluster (The Grid\'s cluster setting is off)';
        $('#st-hud').textContent = n.hud ? n.hud + ' layers from The Grid' : 'stock HUD only (The Grid\'s HUD setting is off)';
        $('#scenv').textContent = pilot.on() ? 'Autopilot: ' + pilot.label() : 'Off · you drive' + (pilot.why ? ' (' + pilot.why + ')' : '');
        if (logDirty) {
            logDirty = false;
            const el = $('#log'), bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
            el.innerHTML = LOG.slice(-160).map(([l, s]) => '<span class="' + (l === 'warn' ? 'w' : l === 'error' ? 'e' : '') + '">' + s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])) + '</span>').join('\n');
            if (bottom) el.scrollTop = el.scrollHeight;
        }
        const errs = cl.errors();
        if (errs.length && !panel.shownErr) { panel.shownErr = true; addLog('error', 'cluster shader: ' + errs[0]); }
    }
    setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }, 1000);

    /* ---------- touch on the center screen ---------- */
    const stage = $('#stage');
    const at = (e) => { const r = stage.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * 1920 / r.width), Math.round((e.clientY - r.top) * 720 / r.height)]; };
    let down = null;
    stage.addEventListener('pointerdown', (e) => { if (!$('#closed').hidden) return; down = e.pointerId; stage.setPointerCapture(e.pointerId); const [x, y] = at(e); rd.touch(1, x, y); e.preventDefault(); });
    stage.addEventListener('pointermove', (e) => { if (down !== e.pointerId) return; const [x, y] = at(e); rd.touch(2, x, y); });
    const up = (e) => { if (down !== e.pointerId) return; down = null; const [x, y] = at(e); rd.touch(3, x, y); };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); rd.ccu({ turn: e.deltaY > 0 ? 1 : -1 }); }, { passive: false });

    /* ---------- the iDrive controller ---------- */
    const knob = $('#knob'), dot = knob.querySelector('.dot');
    let knobA = 0;
    const turn = (n) => { knobA += n * 15; dot.style.transform = 'rotate(' + knobA + 'deg)'; rd.ccu({ turn: n }); };
    const press = (on) => { knob.classList.toggle('press', on); rd.ccu({ press: on }); };
    knob.addEventListener('wheel', (e) => { e.preventDefault(); turn(e.deltaY > 0 ? 1 : -1); }, { passive: false });
    let kd = null;
    knob.addEventListener('pointerdown', (e) => { kd = { x: e.clientX, y: e.clientY, a: null, moved: false }; knob.setPointerCapture(e.pointerId); });
    knob.addEventListener('pointermove', (e) => {
        if (!kd) return;
        const r = knob.getBoundingClientRect(), a = Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2) * 180 / Math.PI;
        if (Math.hypot(e.clientX - kd.x, e.clientY - kd.y) > 8) kd.moved = true;
        if (kd.a === null) { kd.a = a; return; }
        let d = a - kd.a; if (d > 180) d -= 360; if (d < -180) d += 360;
        if (Math.abs(d) >= 15) { turn(Math.sign(d)); kd.a = a; }
    });
    knob.addEventListener('pointerup', () => { if (kd && !kd.moved) { press(true); setTimeout(() => press(false), 120); } kd = null; });
    const tilt = (dir) => { rd.ccu({ tilt: dir }); setTimeout(() => rd.ccu({ tilt: null }), 120); };
    $('#c-back').addEventListener('click', () => { if (rd.conn.grab) tilt('W'); else hu.hmi('back'); });
    $('#c-menu').addEventListener('click', () => hu.hmi('home'));
    $('#c-open').addEventListener('click', () => hu.hmi('open'));

    /* ---------- driving ---------- */
    $('#engine').addEventListener('click', () => { if (car.running) car.stopEngine(); else car.startEngine(); });
    $$('#gears button').forEach((b) => b.addEventListener('click', () => gearKey(b.dataset.g)));
    function gearKey(g) {
        if (!car.running && g !== 'P') car.startEngine();
        if (g === 'S') { if (car.sel !== 'D') car.select('D'); car.prog = car.prog === 'S' ? 'D' : 'S'; return; }
        if (g === 'M') { car.manual(car.prog !== 'M'); return; }
        car.select(g);
    }
    $('#pup').addEventListener('click', () => car.paddle(1));
    $('#pdn').addEventListener('click', () => car.paddle(-1));
    const hold = (el, key) => {
        const on = (e) => { input[key] = true; el.classList.add('held'); if (e) e.preventDefault(); };
        const off = () => { input[key] = false; el.classList.remove('held'); };
        el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); on(e); });
        el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
    };
    hold($('#gas'), 'gas'); hold($('#brake'), 'brake');
    const out = (id, f) => { const i = $('#' + id), o = $('#' + id + 'v'); const u = () => { o.textContent = f(Number(i.value)); }; i.addEventListener('input', u); u(); return i; };
    out('cap', (v) => v + '%');
    out('steer', (v) => (v > 0 ? 'R ' : v < 0 ? 'L ' : '') + Math.abs(v));
    $('#steer').addEventListener('dblclick', () => { $('#steer').value = 0; $('#steer').dispatchEvent(new Event('input')); });
    out('amb', (v) => { car.env.ambient = v; return v + ' °C'; });
    out('eth', (v) => { car.env.ethanol = v; return 'E' + v; });
    const chk = (id, f) => { const i = $('#' + id); i.addEventListener('change', () => f(i.checked)); f(i.checked); };
    chk('flex', (v) => { car.env.flex = v; });
    chk('link', (v) => { car.env.linkUp = v; hu.sig.link(v); });
    chk('mhd', (v) => { car.env.mhd = v; });
    chk('mhdflap', (v) => { car.env.mhdFlap = v; if (!v) car.mhdFlapCmd = null; });
    chk('hotoil', (v) => { car.env.hotOil = v; });
    /* ---------- the car's audio: the volume knob, mute, and whether anything plays (host.js's AudioManager) ---------- */
    out('avol', (v) => { hu.sig.audio({ volume: v }); return String(v); });
    chk('amute', (v) => hu.sig.audio({ mute: v }));
    chk('aplay', (v) => hu.sig.audio({ playing: v }));
    const volKnob = (d) => { const i = $('#avol'); i.value = Math.max(0, Math.min(Number(i.max), Number(i.value) + d)); i.dispatchEvent(new Event('input')); };
    $('#mis').addEventListener('change', (e) => { car.env.misfireCyl = Number(e.target.value); });
    $$('#awd button').forEach((b) => b.addEventListener('click', () => { car.awd = b.dataset.a; }));
    $('#cold').addEventListener('click', () => { pilot.stop(); car.reset(true); car.startEngine(); });
    $('#warm').addEventListener('click', () => { pilot.stop(); car.reset(false); car.startEngine(); });
    $$('#scen button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.s === 'stop') pilot.stop('stopped'); else pilot.start(b.dataset.s); }));

    /* ---------- the app's settings from the page (the same calls as its Settings tab) ---------- */
    $$('#ids button').forEach((b) => b.addEventListener('click', () => hu.settings.set('theme', b.dataset.id)));

    /* ---------- sounds: the app's Sounds setting, a sound board, volume (sound_out.js plays them) ---------- */
    const SFX_LABEL = { boot_sam: 'Sam', boot_flynn: 'Flynn', boot_rinzler: 'Rinzler', boot_ares: 'Ares', tap: 'Tap', map: 'Map',
        flap_open: 'Flap open', flap_close: 'Flap closed', flap_oem: 'Flap OEM', cool_on: 'Cooling on', cool_off: 'Cooling off', refused: 'Refused',
        warn: 'Warning', run_go: 'Run start', run_done: 'Run end', best: 'New best' };
    const SFX_GROUPS = [['Opening · per identity', /^boot_/], ['Taps · Engine page', /^(tap|map|flap_|cool_|refused)$/], ['Warnings', /^warn$/],
        ['Track · timed runs', /^(run_|best)/]];
    const sfxInfo = {};
    sfxOut.list.forEach((x) => { sfxInfo[x.name] = x; });
    const board = $('#sfxboard'), sfxBtn = {};
    SFX_GROUPS.forEach(([title, re]) => {
        const g = document.createElement('div'); g.className = 'grp';
        const h = document.createElement('b'); h.textContent = title; g.appendChild(h);
        const row = document.createElement('div'); row.className = 'btns';
        sfxOut.list.filter((x) => re.test(x.name)).forEach((x) => {
            const b = document.createElement('button');
            b.textContent = SFX_LABEL[x.name] || x.name;
            b.title = x.when;
            b.addEventListener('click', () => { sfxFrom = 'board'; sfxOut.unlock().then(() => { sfxOut.play(x.name); sfxFrom = null; }); });
            sfxBtn[x.name] = b; row.appendChild(b);
        });
        g.appendChild(row); board.appendChild(g);
    });
    let sfxFrom = null;
    const sfxNow = $('#sfxnow');
    sfxOut.onPlay((name, heard) => {
        const x = sfxInfo[name] || { when: '' }, label = SFX_LABEL[name] || name;
        const b = sfxBtn[name];
        if (b) { b.classList.add('hit'); clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('hit'), 450); }
        sfxNow.classList.toggle('wait', !heard);
        sfxNow.textContent = (sfxFrom === 'board' ? '▶ ' : '▶ The app: ') + label + ' · ' + x.when + (heard ? '' : sfxOut.running() ? ' (muted)' : ' (not heard: click the page once)');
        if (sfxFrom !== 'board') addLog('info', 'sound: ' + name + (heard ? '' : ' (not heard)'));
    });
    $$('#sfxset button').forEach((b) => b.addEventListener('click', () => { sfxOut.unlock().then(() => hu.settings.set('sounds', b.dataset.v)); }));
    const vol = $('#sfxvol');
    vol.addEventListener('input', () => { sfxOut.setVolume(vol.value / 100); $('#sfxvolv').textContent = vol.value + '%'; });
    /** Mute / unmute; the first click only turns sound on (and with `hello`, plays the identity's opening). */
    let runAtDown = false;                       // was sound on before this click's pointerdown turned it on?
    const soundButton = (hello) => {
        if (runAtDown && sfxOut.running()) { sfxOut.setMuted(!sfxOut.muted); return; }
        sfxOut.unlock().then((ok) => {
            if (!ok) return;
            sfxOut.setMuted(false);
            if (hello) { sfxFrom = 'board'; sfxOut.play('boot_' + (hu.settings.get('theme') || 'sam')); sfxFrom = null; }
        });
    };
    $('#sfxmute').addEventListener('click', () => soundButton(false));
    $('#sfxon').addEventListener('click', () => soundButton(true));
    // browsers start audio only after a click or a key on the page
    const unlockOnce = () => { if (!sfxOut.running()) sfxOut.unlock().then((ok) => { if (ok && !sfxNow.dataset.ok) { sfxNow.dataset.ok = '1'; sfxNow.classList.remove('wait'); sfxNow.textContent = 'Sound on. Click a sound to hear it.'; } }); };
    document.addEventListener('pointerdown', () => { runAtDown = sfxOut.running(); unlockOnce(); }, true);
    document.addEventListener('keydown', () => { runAtDown = sfxOut.running(); unlockOnce(); }, true);
    function sfxPanel() {
        const v = hu.settings.get('sounds') && hu.settings.get('sounds') !== 'off' ? 'on' : 'off';
        $$('#sfxset button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        const st = !sfxOut.running() ? 'off' : sfxOut.muted ? 'muted' : 'live';
        const btn = $('#sfxon');
        if (btn.dataset.st !== st) {
            btn.dataset.st = st; btn.className = st;
            btn.title = st === 'off' ? 'Sound: click to turn it on (browsers need a click first)' : st === 'muted' ? 'Sound muted: click to unmute' : 'Sound on: click to mute';
            $('#sfxmute').textContent = st === 'muted' ? 'unmute' : 'mute';
        }
    }
    setInterval(sfxPanel, 250);
    sfxPanel();
    $$('#views button').forEach((b) => b.addEventListener('click', () => {
        document.body.dataset.view = b.dataset.view;
        $$('#views button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('#logclr').addEventListener('click', () => { LOG.length = 0; logDirty = true; });
    // (no confirm(): a sandboxed frame may block dialogs) - a second click within 4 s resets
    let wipeT = 0;
    $('#wipe').addEventListener('click', () => {
        const b = $('#wipe');
        if (Date.now() - wipeT < 4000) { fs.__wipe(); location.reload(); return; }
        wipeT = Date.now(); b.textContent = 'Click again to reset';
        setTimeout(() => { b.textContent = 'Reset app data'; }, 4000);
    });
    $('#relo').addEventListener('click', () => location.reload());

    /* ---------- keys ---------- */
    const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
    const KEYS = { ArrowUp: 'gas', ArrowDown: 'brake', ' ': 'brake', ArrowLeft: 'left', ArrowRight: 'right' };
    window.addEventListener('keydown', (e) => {
        if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
        if (KEYS[e.key]) { input[KEYS[e.key]] = true; e.preventDefault(); return; }
        if (e.repeat) return;
        const k = e.key.toUpperCase();
        if ('PRNDM'.indexOf(k) >= 0 && k.length === 1) gearKey(k);
        else if (k === 'Q') car.paddle(-1);
        else if (k === 'E') car.paddle(1);
        else if (e.key === '[') turn(-1);
        else if (e.key === ']') turn(1);
        else if (e.key === '-') volKnob(-1);
        else if (e.key === '=' || e.key === '+') volKnob(1);
        else if (e.key === 'Enter') { press(true); setTimeout(() => press(false), 120); }
        else if (e.key === 'Backspace') { e.preventDefault(); if (rd.conn.grab) tilt('W'); else hu.hmi('back'); }
        else return;
        e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { if (KEYS[e.key]) input[KEYS[e.key]] = false; });
    window.addEventListener('blur', () => Object.keys(input).forEach((k) => { input[k] = false; }));

    // start in the driveway: warmed up, engine running, in park (Cold start is a button)
    car.reset(false);
    car.startEngine();
    globalThis.__GRID__ = { hu, car, rd, cl, gfx, pilot, input, ctl, hudCv, mapCv, panelCv, Car };
}

/* ---------- the autopilot: scripted drives the app can be watched on ---------- */
function makePilot(car) {
    let s = null, t = 0, phase = 0, label = '';
    const mph = (x) => x / 2.23694;
    const holdSpeed = (target, dt) => {
        const e = target - car.v;
        car.brake = e < -1.5 ? clamp(-e / 6, 0, 0.6) : 0;
        car.throttle = clamp(car.throttle + (e * 0.08 - car.a * 0.02) * dt * 10, 0, e > 6 ? 0.75 : 0.45);
        if (car.brake > 0) car.throttle = 0;
    };
    const ready = (prog) => { if (!car.running) car.startEngine(); if (car.sel !== 'D') car.select('D'); car.prog = prog || 'D'; };
    const P = {
        launch(dt) {
            if (phase === 0) { ready('S'); car.brake = 1; car.throttle = 0; car.steer = 0; if (Math.abs(car.v) < 0.1 && t > 0.6) { phase = 1; t = 0; } label = 'staging'; }
            else if (phase === 1) { car.brake = 1; car.throttle = 0.35; label = 'brake boost'; if (t > 1.2) { phase = 2; t = 0; } }
            else if (phase === 2) { car.brake = 0; car.throttle = 1; label = 'launch!'; if (car.v > mph(118) || t > 14) { phase = 3; t = 0; } }
            else if (phase === 3) { car.throttle = 0; car.brake = 0.55; label = 'braking'; if (Math.abs(car.v) < 0.2) { phase = 4; t = 0; car.brake = 1; } }
            else { car.brake = 1; label = 'done: Track page has the times'; if (t > 1.5) { car.select('P'); stop('run finished: in P, see the Track page'); } }
        },
        cruise(dt) { ready(); car.steer = 0; holdSpeed(mph(45), dt); label = 'holding 45 mph'; },
        highway(dt) { ready(); car.steer = Math.sin(t / 7) * 0.05; holdSpeed(mph(75), dt); label = 'holding 75 mph'; },
        twisty(dt) { ready('S'); const c = Math.sin(t / 2.6); car.steer = c * 0.85; holdSpeed(mph(50 - 8 * Math.abs(c)), dt); label = 'back roads, 0.6 g corners'; },
        track(dt) {
            ready('S');
            const cyc = t % 17;
            if (cyc < 7) { car.throttle = 1; car.brake = 0; car.steer = 0; label = 'pull'; }
            else if (cyc < 9.2) { car.throttle = 0; car.brake = car.v > mph(45) ? 0.85 : 0; car.steer = 0; label = 'braking zone'; }
            else { car.brake = 0; car.steer = Math.sin((cyc - 9.2) / 7.8 * Math.PI) * 0.9; car.throttle = clamp(0.25 + (cyc - 9.2) / 7.8 * 0.7, 0, 1); label = 'corner'; }
        },
    };
    function stop(why) { if (s) { car.throttle = 0; car.brake = 0; car.steer = 0; } s = null; pilot.why = why || ''; }
    const pilot = {
        why: '',
        on: () => !!s,
        label: () => label,
        start(name) { s = name; t = 0; phase = 0; pilot.why = ''; },
        stop,
        drive(dt) { t += dt; P[s](dt); },
    };
    return pilot;
}

boot().catch((e) => { console.error(e); const b = document.querySelector('#boot'); if (b) { b.hidden = false; b.classList.add('err'); b.textContent = 'The emulator stopped: ' + (e && e.stack || e); } });
