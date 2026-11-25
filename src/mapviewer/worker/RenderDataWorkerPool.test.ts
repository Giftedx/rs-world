import { Bzip2 } from "../../rs/compression/Bzip2";
import { RenderDataWorkerPool } from "./RenderDataWorkerPool";

// A stand-in for one worker thread with the rules of RenderDataWorker: a task that reads the cache throws
// "Worker not initialized" until the worker has had its initCache message.
function fakeThread(log: string[], name: string, rejectWasm = false) {
    let cache: unknown;
    const needCache = () => {
        if (!cache) {
            throw new Error("Worker not initialized");
        }
    };
    return {
        async initCache(c: unknown, _npcSpawns: unknown, wasm?: unknown) {
            if (rejectWasm && wasm) {
                throw new Error("DataCloneError");
            }
            log.push(`${name} initCache`);
            cache = c;
        },
        async initDataLoader() {},
        async load(_loader: unknown, input: unknown) {
            needCache();
            log.push(`${name} load`);
            return input;
        },
        async loadEntityAnim() {
            needCache();
            return "anim";
        },
        async loadTexture() {
            needCache();
            return "texture";
        },
        async loadMapImage() {
            needCache();
            return "map image";
        },
        async setVars() {
            needCache();
            log.push(`${name} setVars`);
        },
        async loadCachedMapImages() {
            needCache();
            return new Map<number, string>();
        },
    };
}

// The threads Pool runs a task on a worker as soon as that worker has started: it does not know about initCache.
function fakePool(threads: ReturnType<typeof fakeThread>[]) {
    const workers = threads.map((t) => ({ init: Promise.resolve(t), runningTasks: [] }));
    let next = 0;
    const pool = {
        queue: (task: (w: any) => Promise<unknown>) => workers[next++ % workers.length].init.then(task),
        terminate: async () => {},
    };
    return new RenderDataWorkerPool(pool as any, workers as any, workers.length);
}

const cache = { info: { name: "test" } } as any;
const loader = {} as any;
const originalInitWasm = Bzip2.initWasm;
const originalWasmModule = Bzip2.wasmModule;

beforeEach(() => {
    // The bzip2 WebAssembly loads on the main thread first, so initCache reaches each worker late.
    (Bzip2 as any).initWasm = () => new Promise((resolve) => setTimeout(resolve, 20));
});

afterEach(() => {
    (Bzip2 as any).initWasm = originalInitWasm;
    Bzip2.wasmModule = originalWasmModule;
});

test("map squares queued at start wait for the cache and do not fail", async () => {
    const log: string[] = [];
    const pool = fakePool([fakeThread(log, "a"), fakeThread(log, "b")]);
    pool.initCache(cache, []);
    const squares = await Promise.all([
        pool.queueLoad(loader, [49, 53]),
        pool.queueLoad(loader, [49, 54]),
    ]);
    expect(squares).toEqual([
        [49, 53],
        [49, 54],
    ]);
    expect(log.indexOf("a load")).toBeGreaterThan(log.indexOf("a initCache"));
    expect(log.indexOf("b load")).toBeGreaterThan(log.indexOf("b initCache"));
});

test("initCache resolves after every worker has the cache", async () => {
    const log: string[] = [];
    const pool = fakePool([fakeThread(log, "a"), fakeThread(log, "b")]);
    await pool.initCache(cache, []);
    expect(log.sort()).toEqual(["a initCache", "b initCache"]);
});

test("every task that reads the cache waits for initCache", async () => {
    const log: string[] = [];
    const pool = fakePool([fakeThread(log, "a")]);
    pool.initCache(cache, []);
    const results = await Promise.all([
        pool.queueEntityAnim({} as any),
        pool.queueLoadTexture(1, 128, false, 0.7),
        pool.queueMapImage(49, 53, 0, true),
        pool.loadCachedMapImages(),
        pool.setVars(new Int32Array(1)),
    ]);
    expect(results.slice(0, 4)).toEqual(["anim", "texture", "map image", new Map()]);
    expect(log).toEqual(["a initCache", "a setVars"]);
});

test("a worker that cannot take the WebAssembly module gets the cache without it", async () => {
    Bzip2.wasmModule = {} as WebAssembly.Module;
    const log: string[] = [];
    const pool = fakePool([fakeThread(log, "a", true)]);
    pool.initCache(cache, []);
    expect(await pool.queueLoad(loader, [49, 53])).toEqual([49, 53]);
    expect(log).toEqual(["a initCache", "a load"]);
});
