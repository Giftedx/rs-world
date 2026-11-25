// Unit tests for the per-frame work of the entity renderer: page keys built once, loc overrides out of range skipped
// before any lookup, far players read from the squares near the camera, ground heights without a new object.
import { Camera } from "../mapviewer/Camera";
import { FarPlayers } from "./FarPlayers";
import { LiveNpc } from "./LiveEntity";
import { LiveEntityRenderer, getGroundHeight } from "./LiveEntityRenderer";

// Every map square is loaded and flat.
const square = { heightMapData: true, getTileRenderFlag: () => 0, getHeightInterp: () => 0 };
const mapManager = { getMap: () => square, mapSquares: new Map() } as any;

function renderer(world: any) {
    const asked: string[] = [];
    const workerPool = {
        queueEntityAnim: (request: { key: string }) => {
            asked.push(request.key);
            return new Promise(() => {});
        },
    } as any;
    const app = { createTexture2D: () => ({ data() {}, delete() {} }) } as any;
    const r = new LiveEntityRenderer(
        app,
        {} as any,
        {} as any,
        workerPool,
        { load: () => ({}) } as any,
        mapManager,
        world,
    );
    return { r, asked };
}

function world(far: FarPlayers = new FarPlayers()) {
    return {
        players: new Map(),
        npcs: new Map(),
        far,
        loopCycle: 0,
        spotAnimTypeLoader: undefined,
    } as any;
}

function npc(id: number, type: number, tileX: number, tileZ: number): LiveNpc {
    const n = new LiveNpc(id);
    n.setType({ id: type, size: 1, rotationSpeed: 32, idleSeqId: -1, walkSeqId: -1 } as any);
    n.x = tileX * 128 + 64;
    n.z = tileZ * 128 + 64;
    return n;
}

const camera = new Camera(3200, -6, 3195, -185, 0);

test("an npc's page key is built once and keeps the key format", () => {
    const w = world();
    const goblin = npc(1, 5, 3200, 3200);
    w.npcs.set(1, goblin);
    const { r, asked } = renderer(w);
    r.prepare(3, camera, 64);
    expect(asked).toEqual(["n5@-1"]);
    const cached = goblin.pageKey;
    expect(cached.key).toBe("n5@-1");

    r.prepare(3, camera, 64);
    expect(goblin.pageKey).toBe(cached);
    expect(cached.key).toBe("n5@-1");

    goblin.secondaryAnim = 808;
    r.prepare(3, camera, 64);
    expect(cached.key).toBe("n5@808");
});

test("loc overrides out of the view's range are skipped before the static loc and type lookups", () => {
    const w = world();
    const { r } = renderer(w);
    const looked: number[] = [];
    r.getStaticLoc = (x: number) => {
        looked.push(x);
        return false;
    };
    r.locTypeLoader = { load: () => ({ sizeX: 1, sizeY: 1 }) } as any;
    const loc = (x: number, z: number) => ({
        x,
        z,
        level: 0,
        layer: 2,
        id: 1,
        shape: 10,
        angle: 0,
        seq: undefined,
        animFrame: 0,
    });
    r.worldState = {
        locs: new Map([
            [1, loc(3205, 3200)],
            [2, loc(3400, 3400)],
            [3, loc(3200 + 64 + 15, 3200)],
        ]),
        objTiles: new Map(),
        mapAnims: [],
        projectiles: [],
    } as any;
    r.prepare(3, camera, 64);
    // 3205 is in range; 3279 is 15 tiles past the range, inside the 16-tile margin, so its exact check runs.
    expect(looked).toEqual([3205, 3279]);
});

test("far players come from the squares near the camera, and the ones in the streamed area are left out", () => {
    const far = new FarPlayers();
    far.update(
        [
            [1, "Near", 3210, 3200, 0, 3],
            [2, "Gone", 2600, 3400, 0, 3],
            [3, "Edge", 3200 + 70, 3200, 0, 3],
            [4, "Streamed", 3205, 3205, 0, 3],
        ],
        1,
        0,
    );
    expect([...far.squares.values()].reduce((n, list) => n + list.length, 0)).toBe(4);
    const w = world(far);
    w.players.set(4, {} as any);
    const { r } = renderer(w);
    // The shared far body is baked: one page for standing and walking.
    const page = { key: "far", frames: [[0, 1, 1]], frameHeights: new Int16Array([200]) };
    (r as any).getFarPlayerPage = () => page;
    (r as any).pushItem = () => {};
    r.prepare(3, camera, 64);
    expect(r.farLabels.map((l) => l.name)).toEqual(["Near"]);
});

test("getGroundHeight writes into the object it is given", () => {
    const out = { y: 1, plane: 9 };
    expect(getGroundHeight(mapManager, 0, 3200 * 128, 3200 * 128, out)).toBe(out);
    expect(out).toEqual({ y: 0, plane: 0 });
    expect(getGroundHeight(mapManager, 0, 3200 * 128, 3200 * 128)).toEqual({ y: 0, plane: 0 });
});
