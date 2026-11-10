// Multi-view arithmetic with no DOM or GL in it: the name list, the tiling layouts, the move of a
// pane between two rectangles, the GL viewport of a pane and the map squares a set of cameras needs.

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

// Tiling layouts. Pane 0 of every layout is the main pane.
//   grid     near-square panes; the last row is stretched, so no part of the window is empty
//   main     one large pane and a stack of the others (master-stack)
//   focus    one pane at full size and the others in a strip of thumbnails
//   columns  panes side by side at full height
export const LAYOUT_MODES = ["grid", "main", "focus", "columns"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

// Space between neighbouring panes in CSS pixels. The window edge has none.
export const DEFAULT_GAP = 4;
export const MAX_GAP = 24;
// Share of the window the main pane of the "main" layout takes.
export const DEFAULT_RATIO = 0.62;
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 0.8;
// Time a pane takes to move to a new rectangle.
export const TRANSITION_MS = 240;

export type LayoutOptions = { mode: LayoutMode; gap: number; ratio: number };

export function parseLayoutMode(raw: unknown): LayoutMode | undefined {
    return LAYOUT_MODES.find((mode) => mode === raw);
}

export function parseGap(raw: unknown): number | undefined {
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_GAP
        ? raw
        : undefined;
}

export function parseRatio(raw: unknown): number | undefined {
    return typeof raw === "number" && raw >= MIN_RATIO && raw <= MAX_RATIO ? raw : undefined;
}

// A pane is a 3D view: a 4:3 pane shows its player best. The grid is scored by the largest 4:3
// box that fits in a cell.
const PANE_ASPECT = 4 / 3;
// Narrowest column of the "columns" layout and narrowest thumbnail of the "focus" strip. More
// panes than fit at that width wrap into another row.
const MIN_COLUMN_WIDTH = 160;
const MIN_THUMB_WIDTH = 80;
const MAX_THUMB_ROWS = 3;

// Cuts a length into n parts with a gap between neighbours. Every edge is a whole pixel, the
// parts differ by at most 1 px and the last part ends at the end of the length.
function cut(start: number, length: number, n: number, gap: number, out: number[]): void {
    const free = Math.max(length - gap * (n - 1), 0);
    for (let i = 0; i < n; i++) {
        const from = Math.round((i * free) / n);
        out.push(start + from + i * gap, Math.max(Math.round(((i + 1) * free) / n) - from, 0));
    }
}

// Rows of panes in an area: counts[r] panes in row r, each row at full width.
function rowsInto(
    rects: PaneRect[],
    x: number,
    y: number,
    w: number,
    h: number,
    counts: number[],
    gap: number,
): void {
    const ys: number[] = [];
    cut(y, h, counts.length, gap, ys);
    for (let r = 0; r < counts.length; r++) {
        const xs: number[] = [];
        cut(x, w, counts[r], gap, xs);
        for (let c = 0; c < counts[r]; c++) {
            rects.push({ x: xs[c * 2], y: ys[r * 2], w: xs[c * 2 + 1], h: ys[r * 2 + 1] });
        }
    }
}

// Full rows of cols panes, then the rest in a last row.
function fullRows(count: number, cols: number): number[] {
    const counts: number[] = [];
    for (let left = count; left > 0; left -= cols) {
        counts.push(Math.min(cols, left));
    }
    return counts;
}

// count panes over rows that differ by at most one pane, the longer rows first.
function evenRows(count: number, rows: number): number[] {
    const counts: number[] = [];
    let left = count;
    for (let r = rows; r > 0; r--) {
        const take = Math.ceil(left / r);
        counts.push(take);
        left -= take;
    }
    return counts;
}

// The column count that gives the largest panes: the one whose cells hold the largest 4:3 box.
// Equal scores go to the grid with fewer empty cells, then to fewer columns.
export function gridColumns(count: number, width: number, height: number, gap: number): number {
    const n = Math.max(count, 1);
    let best = 1;
    let bestScore = -1;
    let bestHoles = 0;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const cellW = (width - gap * (cols - 1)) / cols;
        const cellH = (height - gap * (rows - 1)) / rows;
        const score = Math.min(cellW, cellH * PANE_ASPECT);
        const holes = rows * cols - n;
        if (score > bestScore + 0.01 || (score > bestScore - 0.01 && holes < bestHoles)) {
            best = cols;
            bestScore = score;
            bestHoles = holes;
        }
    }
    return best;
}

function gridInto(
    rects: PaneRect[],
    count: number,
    x: number,
    y: number,
    w: number,
    h: number,
    gap: number,
): void {
    if (count > 0) {
        rowsInto(rects, x, y, w, h, fullRows(count, gridColumns(count, w, h, gap)), gap);
    }
}

