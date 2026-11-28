import { MapManager, MapSquare } from "./MapManager";
import { MAX_BODY_CACHE_ENTRIES, EntityModelLoader } from "../live/EntityModelLoader";
import { LiveEntityRenderer } from "../live/LiveEntityRenderer";
import { WebGLMapSquare } from "./webgl/WebGLMapSquare";

class FakeSquare implements MapSquare {
    deleted = false;
    constructor(
        readonly mapX: number,
        readonly mapY: number,
    ) {}
    canRender(): boolean {
        return true;
    }
    delete(): void {
        this.deleted = true;
    }
}

function makeCamera(x: number, z: number, visibleIds?: Set<number>) {
    return {
        updatedPosition: true,
        getPosX: () => x,
        getPosZ: () => z,
        frustum: {
            intersectsBox: (box: number[][]) => {
                if (!visibleIds) return true;
                const mapX = Math.floor(box[0][0] / 64);
                const mapY = Math.floor(box[0][2] / 64);
                return visibleIds.has((mapX << 8) + mapY);
            },
        },
    } as any;
}

describe("MapManager memory retention", () => {
    test("update() truncates visibleMaps when fewer squares are visible so evicted squares are released", () => {
        const manager = new MapManager<FakeSquare>(8, () => {});
        const s1 = new FakeSquare(50, 50);
        const s2 = new FakeSquare(51, 50);
        const s3 = new FakeSquare(50, 51);
        manager.addMap(50, 50, s1);
        manager.addMap(51, 50, s2);
        manager.addMap(50, 51, s3);

        // All 3 visible on frame 1
        manager.update(makeCamera(50 * 64 + 32, 50 * 64 + 32), 1, 96, 2);
        expect(manager.visibleMapCount).toBe(3);
        expect(manager.visibleMaps.length).toBe(3);

        // Only 1 visible on frame 2: trailing references must be dropped immediately
        const onlyOne = new Set([(50 << 8) + 50]);
        manager.update(makeCamera(50 * 64 + 32, 50 * 64 + 32, onlyOne), 2, 96, 2);
        expect(manager.visibleMapCount).toBe(1);
        expect(manager.visibleMaps.length).toBe(1);
        expect(manager.visibleMaps[0]).toBe(s1);

        // clearMaps() drops visibleMaps and calls delete() on every square
        manager.clearMaps();
        expect(manager.visibleMapCount).toBe(0);
        expect(manager.visibleMaps.length).toBe(0);
        expect(s1.deleted && s2.deleted && s3.deleted).toBe(true);
    });

    test("EntityModelLoader bounds bodyCache via LRU at MAX_BODY_CACHE_ENTRIES", () => {
        const loader = new EntityModelLoader(
            {} as any,
            {} as any,
            {} as any,
            { load: () => ({ modelId: undefined }) } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        const cacheBody = (loader as any).cacheBody.bind(loader);
        for (let i = 0; i < MAX_BODY_CACHE_ENTRIES + 40; i++) {
            cacheBody(`k:${i}`, undefined);
        }
        expect(loader.bodyCache.size).toBe(MAX_BODY_CACHE_ENTRIES);
        expect(loader.bodyCache.has("k:0")).toBe(false);
        expect(loader.bodyCache.has(`k:${MAX_BODY_CACHE_ENTRIES + 39}`)).toBe(true);
    });

    test("LiveEntityRenderer bounds failed page sentinel entries", () => {
        const renderer = Object.create(LiveEntityRenderer.prototype) as any;
        renderer.pages = new Map();
        renderer.failedKeys = [];
        for (let i = 0; i < 600; i++) {
            renderer.markFailed(`bad:${i}`);
        }
        expect(renderer.pages.size).toBe(512);
        expect(renderer.pages.has("bad:0")).toBe(false);
        expect(renderer.pages.has("bad:599")).toBe(true);
    });

    test("WebGLMapSquare.delete clears CPU-side typed arrays and hiddenLocs", () => {
        const noop = { delete: () => {} };
        const sq = Object.create(WebGLMapSquare.prototype) as any;
        sq.vertexArray = noop;
        sq.interleavedBuffer = noop;
        sq.indexBuffer = noop;
        sq.heightMapTexture = noop;
        sq.modelInfoTexture = noop;
        sq.modelInfoTextureAlpha = noop;
        sq.modelInfoTextureLod = noop;
        sq.modelInfoTextureLodAlpha = noop;
        sq.modelInfoTextureInteract = noop;
        sq.modelInfoTextureInteractAlpha = noop;
        sq.modelInfoTextureInteractLod = noop;
        sq.modelInfoTextureInteractLodAlpha = noop;
        sq.hiddenLocs = new Map([[1, {}]]);
        sq.heightMapData = new Int16Array(64);
        sq.locTable = { refs: [] };
        sq.modelTextureDatas = [new Uint16Array(64)];

        sq.delete();
        expect(sq.hiddenLocs.size).toBe(0);
        expect(sq.heightMapData).toBeUndefined();
        expect(sq.locTable).toBeUndefined();
        expect(sq.modelTextureDatas).toBeUndefined();
    });
});
