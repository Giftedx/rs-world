// Unit tests for the feed area during a follow flight: while the camera holds the old view for the destination's
// squares, the feed keeps the old area, so the held view keeps its players, doors, fires and ground items.
import { Camera } from "../mapviewer/Camera";
import { LiveController } from "./LiveController";

function setup() {
    const live = new LiveController(
        "ws://localhost:9999/worldfeed",
        {} as any,
        {} as any,
        {} as any,
        undefined,
    );
    const areas: [number, number, number, number][] = [];
    (live.feed as any).connect = () => {};
    (live.feed as any).setArea = (x: number, z: number, w: number, h: number) =>
        areas.push([x, z, w, h]);
    let ready = false;
    const maps = { prefetch() {}, ready: () => ready, visibleMapCount: 0, blankOnScreen: 0 };
    live.maps = maps;
    live.world.applyRoster({
        t: "roster",
        k: 1,
        p: [
            [1, "Alice", 3200, 3200, 0, 3],
            [2, "Bob", 3400, 3400, 0, 3],
        ],
        npcs: 0,
    });
    return { live, areas, maps, setReady: (r: boolean) => (ready = r) };
}

const holds = (area: number[], x: number, z: number) =>
    x >= area[0] && x < area[0] + area[2] && z >= area[1] && z < area[1] + area[3];

test("the feed keeps the old area while a flight holds the old view, and moves when the camera moves", () => {
    const { live, areas, maps, setReady } = setup();
    const camera = new Camera(3200, -10, 3200, 0, 0);
    const frame = () =>
        live.update(
            0,
            camera,
            64,
            () => 0,
            () => 0,
        );

    // The first follow of an empty scene jumps there.
    expect(live.goToPlayer("Alice", camera)).toBe(true);
    frame();
    expect(holds(areas.at(-1)!, 3200, 3200)).toBe(true);
    const old = areas.at(-1);

    // A follow change flies; its squares are not loaded yet, so the camera holds the old view.
    maps.visibleMapCount = 9;
    expect(live.goToPlayer("Bob", camera)).toBe(true);
    expect(live.inFlight).toBe(true);
    frame();
    frame();
    expect(areas.at(-1)).toBe(old);

    // The squares are in: the camera starts to move and the feed asks for the new area.
    setReady(true);
    frame();
    expect(holds(areas.at(-1)!, 3400, 3400)).toBe(true);
});