// Pane rectangles in CSS pixels for a window of width x height. Pane 0 is the main pane. Panes
// never overlap, never leave the window, and neighbours are exactly one gap apart.
export function tileRects(
    count: number,
    width: number,
    height: number,
    options: LayoutOptions,
): PaneRect[] {
    const rects: PaneRect[] = [];
    const { mode, gap, ratio } = options;
    if (count <= 0) {
        return rects;
    }
    if (count === 1 || mode === "grid") {
        gridInto(rects, count, 0, 0, width, height, gap);
    } else if (mode === "columns") {
        const perRow = Math.max(Math.floor((width + gap) / (MIN_COLUMN_WIDTH + gap)), 1);
        rowsInto(rects, 0, 0, width, height, evenRows(count, Math.ceil(count / perRow)), gap);
    } else if (mode === "main") {
        // The stack goes on the long side of the window: to the right of the main pane in a
        // wide window, under it in a tall one. The stack is a grid of its own.
        if (width >= height) {
            const mainW = Math.round((width - gap) * ratio);
            rects.push({ x: 0, y: 0, w: mainW, h: height });
            gridInto(rects, count - 1, mainW + gap, 0, width - mainW - gap, height, gap);
        } else {
            const mainH = Math.round((height - gap) * ratio);
            rects.push({ x: 0, y: 0, w: width, h: mainH });
            gridInto(rects, count - 1, 0, mainH + gap, width, height - mainH - gap, gap);
        }
    } else {
        // focus: thumbnails in a strip along the bottom, in as few rows as keep them wide enough.
        const thumbs = count - 1;
        const rows = Math.min(
            Math.max(Math.ceil((thumbs * (MIN_THUMB_WIDTH + gap) - gap) / Math.max(width, 1)), 1),
            MAX_THUMB_ROWS,
        );
        const thumbH = Math.min(Math.max(Math.round(height * 0.16), 56), 150);
        const stripH = Math.min(rows * thumbH + (rows - 1) * gap, Math.round(height * 0.45));
        const mainH = Math.max(height - stripH - gap, 0);
        rects.push({ x: 0, y: 0, w: width, h: mainH });
        rowsInto(rects, 0, mainH + gap, width, height - mainH - gap, evenRows(thumbs, rows), gap);
    }
    return rects;
}

// The order the layout draws panes in: the main pane first, the others in their asked order.
export function mainFirst<T>(panes: readonly T[], main: T | undefined): T[] {
    const index = main === undefined ? -1 : panes.indexOf(main);
    return index <= 0 ? panes.slice() : [panes[index], ...panes.filter((_, i) => i !== index)];
}

// A new order for the panes: the listed ones first, in the listed order, then the others as
// they were. A key that names no pane, or names one again, is dropped.
export function reorderBy<T>(
    panes: readonly T[],
    keys: readonly string[],
    keyOf: (pane: T) => string,
): T[] {
    const left = panes.slice();
    const next: T[] = [];
    for (const key of keys) {
        const index = left.findIndex((pane) => keyOf(pane) === key);
        if (index !== -1) {
            next.push(left.splice(index, 1)[0]);
        }
    }
    return next.concat(left);
}

// Ease-out cubic: fast at the start, at rest at the end. The CSS equal is
// cubic-bezier(1/3, 1, 2/3, 1).
export function easeOutCubic(t: number): number {
    const u = 1 - Math.min(Math.max(t, 0), 1);
    return 1 - u * u * u;
}

// The rectangle a share e of the way from one rectangle to another, in whole pixels, written
// into out. e = 1 gives the target exactly.
export function mixRect(out: PaneRect, from: PaneRect, to: PaneRect, e: number): PaneRect {
    const x0 = Math.round(from.x + (to.x - from.x) * e);
    const y0 = Math.round(from.y + (to.y - from.y) * e);
    const x1 = Math.round(from.x + from.w + (to.x + to.w - from.x - from.w) * e);
    const y1 = Math.round(from.y + from.h + (to.y + to.h - from.y - from.h) * e);
    out.x = x0;
    out.y = y0;
    out.w = Math.max(x1 - x0, 0);
    out.h = Math.max(y1 - y0, 0);
    return out;
}

// A rectangle shrunk about its centre: where a new pane starts and a closed pane ends.
export function shrunkRect(rect: PaneRect, scale: number): PaneRect {
    const w = Math.round(rect.w * scale);
    const h = Math.round(rect.h * scale);
    return {
        x: rect.x + Math.round((rect.w - w) / 2),
        y: rect.y + Math.round((rect.h - h) / 2),
        w,
        h,
    };
}

export function paneAt(rects: PaneRect[], x: number, y: number): number {
    return rects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

// A pane's rectangle as a GL viewport: framebuffer pixels, origin at the bottom left. With out,
// the result is written there and nothing is allocated. Both edges are rounded, so two panes a
// gap apart never share a framebuffer pixel.
export function viewportRect(
    rect: PaneRect,
    cssHeight: number,
    scaleX: number,
    scaleY: number,
    out: PaneRect = { x: 0, y: 0, w: 1, h: 1 },
): PaneRect {
    const x0 = Math.round(rect.x * scaleX);
    const y0 = Math.round((cssHeight - rect.y - rect.h) * scaleY);
    out.x = x0;
    out.y = y0;
    out.w = Math.max(Math.round((rect.x + rect.w) * scaleX) - x0, 1);
    out.h = Math.max(Math.round((cssHeight - rect.y) * scaleY) - y0, 1);
    return out;
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
