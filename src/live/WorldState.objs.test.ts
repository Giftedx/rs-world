import { LiveWorld } from "./LiveWorld";
import { WorldState, getLocKey, getTileKey } from "./WorldState";
import { ZoneRecord } from "./protocol";

function createState(): WorldState {
    const locTypeLoader = { load: () => ({ seqId: -1 }) } as any;
    const seqTypeLoader = { load: () => ({ frameIds: [] }) } as any;
    return new WorldState(locTypeLoader, seqTypeLoader, {} as any, undefined);
}

const world = {} as LiveWorld;

// 64 x 64 tiles at (3200, 3200): zones 400..407 x 400..407.
const AREA: ZoneRecord = { e: "za", x: 3200, z: 3200, w: 64, h: 64 };
const FAR_AREA: ZoneRecord = { e: "za", x: 3400, z: 3400, w: 64, h: 64 };
const STUMP: ZoneRecord = { e: "la", x: 3217, z: 3241, l: 0, id: 1342, s: 10, r: 1 };
const COINS: ZoneRecord = { e: "oa", x: 3218, z: 3242, l: 0, id: 995, n: 5 };
const BONES: ZoneRecord = { e: "oa", x: 3218, z: 3242, l: 0, id: 526, n: 1 };
const TILE = getTileKey(3218, 3242, 0);
const STUMP_KEY = getLocKey(3217, 3241, 0, 2);

function objsAt(state: WorldState, key: number) {
    return state.objTiles.get(key)?.objs;
}

test("a feed without obj records leaves the obj store empty and its version unchanged", () => {
    const state = createState();
    const a = state.newFeedId();
    state.apply(a, 10, world, [AREA, STUMP]);
    state.apply(a, 11, world, [{ e: "ld", x: 3217, z: 3241, l: 0, s: 10, r: 1 }]);
    state.apply(a, 12, world, [FAR_AREA]);
    expect(state.objTiles.size).toBe(0);
    expect(state.objVersion).toBe(0);
});

test("oa adds objs to a tile in order, on the level it names", () => {
    const state = createState();
    const a = state.newFeedId();
    state.apply(a, 10, world, [AREA, COINS, BONES, { ...BONES, l: 1 } as ZoneRecord]);
    expect(objsAt(state, TILE)).toEqual([
        { id: 995, count: 5 },
        { id: 526, count: 1 },
    ]);
    expect(objsAt(state, getTileKey(3218, 3242, 1))).toEqual([{ id: 526, count: 1 }]);
    expect(state.objVersion).toBe(3);
});

test("od removes one obj of that type and drops the tile when it empties", () => {
    const state = createState();
    const a = state.newFeedId();
    state.apply(a, 10, world, [AREA, BONES, COINS, BONES]);
    state.apply(a, 11, world, [{ e: "od", x: 3218, z: 3242, l: 0, id: 526 }]);
    expect(objsAt(state, TILE)).toEqual([
        { id: 995, count: 5 },
        { id: 526, count: 1 },
    ]);
    const version = state.objVersion;
    // No such obj on the tile, and no objs on that tile: nothing changes.
    state.apply(a, 12, world, [
        { e: "od", x: 3218, z: 3242, l: 0, id: 4151 },
        { e: "od", x: 3219, z: 3242, l: 0, id: 526 },
    ]);
    expect(state.objVersion).toBe(version);
    state.apply(a, 13, world, [
        { e: "od", x: 3218, z: 3242, l: 0, id: 526 },
        { e: "od", x: 3218, z: 3242, l: 0, id: 995 },
    ]);
    expect(state.objTiles.size).toBe(0);
    // The tile is free again: an obj added later is kept and cleared with its zone.
    state.apply(a, 14, world, [COINS]);
    state.apply(a, 15, world, [{ ...AREA, r: 1 } as ZoneRecord]);
    expect(state.objTiles.size).toBe(0);
});

test("oc changes the count of the stack with the old count, else the first of that type", () => {
    const state = createState();
    const a = state.newFeedId();
    const more: ZoneRecord = { e: "oa", x: 3218, z: 3242, l: 0, id: 995, n: 40 };
    state.apply(a, 10, world, [AREA, COINS, more]);
    state.apply(a, 11, world, [{ e: "oc", x: 3218, z: 3242, l: 0, id: 995, n0: 40, n: 90 }]);
    expect(objsAt(state, TILE)).toEqual([
        { id: 995, count: 5 },
        { id: 995, count: 90 },
    ]);
    // A snapshot taken on the tick of the change already has the new count: n0 matches nothing.
    state.apply(a, 12, world, [{ e: "oc", x: 3218, z: 3242, l: 0, id: 995, n0: 7, n: 8 }]);
    expect(objsAt(state, TILE)).toEqual([
        { id: 995, count: 8 },
        { id: 995, count: 90 },
    ]);
    const version = state.objVersion;
    state.apply(a, 13, world, [{ e: "oc", x: 3218, z: 3242, l: 0, id: 526, n0: 1, n: 2 }]);
    expect(state.objVersion).toBe(version);
});

test("objs go when their zone is left or reset, and a reset's snapshot replaces them", () => {
    const state = createState();
    const a = state.newFeedId();
    state.apply(a, 10, world, [AREA, STUMP, COINS]);
    state.apply(a, 12, world, [FAR_AREA]);
    expect(state.objTiles.size).toBe(0);
    expect(state.zones.size).toBe(0);

    state.apply(a, 14, world, [AREA, COINS]);
    expect(objsAt(state, TILE)).toEqual([{ id: 995, count: 5 }]);
    // The coins were taken while the bones were dropped: the reset's snapshot is the state.
    state.apply(a, 20, world, [{ ...AREA, r: 1 } as ZoneRecord, STUMP, BONES]);
    expect(objsAt(state, TILE)).toEqual([{ id: 526, count: 1 }]);
    expect(state.locs.get(STUMP_KEY)?.id).toBe(1342);

    state.dropFeed(a);
    expect(state.objTiles.size).toBe(0);
});

test("overlapping feeds add each obj once, and a stale feed's records are skipped", () => {
    const state = createState();
    const a = state.newFeedId();
    const b = state.newFeedId();
    state.apply(a, 10, world, [AREA, COINS]);
    state.apply(b, 10, world, [AREA, COINS]);
    state.apply(a, 11, world, [BONES]);
    state.apply(b, 11, world, [BONES]);
    expect(objsAt(state, TILE)).toEqual([
        { id: 995, count: 5 },
        { id: 526, count: 1 },
    ]);
    // b is ahead for tick 12; a's copy of the same pickup is skipped.
    const del: ZoneRecord[] = [{ e: "od", x: 3218, z: 3242, l: 0, id: 526 }];
    state.apply(b, 12, world, del);
    state.apply(a, 12, world, del);
    expect(objsAt(state, TILE)).toEqual([{ id: 995, count: 5 }]);
});

test("records that are not a valid obj are ignored", () => {
    const state = createState();
    const a = state.newFeedId();
    state.apply(a, 10, world, [
        AREA,
        { e: "oa", x: 3218, z: 3242, l: 0, id: -1, n: 1 },
        { e: "oa", x: 3218, z: 3242, l: 0, id: 995, n: 0 },
        { e: "oa", x: 3218, z: 3242, l: 0, id: 995 } as any,
        { e: "zz", x: 3218, z: 3242, l: 0 } as any,
    ]);
    expect(state.objTiles.size).toBe(0);
    expect(state.objVersion).toBe(0);
});
