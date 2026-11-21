import WasmBzip2 from "@foxglove/wasm-bz2";

const bzip2 = require("bzip2");
const createBzip2Module = require("@foxglove/wasm-bz2/wasm/module");
const wasmBzipUrl: string = require("@foxglove/wasm-bz2/wasm/module.wasm");

async function compileBzip2Module(): Promise<WebAssembly.Module> {
    const responsePromise = fetch(wasmBzipUrl, { credentials: "same-origin" });
    if (typeof WebAssembly.compileStreaming === "function") {
        try {
            return await WebAssembly.compileStreaming(responsePromise);
        } catch {
            // Fall back to ArrayBuffer compile if server Content-Type is not application/wasm.
        }
    }
    const response = await responsePromise;
    if (!response.ok) {
        throw new Error(`Failed loading bzip2 wasm (${response.status})`);
    }
    return await WebAssembly.compile(await response.arrayBuffer());
}

export class Bzip2 {
    static bzip2Header = new Uint8Array("BZh1".split("").map((char) => char.charCodeAt(0)));

    static wasmBzip: WasmBzip2;
    static wasmModule?: WebAssembly.Module;
    private static initPromise?: Promise<WasmBzip2>;

    static initWasm(precompiled?: WebAssembly.Module | ArrayBuffer): Promise<WasmBzip2> {
        if (Bzip2.wasmBzip) {
            return Promise.resolve(Bzip2.wasmBzip);
        }
        if (!Bzip2.initPromise) {
            Bzip2.initPromise = (async () => {
                try {
                    let mod: WebAssembly.Module | undefined;
                    if (precompiled instanceof WebAssembly.Module) {
                        mod = precompiled;
                    } else if (precompiled instanceof ArrayBuffer) {
                        mod = await WebAssembly.compile(precompiled);
                    } else if (Bzip2.wasmModule) {
                        mod = Bzip2.wasmModule;
                    } else if (typeof fetch === "function" && typeof WebAssembly !== "undefined") {
                        mod = await compileBzip2Module();
                    }

                    let bzip: WasmBzip2;
                    if (mod) {
                        Bzip2.wasmModule = mod;
                        const initFactory = createBzip2Module.default ?? createBzip2Module;
                        const emModule = await initFactory({
                            instantiateWasm(
                                imports: WebAssembly.Imports,
                                successCallback: (inst: WebAssembly.Instance, m?: WebAssembly.Module) => void,
                            ) {
                                WebAssembly.instantiate(mod!, imports).then((inst) =>
                                    successCallback(inst, mod),
                                );
                                return {};
                            },
                        });
                        bzip = new (WasmBzip2 as unknown as new (m: unknown) => WasmBzip2)(emModule);
                    } else {
                        bzip = await WasmBzip2.init();
                    }
                    Bzip2.wasmBzip = bzip;
                    return bzip;
                } catch (err) {
                    Bzip2.initPromise = undefined;
                    throw err;
                }
            })();
        }
        return Bzip2.initPromise;
    }

    static decompress(compressed: Uint8Array, actualSize: number): Int8Array {
        const compressedBzip = new Uint8Array(compressed.length + 4);
        compressedBzip.set(Bzip2.bzip2Header, 0);
        compressedBzip.set(compressed, 4);

        if (Bzip2.wasmBzip) {
            const decompressed = Bzip2.wasmBzip.decompress(compressedBzip, actualSize, {
                small: false,
            });
            return new Int8Array(decompressed.buffer);
        }

        return new Int8Array(bzip2.simple(bzip2.array(compressedBzip)).buffer);
    }
}
