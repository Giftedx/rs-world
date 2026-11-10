// Multi-view arithmetic with no DOM or GL in it: the name list, the pane grid, the GL viewport
// of a pane and the map squares a set of cameras needs.

export const MAX_PANES = 16;

// Pane view distance in tiles (?md=): smaller than a full view, so 16 panes stay light.
export const DEFAULT_MULTI_DISTANCE = 48;
export const MIN_MULTI_DISTANCE = 16;
export const MAX_MULTI_DISTANCE = 128;

const MAP_SQUARE_SIZE = 64;
const MAX_MAP_X = 100;
const MAX_MAP_Y = 200;

export type PaneRect = { x: number; y: number; w: number; h: number };

// Names from ?multi=a,b,c or a {multi: [...]} message: trimmed, blanks and repeats (any case)
// dropped, at most MAX_PANES. Anything that is not a string is dropped.
export function parseMultiNames(raw: unknown): string[] {
    const list: unknown[] =
        typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
        if (typeof entry !== "string") {
            continue;
        }
        const name = entry.trim();
        const key = name.toLowerCase();
        if (!name || seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(name);
        if (names.length === MAX_PANES) {
            break;
        }
    }
    return names;
}

export function parseMultiDistance(raw: unknown): number | undefined {
    const value = typeof raw === "number" ? raw : parseInt(typeof raw === "string" ? raw : "");
    return value >= MIN_MULTI_DISTANCE && value <= MAX_MULTI_DISTANCE ? value : undefined;
}

// The grid that keeps panes closest to square: wide windows get the extra column, tall ones
// the extra row.
export function gridSize(
    count: number,
    width: number,
    height: number,
): { cols: number; rows: number } {
    const n = Math.max(count, 1);
    const side = Math.ceil(Math.sqrt(n));
    const cols = width < height ? Math.ceil(n / side) : side;
    return { cols, rows: Math.ceil(n / cols) };
}

// Pane rectangles in CSS pixels, row by row from the top left, with a 2 px gutter between
// neighbours. They never overlap and never leave the window.
export function layoutRects(count: number, width: number, height: number): PaneRect[] {
    const { cols, rows } = gridSize(count, width, height);
    const half = 1;
    const rects: PaneRect[] = [];
    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x0 = Math.round((col * width) / cols) + (col > 0 ? half : 0);
        const x1 = Math.round(((col + 1) * width) / cols) - (col < cols - 1 ? half : 0);
        const y0 = Math.round((row * height) / rows) + (row > 0 ? half : 0);
        const y1 = Math.round(((row + 1) * height) / rows) - (row < rows - 1 ? half : 0);
        rects.push({ x: x0, y: y0, w: Math.max(x1 - x0, 0), h: Math.max(y1 - y0, 0) });
    }
    return rects;
}

export function paneAt(rects: PaneRect[], x: number, y: number): number {
    return rects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

// A pane's rectangle as a GL viewport: framebuffer pixels, origin at the bottom left.
export function viewportRect(
    rect: PaneRect,
    cssHeight: number,
    scaleX: number,
    scaleY: number,
): PaneRect {
    return {
        x: Math.round(rect.x * scaleX),
        y: Math.round((cssHeight - rect.y - rect.h) * scaleY),
        w: Math.max(Math.round(rect.w * scaleX), 1),
        h: Math.max(Math.round(rect.h * scaleY), 1),
    };
}

// Map square bounds [startX, startY, endX, endY) a camera at a tile position draws.
export function squareBounds(
    x: number,
    z: number,
    renderDistance: number,
): [number, number, number, number] {
    return [
        Math.floor((x - renderDistance) / MAP_SQUARE_SIZE),
        Math.floor((z - renderDistance) / MAP_SQUARE_SIZE),
        Math.ceil((x + renderDistance) / MAP_SQUARE_SIZE),
        Math.ceil((z + renderDistance) / MAP_SQUARE_SIZE),
    ];
}

function squareDistance(x: number, z: number, mapX: number, mapY: number): number {
    const dx = Math.max(Math.abs(x - (mapX * MAP_SQUARE_SIZE + 32)) - 32, 0);
    const dz = Math.max(Math.abs(z - (mapY * MAP_SQUARE_SIZE + 32)) - 32, 0);
    return Math.sqrt(dx * dx + dz * dz);
}

// The union of the map squares a set of cameras needs, each once, nearest to any camera first.
// Ids are (mapX << 8) | mapY, like getMapSquareId.
export function squaresNeeded(
    cameras: readonly (readonly [number, number])[],
    renderDistance: number,
    isInvalid?: (mapId: number) => boolean,
): number[] {
    const wanted = new Map<number, number>();
    for (const [x, z] of cameras) {
        const [startX, startY, endX, endY] = squareBounds(x, z, renderDistance);
        for (let mapX = startX; mapX < endX; mapX++) {
            for (let mapY = startY; mapY < endY; mapY++) {
                if (mapX < 0 || mapY < 0 || mapX >= MAX_MAP_X || mapY >= MAX_MAP_Y) {
                    continue;
                }
                const mapId = (mapX << 8) | mapY;
                if (isInvalid?.(mapId)) {
                    continue;
                }
                const distance = squareDistance(x, z, mapX, mapY);
                const best = wanted.get(mapId);
                if (best === undefined || distance < best) {
                    wanted.set(mapId, distance);
                }
            }
        }
    }
    return Array.from(wanted.entries())
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])
        .map((entry) => entry[0]);
}
