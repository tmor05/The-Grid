'use strict';
/**
 * net for the browser emulator: Unix sockets between the app and the services the page runs
 * in place of the car's (the GPU renderer, cluster-render). net.__listen(path, onConnection)
 * registers a service; the app's net.createConnection(path) gets a socket whose writes reach
 * the service's side in order, a tick later, as bytes would on the car.
 */
const EventEmitter = require('events');
const { Buffer } = require('buffer');
const fs = require('fs');

const services = new Map();

class Sock extends EventEmitter {
    constructor() { super(); this.peer = null; this.destroyed = false; this.q = []; this.flushing = false; this.writableLength = 0; this.connecting = true; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    setTimeout() { return this; }
    ref() { return this; }
    unref() { return this; }
    write(b, enc, cb) {
        if (typeof enc === 'function') { cb = enc; enc = undefined; }
        if (this.destroyed || !this.peer) return false;
        const copy = typeof b === 'string' ? Buffer.from(b, enc || 'utf8') : Buffer.from(b);
        this.q.push(copy);
        if (!this.flushing) { this.flushing = true; Promise.resolve().then(() => this._flush()); }
        if (cb) setTimeout(cb, 0);
        return true;
    }
    _flush() {
        this.flushing = false;
        const peer = this.peer, q = this.q;
        this.q = [];
        if (!peer || peer.destroyed || !q.length) return;
        const all = q.length === 1 ? q[0] : Buffer.concat(q);
        try { peer.emit('data', all); } catch (e) { console.error('[net] ' + (e && e.stack || e)); }
    }
    end() { this.destroy(); }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        const p = this.peer;
        setTimeout(() => {
            this.emit('close', false);
            if (p && !p.destroyed) { p.destroyed = true; p.emit('end'); p.emit('close', false); }
        }, 0);
    }
}

function createConnection(path, cb) {
    if (typeof path === 'object' && path) path = path.path;
    const c = new Sock();
    const svc = services.get(path);
    setTimeout(() => {
        if (!svc) { const e = new Error('connect ENOENT ' + path); e.code = 'ENOENT'; c.emit('error', e); c.destroyed = true; c.emit('close', true); return; }
        const s = new Sock();
        c.peer = s; s.peer = c; c.connecting = s.connecting = false;
        try { svc(s); } catch (e) { console.error('[net] service ' + path + ': ' + (e && e.stack || e)); }
        c.emit('connect');
        if (cb) cb();
    }, 0);
    return c;
}

module.exports = {
    createConnection,
    connect: createConnection,
    Socket: Sock,
    createServer() { throw new Error('emulator: no servers in the app'); },
    __listen(path, onConn) { services.set(path, onConn); fs.__socket(path); },
};
