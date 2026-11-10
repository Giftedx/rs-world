import { Camera } from "../mapviewer/Camera";

// Camera flight to a followed player, so a follow change never cuts to an unloaded (black) area.
//   prep:    hold the old view until the squares around the destination are loaded. Capped, so a stuck
//            loader cannot hold the camera forever. Nothing loads around the start: no phase climbs there.
//   glide:   short hops (<= GLIDE_MAX tiles) fly straight across into the follow orbit.
//   warp:    long hops blur the canvas for a moment and move to a point just outside the orbit, because
//            the hundreds of tiles in between are not loaded and would draw black.
//   descend: settle from that point into the follow orbit around the player.

// The area a follow change waits for around the new player, and the area a prewarm loads: a prewarmed
// player needs no load.
export const WARM_RADIUS = 56;

export type MapAccess = {
    prefetch(tileX: number, tileZ: number, radiusTiles: number): void;
    ready(tileX: number, tileZ: number, radiusTiles: number): boolean;
    visibleMapCount: number;
    blankOnScreen: number;
};

type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };

const RS_TO_RADIANS = Math.PI / 1024;
const PREP_MAX_MS = 6000;
const WARP_MS = 300;
const DESCEND_MS = 450;
const GLIDE_MAX = 64;
// The warp lands this far out along the line from the player to the orbit pose.
const NEAR_SCALE = 1.35;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// Shortest way round for RS angles (0..2047).
const lerpYaw = (a: number, b: number, t: number) => {
    let d = ((b - a + 3072) % 2048) - 1024;
    return (a + d * t + 2048) % 2048;
};

export class CameraFlight {
    private phase: "prep" | "glide" | "warp" | "descend" = "prep";
    private phaseStart: number;
    private readonly from: Pose;
    private readonly near: Pose;
    private readonly end: Pose;
    readonly started: number;
    readonly distance: number;
    readonly glide: boolean;
    done = false;

    // True while the camera moves (not while it holds the old view for loading).
    get moving(): boolean {
        return this.phase !== "prep";
    }

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
        this.from = {
            x: camera.getPosX(),
            y: camera.pos[1],
            z: camera.getPosZ(),
            yaw: camera.yaw,
            pitch: camera.pitch,
        };
        this.distance = Math.hypot(toX - this.from.x, toZ - this.from.z);
        this.glide = this.distance <= GLIDE_MAX;
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
        this.near = {
            ...this.end,
            x: toX + (this.end.x - toX) * NEAR_SCALE,
            y: this.end.y * NEAR_SCALE,
            z: toZ + (this.end.z - toZ) * NEAR_SCALE,
        };
    }

    // Moves the camera for this frame. Returns true when the flight has ended.
    step(camera: Camera, maps: MapAccess | undefined): boolean {
        const now = performance.now();
        const t = (ms: number) => Math.min(1, (now - this.phaseStart) / ms);
        const next = (p: typeof this.phase) => {
            this.phase = p;
            this.phaseStart = now;
        };
        maps?.prefetch(this.toX, this.toZ, WARM_RADIUS);

        switch (this.phase) {
            case "prep": {
                this.apply(camera, this.from);
                if (
                    !maps ||
                    maps.ready(this.toX, this.toZ, WARM_RADIUS) ||
                    now - this.phaseStart > PREP_MAX_MS
                ) {
                    next(this.glide ? "glide" : "warp");
                }
                break;
            }
            case "glide": {
                const k = ease(t(Math.min(1400, 500 + this.distance * 6)));
                const p = this.mix(this.from, this.end, k);
                p.y -= Math.sin(Math.PI * k) * Math.min(10, this.distance * 0.1);
                this.apply(camera, p);
                if (k >= 1) {
                    this.done = true;
                    return true;
                }
                break;
            }
            case "warp": {
                const k = t(WARP_MS);
                const blur = Math.sin(Math.PI * k) * 14;
                if (this.canvas)
                    this.canvas.style.filter =
                        blur > 0.2
                            ? `blur(${blur.toFixed(1)}px) brightness(${(1 + blur / 40).toFixed(2)})`
                            : "";
                this.apply(camera, k >= 0.5 ? this.near : this.from);
                if (k >= 1) {
                    if (this.canvas) this.canvas.style.filter = "";
                    next("descend");
                }
                break;
            }
            case "descend": {
                const k = ease(t(DESCEND_MS));
                this.apply(camera, this.mix(this.near, this.end, k));
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

    private mix(a: Pose, b: Pose, k: number): Pose {
        return {
            x: lerp(a.x, b.x, k),
            y: lerp(a.y, b.y, k),
            z: lerp(a.z, b.z, k),
            yaw: lerpYaw(a.yaw, b.yaw, k),
            pitch: lerp(a.pitch, b.pitch, k),
        };
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
