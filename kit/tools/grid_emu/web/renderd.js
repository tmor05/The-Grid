'use strict';
/**
 * renderd.js (emulator page) - the daemon side of the car's GPU renderer (kit/renderd/PROTOCOL.md,
 * mgu-render/1) for the app running in this page, drawing with the car's own draw engine
 * (kit/renderd/src/gfx.c as WebAssembly, kit/emu/web/gfx). A browser port of the renderer part of
 * kit/tools/emu.js: HELLO -> X_READY + READY, TICK once a frame is drawn (paced by the display),
 * touch inside the app's claims as TOUCH, the iDrive controller as X_CCU while it grabs.
 */
const net = require('net');
const { Buffer } = require('buffer');

const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8, M9: 9, M10: 10, FPS: 12 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104, TOUCH: 105, CLOSED: 106 };
const X = { MODE: 0x4d520001, GRAB: 0x4d520002, READY: 0x4d520101, STATE: 0x4d520102, CCU: 0x4d520103 };
const SCREEN = { w: 1920, h: 720 };
const SOCK = '/run/mgu-render/render.sock';
const T0 = Date.now();

function msg(type, words, raw) {
    const p = raw || Buffer.alloc(words.length * 4);
    if (!raw) words.forEach((w, i) => p.writeUInt32LE((Number(w) || 0) >>> 0, i * 4));
    const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
    return b;
}

/**
 * start(gfx, opts) -> { touch(phase, x, y), ccu({ turn | press | tilt }), conn }
 *   opts.onHmi(action)   the HMI's own column was touched: 'home' | 'back'
 *   opts.onState(info)   the connection changed (shown, grab, claims)
 *   opts.log(level, s)
 */
