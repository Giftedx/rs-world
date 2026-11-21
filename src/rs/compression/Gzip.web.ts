import pako from "pako";
import init, { decompressGzip } from "wasm-gzip";

const wasmGzipUrl = require("wasm-gzip/wasm_gzip_bg.wasm");

export class Gzip {
    static wasmLoaded = false;
    static wasmModule?: WebAssembly.Module;
    private static initPromise?: Promise<void>;

    static initWasm(precompiled?: WebAssembly.Module | ArrayBuffer): Promise<void> {
        if (Gzip.wasmLoaded) {
            return Promise.resolve();
        }
        if (!Gzip.initPromise) {
            Gzip.initPromise = (async () => {
                try {
                    const source = precompiled ?? Gzip.wasmModule ?? wasmGzipUrl;
                    await init(source);
                    if (source instanceof WebAssembly.Module) {
                        Gzip.wasmModule = source;
                    } else {
                        Gzip.wasmModule = (init as unknown as { __wbindgen_wasm_module?: WebAssembly.Module }).__wbindgen_wasm_module;
                    }
                    Gzip.wasmLoaded = true;
                } catch (err) {
                    Gzip.initPromise = undefined;
                    throw err;
                }
            })();
        }
        return Gzip.initPromise;
    }

    static decompress(compressed: Uint8Array): Int8Array {
        if (!Gzip.wasmLoaded) {
            const decompressed = new Int8Array(pako.ungzip(compressed).buffer);
            return decompressed;
        }
        const decompressed = decompressGzip(compressed);
        if (!decompressed) {
            throw new Error("Failed to decompress gzip");
        }
        return new Int8Array(decompressed.buffer);
    }
}
