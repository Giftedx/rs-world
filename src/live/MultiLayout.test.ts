import {
    DEFAULT_GAP,
    DEFAULT_RATIO,
    LAYOUT_MODES,
    LayoutMode,
    LayoutOptions,
    MAX_PANES,
    PaneRect,
    TRANSITION_MS,
    easeOutCubic,
    gridColumns,
    mainFirst,
    mixRect,
    paneAt,
    parseGap,
    parseLayoutMode,
    parseMultiDistance,
    parseMultiNames,
    parseRatio,
    parseShares,
    parseStrip,
    reorderBy,
    sameShares,
    shrunkRect,
    squareBounds,
    squaresNeeded,
    tileRects,
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

const layout = (mode: LayoutMode, gap = DEFAULT_GAP, ratio = DEFAULT_RATIO): LayoutOptions => ({
    mode,
    gap,
    ratio,
});
const overlaps = (a: PaneRect, b: PaneRect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const WINDOWS = [
    [1280, 720],
    [1048, 757],
    [375, 812],
    [390, 700],
    [1001, 333],
];

test("layout options accept the listed modes, a gap of 0 to 24 px and a ratio of 0.5 to 0.8", () => {
    expect(LAYOUT_MODES.map(parseLayoutMode)).toEqual(["grid", "main", "focus", "columns"]);
    expect(parseLayoutMode("spiral")).toBeUndefined();
    expect(parseLayoutMode(1)).toBeUndefined();
    expect([0, 4, 24].map(parseGap)).toEqual([0, 4, 24]);
    expect([-1, 25, 2.5, "4", NaN].map(parseGap)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    ]);
    expect([0.5, 0.62, 0.8].map(parseRatio)).toEqual([0.5, 0.62, 0.8]);
    expect([0.49, 0.81, "0.6", NaN].map(parseRatio)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
    ]);
});

describe("gridColumns", () => {
    test("a wide window gets the column count with the largest 4:3 panes", () => {
        const cols = Array.from({ length: 16 }, (_, i) => gridColumns(i + 1, 1280, 720, 4));
        expect(cols).toEqual([1, 2, 2, 2, 3, 3, 4, 4, 3, 4, 4, 4, 5, 5, 5, 4]);
    });

    test("a tall window puts the extra panes in rows", () => {
        expect(gridColumns(2, 390, 700, 4)).toBe(1);
        expect(gridColumns(4, 390, 700, 4)).toBe(1);
        expect(gridColumns(9, 390, 700, 4)).toBe(2);
        expect(gridColumns(16, 390, 700, 4)).toBe(3);
    });

    test("of two grids with equal panes, the one with fewer empty cells wins", () => {
        // 2 x 2 and 3 x 2 cells hold the same 4:3 box in this window; 3 x 2 has no empty cell.
        expect(gridColumns(6, 1200, 600, 0)).toBe(3);
    });
});