function start(gfx, opts) {
    const o = opts || {};
    const log = o.log || ((l, s) => console[l === 'error' ? 'error' : 'log']('[renderd] ' + s));
    let R = null;
    const tick = { busy: false, n: 0, raf: 0 };
    const ccu = { seq: 0, knob: 0, pb: 0, df: 0 };
    const toApp = (b) => { if (R && !R.sock.destroyed) R.sock.write(b); };
    const info = () => (R ? { on: true, app: R.app, shown: R.visible, grab: R.grab, claims: R.claims.length, place: R.place } : { on: false });
    const changed = () => { if (o.onState) o.onState(info()); };

    function frameDrawn() {
        tick.raf = 0;
        tick.busy = false;
        if (!R || !R.visible) return;
        if (!R.onScreen && R.frame && R.native) { R.onScreen = true; toApp(msg(X.STATE, [1, 1, 1])); }
        toApp(msg(E.TICK, [++tick.n, Date.now() - T0]));
    }
    function wantTick() {
        if (tick.raf || !R || !R.visible) return;
        tick.raf = requestAnimationFrame(frameDrawn);
    }

    net.__listen(SOCK, (sock) => {
        if (R) R.sock.destroy();
        const c = R = { sock, app: '?', native: false, visible: false, onScreen: false, grab: false, claims: [], place: null, frame: false, buf: Buffer.alloc(0), gesture: false };
        tick.busy = false;
        gfx.reset();
        sock.on('data', (d) => {
            if (R !== c) return;
            c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : Buffer.from(d);
            let off = 0, frame = false;
            while (c.buf.length - off >= 8) {
                const type = c.buf.readUInt32LE(off), len = c.buf.readUInt32LE(off + 4);
                if (c.buf.length - off < 8 + len) break;
                const p = c.buf.slice(off + 8, off + 8 + len);
                try { if (handle(c, type, p)) frame = true; } catch (e) { log('error', 'bad message: ' + e.message); }
                off += 8 + len;
            }
            if (off) {
                const whole = c.buf.slice(0, off);
                const r = gfx.feed(new Uint8Array(whole.buffer, whole.byteOffset, whole.byteLength));
                if (r < 0) { const s = gfx.stats(); log('error', 'renderer dropped the app: ' + (s.error || 'bad message')); sock.destroy(); return; }
            }
            c.buf = c.buf.slice(off);
            if (frame) { tick.busy = true; wantTick(); }
        });
        sock.on('close', () => { if (R === c) { R = null; changed(); } });
    });

    /** One message from the app: what the daemon must know. Returns true for a FRAME. */
    function handle(c, type, p) {
        const u = (i) => p.readUInt32LE(i * 4);
        switch (type) {
        case M.HELLO: {
            const f = p.toString('utf8').split('\0');
            c.app = f[0];
            if (f.slice(1).indexOf('proto=mgu-render/1') >= 0) {
                c.native = true;
                // version 1, layer mode, caps: touch routing | controller gate | pixmaps; app area; pixmap side; 60 Hz
                toApp(msg(X.READY, [1, 1, 1 | 2 | 8, 0, 0, 0, 0, 108, 82, 1790, 638, 2048, 60000]));
            }
            toApp(msg(E.READY, [4, SCREEN.w, SCREEN.h, 1]));
            log('info', c.app + ' connected' + (c.native ? ' (mgu-render/1)' : ''));
            changed();
            return false;
        }
        case M.PLACE:
            c.place = { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12), s: p.readFloatLE(16), ox: p.readFloatLE(20), oy: p.readFloatLE(24) };
            changed();
            return false;
        case M.SHOW:
            c.visible = !!u(0);
            if (!c.visible && c.onScreen && c.native) { c.onScreen = false; toApp(msg(X.STATE, [1, 0, 1])); }
            if (c.visible) { tick.busy = false; wantTick(); }
            changed();
            return false;
        case M.FRAME: c.frame = true; return true;
        case M.M9: {
            // IterioDev / mgu-render CLAIM: touch areas in the app's logical px
            if (!c.native && p.length >= 12 && u(1) >= 1 && u(2) >= 1 && p.length >= 12 + u(1) * u(2) * 4) return false;   // upstream IMAGE
            const n = u(0);
            c.claims = [];
            for (let i = 0; i < n && 4 + i * 16 + 16 <= p.length; i++) c.claims.push({ x: p.readFloatLE(4 + i * 16), y: p.readFloatLE(8 + i * 16), w: p.readFloatLE(12 + i * 16), h: p.readFloatLE(16 + i * 16) });
            changed();
            return false;
        }
        case M.M10: if (!c.native && p.length === 4) { c.grab = !!u(0); changed(); } return false;
        case X.GRAB: c.grab = !!u(0); changed(); return false;
        default: return false;
        }
    }

    const BACK = { w: 84, h: 530, head: 76 };
    return {
        get conn() { return info(); },
        /** A finger on the screen (screen px). Inside the app's claims: the app's. The HMI's column: home / back. */
        touch(phase, x, y) {
            const c = R;
            if (phase === 1) {
                let mine = false;
                if (c && c.visible && c.place && c.claims.length) {
                    const lx = (x - c.place.x - c.place.ox) / c.place.s, ly = (y - c.place.y - c.place.oy) / c.place.s;
                    mine = c.claims.some((r) => lx >= r.x && lx < r.x + r.w && ly >= r.y && ly < r.y + r.h);
                }
                if (!mine && x < BACK.w && y < BACK.h && o.onHmi) o.onHmi(y < BACK.head ? 'home' : 'back');
                else if (!mine && o.onHmiTap) o.onHmiTap(x, y);
                if (c) c.gesture = mine;
            }
            if (!c || !c.gesture || !c.place) return;
            const lx = (x - c.place.x - c.place.ox) / c.place.s, ly = (y - c.place.y - c.place.oy) / c.place.s;
            const b = Buffer.alloc(12);
            b.writeUInt32LE(phase, 0); b.writeFloatLE(lx, 4); b.writeFloatLE(ly, 8);
            toApp(msg(E.TOUCH, null, b));
            if (phase === 3) c.gesture = false;
        },
        /** The iDrive controller: { turn: n } | { press: bool } | { tilt: 'N'|'E'|'S'|'W'|null }. */
        ccu(m) {
            const TILT = { N: 1, E: 4, S: 7, W: 10 };
            const send = () => {
                ccu.seq = (ccu.seq + 1) & 255;
                if (R && R.grab && R.visible) {
                    const b = Buffer.alloc(8);
                    b[0] = ccu.seq; b.writeUInt16BE(ccu.knob, 1); b[3] = ccu.pb; b[4] = ccu.df;
                    toApp(msg(R.native ? X.CCU : E.TOUCH, null, b));
                }
                if (o.onCcu) o.onCcu(Object.assign({ grabbed: !!(R && R.grab && R.visible) }, ccu));
            };
            if (m.turn) {
                let n = Math.max(-64, Math.min(64, Math.round(m.turn)));
                while (n) { const s = Math.max(-16, Math.min(16, n)); n -= s; ccu.knob = (ccu.knob + s) & 0xffff; send(); }
                return;
            }
            if (m.press !== undefined) ccu.pb = m.press ? 1 : 0;
            if (m.tilt !== undefined) ccu.df = TILT[m.tilt] || 0;
            send();
        },
        /** The HMI hid / showed the app (it left its screen): CLOSED as the car's HMI would. */
        closed() { if (R) toApp(msg(E.CLOSED, [])); },
    };
}

module.exports = { start, SOCK };
