import {
    MAX_PANES,
    PaneRect,
    gridSize,
    layoutRects,
    paneAt,
    parseMultiDistance,
    parseMultiNames,
    squareBounds,
    squaresNeeded,
    viewportRect,
} from "./MultiLayout";

const id = (mapX: number, mapY: number) => (mapX << 8) | mapY;

describe("parseMultiNames", () => {
    test("splits a URL list, trims, and drops blanks", () => {
        expect(parseMultiNames(" Zezima , ,Bob,")).toEqual(["Zezima", "Bob"]);
        expect(parseMultiNames("")).toEqual([]);
    });

    test("takes a message array and drops what is not a name", () => {
        expect(parseMultiNames(["a", 3, null, " b ", {}, ""])).toEqual(["a", "b"]);
        expect(parseMultiNames(undefined)).toEqual([]);
        expect(parseMultiNames({ 0: "a" })).toEqual([]);
    });

    test("keeps the first of a repeated name, whatever its case", () => {
        expect(parseMultiNames("Bob,bob,BOB,Al")).toEqual(["Bob", "Al"]);
    });

    test("caps the list at 16", () => {
        const many = Array.from({ length: 40 }, (_, i) => "p" + i);
        expect(parseMultiNames(many)).toEqual(many.slice(0, 16));
        expect(parseMultiNames(many.join(","))).toHaveLength(MAX_PANES);
    });
});

test("parseMultiDistance accepts 16 to 128 tiles only", () => {
    expect(parseMultiDistance("48")).toBe(48);
    expect(parseMultiDistance(16)).toBe(16);
    expect(parseMultiDistance(128)).toBe(128);
    expect(parseMultiDistance("15")).toBeUndefined();
    expect(parseMultiDistance(129)).toBeUndefined();
    expect(parseMultiDistance(null)).toBeUndefined();
    expect(parseMultiDistance("x")).toBeUndefined();
});

describe("gridSize", () => {
    test("wide windows, 1 to 16 panes", () => {
        const grids = Array.from({ length: 16 }, (_, i) => {
            const { cols, rows } = gridSize(i + 1, 1600, 900);
            return `${cols}x${rows}`;
        });
        expect(grids).toEqual([
            "1x1",
            "2x1",
            "2x2",
            "2x2",
            "3x2",
            "3x2",
            "3x3",
            "3x3",
            "3x3",
            "4x3",
            "4x3",
            "4x3",
            "4x4",
            "4x4",
            "4x4",
            "4x4",
        ]);
    });

    test("tall windows put the extra panes in rows", () => {
        expect(gridSize(2, 400, 900)).toEqual({ cols: 1, rows: 2 });
        expect(gridSize(5, 400, 900)).toEqual({ cols: 2, rows: 3 });
        expect(gridSize(10, 400, 900)).toEqual({ cols: 3, rows: 4 });
        expect(gridSize(16, 400, 900)).toEqual({ cols: 4, rows: 4 });
    });

    test("always has room for every pane", () => {
        for (let n = 1; n <= 16; n++) {
            for (const [w, h] of [
                [1600, 900],
                [400, 900],
                [500, 500],
            ]) {
                const { cols, rows } = gridSize(n, w, h);
                expect(cols * rows).toBeGreaterThanOrEqual(n);
                expect(cols * (rows - 1)).toBeLessThan(n);
            }
        }
    });
});

describe("layoutRects", () => {
    const overlaps = (a: PaneRect, b: PaneRect) =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    test("one pane fills the window", () => {
        expect(layoutRects(1, 1280, 720)).toEqual([{ x: 0, y: 0, w: 1280, h: 720 }]);
    });

    test("four panes are a 2 x 2 grid with a 2 px gutter", () => {
        expect(layoutRects(4, 1280, 720)).toEqual([
            { x: 0, y: 0, w: 639, h: 359 },
            { x: 641, y: 0, w: 639, h: 359 },
            { x: 0, y: 361, w: 639, h: 359 },
            { x: 641, y: 361, w: 639, h: 359 },
        ]);
    });

    test("1 to 16 panes stay inside the window and never overlap", () => {
        for (let n = 1; n <= 16; n++) {
            for (const [w, h] of [
                [1280, 720],
                [375, 812],
                [1001, 333],
            ]) {
                const rects = layoutRects(n, w, h);
                expect(rects).toHaveLength(n);
                for (let i = 0; i < n; i++) {
                    const r = rects[i];
                    expect(r.w).toBeGreaterThan(0);
                    expect(r.h).toBeGreaterThan(0);
                    expect(r.x).toBeGreaterThanOrEqual(0);
                    expect(r.y).toBeGreaterThanOrEqual(0);
                    expect(r.x + r.w).toBeLessThanOrEqual(w);
                    expect(r.y + r.h).toBeLessThanOrEqual(h);
                    for (let j = i + 1; j < n; j++) {
                        expect(overlaps(r, rects[j])).toBe(false);
                    }
                }
            }
        }
    });

    test("paneAt finds the pane under a point and nothing in a gutter", () => {
        const rects = layoutRects(4, 1280, 720);
        expect(paneAt(rects, 10, 10)).toBe(0);
        expect(paneAt(rects, 1279, 10)).toBe(1);
        expect(paneAt(rects, 10, 719)).toBe(2);
        expect(paneAt(rects, 700, 400)).toBe(3);
        expect(paneAt(rects, 640, 10)).toBe(-1);
        expect(paneAt(rects, 10, 360)).toBe(-1);
    });
});

