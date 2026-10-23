import { Camera } from "../mapviewer/Camera";

// Camera flight between two followed players, so a follow change never cuts to an unloaded (black) area.
//   rise:    climb over the current spot (its map squares are loaded) and tilt down.
//   wait:    hover there, slowly turning, until the destination squares (and, for a short hop, the squares on
//            the way) are loaded. Capped, so a stuck loader cannot hold the camera forever.
//   glide:   short hops (<= GLIDE_MAX tiles) fly across at height; the path was prefetched with the destination.
//   warp:    long hops blur the canvas for a moment and move to the same height over the destination, because
//            the hundreds of tiles in between are not loaded and would draw black.
//   descend: drop from the height into the follow orbit around the player.

export type MapAccess = {
    prefetch(tileX: number, tileZ: number, radiusTiles: number): void;
    ready(tileX: number, tileZ: number, radiusTiles: number): boolean;
    blankOnScreen: number;
};

type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };

const RS_TO_RADIANS = Math.PI / 1024;
const RISE_MS = 600;
const WAIT_MAX_MS = 9000;
const WARP_MS = 420;
const DESCEND_MS = 900;
const GLIDE_MAX = 192;
// Height of the flight above the ground (camera Y grows downward: negative is up), and the pitch on the way.
const HIGH = 34;
const HIGH_PITCH = -430;
// Squares loaded around the destination before the camera comes down.
const DEST_RADIUS = 40;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// Shortest way round for RS angles (0..2047).
const lerpYaw = (a: number, b: number, t: number) => {
    let d = ((b - a + 3072) % 2048) - 1024;
    return (a + d * t + 2048) % 2048;
};

export class CameraFlight {
    private phase: "rise" | "wait" | "glide" | "warp" | "descend" = "rise";
    private phaseStart: number;
    private readonly from: Pose;
    private high: Pose;
    private readonly highDest: Pose;
    private readonly end: Pose;
    private warped = false;
    readonly started: number;
    readonly distance: number;
    readonly glide: boolean;
    done = false;

    constructor(
        camera: Camera,
        readonly toX: number,
        readonly toZ: number,
        orbitDistance: number,
        orbitPitch: number,
        private readonly canvas?: HTMLElement,
    ) {
        const now = performance.now();
        this.started = now;
        this.phaseStart = now;
        this.from = { x: camera.getPosX(), y: camera.pos[1], z: camera.getPosZ(), yaw: camera.yaw, pitch: camera.pitch };
        this.distance = Math.hypot(toX - this.from.x, toZ - this.from.z);
        this.glide = this.distance <= GLIDE_MAX;
        // Over the start, pulled back toward where we came from so the view keeps the ground below in frame.
        this.high = { ...this.from, y: Math.min(this.from.y, 0) - HIGH, pitch: HIGH_PITCH };
        this.highDest = { x: toX, y: -HIGH, z: toZ, yaw: this.from.yaw, pitch: HIGH_PITCH };
        // Final orbit pose around the player at ground level (the follow camera corrects for real height).
        const yaw = (this.from.yaw - 1024) * RS_TO_RADIANS;
        const pitch = orbitPitch * RS_TO_RADIANS;
        this.end = {
            x: toX + Math.cos(pitch) * Math.sin(yaw) * orbitDistance,
            y: -0.75 + Math.sin(pitch) * orbitDistance,
            z: toZ + Math.cos(pitch) * Math.cos(yaw) * orbitDistance,
            yaw: this.from.yaw,
            pitch: orbitPitch,
        };
        // The descent ends looking at the player: put the high point straight above and behind the end pose.
        this.highDest.x = toX + (this.end.x - toX) * 1.6;
        this.highDest.z = toZ + (this.end.z - toZ) * 1.6;
    }

