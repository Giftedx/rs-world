import { CacheFiles } from "./CacheFiles";

function makeMemoryCache(initial?: Map<string, any>): Cache {
    const store = initial ?? new Map<string, any>();
    return {
        match: jest.fn(async (req: RequestInfo | URL) => store.get(String(req))),
        matchAll: jest.fn(async (req?: RequestInfo | URL) => {
            const prefix = String(req ?? "");
            const matches: any[] = [];
            for (const [key, val] of store.entries()) {
                if (key.startsWith(prefix)) {
                    matches.push(val);
                }
            }
            return matches;
        }),
        put: jest.fn(async (req: RequestInfo | URL, resp: Response) => {
            store.set(String(req), resp);
        }),
        delete: jest.fn(async (req: RequestInfo | URL) => store.delete(String(req))),
        add: jest.fn(),
        addAll: jest.fn(),
        keys: jest.fn(async () => []),
    } as unknown as Cache;
}

function makeStreamResponse(
    bytes: Uint8Array,
    status: number = 200,
    extraHeaders: Record<string, string> = {},
) {
    const headers = new Map<string, string>([
        ["content-length", String(bytes.byteLength)],
        ...Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v] as const),
    ]);
    return {
        status,
        headers: {
            get: (name: string) => headers.get(name.toLowerCase()) ?? null,
        },
        body: {
            getReader() {
                let done = false;
                return {
                    async read() {
                        if (done) {
                            return { done: true, value: undefined };
                        }
                        done = true;
                        return { done: false, value: bytes };
                    },
                };
            },
        },
    };
}

