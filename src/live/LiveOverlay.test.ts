// Unit tests for the name overlay: a frame that would draw what the canvas already shows leaves the canvas as it is.
import { Camera } from "../mapviewer/Camera";
import { LivePlayer } from "./LiveEntity";
import { LiveOverlay } from "./LiveOverlay";
import { markers } from "./Markers";

const METHODS = new Set([
    "setTransform",
    "clearRect",
    "fillText",
    "fillRect",
    "drawImage",
    "beginPath",
    "moveTo",
    "lineTo",
    "closePath",
    "fill",
    "stroke",
    "arc",
    "save",
    "restore",
]);

// A 2D context that records the names of the draw calls (jsdom has no canvas).
function fakeContext(calls: string[]): CanvasRenderingContext2D {
    const state: Record<string | symbol, unknown> = {};
    return new Proxy(state, {
        get: (target, prop) => {
            if (prop === "measureText") return (text: string) => ({ width: text.length * 6 });
            if (typeof prop === "string" && METHODS.has(prop)) return () => calls.push(prop);
            return target[prop];
        },
        set: (target, prop, value) => {
            target[prop] = value;
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
}

function player(id: number, name: string, tileX: number, tileZ: number): LivePlayer {
    const p = new LivePlayer(id);
    p.name = name;
    p.x = tileX * 128 + 64;
    p.z = tileZ * 128 + 64;
    return p;
}

function controller(players: LivePlayer[]) {
    return {
        options: {
            showPlayers: true,
            showNpcs: true,
            showPlayerNames: true,
            showNpcNames: false,
            showChat: true,
            showCombat: true,
        },
        world: { players: new Map(players.map((p) => [p.id, p])), npcs: new Map(), loopCycle: 0 },
        getFollowed: () => undefined,
        worldState: undefined,
        headIconSprites: [],
        hitmarkSprites: [],
    } as any;
}

// The follow orbit around tile (3200, 3200): 11 tiles out, south of the player, looking north and down.
function followCamera(): Camera {
    const camera = new Camera(3200.5, -6.7, 3191.2, -185, 0);
    camera.update(800, 600);
    return camera;
}

let calls: string[];
let overlay: LiveOverlay;
const ground = () => 0;

beforeEach(() => {
    calls = [];
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => fakeContext(calls) as any,
    );
    overlay = new LiveOverlay();
    Object.defineProperty(overlay.canvas, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(overlay.canvas, "clientHeight", { configurable: true, value: 600 });
});

afterEach(() => {
    jest.restoreAllMocks();
});

test("a still view draws its names once and then leaves the canvas alone", () => {
    const live = controller([player(1, "Alice", 3200, 3200)]);
    const camera = followCamera();
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect((overlay as any).overlays.map((o: { name?: string }) => o.name)).toEqual(["Alice"]);
    expect(calls).toContain("clearRect");
    expect(calls).toContain("fillText");
    const drawn = calls.length;

    overlay.draw(live, camera, ground, 3, 64, 8, []);
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(calls.length).toBe(drawn);
    expect(overlay.painted).toBe(1);
    expect(overlay.skipped).toBe(2);
});

test("a moved player, a chat line, a moved camera, a new overlay message and a new size each redraw", () => {
    const alice = player(1, "Alice", 3200, 3200);
    const live = controller([alice]);
    const camera = followCamera();
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(1);

    alice.x += 32;
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(2);

    alice.chatMessage = "hello";
    alice.chatTimer = 50;
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(3);

    camera.pos[0] += 0.25;
    camera.update(800, 600);
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(4);

    markers.setOverlay({});
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(5);

    Object.defineProperty(overlay.canvas, "clientWidth", { configurable: true, value: 640 });
    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(6);

    overlay.draw(live, camera, ground, 3, 64, 8, []);
    expect(overlay.painted).toBe(6);
    expect(overlay.skipped).toBe(1);
});

test("a far player's name that moves redraws", () => {
    const live = controller([]);
    const camera = followCamera();
    const far = [{ name: "Bob", x: 3202 * 128, z: 3205 * 128, groundY: 0, height: 200 }];
    overlay.draw(live, camera, ground, 3, 64, 8, far);
    expect(calls).toContain("fillText");
    overlay.draw(live, camera, ground, 3, 64, 8, far);
    expect(overlay.painted).toBe(1);
    far[0].x += 64;
    overlay.draw(live, camera, ground, 3, 64, 8, far);
    expect(overlay.painted).toBe(2);
});
