import { Camera } from "../mapviewer/Camera";
import { TypeLoader } from "../rs/config/TypeLoader";
import { NpcTypeLoader } from "../rs/config/npctype/NpcTypeLoader";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { SpotAnimType } from "../rs/config/spotanimtype/SpotAnimType";
import { SeqFrameLoader } from "../rs/model/seq/SeqFrameLoader";
import { IndexedSprite } from "../rs/sprite/IndexedSprite";
import { LiveEntity, LivePlayer } from "./LiveEntity";
import { LiveWorld } from "./LiveWorld";
import { FeedStatus, WorldFeedClient } from "./WorldFeedClient";
import { WorldState } from "./WorldState";
import { FeedRoster, RosterPlayer } from "./protocol";
import {
    CLIENT,
    CLIENT_FOLLOW_DISTANCE,
    CLIENT_FOLLOW_PITCH,
    EMBED,
    EMBED_FOLLOW_DISTANCE,
    EMBED_FOLLOW_PITCH,
    FLIGHT,
    notifyCameraReleased,
    postTiming,
    resolveFollow,
} from "./embed";
import { CameraFlight, MapAccess } from "./CameraFlight";

// Tiles streamed around the camera; the engine caps a subscription at 384 x 384, which a radius
// of 188 plus the grid padding fills exactly. Past that, players come from the roster instead.
const MIN_AREA_RADIUS = 32;
export const MAX_AREA_RADIUS = 188;
// Re-subscribe only when the camera crosses an 8-tile grid line.
const AREA_GRID = 8;

// Follow is an orbit camera around the player's chest: rotating the camera (drag, arrow keys)
// circles the player, the wheel changes the distance, and moving the camera (WASD etc.) stops
// following. "Go to player" starts from the south-west, a little above.
const FOLLOW_YAW = 182;
const FOLLOW_PITCH = -185;
const FOLLOW_DISTANCE = 11;
const MIN_ORBIT_DISTANCE = 2;
const MAX_ORBIT_DISTANCE = 48;
const MIN_ORBIT_PITCH = -500;
const MAX_ORBIT_PITCH = -16;
// Orbit pivot above the player's feet, in fine units (a tile is 128).
const ORBIT_PIVOT_HEIGHT = 96;
const RS_TO_RADIANS = Math.PI / 1024;

export type LiveOptions = {
    showPlayers: boolean;
    showNpcs: boolean;
    showPlayerNames: boolean;
    showNpcNames: boolean;
    showChat: boolean;
    showCombat: boolean;
};

// Owns the world feed connection and the simulated entities, and drives "follow" camera mode.
// Created by MapViewer when a feed URL is configured (?live=ws://host:port/worldfeed).
export class LiveController {
    readonly world: LiveWorld;
    readonly feed: WorldFeedClient;
    readonly feedId: number;

    status: FeedStatus = "closed";
    error?: string;

    options: LiveOptions = {
        showPlayers: true,
        showNpcs: true,
        showPlayerNames: true,
        showNpcNames: false,
        // Chat bubbles are noise in the dashboard's small map window.
        showChat: !EMBED,
        showCombat: true,
    };

    // Player being followed: by slot once visible, by name while flying to them.
    followSlot: number = -1;
    followName?: string;
    // From ?follow=<name>: start following once the roster says where they are.
    pendingFollow?: string;
    // Orbit distance in tiles; 0 until the camera has been aimed at the player.
    private orbitDistance: number = 0;
    private lastRosterJumpTick: number = -1;

    // The Live panel's search. It lives here so the next/previous player keys step through the
    // list the panel shows, even with the UI hidden.
    playerFilter: string = "";
    private listed?: { roster: RosterPlayer[]; filter: string; players: RosterPlayer[] };

    private started: boolean = false;

