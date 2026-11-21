// Unit tests for native ?client=1 dashboard camera defaults and user unfollow notifications.

function loadModules(search: string) {
    window.history.replaceState({}, "", "/" + search);
    let embed!: typeof import("./embed");
    let Camera!: typeof import("../mapviewer/Camera").Camera;
    let LiveController!: typeof import("./LiveController").LiveController;
    jest.isolateModules(() => {
        embed = require("./embed");
        Camera = require("../mapviewer/Camera").Camera;
        LiveController = require("./LiveController").LiveController;
    });
    return { embed, Camera, LiveController };
}

function makeController(LiveController: typeof import("./LiveController").LiveController) {
    return new LiveController(
        "ws://localhost:9999/worldfeed",
        {} as any,
        {} as any,
        {} as any,
        undefined,
    );
}

describe("native ?client=1 dashboard camera defaults", () => {
    test("standalone defaults are unchanged", () => {
        const { embed, Camera, LiveController } = loadModules("");
        expect(embed.EMBED).toBe(false);
        expect(embed.CLIENT).toBe(false);
        const camera = new Camera(3200, -10, 3200, 0, 0);
        expect(camera.fov).toBe(90);

        const live = makeController(LiveController);
        live.flights = false;
        live.world.applyRoster({ t: "roster", k: 1, p: [[1, "Alice", 3200, 3200, 0, 3]], npcs: 0 });
        live.goToPlayer("Alice", camera);

        expect(camera.pitch).toBe(-185);
        expect((live as any).orbitDistance).toBe(11);
    });

    test("?embed=1 defaults are unchanged", () => {
        const { embed, Camera, LiveController } = loadModules("?embed=1");
        expect(embed.EMBED).toBe(true);
        expect(embed.CLIENT).toBe(false);
        const camera = new Camera(3200, -10, 3200, 0, 0);
        expect(camera.fov).toBe(90);

        const live = makeController(LiveController);
        live.flights = false;
        live.world.applyRoster({ t: "roster", k: 1, p: [[1, "Alice", 3200, 3200, 0, 3]], npcs: 0 });
        live.goToPlayer("Alice", camera);

        expect(camera.pitch).toBe(-290);
        expect((live as any).orbitDistance).toBe(20);
    });

    test("?client=1 uses fov 55, orbitDistance 7, pitch -245", () => {
        const { embed, Camera, LiveController } = loadModules("?client=1");
        expect(embed.EMBED).toBe(false);
        expect(embed.CLIENT).toBe(true);
        const camera = new Camera(3200, -10, 3200, 0, 0);
        expect(camera.fov).toBe(55);

        const live = makeController(LiveController);
        live.flights = false;
        live.world.applyRoster({ t: "roster", k: 1, p: [[1, "Alice", 3200, 3200, 0, 3]], npcs: 0 });
        live.goToPlayer("Alice", camera);

        expect(camera.pitch).toBe(-245);
        expect((live as any).orbitDistance).toBe(7);

        // Following a visible entity directly (orbitDistance initially 0) also locks to ?client=1 framing.
        const player = { id: 1, name: "Alice", x: 3200 * 128 + 64, z: 3200 * 128 + 64, level: 0 } as any;
        live.world.players.set(1, player);
        live.follow(player);
        (live as any).updateFollow(camera, () => 0);

        expect(camera.pitch).toBe(-245);
        expect((live as any).orbitDistance).toBe(7);
    });

    test("?client=1&embed=1 keeps embed orbitDistance=20 while applying client fov=55", () => {
        const { embed, Camera, LiveController } = loadModules("?client=1&embed=1");
        expect(embed.EMBED).toBe(true);
        expect(embed.CLIENT).toBe(true);
        const camera = new Camera(3200, -10, 3200, 0, 0);
        expect(camera.fov).toBe(55);

        const live = makeController(LiveController);
        live.flights = false;
        live.world.applyRoster({ t: "roster", k: 1, p: [[1, "Alice", 3200, 3200, 0, 3]], npcs: 0 });
        live.goToPlayer("Alice", camera);

        expect(camera.pitch).toBe(-290);
        expect((live as any).orbitDistance).toBe(20);
    });

    test("dispatches atlasCameraReleased only when user unfollows an active target", () => {
        const { LiveController } = loadModules("?client=1");
        const onRelease = jest.fn();
        window.addEventListener("atlasCameraReleased", onRelease);
        try {
            const live = makeController(LiveController);
            const player = { id: 1, name: "Alice", x: 3200 * 128, z: 3200 * 128, level: 0 } as any;

            // Not following yet: user unfollow is a no-op.
            live.unfollow(true);
            expect(onRelease).not.toHaveBeenCalled();

            // Programmatic unfollow does not fire the user event.
            live.follow(player);
            live.unfollow();
            expect(onRelease).not.toHaveBeenCalled();

            // User unfollow fires atlasCameraReleased once.
            live.follow(player);
            live.unfollow(true);
            expect(onRelease).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener("atlasCameraReleased", onRelease);
        }
    });
});
