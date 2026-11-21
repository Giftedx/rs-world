import pako from "pako";

export class Gzip {
    static wasmModule?: WebAssembly.Module;

    static async initWasm(_precompiled?: WebAssembly.Module | ArrayBuffer): Promise<void> {}

    static decompress(compressed: Uint8Array): Int8Array {
        const decompressed = new Int8Array(pako.ungzip(compressed).buffer);
        return decompressed;
    }
}