    // Follow changes fly the camera (CameraFlight) instead of cutting; the renderer hands over map loading and
    // its canvas (for the warp blur).
    private flight?: CameraFlight;
    get inFlight(): boolean {
        return this.flight !== undefined;
    }
    maps?: MapAccess;
    canvas?: HTMLElement;
    // ?flight=0: time from a follow change until the destination squares are loaded.
    // A follow change being timed: until the flight has landed (or the jump is done) and nothing in view is blank.
    private timing?: { mode: "flight" | "snap"; start: number; tiles: number; frames: number; blankFrames: number; holdFrames: number };

    // Bumped on any change the UI should re-render for.
    version: number = 0;

    // The client's hitmark sprites (media archive "hitmarks"), indexed by damage type.
    hitmarkSprites: IndexedSprite[] = [];
    // The client's overhead icons (media archive "headicons"): prayers, skull, hint arrow.
    headIconSprites: IndexedSprite[] = [];

    constructor(
        readonly url: string,
        npcTypeLoader: NpcTypeLoader,
        seqTypeLoader: SeqTypeLoader,
        seqFrameLoader: SeqFrameLoader,
        spotAnimTypeLoader: TypeLoader<SpotAnimType> | undefined,
        readonly worldState?: WorldState,
        roster: boolean = true,
    ) {
        this.world = new LiveWorld(
            npcTypeLoader,
            seqTypeLoader,
            seqFrameLoader,
            spotAnimTypeLoader,
        );
        this.feedId = worldState?.newFeedId() ?? 0;
        this.feed = new WorldFeedClient(url, {
            onHello: (hello) => {
                this.world.clear();
                this.world.far.clear();
                // A new connection sends its area (za) and that area's state again.
                this.worldState?.onHello(this.feedId, hello.tick);
                this.version++;
            },
            onTick: (tick) => {
                this.world.applyTick(tick);
                if (tick.w) {
                    // A reset comes with its own za (r = 1).
                    this.worldState?.apply(this.feedId, tick.k, this.world, tick.w);
                }
                this.version++;
            },
            onRoster: (roster) => {
                this.world.applyRoster(roster);
                if (this.rosterListeners.length > 0) {
                    const full = this.rosterSnapshot();
                    if (full) {
                        for (const listener of this.rosterListeners) {
                            listener(full);
                        }
                    }
                }
                this.version++;
            },
            onStatus: (status, error) => {
                this.status = status;
                this.error = error;
                this.version++;
            },
        });
        // Multi-view panes share one roster subscription (see rosterListeners).
        this.feed.setRoster(roster);
    }

    rosterListeners: ((roster: FeedRoster) => void)[] = [];

    // The roster this controller holds, as a full roster message. The feed sends changes after the
    // first roster, so another pane's world can only take the whole list.
    rosterSnapshot(): FeedRoster | undefined {
        const world = this.world;
        if (world.rosterTick === -1) {
            return undefined;
        }
        return { t: "roster", k: world.rosterTick, p: world.rosterPlayers, npcs: world.rosterNpcCount };
    }

    // Largest feed area radius in tiles; multi-view panes ask for less than a full view.
    maxAreaRadius: number = MAX_AREA_RADIUS;
    // False in a multi-view pane: a follow change jumps there, with no flight and no timing report.
    flights: boolean = true;

    stop(): void {
        this.feed.close();
        this.world.clear();
        this.worldState?.dropFeed(this.feedId);
    }

    reconnect(): void {
        this.feed.reconnect();
    }