describe("CacheFiles deduplication, prefetch coordination and range handling", () => {
    const origCaches = (globalThis as any).caches;
    const origFetch = (globalThis as any).fetch;
    const origResponse = (globalThis as any).Response;
    const origReadableStream = (globalThis as any).ReadableStream;
    const origPrefetch = (globalThis as any).__atlasCachePrefetch;

    beforeEach(() => {
        (globalThis as any).ReadableStream = class {
            constructor(src: { start(c: any): void }) {
                src.start({ enqueue() {}, close() {} });
            }
        };
        (globalThis as any).Response = class {
            headers: { get(k: string): string | null };
            constructor(
                public body: any,
                init?: { status?: number; headers?: Record<string, string> },
            ) {
                const map = new Map(
                    Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
                );
                this.headers = { get: (k: string) => map.get(k.toLowerCase()) ?? null };
            }
        };
        delete (globalThis as any).__atlasCachePrefetch;
    });

    afterEach(() => {
        (globalThis as any).caches = origCaches;
        (globalThis as any).fetch = origFetch;
        (globalThis as any).Response = origResponse;
        (globalThis as any).ReadableStream = origReadableStream;
        if (origPrefetch === undefined) {
            delete (globalThis as any).__atlasCachePrefetch;
        } else {
            (globalThis as any).__atlasCachePrefetch = origPrefetch;
        }
    });

    test("deduplicates concurrent dat/idx fetches and preserves shared download when one waiter aborts", async () => {
        const memCache = makeMemoryCache();
        (globalThis as any).caches = { open: jest.fn(async () => memCache) };

        let resolveDat!: (v: any) => void;
        let datSignal: AbortSignal | undefined;
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        const fetchMock = jest.fn((url: string, init?: RequestInit) => {
            if (url.endsWith("main_file_cache.dat")) {
                datSignal = init?.signal ?? undefined;
                return new Promise((resolve) => {
                    resolveDat = resolve;
                });
            }
            return Promise.resolve(makeStreamResponse(new Uint8Array([9, 8]), 200));
        });
        (globalThis as any).fetch = fetchMock;

        const flush = () => new Promise((r) => setTimeout(r, 0));
        const c1 = new AbortController();
        const c2 = new AbortController();
        const p1 = CacheFiles.fetchDat("/caches/rs-sdk-289/", "rs-sdk-289", false, c1.signal);
        const p2 = CacheFiles.fetchDat("/caches/rs-sdk-289/", "rs-sdk-289", false, c2.signal);

        try {
            await flush();
            // Only 1 dat + 5 idx fetches despite 2 concurrent fetchDat callers.
            expect(fetchMock).toHaveBeenCalledTimes(6);

            // Aborting caller 1 rejects only caller 1; underlying fetch continues for caller 2.
            c1.abort();
            await expect(p1).rejects.toThrow(/Aborted/i);
            expect(datSignal?.aborted).toBe(false);
        } finally {
            resolveDat?.(makeStreamResponse(payload, 200));
        }
        const result = await p2;
        expect(new Uint8Array(result.files.get("main_file_cache.dat")!)).toEqual(payload);
    });

    test("consumes __atlasCachePrefetch files without extra network fetches", async () => {
        const memCache = makeMemoryCache();
        (globalThis as any).caches = { open: jest.fn(async () => memCache) };

        const datBytes = new Uint8Array([10, 20, 30, 40]).buffer;
        const idx0 = new Uint8Array([1]).buffer;
        const idx1 = new Uint8Array([2]).buffer;
        const idx2 = new Uint8Array([3]).buffer;
        const idx3 = new Uint8Array([4]).buffer;
        const idx4 = new Uint8Array([5]).buffer;
        (globalThis as any).__atlasCachePrefetch = {
            ready: Promise.resolve(),
            files: new Map<string, Promise<ArrayBuffer>>([
                ["/viewer/caches/rs-sdk-289/main_file_cache.dat", Promise.resolve(datBytes)],
                ["/viewer/caches/rs-sdk-289/main_file_cache.idx0", Promise.resolve(idx0)],
                ["/viewer/caches/rs-sdk-289/main_file_cache.idx1", Promise.resolve(idx1)],
                ["/viewer/caches/rs-sdk-289/main_file_cache.idx2", Promise.resolve(idx2)],
                ["/viewer/caches/rs-sdk-289/main_file_cache.idx3", Promise.resolve(idx3)],
                ["/viewer/caches/rs-sdk-289/main_file_cache.idx4", Promise.resolve(idx4)],
            ]),
        };

        const fetchMock = jest.fn(() => {
            throw new Error("should not fetch when prefetch holds file");
        });
        (globalThis as any).fetch = fetchMock;

        const result = await CacheFiles.fetchDat("/viewer/caches/rs-sdk-289/", "rs-sdk-289");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(new Uint8Array(result.files.get("main_file_cache.dat")!)).toEqual(
            new Uint8Array([10, 20, 30, 40]),
        );
    });

    test("drops stale partial prefix when server replies 200 instead of 206, and handles 416 exact EOF", async () => {
        // Case 1: offset > 0 and server returns 200 OK full payload -> must not duplicate prefix.
        const part0 = makeStreamResponse(new Uint8Array([1, 2]), 200, { "Cache-Part": "0" });
        (part0 as any).url = "/caches/rs-sdk-289/main_file_cache.dat/part/?p=0";
        const store1 = new Map<string, any>([
            ["/caches/rs-sdk-289/main_file_cache.dat/part/?p=0", part0],
        ]);
        const cache1 = makeMemoryCache(store1);
        (globalThis as any).caches = { open: jest.fn(async () => cache1) };
        (globalThis as any).fetch = jest.fn(async (url: string) => {
            if (url.endsWith("main_file_cache.dat")) {
                return makeStreamResponse(new Uint8Array([1, 2, 3, 4]), 200);
            }
            return makeStreamResponse(new Uint8Array([0]), 200);
        });
        const res1 = await CacheFiles.fetchDat("/caches/rs-sdk-289/", "rs-sdk-289");
        expect(new Uint8Array(res1.files.get("main_file_cache.dat")!)).toEqual(
            new Uint8Array([1, 2, 3, 4]),
        );

        // Case 2: offset > 0 and server replies 416 with matching Content-Range total -> assembles parts.
        const partA = makeStreamResponse(new Uint8Array([5, 6, 7]), 200, { "Cache-Part": "0" });
        (partA as any).url = "/caches/rs-sdk-289/main_file_cache.dat/part/?p=0";
        const store2 = new Map<string, any>([
            ["/caches/rs-sdk-289/main_file_cache.dat/part/?p=0", partA],
        ]);
        const cache2 = makeMemoryCache(store2);
        (globalThis as any).caches = { open: jest.fn(async () => cache2) };
        (globalThis as any).fetch = jest.fn(async (url: string) => {
            if (url.endsWith("main_file_cache.dat")) {
                return makeStreamResponse(new Uint8Array(0), 416, { "Content-Range": "bytes */3" });
            }
            return makeStreamResponse(new Uint8Array([0]), 200);
        });
        const res2 = await CacheFiles.fetchDat("/caches/rs-sdk-289/", "rs-sdk-289");
        expect(new Uint8Array(res2.files.get("main_file_cache.dat")!)).toEqual(
            new Uint8Array([5, 6, 7]),
        );
    });
});