describe("tileRects", () => {
    test("one pane fills the window in every layout", () => {
        for (const mode of LAYOUT_MODES) {
            expect(tileRects(1, 1280, 720, layout(mode))).toEqual([
                { x: 0, y: 0, w: 1280, h: 720 },
            ]);
        }
        expect(tileRects(0, 1280, 720, layout("grid"))).toEqual([]);
    });

    test("four panes are a 2 x 2 grid with the gap between them", () => {
        expect(tileRects(4, 1280, 720, layout("grid"))).toEqual([
            { x: 0, y: 0, w: 638, h: 358 },
            { x: 642, y: 0, w: 638, h: 358 },
            { x: 0, y: 362, w: 638, h: 358 },
            { x: 642, y: 362, w: 638, h: 358 },
        ]);
        expect(tileRects(4, 1280, 720, layout("grid", 0))).toEqual([
            { x: 0, y: 0, w: 640, h: 360 },
            { x: 640, y: 0, w: 640, h: 360 },
            { x: 0, y: 360, w: 640, h: 360 },
            { x: 640, y: 360, w: 640, h: 360 },
        ]);
    });

    test("the last row of a grid is stretched over the full width", () => {
        const rects = tileRects(5, 1280, 720, layout("grid"));
        expect(rects.slice(3)).toEqual([
            { x: 0, y: 362, w: 638, h: 358 },
            { x: 642, y: 362, w: 638, h: 358 },
        ]);
    });

    test("main: the main pane takes the ratio and the stack is on the long side", () => {
        const wide = tileRects(4, 1280, 720, layout("main"));
        expect(wide[0]).toEqual({ x: 0, y: 0, w: 791, h: 720 });
        expect(wide.slice(1).every((r) => r.x === 795 && r.w === 485)).toBe(true);
        expect(wide.slice(1).map((r) => r.y)).toEqual([0, 241, 483]);
        expect(tileRects(4, 1280, 720, layout("main", 4, 0.8))[0].w).toBe(1021);

        const tall = tileRects(4, 390, 700, layout("main"));
        expect(tall[0]).toEqual({ x: 0, y: 0, w: 390, h: 432 });
        expect(tall.slice(1).every((r) => r.y >= 436)).toBe(true);
    });

    test("main: a large stack is a grid of its own", () => {
        const rects = tileRects(16, 1280, 720, layout("main"));
        const columns = new Set(rects.slice(1).map((r) => r.x));
        expect(columns.size).toBeGreaterThan(1);
        expect(Math.min(...rects.slice(1).map((r) => r.h))).toBeGreaterThan(80);
    });

    test("focus: the main pane has the full width over a strip of thumbnails", () => {
        const rects = tileRects(5, 1280, 720, layout("focus"));
        expect(rects[0]).toEqual({ x: 0, y: 0, w: 1280, h: 601 });
        expect(rects.slice(1).map((r) => [r.x, r.y, r.w, r.h])).toEqual([
            [0, 605, 317, 115],
            [321, 605, 317, 115],
            [642, 605, 317, 115],
            [963, 605, 317, 115],
        ]);
        // A narrow window wraps the thumbnails into rows and keeps the main pane the largest.
        const phone = tileRects(16, 390, 700, layout("focus"));
        expect(new Set(phone.slice(1).map((r) => r.y)).size).toBe(3);
        expect(phone[0].h).toBeGreaterThanOrEqual(700 * 0.5);
        expect(Math.min(...phone.slice(1).map((r) => r.w))).toBeGreaterThanOrEqual(70);
    });

    test("columns: full height side by side, wrapped when a column would be too narrow", () => {
        const four = tileRects(4, 1280, 720, layout("columns"));
        expect(four.every((r) => r.y === 0 && r.h === 720)).toBe(true);
        expect(four.map((r) => r.x)).toEqual([0, 321, 642, 963]);
        const many = tileRects(16, 1280, 720, layout("columns"));
        expect(new Set(many.map((r) => r.y)).size).toBe(3);
        expect(Math.min(...many.map((r) => r.w))).toBeGreaterThanOrEqual(160);
    });

    test("1 to 16 panes of every layout stay inside the window and never overlap", () => {
        for (const mode of LAYOUT_MODES) {
            for (const gap of [0, 4, 12]) {
                for (const [w, h] of WINDOWS) {
                    for (let n = 1; n <= 16; n++) {
                        const rects = tileRects(n, w, h, layout(mode, gap));
                        expect(rects).toHaveLength(n);
                        for (let i = 0; i < n; i++) {
                            const r = rects[i];
                            expect([r.x, r.y, r.w, r.h].every(Number.isInteger)).toBe(true);
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
            }
        }
    });

    test("the panes and their gaps cover the window: neighbours are one gap apart", () => {
        for (const mode of LAYOUT_MODES) {
            for (const gap of [0, 4]) {
                for (const [w, h] of WINDOWS) {
                    for (let n = 1; n <= 16; n++) {
                        const rects = tileRects(n, w, h, layout(mode, gap));
                        for (const r of rects) {
                            // The next thing to the right and below is a pane one gap away, or the edge.
                            const right = r.x + r.w;
                            const below = r.y + r.h;
                            if (right < w) {
                                expect(
                                    rects.some(
                                        (o) =>
                                            o.x === right + gap && o.y < below && r.y < o.y + o.h,
                                    ),
                                ).toBe(true);
                            }
                            if (below < h) {
                                expect(
                                    rects.some(
                                        (o) =>
                                            o.y === below + gap && o.x < right && r.x < o.x + o.w,
                                    ),
                                ).toBe(true);
                            }
                        }
                        const area = rects.reduce((sum, r) => sum + r.w * r.h, 0);
                        if (gap === 0) {
                            expect(area).toBe(w * h);
                        }
                    }
                }
            }
        }
    });

    test("the main pane is the largest pane of the main and focus layouts", () => {
        for (const mode of ["main", "focus"] as const) {
            for (const [w, h] of WINDOWS) {
                for (let n = 2; n <= 16; n++) {
                    const rects = tileRects(n, w, h, layout(mode));
                    const areas = rects.map((r) => r.w * r.h);
                    expect(areas[0]).toBe(Math.max(...areas));
                }
            }
        }
    });

    test("paneAt finds the pane under a point and nothing in a gap", () => {
        const rects = tileRects(4, 1280, 720, layout("grid"));
        expect(paneAt(rects, 10, 10)).toBe(0);
        expect(paneAt(rects, 1279, 10)).toBe(1);
        expect(paneAt(rects, 10, 719)).toBe(2);
        expect(paneAt(rects, 700, 400)).toBe(3);
        expect(paneAt(rects, 640, 10)).toBe(-1);
        expect(paneAt(rects, 10, 360)).toBe(-1);
    });
});

describe("pane order", () => {
    test("mainFirst moves the main pane to the front and keeps the others in order", () => {
        expect(mainFirst(["a", "b", "c", "d"], "c")).toEqual(["c", "a", "b", "d"]);
        expect(mainFirst(["a", "b", "c"], "a")).toEqual(["a", "b", "c"]);
        expect(mainFirst(["a", "b", "c"], undefined)).toEqual(["a", "b", "c"]);
        expect(mainFirst(["a", "b", "c"], "x")).toEqual(["a", "b", "c"]);
    });

    test("reorderBy takes the listed panes first and keeps the others", () => {
        const key = (name: string) => name.toLowerCase();
        expect(reorderBy(["Ann", "Bob", "Cat"], ["cat", "ann", "bob"], key)).toEqual([
            "Cat",
            "Ann",
            "Bob",
        ]);
        expect(reorderBy(["Ann", "Bob", "Cat"], ["bob"], key)).toEqual(["Bob", "Ann", "Cat"]);
        expect(reorderBy(["Ann", "Bob", "Cat"], ["zed", "cat", "cat"], key)).toEqual([
            "Cat",
            "Ann",
            "Bob",
        ]);
    });
});

describe("pane transition", () => {
    test("the move takes between 220 and 260 ms", () => {
        expect(TRANSITION_MS).toBeGreaterThanOrEqual(220);
        expect(TRANSITION_MS).toBeLessThanOrEqual(260);
    });

    test("easeOutCubic starts fast, never goes back and ends at rest", () => {
        expect(easeOutCubic(0)).toBe(0);
        expect(easeOutCubic(1)).toBe(1);
        expect(easeOutCubic(-1)).toBe(0);
        expect(easeOutCubic(2)).toBe(1);
        expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
        let last = 0;
        for (let i = 1; i <= 100; i++) {
            const e = easeOutCubic(i / 100);
            expect(e).toBeGreaterThanOrEqual(last);
            last = e;
        }
        expect(easeOutCubic(0.1) - easeOutCubic(0)).toBeGreaterThan(
            easeOutCubic(1) - easeOutCubic(0.9),
        );
    });

    test("mixRect moves every edge one way, in whole pixels, and lands on the target", () => {
        const from = { x: 0, y: 0, w: 638, h: 358 };
        const to = { x: 795, y: 483, w: 485, h: 237 };
        const out = { x: 0, y: 0, w: 0, h: 0 };
        expect(mixRect(out, from, to, 0)).toEqual(from);
        expect(mixRect(out, from, to, 1)).toEqual(to);
        expect(mixRect(out, from, to, 1)).toBe(out);
        let last = { ...from };
        for (let i = 1; i <= 60; i++) {
            const r = mixRect(out, from, to, easeOutCubic(i / 60));
            expect([r.x, r.y, r.w, r.h].every(Number.isInteger)).toBe(true);
            expect(r.x).toBeGreaterThanOrEqual(last.x);
            expect(r.y).toBeGreaterThanOrEqual(last.y);
            expect(r.x + r.w).toBeGreaterThanOrEqual(last.x + last.w);
            expect(r.y + r.h).toBeGreaterThanOrEqual(last.y + last.h);
            last = { ...r };
        }
    });

    test("two panes that swap places keep their gap apart sizes at both ends", () => {
        const [a, b] = tileRects(2, 1280, 720, layout("grid"));
        const out = { x: 0, y: 0, w: 0, h: 0 };
        expect(mixRect(out, a, b, 1)).toEqual(b);
        expect({ ...mixRect(out, b, a, 1) }).toEqual(a);
    });

    test("shrunkRect keeps the centre", () => {
        expect(shrunkRect({ x: 100, y: 50, w: 400, h: 200 }, 0.5)).toEqual({
            x: 200,
            y: 100,
            w: 200,
            h: 100,
        });
        expect(shrunkRect({ x: 0, y: 0, w: 101, h: 51 }, 1)).toEqual({ x: 0, y: 0, w: 101, h: 51 });
    });
});

describe("viewportRect", () => {
    test("flips to GL's bottom-left origin", () => {
        const rects = tileRects(4, 1280, 720, layout("grid"));
        expect(viewportRect(rects[0], 720, 1, 1)).toEqual({ x: 0, y: 362, w: 638, h: 358 });
        expect(viewportRect(rects[3], 720, 1, 1)).toEqual({ x: 642, y: 0, w: 638, h: 358 });
    });

    test("writes into the given rectangle", () => {
        const out = { x: 0, y: 0, w: 0, h: 0 };
        expect(viewportRect({ x: 10, y: 20, w: 30, h: 40 }, 100, 1, 1, out)).toBe(out);
        expect(out).toEqual({ x: 10, y: 40, w: 30, h: 40 });
    });

    test("panes a gap apart never share a framebuffer pixel at any scale", () => {
        for (const scale of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
            for (const mode of LAYOUT_MODES) {
                const rects = tileRects(9, 1048, 757, layout(mode, 1));
                const views = rects.map((r) => viewportRect(r, 757, scale, scale));
                for (let i = 0; i < views.length; i++) {
                    for (let j = i + 1; j < views.length; j++) {
                        expect(overlaps(views[i], views[j])).toBe(false);
                    }
                }
            }
        }
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
            for (const rect of tileRects(n, 1001, 333, layout("grid"))) {
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

describe("row, column and strip shares", () => {
    test("shares are parts of 1; a share under a quarter of an even one is not taken", () => {
        expect(parseShares([1, 3])).toEqual([0.25, 0.75]);
        expect(parseShares([])).toEqual([]);
        expect(parseShares([1, 9])).toBeUndefined();
        expect(parseShares([1, "2"])).toBeUndefined();
        expect(parseShares([1, 0])).toBeUndefined();
        expect(parseShares(new Array(17).fill(1))).toBeUndefined();
        expect(parseShares("1,2")).toBeUndefined();
        expect(parseStrip(0.3)).toBe(0.3);
        expect(parseStrip(0)).toBe(0);
        expect(parseStrip(0.5)).toBeUndefined();
        expect(sameShares(undefined, [])).toBe(true);
        expect(sameShares([0.5, 0.5], [0.5, 0.5])).toBe(true);
        expect(sameShares([0.4, 0.6], [0.5, 0.5])).toBe(false);
    });

    test("grid: rows and columns take their shares, neighbours stay one gap apart", () => {
        const options = { ...layout("grid"), rowShares: [0.25, 0.75], colShares: [0.6, 0.4] };
        const rects = tileRects(4, 1004, 804, options);
        expect(rects).toEqual([
            { x: 0, y: 0, w: 600, h: 200 },
            { x: 604, y: 0, w: 400, h: 200 },
            { x: 0, y: 204, w: 600, h: 600 },
            { x: 604, y: 204, w: 400, h: 600 },
        ]);
    });

    test("a list of another length than the layout has rows or columns leaves them even", () => {
        const even = tileRects(5, 1280, 720, layout("grid"));
        const options = { ...layout("grid"), rowShares: [0.2, 0.3, 0.5], colShares: [0.5, 0.5] };
        expect(tileRects(5, 1280, 720, options)).toEqual(even);
        // The stretched last row has two panes, the full row three: only the full row takes shares.
        const sized = tileRects(5, 1280, 720, { ...layout("grid"), colShares: [0.5, 0.25, 0.25] });
        expect(sized[0].w).toBe(636);
        expect(sized.slice(3)).toEqual(even.slice(3));
    });

    test("columns take the column shares; the focus strip takes the strip share", () => {
        const columns = tileRects(3, 1208, 600, {
            ...layout("columns"),
            colShares: [0.5, 0.25, 0.25],
        });
        expect(columns.map((r) => r.w)).toEqual([600, 300, 300]);
        const focus = tileRects(4, 1000, 800, { ...layout("focus"), stripShare: 0.25 });
        expect(focus[0]).toEqual({ x: 0, y: 0, w: 1000, h: 596 });
        expect(focus.slice(1).every((r) => r.y === 600 && r.h === 200)).toBe(true);
    });

    test("with shares no pane overlaps another or leaves the window", () => {
        for (const [width, height] of WINDOWS) {
            const options = { ...layout("grid"), rowShares: [0.7, 0.3], colShares: [0.2, 0.8] };
            const rects = tileRects(4, width, height, options);
            for (let i = 0; i < rects.length; i++) {
                expect(rects[i].x + rects[i].w).toBeLessThanOrEqual(width);
                expect(rects[i].y + rects[i].h).toBeLessThanOrEqual(height);
                for (let j = i + 1; j < rects.length; j++) {
                    expect(overlaps(rects[i], rects[j])).toBe(false);
                }
            }
        }
    });
});