describe("viewportRect", () => {
    test("flips to GL's bottom-left origin", () => {
        const rects = layoutRects(4, 1280, 720);
        expect(viewportRect(rects[0], 720, 1, 1)).toEqual({ x: 0, y: 361, w: 639, h: 359 });
        expect(viewportRect(rects[3], 720, 1, 1)).toEqual({ x: 641, y: 0, w: 639, h: 359 });
    });

    test("scales CSS pixels to framebuffer pixels", () => {
        expect(viewportRect({ x: 100, y: 50, w: 200, h: 100 }, 400, 0.5, 0.5)).toEqual({
            x: 50,
            y: 125,
            w: 100,
            h: 50,
        });
    });

    test("is never empty", () => {
        expect(viewportRect({ x: 0, y: 0, w: 0, h: 0 }, 10, 1, 1)).toMatchObject({ w: 1, h: 1 });
    });

    test("viewports of a grid stay inside the framebuffer", () => {
        for (let n = 1; n <= 16; n++) {
            for (const rect of layoutRects(n, 1001, 333)) {
                const v = viewportRect(rect, 333, 0.75, 0.75);
                expect(v.x).toBeGreaterThanOrEqual(0);
                expect(v.y).toBeGreaterThanOrEqual(0);
                expect(v.x + v.w).toBeLessThanOrEqual(Math.round(1001 * 0.75));
                expect(v.y + v.h).toBeLessThanOrEqual(Math.round(333 * 0.75));
            }
        }
    });
});

describe("squaresNeeded", () => {
    test("squareBounds covers the render distance around a tile", () => {
        // Lumbridge (3222, 3218) is in square 50, 50.
        expect(squareBounds(3222, 3218, 48)).toEqual([49, 49, 52, 52]);
        expect(squareBounds(3232, 3232, 16)).toEqual([50, 50, 51, 51]);
    });

    test("one camera needs its own squares, nearest first", () => {
        const ids = squaresNeeded([[3232, 3232]], 48);
        expect(ids[0]).toBe(id(50, 50));
        const all = [49, 50, 51].flatMap((x) => [49, 50, 51].map((y) => id(x, y)));
        expect([...ids].sort()).toEqual(all.sort());
        // The four squares that share an edge with the camera's come before the four corners.
        expect(ids.slice(1, 5).sort()).toEqual(
            [id(49, 50), id(51, 50), id(50, 49), id(50, 51)].sort(),
        );
    });

    test("cameras in the same place share their squares", () => {
        const one = squaresNeeded([[3232, 3232]], 48);
        const three = squaresNeeded(
            [
                [3232, 3232],
                [3235, 3230],
                [3232, 3232],
            ],
            48,
        );
        expect([...three].sort()).toEqual([...one].sort());
    });

    test("cameras apart need the union, each square once", () => {
        const a = squaresNeeded([[3232, 3232]], 16);
        const b = squaresNeeded([[2600, 3100]], 16);
        const both = squaresNeeded(
            [
                [3232, 3232],
                [2600, 3100],
            ],
            16,
        );
        expect(a).toEqual([id(50, 50)]);
        expect(b).toEqual([id(40, 48)]);
        expect([...both].sort()).toEqual([...a, ...b].sort());
        expect(new Set(both).size).toBe(both.length);
    });

    test("orders by the distance to the nearest camera", () => {
        const ids = squaresNeeded(
            [
                [3232, 3232],
                [3360, 3232],
            ],
            70,
        );
        // Both cameras stand inside their own square: those two come first.
        expect(ids.slice(0, 2).sort()).toEqual([id(50, 50), id(52, 50)].sort());
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("leaves out invalid squares and squares off the map", () => {
        const invalid = id(49, 50);
        const ids = squaresNeeded([[3232, 3232]], 48, (mapId) => mapId === invalid);
        expect(ids).not.toContain(invalid);
        expect(ids).toHaveLength(8);
        expect(squaresNeeded([[10, 10]], 48)).toEqual([id(0, 0)]);
        expect(squaresNeeded([[-500, -500]], 48)).toEqual([]);
    });

    test("16 cameras spread over the world stay within the square cache", () => {
        const cameras = Array.from(
            { length: 16 },
            (_, i) => [2200 + i * 90, 3000 + i * 40] as const,
        );
        const ids = squaresNeeded(cameras, 48);
        expect(ids.length).toBeLessThanOrEqual(16 * 9);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
