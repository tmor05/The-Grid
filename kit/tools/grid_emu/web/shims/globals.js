// injected into every module of the emulator bundle (esbuild "inject"): Node's globals
import { Buffer } from 'buffer';
import proc from './process.js';

const setImmediate_ = (fn, ...a) => setTimeout(fn, 0, ...a);
const clearImmediate_ = (t) => clearTimeout(t);
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = proc;
if (!globalThis.setImmediate) globalThis.setImmediate = setImmediate_;
if (!globalThis.clearImmediate) globalThis.clearImmediate = clearImmediate_;
export { Buffer, proc as process, setImmediate_ as setImmediate, clearImmediate_ as clearImmediate };
