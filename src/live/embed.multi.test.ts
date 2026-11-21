// The hidden-name rule for multi-view panes: a hidden name is never printed in a pane label and never
// sent in a message to the embedding page.

type Embed = typeof import("./embed");

function loadEmbed(search: string, fetchImpl?: jest.Mock): Embed {
    window.history.replaceState({}, "", "/" + search);
    (global as any).fetch = fetchImpl;
    let embed!: Embed;
    jest.isolateModules(() => {
        embed = require("./embed");
    });
    return embed;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a pane prints an ordinary name and nothing for a hidden one", () => {
    const embed = loadEmbed("?embed=1&hideNames=Secret,Other");
    expect(embed.paneLabel("Bob")).toBe("Bob");
    expect(embed.paneLabel("Secret")).toBe("");
    expect(embed.paneLabel("sEcReT")).toBe("");
    expect(embed.paneLabel("Other")).toBe("");
    expect(embed.paneLabel(embed.MAIN_MARK)).toBe("");
    expect(embed.paneLabel(undefined)).toBe("");
});

test("a message carries the marker in place of a hidden name", () => {
    const embed = loadEmbed("?embed=1&hideNames=Secret");
    expect(embed.paneMessageName("Bob")).toBe("Bob");
    expect(embed.paneMessageName("SECRET")).toBe(embed.MAIN_MARK);
    expect(embed.paneMessageName(embed.MAIN_MARK)).toBe(embed.MAIN_MARK);
    expect(embed.resolveFollow(embed.MAIN_MARK)).toBe("secret");
});

test("no name is printed until the hidden list has arrived", async () => {
    let deliver!: (list: string[]) => void;
    const fetchMock = jest.fn().mockReturnValue(
        new Promise((resolve) => {
            deliver = (list) => resolve({ json: () => Promise.resolve(list) });
        }),
    );
    const embed = loadEmbed("?embed=1&hideNamesFrom=http%3A%2F%2Fx%2Fhidden.json", fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embed.paneLabel("Bob")).toBe("");
    expect(embed.paneLabel("Secret")).toBe("");
    deliver(["Secret"]);
    await flush();
    await flush();
    expect(embed.paneLabel("Bob")).toBe("Bob");
    expect(embed.paneLabel("Secret")).toBe("");
    expect(embed.paneMessageName("Secret")).toBe(embed.MAIN_MARK);
});

test("a hidden list that fails to load still lets ordinary names print", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("down"));
    const embed = loadEmbed(
        "?embed=1&hideNames=Secret&hideNamesFrom=http%3A%2F%2Fx%2Fh.json",
        fetchMock,
    );
    expect(embed.paneLabel("Bob")).toBe("");
    await flush();
    await flush();
    expect(embed.paneLabel("Bob")).toBe("Bob");
    expect(embed.paneLabel("Secret")).toBe("");
});

test("the multi-view status is posted to the parent once per change", () => {
    const embed = loadEmbed("?embed=1");
    const post = jest.fn();
    const parent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage: post } });
    try {
        const status = { names: ["a", "b"], shown: ["a"], offline: [] };
        embed.postMultiStatus(status);
        embed.postMultiStatus({ ...status });
        embed.postMultiStatus({ ...status, shown: ["a", "b"] });
        embed.postMultiPick("b", 1);
        expect(post.mock.calls).toEqual([
            [{ viewerMulti: status }, "*"],
            [{ viewerMulti: { names: ["a", "b"], shown: ["a", "b"], offline: [] } }, "*"],
            [{ viewerMultiPick: "b", index: 1 }, "*"],
        ]);
    } finally {
        if (parent) {
            Object.defineProperty(window, "parent", parent);
        }
    }
});

test("the layout message carries the marker for a hidden name, as a pane, as main and as focus", () => {
    const embed = loadEmbed("?embed=1&hideNames=Secret");
    const rect = { x: 10, y: 20, w: 300, h: 200 };
    const info = embed.multiLayoutInfo(
        "main",
        "SECRET",
        "secret",
        [
            { asked: "Bob", rect },
            { asked: "Secret", rect: { x: 314, y: 20, w: 100, h: 200 } },
            { asked: embed.MAIN_MARK, rect },
            { asked: undefined, rect },
        ],
        5,
        7,
        true,
        240,
        1234.5,
    );
    expect(info).toEqual({
        mode: "main",
        main: embed.MAIN_MARK,
        focus: embed.MAIN_MARK,
        rects: [
            { name: "Bob", x: 15, y: 27, w: 300, h: 200 },
            { name: embed.MAIN_MARK, x: 319, y: 27, w: 100, h: 200 },
            { name: embed.MAIN_MARK, x: 15, y: 27, w: 300, h: 200 },
        ],
        animating: true,
        ms: 240,
        at: 1234.5,
    });
    expect(JSON.stringify(info).toLowerCase()).not.toContain("secret");
    expect(
        embed.multiLayoutInfo("grid", undefined, undefined, [], 0, 0, false, 0, 0),
    ).toMatchObject({
        main: null,
        focus: null,
        rects: [],
    });
});