    // Called once per rendered frame with the 20ms client cycles that elapsed.
    update(
        clientCycles: number,
        camera: Camera,
        renderDistance: number,
        getGroundY: (e: LiveEntity) => number | undefined,
        getTileGroundY?: (level: number, fineX: number, fineZ: number) => number | undefined,
    ): void {
        // Connect on the first rendered frame, so viewers that never render never connect.
        if (!this.started) {
            this.started = true;
            this.feed.connect();
        }

        for (let i = 0; i < clientCycles; i++) {
            this.world.cycle();
        }

        this.resolvePending(camera, getTileGroundY);

        if (this.flight) {
            if (this.flight.step(camera, this.maps)) {
                this.flight = undefined;
                this.orbitDistance = defaultFollowDistance();
                this.updateFollow(camera, getGroundY, getTileGroundY);
            }
        } else {
            this.updateFollow(camera, getGroundY, getTileGroundY);
        }
        const tm = this.timing;
        if (tm && this.maps) {
            tm.frames++;
            const blank = this.maps.blankOnScreen > 0;
            // A flight holding still for loading shows the old view; only frames while moving count as its blanks.
            if (this.flight && !this.flight.moving) tm.holdFrames++;
            else if (blank) tm.blankFrames++;
            // The map manager counts blanks for the previous camera; give it 3 frames after the move.
            if (!this.flight && tm.frames > 3 && !blank) {
                postTiming(tm.mode, performance.now() - tm.start, tm.tiles, tm.frames, tm.blankFrames, tm.holdFrames);
                this.timing = undefined;
            }
        }

        if (!this.hasPlacedTarget()) {
            return;
        }
        // A flight holds the old view while the squares at the destination load (up to 6 s). The feed keeps the old
        // area until the camera moves, so the held view keeps its players, doors, fires and ground items. The new area
        // is asked for when the camera starts to move, 0.5 to 1.4 s before it arrives.
        if (this.flight && !this.flight.moving) {
            return;
        }

        // Seeing further than the engine will stream: the half behind the camera is mostly off
        // screen, so slide the area forward, up to half its size (less when looking down).
        const radius = clamp(renderDistance, MIN_AREA_RADIUS, this.maxAreaRadius);
        const followTarget = this.isFollowing() ? this.getTargetTile() : undefined;
        let centerX: number;
        let centerZ: number;
        if (followTarget) {
            centerX = followTarget[0];
            centerZ = followTarget[1];
        } else {
            const ahead =
                clamp(renderDistance - MAX_AREA_RADIUS, 0, MAX_AREA_RADIUS / 2) *
                Math.cos(camera.pitch * RS_TO_RADIANS);
            const yaw = (camera.yaw - 1024) * RS_TO_RADIANS;
            centerX = camera.getPosX() - Math.sin(yaw) * ahead;
            centerZ = camera.getPosZ() - Math.cos(yaw) * ahead;
        }
        const x0 = Math.floor((centerX - radius) / AREA_GRID) * AREA_GRID;
        const z0 = Math.floor((centerZ - radius) / AREA_GRID) * AREA_GRID;
        const size = Math.ceil((radius * 2) / AREA_GRID) * AREA_GRID + AREA_GRID;
        this.feed.setArea(x0, z0, size, size);
    }

    isFollowing(): boolean {
        return this.followName !== undefined;
    }

    // False while waiting on the roster to place an initial ?follow / multi-pane target,
    // so callers neither stream nor draw a stale template camera position.
    hasPlacedTarget(): boolean {
        return !(this.pendingFollow && !this.followName);
    }

    getTargetTile(): [number, number] | undefined {
        const player = this.getFollowed();
        if (player) {
            return [player.x / 128, player.z / 128];
        }
        if (this.followName) {
            const key = this.followName.toLowerCase();
            const entry = this.world.rosterPlayers.find((p) => p[1].toLowerCase() === key);
            if (entry) {
                return [entry[2] + 0.5, entry[3] + 0.5];
            }
        }
        return undefined;
    }

    resolvePending(
        camera: Camera,
        getTileGroundY?: (level: number, fineX: number, fineZ: number) => number | undefined,
    ): boolean {
        if (!this.pendingFollow || (this.world.rosterTick === -1 && this.world.players.size === 0)) {
            return false;
        }
        // The embedding page may ask for the hidden main account by marker; wait for the hidden list.
        const name = resolveFollow(this.pendingFollow);
        if (!name || !this.goToPlayer(name, camera, getTileGroundY)) {
            return false;
        }
        this.pendingFollow = undefined;
        return true;
    }

    // Follow a visible player: the camera turns to face them from where it is.
    follow(player: LivePlayer): void {
        this.followName = player.name;
        this.followSlot = player.id;
        this.orbitDistance = 0;
        this.version++;
    }

