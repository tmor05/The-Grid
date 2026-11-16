'use strict';
/** zlib for the browser emulator: the sync calls the kit uses (font atlases, PNGs), via pako. */
const pako = require('pako');
const { Buffer } = require('buffer');

const out = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
module.exports = {
    inflateSync: (b) => out(pako.inflate(b)),
    deflateSync: (b, o) => out(pako.deflate(b, { level: (o && o.level) != null ? o.level : 6 })),
    inflateRawSync: (b) => out(pako.inflateRaw(b)),
    deflateRawSync: (b) => out(pako.deflateRaw(b)),
    gunzipSync: (b) => out(pako.ungzip(b)),
    gzipSync: (b) => out(pako.gzip(b)),
    constants: {},
};