    // Moves the camera for this frame. Returns true when the flight has ended.
    step(camera: Camera, maps: MapAccess | undefined): boolean {
        const now = performance.now();
        const t = (ms: number) => Math.min(1, (now - this.phaseStart) / ms);
        const next = (p: typeof this.phase) => {
            this.phase = p;
            this.phaseStart = now;
        };
        maps?.prefetch(this.toX, this.toZ, DEST_RADIUS);
        if (this.glide) maps?.prefetch((this.from.x + this.toX) / 2, (this.from.z + this.toZ) / 2, this.distance / 2 + 24);
        const destReady = () =>
            !maps ||
            (maps.ready(this.toX, this.toZ, DEST_RADIUS) &&
                (!this.glide || maps.ready((this.from.x + this.toX) / 2, (this.from.z + this.toZ) / 2, this.distance / 2 + 24)));

        switch (this.phase) {
            case "rise": {
                const k = ease(t(RISE_MS));
                this.apply(camera, this.mix(this.from, this.high, k));
                if (k >= 1) next("wait");
                break;
            }
            case "wait": {
                // Turn slowly while the destination loads, so the frame is alive and never black.
                this.high = { ...this.high, yaw: (this.high.yaw + 0.6) % 2048 };
                this.highDest.yaw = this.high.yaw;
                this.end.yaw = this.high.yaw;
                this.recomputeEnd();
                this.apply(camera, this.high);
                if (destReady() || now - this.phaseStart > WAIT_MAX_MS) next(this.glide ? "glide" : "warp");
                break;
            }
            case "glide": {
                const ms = Math.min(2200, 900 + this.distance * 7);
                const k = ease(t(ms));
                const p = this.mix(this.high, this.highDest, k);
                p.y -= Math.sin(Math.PI * k) * Math.min(24, this.distance * 0.12);
                this.apply(camera, p);
                if (k >= 1) next("descend");
                break;
            }
            case "warp": {
                const k = t(WARP_MS);
                const blur = Math.sin(Math.PI * k) * 14;
                if (this.canvas) this.canvas.style.filter = blur > 0.2 ? `blur(${blur.toFixed(1)}px) brightness(${(1 + blur / 40).toFixed(2)})` : "";
                if (k >= 0.5 && !this.warped) {
                    this.warped = true;
                    this.apply(camera, this.highDest);
                } else if (!this.warped) {
                    this.apply(camera, this.high);
                }
                if (k >= 1) {
                    if (this.canvas) this.canvas.style.filter = "";
                    next("descend");
                }
                break;
            }
            case "descend": {
                const k = ease(t(DESCEND_MS));
                this.apply(camera, this.mix(this.highDest, this.end, k));
                if (k >= 1) {
                    this.done = true;
                    return true;
                }
                break;
            }
        }
        return false;
    }

    cancel(): void {
        if (this.canvas) this.canvas.style.filter = "";
        this.done = true;
    }

    private recomputeEnd(): void {
        const yaw = (this.end.yaw - 1024) * RS_TO_RADIANS;
        const pitch = this.end.pitch * RS_TO_RADIANS;
        const d = Math.hypot(this.end.x - this.toX, this.end.z - this.toZ) / Math.max(0.001, Math.cos(pitch));
        this.end.x = this.toX + Math.cos(pitch) * Math.sin(yaw) * d;
        this.end.z = this.toZ + Math.cos(pitch) * Math.cos(yaw) * d;
        this.highDest.x = this.toX + (this.end.x - this.toX) * 1.6;
        this.highDest.z = this.toZ + (this.end.z - this.toZ) * 1.6;
    }

    private mix(a: Pose, b: Pose, k: number): Pose {
        return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k), yaw: lerpYaw(a.yaw, b.yaw, k), pitch: lerp(a.pitch, b.pitch, k) };
    }

    private apply(camera: Camera, p: Pose): void {
        camera.pos[0] = p.x;
        camera.pos[1] = p.y;
        camera.pos[2] = p.z;
        camera.yaw = Math.round(p.yaw) & 2047;
        camera.pitch = Math.round(p.pitch);
        camera.updated = true;
        camera.updatedPosition = true;
    }
}