    // Fly to a player (they may be outside the streamed area, then the roster has them) and
    // keep following them. Returns true once a position was found and the camera placed/flown.
    goToPlayer(
        name: string,
        camera: Camera,
        getTileGroundY?: (level: number, fineX: number, fineZ: number) => number | undefined,
    ): boolean {
        const key = name.toLowerCase();
        const visible = this.world.findPlayer(name);
        const entry = this.world.rosterPlayers.find((p) => p[1].toLowerCase() === key);
        if (!visible && !entry) {
            return false;
        }
        const tileX = visible ? visible.x / 128 : entry![2] + 0.5;
        const tileZ = visible ? visible.z / 128 : entry![3] + 0.5;
        const level = visible ? visible.level : entry![4];
        const fineX = visible ? visible.x : entry![2] * 128 + 64;
        const fineZ = visible ? visible.z : entry![3] * 128 + 64;
        const groundY = getTileGroundY?.(level, fineX, fineZ);
        const initialTargetY = ((groundY ?? -level * 240) - ORBIT_PIVOT_HEIGHT) / 128;

        // Already following someone else: fly there. From free camera fly too, once the scene has squares to
        // hold on screen; the first follow of an empty scene (page load) jumps straight in.
        const fly = this.followName === undefined ? (this.maps?.visibleMapCount ?? 0) > 0 : this.followName.toLowerCase() !== key;
        if (FLIGHT && fly && this.flights) {
            this.flight?.cancel();
            const resolveFlightTarget = () => {
                const p = this.world.findPlayer(name);
                const r = p ? undefined : this.world.rosterPlayers.find((item) => item[1].toLowerCase() === key);
                if (!p && !r) {
                    return undefined;
                }
                const tx = p ? p.x / 128 : r![2] + 0.5;
                const tz = p ? p.z / 128 : r![3] + 0.5;
                const lvl = p ? p.level : r![4];
                const fx = p ? p.x : r![2] * 128 + 64;
                const fz = p ? p.z : r![3] * 128 + 64;
                const gy = getTileGroundY?.(lvl, fx, fz);
                return {
                    x: tx,
                    y: ((gy ?? -lvl * 240) - ORBIT_PIVOT_HEIGHT) / 128,
                    z: tz,
                };
            };
            this.flight = new CameraFlight(
                camera,
                tileX,
                tileZ,
                defaultFollowDistance(),
                defaultFollowPitch(),
                this.canvas,
                initialTargetY,
                resolveFlightTarget,
            );
            this.timing = { mode: "flight", start: performance.now(), tiles: this.flight.distance, frames: 0, blankFrames: 0, holdFrames: 0 };
            this.followName = name;
            this.followSlot = visible ? visible.id : -1;
            this.lastRosterJumpTick = this.world.rosterTick;
            this.version++;
            return true;
        }
        if (this.followName !== undefined && this.flights) {
            this.timing = { mode: "snap", start: performance.now(), tiles: Math.hypot(tileX - camera.getPosX(), tileZ - camera.getPosZ()), frames: 0, blankFrames: 0, holdFrames: 0 };
        }
        this.flyTo(camera, tileX, tileZ, level, groundY);
        this.followName = name;
        this.followSlot = visible ? visible.id : -1;
        this.lastRosterJumpTick = this.world.rosterTick;
        this.version++;
        return true;
    }

    // Online players matching the panel's search, by name.
    listPlayers(): RosterPlayer[] {
        const roster = this.world.rosterPlayers;
        const filter = this.playerFilter.trim().toLowerCase();
        if (this.listed?.roster !== roster || this.listed.filter !== filter) {
            const players = roster
                .filter((p) => !filter || p[1].toLowerCase().includes(filter))
                .sort((a, b) => a[1].localeCompare(b[1]));
            this.listed = { roster, filter, players };
        }
        return this.listed.players;
    }

