import { vec4 } from "gl-matrix";

import { MapFileIndex, getMapSquareId } from "../rs/map/MapFileIndex";
import { Scene } from "../rs/scene/Scene";
import { squareBounds, squaresNeeded } from "../live/MultiLayout";
import { Camera } from "./Camera";

function getMapDistance(x: number, z: number, mapX: number, mapY: number): number {
    const centerX = mapX * Scene.MAP_SQUARE_SIZE + 32;
    const centerY = mapY * Scene.MAP_SQUARE_SIZE + 32;
    const dx = Math.max(Math.abs(x - centerX) - 32, 0);
    const dz = Math.max(Math.abs(z - centerY) - 32, 0);
    return Math.sqrt(dx * dx + dz * dz);
}

type LoadMapFunction = (mapX: number, mapY: number) => void;

export interface MapSquare {
    mapX: number;
    mapY: number;

    canRender(frameCount: number): boolean;

    delete(): void;
}

export class MapManager<T extends MapSquare> {
    static readonly MAX_MAP_X = 100;
    static readonly MAX_MAP_Y = 200;

    static mapIntersectBox: number[][] = [
        [0, (-Scene.UNITS_LEVEL_HEIGHT * 10) / 128, 0],
        [0, (Scene.UNITS_LEVEL_HEIGHT * 3) / 128, 0],
    ];

    invalidMapIds: Set<number> = new Set();
    loadingMapIds: Set<number> = new Set();

    renderBounds: vec4 = vec4.fromValues(-1, -1, -1, -1);

    renderDistMapCount: number = 0;
    renderDistMapIds: number[] = [];

    visibleMapCount: number = 0;
    visibleMaps: T[] = [];

    mapSquares: Map<number, T> = new Map();

    // Recently used map squares stay loaded (least recently used go first) up to this many, so flying back to a
    // place is instant. The squares in view never count against it.
    cacheBudget: number = 64;
    // Squares in view this frame that are not loaded yet: they draw as blank (black) ground.
    blankOnScreen: number = 0;
    private frameCount: number = 0;
    private lastUsed: Map<number, number> = new Map();
    private useClock: number = 0;

    constructor(
        readonly maxQueuedTasks: number,
        readonly loadMapFunction: LoadMapFunction,
    ) {}

    init(mapFileIndex: MapFileIndex, fillEmptyTerrain: boolean): void {
        this.cleanUp();
        for (let x = 0; x < MapManager.MAX_MAP_X; x++) {
            for (let y = 0; y < MapManager.MAX_MAP_Y; y++) {
                const exists = mapFileIndex.getTerrainArchiveId(x, y) !== -1;
                if (exists) {
                    continue;
                }
                if (y < 100 && fillEmptyTerrain) {
                    let hasNeighbour = false;
                    loop: for (let nx = x - 2; nx <= x + 2; nx++) {
                        for (let ny = y - 2; ny <= y + 2; ny++) {
                            const neighbourExists = mapFileIndex.getTerrainArchiveId(nx, ny) !== -1;
                            if (neighbourExists) {
                                hasNeighbour = true;
                                break loop;
                            }
                        }
                    }
                    if (hasNeighbour) {
                        continue;
                    }
                }
                this.invalidMapIds.add(getMapSquareId(x, y));
            }
        }
        console.log("Invalid map count", this.invalidMapIds.size);
    }

    isMapVisible(camera: Camera, mapX: number, mapY: number): boolean {
        const baseX = mapX * Scene.MAP_SQUARE_SIZE;
        const baseY = mapY * Scene.MAP_SQUARE_SIZE;
        const endX = baseX + Scene.MAP_SQUARE_SIZE;
        const endY = baseY + Scene.MAP_SQUARE_SIZE;

        MapManager.mapIntersectBox[0][0] = baseX;
        MapManager.mapIntersectBox[0][2] = baseY;

        MapManager.mapIntersectBox[1][0] = endX;
        MapManager.mapIntersectBox[1][2] = endY;

        return camera.frustum.intersectsBox(MapManager.mapIntersectBox);
    }

