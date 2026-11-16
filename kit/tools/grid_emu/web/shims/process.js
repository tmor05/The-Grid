'use strict';
/** process for the browser emulator: the few fields the kit reads. */
const t0 = Date.now();
const listeners = {};
const proc = {
    env: {
        MGU_RENDERD_SOCKET: '/run/mgu-render/render.sock',
        CLUSTER_RENDER_SOCK: '/dev/shm/cluster-render/render.sock',
    },
    argv: ['node', 'app.js'],
    platform: 'linux',
    arch: 'x64',
    pid: 4242,
    version: 'v16.20.0',
    versions: { node: '16.20.0' },
    title: 'node',
    browser: true,
    cwd: () => '/data',
    exit: (c) => { console.warn('[process] exit(' + c + ') ignored in the emulator'); },
    nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)),
    hrtime: Object.assign((prev) => {
        const ms = performance.now(), s = Math.floor(ms / 1000), ns = Math.floor((ms % 1000) * 1e6);
        if (!prev) return [s, ns];
        let ds = s - prev[0], dn = ns - prev[1];
        if (dn < 0) { ds--; dn += 1e9; }
        return [ds, dn];
    }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
    uptime: () => (Date.now() - t0) / 1000,
    memoryUsage: () => ({ rss: 64 << 20, heapUsed: 32 << 20, heapTotal: 48 << 20, external: 0 }),
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return proc; },
    once(ev, fn) { return proc.on(ev, fn); },
    off() { return proc; },
    removeListener() { return proc; },
    emit(ev, ...a) { (listeners[ev] || []).forEach((fn) => fn(...a)); return true; },
    send: null,
    connected: false,
    stdout: { write: (s) => { console.log(String(s)); return true; } },
    stderr: { write: (s) => { console.warn(String(s)); return true; } },
};
module.exports = proc;