    // Go to the listed player after (step 1) or before (step -1) the followed one, wrapping
    // around. Without one, start at that end of the list.
    followAdjacent(step: 1 | -1, camera: Camera): void {
        const players = this.listPlayers();
        if (players.length === 0) {
            return;
        }
        let index = step > 0 ? -1 : players.length;
        const followed = this.followName;
        if (followed) {
            const name = followed.toLowerCase();
            index = players.findIndex((p) => p[1].toLowerCase() === name);
            if (index === -1) {
                // Not listed (logged out, or filtered away): step from where they'd sort.
                const after = players.findIndex((p) => p[1].localeCompare(followed) > 0);
                const insertAt = after === -1 ? players.length : after;
                index = step > 0 ? insertAt - 1 : insertAt;
            }
        }
        const next = players[(index + step + players.length) % players.length];
        this.goToPlayer(next[1], camera);
    }

    unfollow(byUser: boolean = false): void {
        this.flight?.cancel();
        this.flight = undefined;
        const wasFollowing = this.followName !== undefined || (byUser && this.pendingFollow !== undefined);
        if (byUser) {
            this.pendingFollow = undefined;
        }
        if (!wasFollowing) {
            return;
        }
        this.followSlot = -1;
        this.followName = undefined;
        this.lastRosterJumpTick = -1;
        this.orbitDistance = 0;
        this.version++;
        if (byUser) {
            notifyCameraReleased();
        }
    }

    // Mouse wheel while following: zoom the orbit in or out.
    zoom(wheelDelta: number): void {
        if (wheelDelta === 0 || this.orbitDistance === 0) {
            return;
        }
        this.orbitDistance = clamp(
            this.orbitDistance * Math.exp(wheelDelta * 0.0015),
            MIN_ORBIT_DISTANCE,
            MAX_ORBIT_DISTANCE,
        );
    }

    getFollowed(): LivePlayer | undefined {
        if (this.followSlot !== -1) {
            return this.world.players.get(this.followSlot);
        }
        return undefined;
    }

    // Plane of the followed player: from the feed once visible, else from the roster.
    getFollowedLevel(): number | undefined {
        if (!this.followName) {
            return undefined;
        }
        const player = this.getFollowed();
        if (player) {
            return player.level;
        }
        const name = this.followName.toLowerCase();
        return this.world.rosterPlayers.find((p) => p[1].toLowerCase() === name)?.[4];
    }

    // Puts the orbit's default view on a tile, so the area streams in before the player is found.
    private flyTo(camera: Camera, tileX: number, tileZ: number, level: number = 0, groundY?: number): void {
        const distance = defaultFollowDistance();
        const pitch = defaultFollowPitch();
        camera.yaw = FOLLOW_YAW;
        camera.pitch = pitch;
        this.orbitDistance = distance;
        const targetY = ((groundY ?? -level * 240) - ORBIT_PIVOT_HEIGHT) / 128;
        placeOrbitCamera(camera, tileX, targetY, tileZ, distance);
    }

