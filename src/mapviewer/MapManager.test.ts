// Unit tests for map square bookkeeping around clearMaps(): a square that is replaced gives back its GL buffers, and
// clearMaps() starts a new generation that loads from before it can check.
import { getMapSquareId } from "../rs/map/MapFileIndex";
import { MapManager, MapSquare } from "./MapManager";

function square(mapX: number, mapY: number, deleted: string[]): MapSquare {
    return { mapX, mapY, canRender: () => true, delete: () => deleted.push(`${mapX},${mapY}`) };
}

test("a square added where one is already loaded deletes the old one", () => {
    const deleted: string[] = [];
    const maps = new MapManager<MapSquare>(8, () => {});
    const first = square(50, 50, deleted);
    maps.addMap(50, 50, first);
    maps.addMap(50, 50, first);
    expect(deleted).toEqual([]);
    maps.addMap(50, 50, square(50, 50, deleted));
    expect(deleted).toEqual(["50,50"]);
    expect(maps.mapSquares.size).toBe(1);
});

test("a load that ends after clearMaps() changes nothing, so the new load of that square stays the only one", () => {
    const maps = new MapManager<MapSquare>(8, () => {});
    const id = getMapSquareId(50, 50);
    for (const outcome of ["loaded", "invalid", "empty", "failed"] as const) {
        maps.loadMap(50, 50);
        const before = maps.generation;
        maps.clearMaps();
        maps.loadMap(50, 50);
        expect(maps.finishLoad(before, 50, 50, outcome)).toBe(false);
        expect(maps.loadingMapIds.has(id)).toBe(true);
        expect(maps.pendingUploadIds.has(id)).toBe(false);
        expect(maps.invalidMapIds.has(id)).toBe(false);
        maps.clearMaps();
    }
});

test("a load that ends in its own generation does the bookkeeping of its outcome", () => {
    const maps = new MapManager<MapSquare>(8, () => {});
    const id = getMapSquareId(50, 50);
    maps.loadMap(50, 50);
    expect(maps.finishLoad(maps.generation, 50, 50, "loaded")).toBe(true);
    expect(maps.pendingUploadIds.has(id)).toBe(true);
    maps.clearMaps();
    maps.loadMap(50, 50);
    expect(maps.finishLoad(maps.generation, 50, 50, "failed")).toBe(true);
    expect(maps.loadingMapIds.has(id)).toBe(false);
    maps.loadMap(50, 50);
    expect(maps.finishLoad(maps.generation, 50, 50, "empty")).toBe(true);
    expect(maps.invalidMapIds.has(id)).toBe(true);
});

test("clearMaps() starts a new generation and changes the square version", () => {
    const deleted: string[] = [];
    const loads: string[] = [];
    const maps = new MapManager<MapSquare>(8, (x, y) => loads.push(`${x},${y}`));
    maps.loadMap(50, 50);
    const generation = maps.generation;
    const version = maps.squareVersion;
    maps.addMap(51, 50, square(51, 50, deleted));
    expect(maps.squareVersion).toBe(version + 1);

    maps.clearMaps();
    expect(maps.generation).toBe(generation + 1);
    expect(deleted).toEqual(["51,50"]);
    // The load sets are empty, so the same square loads again; the first load finds a new generation.
    maps.loadMap(50, 50);
    expect(loads).toEqual(["50,50", "50,50"]);
    expect(maps.generation).not.toBe(generation);
});
