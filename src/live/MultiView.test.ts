// The moves of multi-view panes: a pane keeps its identity by object, moves from where it is to its
// new rectangle, a new pane grows in and a closed pane shrinks out. No GL: the renderer only reads
// pane.rect.
import { PaneRect, TRANSITION_MS, tileRects } from "./MultiLayout";
import { MultiPane, MultiView } from "./MultiView";
import { MultiLayoutInfo } from "./embed";

const W = 1280;
const H = 720;

function makePane(name: string): MultiPane {
    const live = { followName: name, pendingFollow: undefined, stop: jest.fn() };
    return new MultiPane({} as any, live as any, name, undefined);
}

function makeView(names: string[]) {
    const infos: MultiLayoutInfo[] = [];
    const retired: MultiPane[] = [];
    const view = new MultiView(true, () => {});
    view.onLayout = (info) => infos.push(info);
    view.onRetired = (pane) => retired.push(pane);
    const panes = names.map(makePane);
    for (const pane of panes) {
        view.addPane(pane);
    }
    return { view, panes, infos, retired };
}

const rectOf = (pane: MultiPane): PaneRect => ({ ...pane.rect });
const grid = (n: number) => tileRects(n, W, H, { mode: "grid", gap: 4, ratio: 0.62 });

function setReducedMotion(on: boolean) {
    (window as any).matchMedia = (query: string) => ({ matches: on && query.includes("reduce") });
}

// The panes' name overlays are 2D canvases, which jsdom does not draw.
beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = jest.fn(() => null) as any;
});
beforeEach(() => setReducedMotion(false));

test("new panes grow and fade in at their place; the move ends on the layout's rectangles", () => {
    const { view, panes, infos } = makeView(["Ann", "Bob", "Cat", "Dan"]);
    expect(view.wantsFrames()).toBe(true);
    view.layout(W, H, 1000);
    const targets = grid(4);
    expect(view.animating).toBe(true);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
        mode: "grid",
        main: "Ann",
        animating: true,
        ms: TRANSITION_MS,
    });
    expect(infos[0].rects).toEqual(
        targets.map((r, i) => ({ name: ["Ann", "Bob", "Cat", "Dan"][i], ...r })),
    );
    // The first frame: smaller than the target, about the same centre, not yet shown.
    panes.forEach((pane, i) => {
        expect(pane.rect.w).toBeLessThan(targets[i].w);
        expect(
            Math.abs(pane.rect.x + pane.rect.w / 2 - (targets[i].x + targets[i].w / 2)),
        ).toBeLessThanOrEqual(1);
        expect(pane.alpha).toBe(0);
    });
    view.layout(W, H, 1000 + TRANSITION_MS / 2);
    panes.forEach((pane) => {
        expect(pane.alpha).toBeGreaterThan(0.5);
        expect(pane.alpha).toBeLessThan(1);
    });
    view.layout(W, H, 1000 + TRANSITION_MS);
    expect(view.animating).toBe(false);
    expect(view.wantsFrames()).toBe(false);
    expect(panes.map(rectOf)).toEqual(targets);
    expect(panes.every((pane) => pane.alpha === 1)).toBe(true);
    expect(infos).toHaveLength(2);
    expect(infos[1]).toMatchObject({ animating: false, ms: 0 });
    expect(panes[0].frame.style.width).toBe(`${targets[0].w}px`);
});