    private updateFollow(
        camera: Camera,
        getGroundY: (e: LiveEntity) => number | undefined,
        getTileGroundY?: (level: number, fineX: number, fineZ: number) => number | undefined,
    ): void {
        if (!this.followName) {
            return;
        }

        let player = this.getFollowed();
        if (player && player.name.toLowerCase() !== this.followName.toLowerCase()) {
            // Slot reused by someone else.
            player = undefined;
        }
        if (!player) {
            this.followSlot = -1;
            player = this.world.findPlayer(this.followName);
            if (player) {
                this.followSlot = player.id;
                this.version++;
            }
        }
        if (!player) {
            const name = this.followName.toLowerCase();
            const entry = this.world.rosterPlayers.find((p) => p[1].toLowerCase() === name);
            if (!entry) {
                return;
            }
            const tileX = entry[2] + 0.5;
            const tileZ = entry[3] + 0.5;
            const level = entry[4];
            const tileGroundY = getTileGroundY?.(level, entry[2] * 128 + 64, entry[3] * 128 + 64);
            // Not streamed here (teleported, or we haven't arrived): jump to where the roster has
            // them, at most once per roster update.
            if (
                this.world.rosterTick !== this.lastRosterJumpTick &&
                (Math.abs(tileX - camera.getPosX()) > 32 || Math.abs(tileZ - camera.getPosZ()) > 32)
            ) {
                this.lastRosterJumpTick = this.world.rosterTick;
                this.flyTo(camera, tileX, tileZ, level, tileGroundY);
                return;
            }
            this.lastRosterJumpTick = this.world.rosterTick;
            // Refine height once the destination square's heightmap is available so the camera sits above
            // elevated rooms/hills while the entity stream catches up.
            if (this.orbitDistance > 0 && tileGroundY !== undefined) {
                const targetY = (tileGroundY - ORBIT_PIVOT_HEIGHT) / 128;
                camera.pitch = clamp(camera.pitch, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH);
                placeOrbitCamera(camera, tileX, targetY, tileZ, this.orbitDistance);
            }
            return;
        }

        const groundY = getGroundY(player);
        if (groundY === undefined && this.orbitDistance === 0 && !EMBED && !CLIENT) {
            // Standalone aim-from-current-camera waits for ground height so pitch angle doesn't snap.
            return;
        }
        const resolvedGroundY = groundY ?? -player.level * 240;
        const targetX = player.x / 128;
        const targetY = (resolvedGroundY - ORBIT_PIVOT_HEIGHT) / 128;
        const targetZ = player.z / 128;

        if (this.orbitDistance === 0) {
            // Just started following: face the player from where the camera is.
            const dx = targetX - camera.getPosX();
            const dy = targetY - camera.getPosY();
            const dz = targetZ - camera.getPosZ();
            const distance = Math.hypot(dx, dy, dz);
            this.orbitDistance = clamp(distance, MIN_ORBIT_DISTANCE, MAX_ORBIT_DISTANCE);
            camera.yaw = Math.round((Math.atan2(dx, dz) * 1024) / Math.PI) & 2047;
            camera.pitch = Math.round(
                Math.asin(clamp(-dy / Math.max(distance, 0.001), -1, 1)) / RS_TO_RADIANS,
            );
            if (EMBED || CLIENT) {
                // Same framing for every followed bot, wherever the camera came from.
                this.orbitDistance = defaultFollowDistance();
                camera.pitch = defaultFollowPitch();
            }
        }

        camera.pitch = clamp(camera.pitch, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH);
        placeOrbitCamera(camera, targetX, targetY, targetZ, this.orbitDistance);
    }
}

// Camera.update: yaw 0 faces north (+z), negative pitch looks down, and the view direction is
// (-cos(p) sin(t), -sin(p), -cos(p) cos(t)) with t = (yaw - 1024) and p = pitch in RS angle units.
function placeOrbitCamera(camera: Camera, x: number, y: number, z: number, distance: number): void {
    const yaw = (camera.yaw - 1024) * RS_TO_RADIANS;
    const pitch = camera.pitch * RS_TO_RADIANS;
    camera.pos[0] = x + Math.cos(pitch) * Math.sin(yaw) * distance;
    camera.pos[1] = y + Math.sin(pitch) * distance;
    camera.pos[2] = z + Math.cos(pitch) * Math.cos(yaw) * distance;
    camera.updated = true;
    camera.updatedPosition = true;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function defaultFollowDistance(): number {
    return EMBED ? EMBED_FOLLOW_DISTANCE : CLIENT ? CLIENT_FOLLOW_DISTANCE : FOLLOW_DISTANCE;
}

function defaultFollowPitch(): number {
    return EMBED ? EMBED_FOLLOW_PITCH : CLIENT ? CLIENT_FOLLOW_PITCH : FOLLOW_PITCH;
}

export function getDefaultFeedUrl(): string | undefined {
    const configured = process.env.REACT_APP_WORLD_FEED_URL;
    if (configured) {
        return configured;
    }
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        return "ws://localhost:8888/worldfeed";
    }
    return undefined;
}
