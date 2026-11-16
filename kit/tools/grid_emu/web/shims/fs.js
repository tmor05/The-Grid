'use strict';
/**
 * fs for the browser emulator: an in-memory file system. Files the app reads (its fonts, the
 * app spec) are preloaded by the bundle; what it writes under the data folder (settings, best
 * runs, the remembered car) is kept in localStorage when the page may use it, so a reload keeps
 * your settings. Sockets are paths registered by the shim for net (statSync(p).isSocket()).
 */
const { Buffer } = require('buffer');

const files = Object.create(null);
const sockets = new Set();
const STORE = 'thegrid-emu:';
let persistRoot = null;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\.\//g, '/').replace(/\/$/, '') || '/';
const enoent = (p) => { const e = new Error("ENOENT: no such file or directory, open '" + p + "'"); e.code = 'ENOENT'; return e; };
const ls = () => { try { return window.localStorage; } catch (e) { return null; } };

function load(p) {
    if (files[p] !== undefined) return files[p];
    if (persistRoot && p.indexOf(persistRoot) === 0) {
        const s = ls();
        try { const v = s && s.getItem(STORE + p); if (v != null) { files[p] = v; return v; } } catch (e) { /* blocked */ }
    }
    return undefined;
}
function save(p, data) {
    files[p] = data;
    if (persistRoot && p.indexOf(persistRoot) === 0 && typeof data === 'string') {
        const s = ls();
        try { if (s) s.setItem(STORE + p, data); } catch (e) { /* full or blocked */ }
    }
}
const asString = (v) => (typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));
const asData = (d) => (typeof d === 'string' ? d : Buffer.isBuffer(d) || d instanceof Uint8Array ? Buffer.from(d).toString('utf8') : String(d));

const fs = {
    __preload(map) { Object.keys(map).forEach((k) => { files[norm(k)] = map[k]; }); },
    __persist(root) { persistRoot = norm(root); },
    __socket(p) { sockets.add(norm(p)); },
    /** Forget everything stored under the data folder (the page's "Reset" button). */
    __wipe() {
        Object.keys(files).forEach((k) => { if (persistRoot && k.indexOf(persistRoot) === 0) delete files[k]; });
        const s = ls();
        try { if (s) Object.keys(s).filter((k) => k.indexOf(STORE) === 0).forEach((k) => s.removeItem(k)); } catch (e) { /* blocked */ }
    },
    readFileSync(p, enc) {
        p = norm(p);
        const v = load(p);
        if (v === undefined) throw enoent(p);
        const want = typeof enc === 'string' ? enc : enc && enc.encoding;
        return want ? asString(v) : Buffer.from(typeof v === 'string' ? Buffer.from(v, 'utf8') : v);
    },
    writeFileSync(p, d) { save(norm(p), asData(d)); },
    appendFileSync(p, d) { p = norm(p); save(p, (load(p) !== undefined ? asString(load(p)) : '') + asData(d)); },
    writeFile(p, d, o, cb) { if (typeof o === 'function') cb = o; try { fs.writeFileSync(p, d); } catch (e) { if (cb) setTimeout(() => cb(e), 0); return; } if (cb) setTimeout(() => cb(null), 0); },
    readFile(p, o, cb) {
        if (typeof o === 'function') { cb = o; o = null; }
        let v, err = null;
        try { v = fs.readFileSync(p, o); } catch (e) { err = e; }
        setTimeout(() => cb(err, v), 0);
    },
    existsSync(p) { p = norm(p); return load(p) !== undefined || sockets.has(p) || Object.keys(files).some((k) => k.indexOf(p + '/') === 0); },
    mkdirSync() {},
    unlinkSync(p) {
        p = norm(p);
        delete files[p];
        const s = ls();
        try { if (s) s.removeItem(STORE + p); } catch (e) { /* blocked */ }
    },
    readdirSync(d) {
        d = norm(d) + '/';
        const out = new Set();
        Object.keys(files).forEach((k) => { if (k.indexOf(d) === 0) out.add(k.slice(d.length).split('/')[0]); });
        if (!out.size) { const e = enoent(d); throw e; }
        return Array.from(out);
    },
    statSync(p) {
        p = norm(p);
        const sock = sockets.has(p), file = load(p) !== undefined;
        if (!sock && !file) throw enoent(p);
        const size = file ? (typeof load(p) === 'string' ? load(p).length : load(p).length) : 0;
        return { isSocket: () => sock, isFile: () => file, isDirectory: () => false, size, mtimeMs: Date.now(), mtime: new Date() };
    },
    openSync() { throw new Error('emulator: no file sinks'); },
    writeSync() {}, closeSync() {},
    createWriteStream() { return { write() { return true; }, end() {}, on() {} }; },
    watch() { return { close() {}, on() {} }; },
};
fs.promises = {
    readFile: async (p, o) => fs.readFileSync(p, o),
    writeFile: async (p, d) => fs.writeFileSync(p, d),
    mkdir: async () => {},
    unlink: async (p) => fs.unlinkSync(p),
};
module.exports = fs;
