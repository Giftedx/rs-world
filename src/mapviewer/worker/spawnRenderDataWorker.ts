import { ModuleThread, spawn } from "threads";

import { RenderDataWorker } from "./RenderDataWorker";

// Starts one render data worker. It is kept out of RenderDataWorkerPool.ts: `import.meta` is for ES modules only, and
// Jest (`craco test`) loads that file's tests as CommonJS.
export function spawnRenderDataWorker(): Promise<ModuleThread<RenderDataWorker>> {
    const worker = new Worker(new URL("./RenderDataWorker", import.meta.url));
    return spawn<RenderDataWorker>(worker);
}