    clearMaps(): void {
        this.invalidMapIds.clear();
        this.loadingMapIds.clear();
        for (const map of this.mapSquares.values()) {
            map.delete();
        }
        this.mapSquares.clear();
    }

    getMap(mapX: number, mapY: number): T | undefined {
        return this.mapSquares.get(getMapSquareId(mapX, mapY));
    }

    addMap(mapX: number, mapY: number, mapSquare: T): void {
        const mapId = getMapSquareId(mapX, mapY);
        this.loadingMapIds.delete(mapId);
        this.invalidMapIds.delete(mapId);
        this.mapSquares.set(mapId, mapSquare);
        this.lastUsed.set(mapId, ++this.useClock);
    }

    // Loads the squares around a tile ahead of the camera (a flight's destination), nearest first.
    prefetch(tileX: number, tileZ: number, radiusTiles: number): void {
        const ids = this.squaresAround(tileX, tileZ, radiusTiles);
        ids.sort((a, b) => getMapDistance(tileX, tileZ, a >> 8, a & 0xff) - getMapDistance(tileX, tileZ, b >> 8, b & 0xff));
        for (const id of ids) {
            if (this.mapSquares.has(id)) this.lastUsed.set(id, ++this.useClock);
            else this.loadMap(id >> 8, id & 0xff);
        }
    }

    // True when every existing square around a tile is loaded and past its first-frames upload delay.
    ready(tileX: number, tileZ: number, radiusTiles: number): boolean {
        return this.squaresAround(tileX, tileZ, radiusTiles).every((id) => this.mapSquares.get(id)?.canRender(this.frameCount) ?? false);
    }

