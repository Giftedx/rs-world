import { ModuleThread, Pool } from "threads";
import { QueuedTask } from "threads/dist/master/pool";
import { WorkerDescriptor } from "threads/dist/master/pool-types";
import { ObservablePromise } from "threads/dist/observable-promise";

import { EntityAnimData, EntityAnimRequest } from "../../live/EntityModelLoader";
import { Bzip2 } from "../../rs/compression/Bzip2";
import { Gzip } from "../../rs/compression/Gzip";
import { LoadedCache } from "../Caches";
import { NpcSpawn } from "../data/npc/NpcSpawn";
import { MinimapData } from "./MinimapData";
import { RenderDataLoader } from "./RenderDataLoader";
import { RenderDataWorker, WorkerWasm } from "./RenderDataWorker";

type RenderDataWorkerThread = ModuleThread<RenderDataWorker>;

export class RenderDataWorkerPool {
    // spawnWorker is spawnRenderDataWorker in the app. It comes in as an argument, so this file has no `import.meta`.
    static create(size: number, spawnWorker: () => Promise<RenderDataWorkerThread>): RenderDataWorkerPool {
        const pool = Pool(() => spawnWorker(), size);
        const workers = pool["workers"] as WorkerDescriptor<RenderDataWorkerThread>[];
        return new RenderDataWorkerPool(pool, workers, size);
    }

    // Resolves when every worker has the cache that initCache sent last. The pool starts a task on a worker as soon as
    // the worker runs, but initCache reaches the worker only after the WebAssembly loads on this thread. A worker
    // without its cache throws "Worker not initialized", so each task that reads the cache waits for this first.
    private cacheReady: Promise<void> | undefined;

    constructor(
        readonly pool: Pool<RenderDataWorkerThread>,
        readonly workers: WorkerDescriptor<RenderDataWorkerThread>[],
        readonly size: number,
    ) {}

    initCache(cache: LoadedCache, npcSpawns: NpcSpawn[]): Promise<void> {
        const wasmReady: Promise<WorkerWasm | undefined> = Promise.all([
            Bzip2.initWasm().catch(() => undefined),
            Gzip.initWasm().catch(() => undefined),
        ]).then(() =>
            Bzip2.wasmModule || Gzip.wasmModule
                ? { bz2: Bzip2.wasmModule, gzip: Gzip.wasmModule }
                : undefined,
        );
        const ready = Promise.all(
            this.workers.map((worker) =>
                Promise.all([worker.init, wasmReady]).then(async ([w, wasm]) => {
                    try {
                        await w.initCache(cache, npcSpawns, wasm);
                    } catch {
                        // Fall back without shared WebAssembly.Module if structured clone rejects it.
                        await w.initCache(cache, npcSpawns);
                    }
                }),
            ),
        ).then(() => undefined);
        this.cacheReady = ready;
        return ready;
    }

    private afterCache<R>(
        task: (w: RenderDataWorkerThread) => PromiseLike<R>,
    ): (w: RenderDataWorkerThread) => Promise<R> {
        return async (w) => {
            await this.cacheReady;
            return task(w);
        };
    }

    async runAll(task: (w: RenderDataWorkerThread) => any): Promise<void> {
        await Promise.all(this.workers.map((desc) => desc.init.then(task)));
    }

    initLoader(loader: RenderDataLoader<any, any>): Promise<void> {
        return this.runAll((w) => w.initDataLoader(loader));
    }

    resetLoader(loader: RenderDataLoader<any, any>): Promise<void> {
        return this.runAll((w) => w.resetDataLoader(loader));
    }

    queueLoad<I, D, Loader extends RenderDataLoader<I, D>>(
        loader: Loader,
        input: I,
    ): QueuedTask<RenderDataWorkerThread, D> {
        return this.pool.queue(
            this.afterCache((w) => w.load(loader, input) as ObservablePromise<D>),
        );
    }

    queueEntityAnim(
        request: EntityAnimRequest,
    ): QueuedTask<RenderDataWorkerThread, EntityAnimData | undefined> {
        return this.pool.queue(
            this.afterCache(
                (w) => w.loadEntityAnim(request) as ObservablePromise<EntityAnimData | undefined>,
            ),
        );
    }

    queueLoadTexture(
        id: number,
        size: number,
        flipH: boolean,
        brightness: number,
    ): QueuedTask<RenderDataWorkerThread, Int32Array> {
        return this.pool.queue(
            this.afterCache(
                (w) => w.loadTexture(id, size, flipH, brightness) as ObservablePromise<Int32Array>,
            ),
        );
    }

    queueMapImage(
        mapX: number,
        mapY: number,
        level: number,
        drawMapFunctions: boolean,
    ): QueuedTask<RenderDataWorkerThread, MinimapData | undefined> {
        return this.pool.queue(
            this.afterCache((w) => w.loadMapImage(mapX, mapY, level, drawMapFunctions)),
        );
    }

    setVars(vars: Int32Array): Promise<void> {
        return this.runAll(this.afterCache((w) => w.setVars(vars)));
    }

    loadCachedMapImages(): QueuedTask<RenderDataWorkerThread, Map<number, string>> {
        return this.pool.queue(this.afterCache((w) => w.loadCachedMapImages()));
    }

    terminate(): Promise<void> {
        return this.pool.terminate();
    }
}