test("the layout message is posted to the parent", () => {
    const embed = loadEmbed("?embed=0");
    const post = jest.fn();
    const parent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage: post } });
    try {
        const info = embed.multiLayoutInfo("grid", "a", "a", [], 0, 0, false, 0, 1);
        embed.postMultiLayout(info);
        expect(post.mock.calls).toEqual([[{ viewerMultiLayout: info }, "*"]]);
    } finally {
        if (parent) {
            Object.defineProperty(window, "parent", parent);
        }
    }
});

describe("LiveController fleet wall placement and ground elevation", () => {
    test("preserves pendingFollow until roster locates player and gates feed.setArea until placed", () => {
        window.history.replaceState({}, "", "/?client=1");
        let Camera!: typeof import("../mapviewer/Camera").Camera;
        let LiveController!: typeof import("./LiveController").LiveController;
        jest.isolateModules(() => {
            Camera = require("../mapviewer/Camera").Camera;
            LiveController = require("./LiveController").LiveController;
        });

        const live = new LiveController(
            "ws://localhost:9999/worldfeed",
            {} as any,
            {} as any,
            {} as any,
            undefined,
        );
        live.flights = false;
        const setArea = jest.spyOn(live.feed, "setArea");
        jest.spyOn(live.feed, "connect").mockImplementation(() => {});

        const camera = new Camera(3200, -10, 3200, -245, 182);
        live.pendingFollow = "Bob";
        // Roster arrived without Bob yet: pendingFollow must NOT be dropped, and template camera must not subscribe feed.
        live.world.applyRoster({ t: "roster", k: 1, p: [[1, "Alice", 3100, 3100, 0, 3]], npcs: 0 });
        live.update(0, camera, 48, () => undefined);
        expect(live.pendingFollow).toBe("Bob");
        expect(live.hasPlacedTarget()).toBe(false);
        expect(setArea).not.toHaveBeenCalled();

        // Bob appears on roster at an elevated tile on level 1 (terrain groundY = -360): camera & feed place safely.
        live.world.applyRoster({ t: "roster", k: 2, p: [[1, "Alice", 3100, 3100, 0, 3], [2, "Bob", 2500, 3400, 1, 3]], npcs: 0 });
        live.update(0, camera, 48, () => undefined, () => -360);
        expect(live.pendingFollow).toBeUndefined();
        expect(live.followName).toBe("Bob");
        expect(live.hasPlacedTarget()).toBe(true);
        expect(setArea).toHaveBeenCalledTimes(1);
        // Camera Y reflects groundY = -360 rather than groundY = 0.
        const targetY = (-360 - 96) / 128;
        const expectedY = targetY + Math.sin((-245 * Math.PI) / 1024) * 7;
        expect(camera.pos[1]).toBeCloseTo(expectedY, 4);
    });

    test("MapManager tracks pending uploads separately from worker tasks and gates canRenderAt by frame delay", () => {
        const { MapManager } = require("../mapviewer/MapManager");
        const loaded: [number, number][] = [];
        const mgr = new MapManager(2, (x: number, y: number) => loaded.push([x, y]));

        mgr.loadMap(50, 50);
        mgr.loadMap(50, 51);
        mgr.loadMap(50, 52);
        expect(mgr.loadingMapIds.size).toBe(3);
        // Exceeding maxQueuedTasks blocks additional worker dispatches until worker marks done.
        mgr.loadMap(50, 53);
        expect(loaded).toHaveLength(3);

        mgr.markWorkerDone(50, 50);
        expect(mgr.loadingMapIds.size).toBe(2);
        expect(mgr.pendingUploadIds.size).toBe(1);
        // Duplicate load of pending upload square is skipped, while new worker task proceeds.
        mgr.loadMap(50, 50);
        mgr.loadMap(50, 53);
        expect(loaded).toHaveLength(4);

        // canRenderAt honors FRAME_RENDER_DELAY via mapSquare.canRender(frameCount).
        mgr.updateMulti([], 10, 48, 2, [[3205, 3205]]);
        mgr.addMap(50, 50, {
            mapX: 50,
            mapY: 50,
            canRender: (f: number) => f >= 13,
            delete: jest.fn(),
        });
        expect(mgr.canRenderAt(3205, 3205)).toBe(false);
        mgr.updateMulti([], 13, 48, 2, [[3205, 3205]]);
        expect(mgr.canRenderAt(3205, 3205)).toBe(true);
    });
});
