import { TextDecoder, TextEncoder } from "util";
import { Hasher } from "../../util/Hasher";

if (!(globalThis as any).TextEncoder) {
    (globalThis as any).TextEncoder = TextEncoder;
}
if (!(globalThis as any).TextDecoder) {
    (globalThis as any).TextDecoder = TextDecoder;
}

describe("WASM initialization deduplication", () => {
    const origFetch = (globalThis as any).fetch;
    const origCompile = WebAssembly.compile;
    const origCompileStreaming = (WebAssembly as any).compileStreaming;
    const origInstantiate = WebAssembly.instantiate;

    afterEach(() => {
        (globalThis as any).fetch = origFetch;
        WebAssembly.compile = origCompile;
        (WebAssembly as any).compileStreaming = origCompileStreaming;
        WebAssembly.instantiate = origInstantiate;
    });

    test("Hasher.init returns a single shared promise and instance", async () => {
        const [a, b] = await Promise.all([Hasher.init(), Hasher.init()]);
        expect(a).toBe(b);
        expect(Hasher.hash32(new Uint8Array([1, 2, 3]))).toBe(a.h32Raw(new Uint8Array([1, 2, 3])));
    });

    test("Bzip2.initWasm fetches/compiles module.wasm once and deduplicates concurrent callers", async () => {
        const fakeModule = Object.create(WebAssembly.Module.prototype);
        const fetchMock = jest.fn(async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new ArrayBuffer(8),
        }));
        (globalThis as any).fetch = fetchMock;
        (WebAssembly as any).compileStreaming = undefined;
        WebAssembly.compile = jest.fn(async () => fakeModule);
        WebAssembly.instantiate = jest.fn(async () => ({ exports: { memory: new WebAssembly.Memory({ initial: 1 }), __wasm_call_ctors() {}, __indirect_function_table: new WebAssembly.Table({ initial: 0, element: "anyfunc" }) } }) as any);

        let Bzip2!: typeof import("./Bzip2").Bzip2;
        jest.isolateModules(() => {
            jest.doMock("@foxglove/wasm-bz2", () => {
                return {
                    __esModule: true,
                    default: class {
                        constructor(public module: any) {}
                    },
                };
            });
            jest.doMock("@foxglove/wasm-bz2/wasm/module", () => ({
                __esModule: true,
                default: async (cfg: any) => {
                    cfg.instantiateWasm({}, () => {});
                    return { decompress: jest.fn() };
                },
            }));
            Bzip2 = require("./Bzip2").Bzip2;
        });

        const p1 = Bzip2.initWasm();
        const p2 = Bzip2.initWasm();
        expect(p1).toBe(p2);
        const [b1, b2] = await Promise.all([p1, p2]);
        expect(b1).toBe(b2);
        expect(Bzip2.wasmModule).toBe(fakeModule);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Subsequent call reuses already-initialized instance without fetching again.
        await Bzip2.initWasm(fakeModule);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