    private squaresAround(tileX: number, tileZ: number, radiusTiles: number): number[] {
        const ids: number[] = [];
        const x0 = Math.max(0, Math.floor((tileX - radiusTiles) / Scene.MAP_SQUARE_SIZE));
        const x1 = Math.min(MapManager.MAX_MAP_X - 1, Math.floor((tileX + radiusTiles) / Scene.MAP_SQUARE_SIZE));
        const y0 = Math.max(0, Math.floor((tileZ - radiusTiles) / Scene.MAP_SQUARE_SIZE));
        const y1 = Math.min(MapManager.MAX_MAP_Y - 1, Math.floor((tileZ + radiusTiles) / Scene.MAP_SQUARE_SIZE));
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const id = getMapSquareId(x, y);
                if (!this.invalidMapIds.has(id)) ids.push(id);
            }
        }
        return ids;
    }

    removeMap(mapX: number, mapY: number): void {
        const mapId = getMapSquareId(mapX, mapY);
        const map = this.mapSquares.get(mapId);
        if (map) {
            map.delete();
            this.mapSquares.delete(mapId);
        }
    }

    addInvalidMap(mapX: number, mapY: number): void {
        const mapId = getMapSquareId(mapX, mapY);
        this.invalidMapIds.add(mapId);
        this.loadingMapIds.delete(mapId);
    }

    loadMap(mapX: number, mapY: number): void {
        const mapId = getMapSquareId(mapX, mapY);
        if (
            this.mapSquares.has(mapId) ||
            this.invalidMapIds.has(mapId) ||
            this.loadingMapIds.has(mapId) ||
            this.loadingMapIds.size > this.maxQueuedTasks
        ) {
            return;
        }
        console.log("Loading map", mapX, mapY);
        this.loadingMapIds.add(mapId);
        this.loadMapFunction(mapX, mapY);
    }

    update(
        camera: Camera,
        frameCount: number,
        renderDistance: number,
        unloadDistance: number,
    ): void {
        const cameraX = camera.getPosX();
        const cameraZ = camera.getPosZ();
        this.frameCount = frameCount;
        this.multiKey = "";

        // Calculate which map square id to start and end on based on camera location and render distance (in tiles).
        const mapStartX = Math.floor((cameraX - renderDistance) / Scene.MAP_SQUARE_SIZE);
        const mapStartY = Math.floor((cameraZ - renderDistance) / Scene.MAP_SQUARE_SIZE);

        const mapEndX = Math.ceil((cameraX + renderDistance) / Scene.MAP_SQUARE_SIZE);
        const mapEndY = Math.ceil((cameraZ + renderDistance) / Scene.MAP_SQUARE_SIZE);

        const renderBoundsChanged =
            this.renderBounds[0] !== mapStartX ||
            this.renderBounds[1] !== mapStartY ||
            this.renderBounds[2] !== mapEndX ||
            this.renderBounds[3] !== mapEndY;

        if (renderBoundsChanged) {
            this.renderDistMapCount = 0;

            for (let x = mapStartX; x < mapEndX; x++) {
                for (let y = mapStartY; y < mapEndY; y++) {
                    if (x < 0 || y < 0 || x >= MapManager.MAX_MAP_X || y >= MapManager.MAX_MAP_Y) {
                        continue;
                    }
                    const mapId = getMapSquareId(x, y);
                    if (this.invalidMapIds.has(mapId)) {
                        continue;
                    }

                    this.renderDistMapIds[this.renderDistMapCount++] = mapId;
                }
            }

            // Calculate which map squares to unload based on the unload distance and remove them.
            // Unload distance is the distance in number of map squares.

            // Out-of-range squares are kept while the cache has room; beyond it the least recently used go.
            const out: number[] = [];
            for (const [id, map] of this.mapSquares) {
                const { mapX, mapY } = map;
                if (
                    mapX < mapStartX - unloadDistance ||
                    mapX > mapEndX + unloadDistance ||
                    mapY < mapStartY - unloadDistance ||
                    mapY > mapEndY + unloadDistance
                ) {
                    out.push(id);
                }
            }
            const excess = this.mapSquares.size - Math.max(this.cacheBudget, this.mapSquares.size - out.length);
            if (excess > 0) {
                out.sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
                for (const id of out.slice(0, excess)) {
                    this.removeMap(id >> 8, id & 0xff);
                    this.lastUsed.delete(id);
                }
            }
        }

        // Sort the maps to render based on a front to back distance.
        if (renderBoundsChanged || camera.updatedPosition) {
            this.renderDistMapIds.length = this.renderDistMapCount;
            // sort front to back
            this.renderDistMapIds.sort((a, b) => {
                const distA = getMapDistance(cameraX, cameraZ, a >> 8, a & 0xff);
                const distB = getMapDistance(cameraX, cameraZ, b >> 8, b & 0xff);
                return distA - distB;
            });
        }

        this.visibleMapCount = 0;
        this.blankOnScreen = 0;
        for (let i = 0; i < this.renderDistMapCount; i++) {
            const mapId = this.renderDistMapIds[i];
            const mapX = mapId >> 8;
            const mapY = mapId & 0xff;
            if (!this.isMapVisible(camera, mapX, mapY)) {
                continue;
            }
            const mapSquare = this.mapSquares.get(mapId);
            if (mapSquare) {
                this.lastUsed.set(mapId, ++this.useClock);
                if (mapSquare.canRender(frameCount)) {
                    this.visibleMaps[this.visibleMapCount++] = mapSquare;
                } else {
                    this.blankOnScreen++;
                }
            } else {
                this.blankOnScreen++;
                this.loadMap(mapX, mapY);
            }
        }

        // Probably a better way to do this, maybe set null
        if (this.visibleMapCount > this.visibleMaps.length) {
            // Delete 1 per frame
            this.visibleMaps.length -= 1;
        }

        // Update the render bounds based on the map squares we are rendering.
        this.renderBounds[0] = mapStartX;
        this.renderBounds[1] = mapStartY;
        this.renderBounds[2] = mapEndX;
        this.renderBounds[3] = mapEndY;
    }

    // Multi-view: keep the squares every camera needs loaded (nearest to any camera first). What each
    // camera sees is then picked with updateVisible().
    private multiKey: string = "";
    private multiWanted: number[] = [];

    updateMulti(
        cameras: Camera[],
        frameCount: number,
        renderDistance: number,
        unloadDistance: number,
    ): void {
        this.frameCount = frameCount;
        this.blankOnScreen = 0;
        const bounds = cameras.map((c) => squareBounds(c.getPosX(), c.getPosZ(), renderDistance));
        const key = bounds.map((b) => b.join(",")).join(";");
        if (key !== this.multiKey) {
            this.multiKey = key;
            // The single view's bounds are stale now: it works them out again when it comes back.
            this.renderBounds.fill(-1);
            this.multiWanted = squaresNeeded(
                cameras.map((c) => [c.getPosX(), c.getPosZ()] as const),
                renderDistance,
                (mapId) => this.invalidMapIds.has(mapId),
            );

            // Squares no camera is near are kept while the cache has room, like update().
            const out: number[] = [];
            for (const [id, map] of this.mapSquares) {
                const { mapX, mapY } = map;
                const near = bounds.some(
                    ([startX, startY, endX, endY]) =>
                        mapX >= startX - unloadDistance &&
                        mapX <= endX + unloadDistance &&
                        mapY >= startY - unloadDistance &&
                        mapY <= endY + unloadDistance,
                );
                if (!near) {
                    out.push(id);
                }
            }
            const excess =
                this.mapSquares.size - Math.max(this.cacheBudget, this.mapSquares.size - out.length);
            if (excess > 0) {
                out.sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
                for (const id of out.slice(0, excess)) {
                    this.removeMap(id >> 8, id & 0xff);
                    this.lastUsed.delete(id);
                }
            }
        }
        for (const mapId of this.multiWanted) {
            if (this.loadingMapIds.size > this.maxQueuedTasks) {
                break;
            }
            if (!this.mapSquares.has(mapId)) {
                this.loadMap(mapId >> 8, mapId & 0xff);
            }
        }
    }

    // The squares one camera sees, into visibleMaps (nearest first). Squares it should see that are
    // not drawable yet add to blankOnScreen.
    updateVisible(camera: Camera, frameCount: number, renderDistance: number): void {
        const cameraX = camera.getPosX();
        const cameraZ = camera.getPosZ();
        const [startX, startY, endX, endY] = squareBounds(cameraX, cameraZ, renderDistance);
        this.visibleMapCount = 0;
        for (let x = startX; x < endX; x++) {
            for (let y = startY; y < endY; y++) {
                if (x < 0 || y < 0 || x >= MapManager.MAX_MAP_X || y >= MapManager.MAX_MAP_Y) {
                    continue;
                }
                const mapId = getMapSquareId(x, y);
                if (this.invalidMapIds.has(mapId) || !this.isMapVisible(camera, x, y)) {
                    continue;
                }
                const mapSquare = this.mapSquares.get(mapId);
                if (!mapSquare) {
                    this.blankOnScreen++;
                    continue;
                }
                this.lastUsed.set(mapId, ++this.useClock);
                if (mapSquare.canRender(frameCount)) {
                    this.visibleMaps[this.visibleMapCount++] = mapSquare;
                } else {
                    this.blankOnScreen++;
                }
            }
        }
        this.visibleMaps.length = this.visibleMapCount;
        this.visibleMaps.sort(
            (a, b) =>
                getMapDistance(cameraX, cameraZ, a.mapX, a.mapY) -
                getMapDistance(cameraX, cameraZ, b.mapX, b.mapY),
        );
    }

    cleanUp(): void {
        this.multiKey = "";
        this.multiWanted = [];
        this.renderBounds.fill(-1);
        this.clearMaps();
    }
}