test("a frame with no change does no work: no message and the same rectangles", () => {
    const { view, panes, infos } = makeView(["Ann", "Bob"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    const before = panes.map(rectOf);
    const place = jest.spyOn(panes[0], "place");
    const shift = jest.spyOn(panes[0], "shift");
    for (let t = 300; t < 400; t += 16) {
        view.layout(W, H, t);
    }
    expect(place).not.toHaveBeenCalled();
    expect(shift).not.toHaveBeenCalled();
    // The same panes asked for again: nothing moves, and the page is told the same rectangles.
    view.reorder(panes.slice());
    expect(view.wantsFrames()).toBe(true);
    view.layout(W, H, 500);
    expect(view.animating).toBe(false);
    expect(view.wantsFrames()).toBe(false);
    expect(infos).toHaveLength(3);
    expect(infos[2]).toMatchObject({ animating: false, ms: 0 });
    infos.pop();
    expect(infos).toHaveLength(2);
    expect(panes.map(rectOf)).toEqual(before);
});

test("a new order moves each pane from its old rectangle to its new one, edge by edge one way", () => {
    const { view, panes } = makeView(["Ann", "Bob", "Cat", "Dan"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    const [ann, bob, cat, dan] = panes;
    const targets = grid(4);
    view.reorder([dan, bob, cat, ann]);
    view.layout(W, H, 1000);
    // The pane objects are the same: Ann starts where she was.
    expect(rectOf(ann)).toEqual(targets[0]);
    let last = rectOf(ann);
    for (let t = 1016; t < 1000 + TRANSITION_MS; t += 16) {
        view.layout(W, H, t);
        const r = rectOf(ann);
        expect(r.x).toBeGreaterThanOrEqual(last.x);
        expect(r.y).toBeGreaterThanOrEqual(last.y);
        expect(ann.alpha).toBe(1);
        last = r;
    }
    view.layout(W, H, 1000 + TRANSITION_MS);
    expect(rectOf(ann)).toEqual(targets[3]);
    expect(rectOf(dan)).toEqual(targets[0]);
    expect(rectOf(bob)).toEqual(targets[1]);
});

test("a layout or main pane change moves the panes; the main pane takes the first place", () => {
    const { view, panes, infos } = makeView(["Ann", "Bob", "Cat"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    view.options.mode = "main";
    view.relayout();
    view.setMain(panes[2]);
    view.layout(W, H, 1000);
    view.layout(W, H, 1000 + TRANSITION_MS);
    const targets = tileRects(3, W, H, view.options);
    expect(rectOf(panes[2])).toEqual(targets[0]);
    expect(rectOf(panes[0])).toEqual(targets[1]);
    expect(rectOf(panes[1])).toEqual(targets[2]);
    // The message keeps the asked order and names the main pane.
    const info = infos[infos.length - 1];
    expect(info.main).toBe("Cat");
    expect(info.rects.map((r) => r.name)).toEqual(["Ann", "Bob", "Cat"]);
    expect(info.rects[2]).toMatchObject(targets[0]);
    // The main pane is drawn last, over the others.
    expect(view.drawList[view.drawList.length - 1]).toBe(panes[2]);
});

test("a move that starts during another carries on from where the panes are", () => {
    const { view, panes } = makeView(["Ann", "Bob"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    view.reorder([panes[1], panes[0]]);
    view.layout(W, H, 1000);
    view.layout(W, H, 1100);
    const mid = rectOf(panes[0]);
    view.reorder([panes[0], panes[1]]);
    view.layout(W, H, 1101);
    expect(rectOf(panes[0])).toEqual(mid);
    view.layout(W, H, 1101 + TRANSITION_MS);
    expect(panes.map(rectOf)).toEqual(grid(2));
});

test("a closed pane shrinks and fades where it is, is drawn until the end, then is retired", () => {
    const { view, panes, retired, infos } = makeView(["Ann", "Bob", "Cat"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    const [ann, bob, cat] = panes;
    const was = rectOf(bob);
    view.reorder([ann, cat]);
    view.layout(W, H, 1000);
    expect(view.panes).toEqual([ann, cat]);
    expect(view.drawList).toContain(bob);
    expect(view.drawList[0]).toBe(bob);
    expect(infos[infos.length - 1].rects.map((r) => r.name)).toEqual(["Ann", "Cat"]);
    view.layout(W, H, 1000 + TRANSITION_MS / 2);
    expect(bob.alpha).toBeLessThan(0.5);
    expect(bob.rect.w).toBeLessThan(was.w);
    expect(Math.abs(bob.rect.x + bob.rect.w / 2 - (was.x + was.w / 2))).toBeLessThanOrEqual(1);
    expect(retired).toEqual([]);
    expect(bob.frame.parentElement).toBe(view.root);
    view.layout(W, H, 1000 + TRANSITION_MS);
    expect(retired).toEqual([bob]);
    expect(view.drawList).not.toContain(bob);
    expect(bob.frame.parentElement).toBeNull();
    expect([ann, cat].map(rectOf)).toEqual(grid(2));
});

test("when the main pane closes, the next pane in the order is the main pane", () => {
    const { view, panes } = makeView(["Ann", "Bob", "Cat"]);
    view.setMain(panes[1]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    view.reorder([panes[0], panes[2]]);
    expect(view.mainPane()).toBe(panes[2]);
    view.reorder([panes[0]]);
    expect(view.mainPane()).toBe(panes[0]);
});

test("the single view that became a pane shrinks from the full window", () => {
    const { view, panes } = makeView(["Ann", "Bob"]);
    panes[0].enter = "full";
    view.layout(W, H, 0);
    expect(rectOf(panes[0])).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(panes[0].alpha).toBe(1);
    view.layout(W, H, TRANSITION_MS);
    expect(rectOf(panes[0])).toEqual(grid(2)[0]);
});

test("a new window size is followed at once", () => {
    const { view, panes, infos } = makeView(["Ann", "Bob"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    view.layout(800, 600, 1000);
    expect(view.animating).toBe(false);
    expect(panes.map(rectOf)).toEqual(tileRects(2, 800, 600, view.options));
    expect(infos[infos.length - 1]).toMatchObject({ animating: false, ms: 0 });
});

test("with reduced motion, or animate off, every change is drawn at once", () => {
    for (const how of ["media", "flag"]) {
        setReducedMotion(how === "media");
        const { view, panes, retired, infos } = makeView(["Ann", "Bob", "Cat"]);
        view.animate = how !== "flag";
        view.layout(W, H, 0);
        expect(view.animating).toBe(false);
        expect(panes.map(rectOf)).toEqual(grid(3));
        expect(panes.every((pane) => pane.alpha === 1)).toBe(true);
        expect(infos).toHaveLength(1);
        expect(infos[0]).toMatchObject({ animating: false, ms: 0 });
        view.reorder([panes[2], panes[0]]);
        view.layout(W, H, 16);
        expect(view.animating).toBe(false);
        expect(view.wantsFrames()).toBe(false);
        expect([panes[2], panes[0]].map(rectOf)).toEqual(grid(2));
        expect(retired).toEqual([panes[1]]);
    }
});

test("findPane takes a number in the asked order or a name in any case", () => {
    const { view, panes } = makeView(["Ann", "Bob"]);
    expect(view.findPane(1)).toBe(panes[1]);
    expect(view.findPane("ANN")).toBe(panes[0]);
    expect(view.findPane("Zed")).toBeUndefined();
    expect(view.findPane(7)).toBeUndefined();
    expect(view.findPane("")).toBeUndefined();
});

test("while a pane moves its DOM frame keeps its layout and follows with a transform", () => {
    const { view, panes } = makeView(["Ann", "Bob"]);
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    const [ann, bob] = panes;
    const [left, right] = grid(2);
    expect(ann.frame.style.transform).toBe("");
    view.reorder([bob, ann]);
    view.layout(W, H, 1000);
    view.layout(W, H, 1000 + TRANSITION_MS / 2);
    // Laid out where it was; moved by the transform to where the pane is drawn.
    expect(ann.frame.style.left).toBe(`${left.x}px`);
    expect(ann.frame.style.width).toBe(`${left.w}px`);
    expect(ann.frame.style.transform).toBe(
        `translate(${ann.rect.x - left.x}px,${ann.rect.y - left.y}px) scale(${
            ann.rect.w / left.w
        },${ann.rect.h / left.h})`,
    );
    view.layout(W, H, 1000 + TRANSITION_MS);
    expect(ann.frame.style.transform).toBe("");
    expect(ann.frame.style.left).toBe(`${right.x}px`);
    // A new pane is laid out at its target and grows there.
    const cat = makePane("Cat");
    view.reorder([bob, ann, cat]);
    view.layout(W, H, 2000);
    const target = grid(3)[2];
    expect(cat.frame.style.left).toBe(`${target.x}px`);
    expect(cat.frame.style.transform).toContain("scale(0.6");
});

test("on the way back to the single view the selected pane grows to the full window", () => {
    const { view, panes, retired } = makeView(["Ann", "Bob", "Cat"]);
    const closed = jest.fn();
    view.onClosed = closed;
    view.layout(W, H, 0);
    view.layout(W, H, TRANSITION_MS);
    view.setActive(1);
    expect(view.close()).toBe(true);
    expect(view.panes).toEqual([panes[1]]);
    view.layout(W, H, 1000);
    expect(view.animating).toBe(true);
    expect(view.drawList).toHaveLength(3);
    view.layout(W, H, 1000 + TRANSITION_MS / 2);
    expect(panes[1].rect.w).toBeGreaterThan(grid(3)[1].w);
    expect(closed).not.toHaveBeenCalled();
    view.layout(W, H, 1000 + TRANSITION_MS);
    expect(rectOf(panes[1])).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(retired).toEqual(expect.arrayContaining([panes[0], panes[2]]));
    expect(closed).toHaveBeenCalledTimes(1);
});

test("with reduced motion, or before the first frame, the way back is at once", () => {
    const early = makeView(["Ann", "Bob"]);
    expect(early.view.close()).toBe(false);
    setReducedMotion(true);
    const still = makeView(["Ann", "Bob"]);
    still.view.layout(W, H, 0);
    expect(still.view.close()).toBe(false);
    expect(still.view.panes).toHaveLength(2);
});
