import { OTHER_NAME_ALPHA, isNameHidden, isNameHighlighted } from "./embed";
import { vec4 } from "gl-matrix";

import { Camera } from "../mapviewer/Camera";
import { IndexedSprite } from "../rs/sprite/IndexedSprite";
import { LiveController } from "./LiveController";
import { LiveEntity, LiveNpc, LivePlayer } from "./LiveEntity";
import { FarPlayerLabel } from "./LiveEntityRenderer";
import { clipSegment, groundColour, markers, shortValue } from "./Markers";

// What the markers layer needs from the renderer: the ground height at a fine position on a level, and an item name.
export type OverlayExtra = {
    groundAt: (fineX: number, fineZ: number, level: number) => number | undefined;
    objName: (id: number) => string | undefined;
};

// Markers are drawn this close to the camera (tiles).
const MARKER_DISTANCE = 64;

// Chat, combat and npc names are only drawn this close to the camera (tiles), so busy areas stay
// readable. Player names go as far as players are drawn, fading into the fog with them.
const LABEL_DISTANCE = 40;
// The shaders' fog edge rounding (FOG_CORNER_ROUNDING), in tiles.
const FOG_CORNER_ROUNDING = 8;

// Label decluttering: screen space is split into cells; a name or chat line is only drawn if
// its cells are free, nearest entities first. Chat may move up a line or two, like the client
// stacks overlapping chat, before it's dropped.
const GRID_CELL = 8;
const CHAT_LINE = 16;
const CHAT_MAX_SHIFTS = 2;

// Overhead chat colours 0-5 from the client (yellow, red, green, cyan, purple, white); 6-11
// flash/glow and are approximated by cycling.
const CHAT_COLOURS = ["#ffff00", "#ff0000", "#00ff00", "#00ffff", "#ff00ff", "#ffffff"];
const FLASH_COLOURS = ["#ff0000", "#00ff00", "#00ffff"];

// Where the client puts each of an entity's 4 hitmark slots, relative to its mid-height.
const HITMARK_OFFSETS: [number, number][] = [
    [0, 0],
    [0, -20],
    [-15, -10],
    [15, -10],
];

// Overhead icons stack in 25px steps, from 30px above the health bar anchor, like the client.
const HEAD_ICON_STEP = 25;

type ScreenPos = { x: number; y: number };

type OverlayEntity = {
    e: LiveEntity;
    distance: number;
    followed: boolean;
    top: ScreenPos;
    head: ScreenPos;
    name?: string;
    nameColour: string;
    nameAlpha: number;
    nameY: number;
    chatY?: number;
    combat: boolean;
    hitmarks: boolean;
    // headicons sprite indices, top to bottom.
    headIcons: number[];
};

type FarName = {
    name: string;
    alpha: number;
    distance: number;
    top: ScreenPos;
    placed: boolean;
};

// Draws names, overhead chat, hitsplats and health bars on a 2D canvas over the GL view,
// projected with the same camera matrices as the frame that was just rendered.
export class LiveOverlay {
    readonly canvas: HTMLCanvasElement;
    readonly ctx: CanvasRenderingContext2D;

    private clip = vec4.create();

    // The cache's hitmark sprites as canvases, rebuilt when the controller's sprites change.
    private hitmarkSource?: IndexedSprite[];
    private hitmarks: HTMLCanvasElement[] = [];
    private headIconSource?: IndexedSprite[];
    private headIcons: HTMLCanvasElement[] = [];

    private grid: Uint8Array = new Uint8Array(0);
    private gridCols: number = 0;
    private gridRows: number = 0;
    private textWidths: Map<string, number> = new Map();

    // Scratch pools reused every frame to eliminate per-entity GC allocations in single and multi-view.
    private npcMarked: Map<LiveEntity, string> = new Map();
    private objCounts: Map<number, number> = new Map();
    private overlayPool: OverlayEntity[] = [];
    private overlays: OverlayEntity[] = [];
    private overlayUsed: number = 0;
    private farNamePool: FarName[] = [];
    private farNames: FarName[] = [];
    private farNameUsed: number = 0;
    private scratchIcons: number[] = [];
    private topTemp: ScreenPos = { x: 0, y: 0 };
    private headTemp: ScreenPos = { x: 0, y: 0 };
    private hitPos: ScreenPos = { x: 0, y: 0 };
    private lineMidPt: ScreenPos = { x: 0, y: 0 };
    private tilePts: ScreenPos[] = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
    ];
    private clipScratch: [number, number, number, number] = [0, 0, 0, 0];

    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "live-overlay";
        this.ctx = this.canvas.getContext("2d")!;
    }

    dispose(): void {
        this.canvas.width = 0;
        this.canvas.height = 0;
        this.textWidths.clear();
        this.npcMarked.clear();
        this.objCounts.clear();
        this.overlays.length = 0;
        this.overlayPool.length = 0;
        this.farNames.length = 0;
        this.farNamePool.length = 0;
        this.hitmarks.length = 0;
        this.headIcons.length = 0;
        this.hitmarkSource = undefined;
        this.headIconSource = undefined;
        this.grid = new Uint8Array(0);
        this.gridCols = 0;
        this.gridRows = 0;
    }

    private collectEntity(
        e: LiveEntity,
        isPlayer: boolean,
        controller: LiveController,
        camera: Camera,
        getGroundY: (e: LiveEntity) => number | undefined,
        maxLevel: number,
        renderDistance: number,
        fogDepth: number,
        width: number,
        height: number,
        followed: LivePlayer | undefined,
        loopCycle: number,
    ): void {
        if (e.level > maxLevel) {
            return;
        }
        const { options } = controller;
        const dx = e.x / 128 - camera.getPosX();
        const dz = e.z / 128 - camera.getPosZ();
        const isFollowed = e === followed;
        const near = isFollowed || (Math.abs(dx) <= LABEL_DISTANCE && Math.abs(dz) <= LABEL_DISTANCE);
        const nameAlpha = isFollowed ? 1 : getFogVisibility(dx, dz, renderDistance, fogDepth);

        // An npc's mark decides whether its name shows; a player's mark only colours a name that shows anyway, so it is
        // looked up after the early returns below (a player in the fog draws nothing).
        const npcMark = isPlayer ? undefined : this.npcMarked.get(e);
        const showName =
            nameAlpha > 0 &&
            (isFollowed || (isPlayer ? options.showPlayerNames : (options.showNpcNames || !!npcMark) && near));
        // Same windows as the client: health bar for 300 cycles after a hit, hitmarks 70.
        const combat = near && options.showCombat && e.combatCycle > loopCycle + 100 && e.totalHealth > 0;
        const chat = near && options.showChat && e.chatMessage !== null && e.chatTimer > 0;
        const hitmarks = near && options.showCombat && hasActiveHitmark(e, loopCycle);
        const icons = this.scratchIcons;
        icons.length = 0;
        if (near) {
            fillHeadIcons(e, icons);
        }
        if (!showName && !combat && !chat && !hitmarks && icons.length === 0) {
            return;
        }

        const groundY = getGroundY(e);
        if (groundY === undefined) {
            return;
        }
        const marked = isPlayer ? markers.playerColour(e.getName()) : npcMark;
        // The client anchors the health bar 15 units above the head and chat at the head.
        if (
            !this.project(camera, e.x, groundY - e.height - 15, e.z, width, height, this.topTemp) ||
            !this.project(camera, e.x, groundY - e.height, e.z, width, height, this.headTemp)
        ) {
            return;
        }

        let item = this.overlayPool[this.overlayUsed];
        if (!item) {
            item = {
                e,
                distance: 0,
                followed: false,
                top: { x: 0, y: 0 },
                head: { x: 0, y: 0 },
                name: undefined,
                nameColour: "#ffffff",
                nameAlpha: 1,
                nameY: 0,
                chatY: undefined,
                combat: false,
                hitmarks: false,
                headIcons: [],
            };
            this.overlayPool.push(item);
        }
        this.overlayUsed++;
        item.e = e;
        item.distance = dx * dx + dz * dz;
        item.followed = isFollowed;
        item.top.x = this.topTemp.x;
        item.top.y = this.topTemp.y;
        item.head.x = this.headTemp.x;
        item.head.y = this.headTemp.y;
        item.name =
            showName && !(isPlayer && isNameHidden(e.getName()))
                ? isPlayer
                    ? e.getName()
                    : formatNpcName(e as LiveNpc)
                : undefined;
        item.nameColour = isFollowed
            ? "#ff981f"
            : marked
              ? marked
              : isPlayer && isNameHighlighted(e.getName())
                ? "#ffc21a"
                : isPlayer
                  ? "#ffffff"
                  : "#ffff00";
        item.nameAlpha =
            isFollowed || !isPlayer || !!marked || isNameHighlighted(e.getName())
                ? nameAlpha
                : nameAlpha * OTHER_NAME_ALPHA;
        item.nameY = item.top.y - 8;
        item.chatY = chat ? item.head.y : undefined;
        item.combat = combat;
        item.hitmarks = hitmarks;
        item.headIcons.length = 0;
        for (let i = 0; i < icons.length; i++) {
            item.headIcons.push(icons[i]);
        }
        this.overlays.push(item);
    }

    draw(
        controller: LiveController,
        camera: Camera,
        getGroundY: (e: LiveEntity) => number | undefined,
        maxLevel: number,
        renderDistance: number,
        fogDepth: number,
        farLabels: FarPlayerLabel[],
        extra?: OverlayExtra,
    ): void {
        const canvas = this.canvas;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (width <= 0 || height <= 0) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.max(1, Math.round(width * dpr));
        const targetH = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
        }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;

        const { options, world } = controller;
        const loopCycle = world.loopCycle;
        const followed = controller.getFollowed();

        // Npcs that the page marked: their names show in the mark colour.
        const npcMarked = this.npcMarked;
        npcMarked.clear();
        if (markers.npcs.length > 0) {
            for (const [nid, n] of world.npcs) {
                const colour = markers.npcColour(nid, n.npcType?.id ?? -1);
                if (colour) npcMarked.set(n, colour);
            }
        }

        // 1. What each nearby entity wants drawn, and where.
        const overlays = this.overlays;
        overlays.length = 0;
        this.overlayUsed = 0;
        if (options.showPlayers) {
            for (const p of world.players.values()) {
                this.collectEntity(
                    p,
                    true,
                    controller,
                    camera,
                    getGroundY,
                    maxLevel,
                    renderDistance,
                    fogDepth,
                    width,
                    height,
                    followed,
                    loopCycle,
                );
            }
        }
        if (options.showNpcs) {
            for (const n of world.npcs.values()) {
                this.collectEntity(
                    n,
                    false,
                    controller,
                    camera,
                    getGroundY,
                    maxLevel,
                    renderDistance,
                    fogDepth,
                    width,
                    height,
                    followed,
                    loopCycle,
                );
            }
        }

        // Players drawn from the roster outside the streamed area only have a name.
        const farNames = this.farNames;
        farNames.length = 0;
        this.farNameUsed = 0;
        if (options.showPlayerNames) {
            for (let i = 0; i < farLabels.length; i++) {
                const p = farLabels[i];
                const dx = p.x / 128 - camera.getPosX();
                const dz = p.z / 128 - camera.getPosZ();
                const alpha = getFogVisibility(dx, dz, renderDistance, fogDepth);
                if (alpha <= 0 || isNameHidden(p.name)) {
                    continue;
                }
                if (!this.project(camera, p.x, p.groundY - p.height - 15, p.z, width, height, this.topTemp)) {
                    continue;
                }
                let entry = this.farNamePool[this.farNameUsed];
                if (!entry) {
                    entry = { name: p.name, alpha, distance: 0, top: { x: 0, y: 0 }, placed: false };
                    this.farNamePool.push(entry);
                }
                this.farNameUsed++;
                entry.name = p.name;
                entry.alpha = alpha;
                entry.distance = dx * dx + dz * dz;
                entry.top.x = this.topTemp.x;
                entry.top.y = this.topTemp.y;
                entry.placed = false;
                farNames.push(entry);
            }
        }

        // 2. Place labels: followed first, then nearest. Chat outranks names, and the streamed
        // area's names outrank the roster's, which are further away.
        overlays.sort(compareOverlayDistance);
        this.resetGrid(width, height);
        for (let i = 0; i < overlays.length; i++) {
            const o = overlays[i];
            if (o.chatY === undefined) {
                continue;
            }
            const half = this.measure("bold", o.e.chatMessage ?? "") / 2;
            let placed: number | undefined;
            for (let shift = 0; shift <= CHAT_MAX_SHIFTS && placed === undefined; shift++) {
                const y = o.chatY - shift * CHAT_LINE;
                if (this.occupy(o.head.x - half, y - 13, o.head.x + half, y + 2, o.followed)) {
                    placed = y;
                }
            }
            o.chatY = placed;
        }
        for (let i = 0; i < overlays.length; i++) {
            const o = overlays[i];
            if (!o.name) {
                continue;
            }
            if (o.chatY !== undefined) {
                o.nameY = Math.min(o.nameY, o.chatY - CHAT_LINE);
            }
            const half = this.measure("plain", o.name) / 2;
            if (!this.occupy(o.top.x - half, o.nameY - 12, o.top.x + half, o.nameY + 2, o.followed)) {
                o.name = undefined;
            }
        }
        farNames.sort(compareFarDistance);
        for (let i = 0; i < farNames.length; i++) {
            const n = farNames[i];
            const half = this.measure("plain", n.name) / 2;
            const y = n.top.y - 8;
            n.placed = this.occupy(n.top.x - half, y - 12, n.top.x + half, y + 2, false);
        }

        // 3. Draw back to front: markers on the ground, names, health bars, hitmarks, then chat on top like the client.
        if (extra) {
            this.drawMarkers(controller, camera, extra, maxLevel, width, height, npcMarked);
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = "16px 'OSRS Small', sans-serif";
        for (let i = farNames.length - 1; i >= 0; i--) {
            const n = farNames[i];
            if (n.placed) {
                // A marked player keeps its mark colour outside the streamed area too.
                const ours = isNameHighlighted(n.name);
                const marked = markers.playerColour(n.name);
                this.drawText(
                    n.name,
                    n.top.x,
                    n.top.y - 8,
                    marked ?? (ours ? "#ffc21a" : "#ffffff"),
                    marked || ours ? n.alpha : n.alpha * OTHER_NAME_ALPHA,
                );
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.name) {
                this.drawText(o.name, o.top.x, o.nameY, o.nameColour, o.nameAlpha);
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.headIcons.length > 0) {
                this.drawHeadIcons(controller, o);
            }
        }
        // Batch green health fills and red remainders to minimize fillStyle state changes.
        let anyCombat = false;
        ctx.fillStyle = "#00ff00";
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (!o.combat) continue;
            anyCombat = true;
            const fill = Math.min(((o.e.health * 30) / o.e.totalHealth) | 0, 30);
            if (fill > 0) {
                ctx.fillRect(Math.round(o.top.x) - 15, Math.round(o.top.y) - 3, fill, 5);
            }
        }
        if (anyCombat) {
            ctx.fillStyle = "#ff0000";
            for (let i = overlays.length - 1; i >= 0; i--) {
                const o = overlays[i];
                if (!o.combat) continue;
                const fill = Math.min(((o.e.health * 30) / o.e.totalHealth) | 0, 30);
                if (fill < 30) {
                    ctx.fillRect(Math.round(o.top.x) - 15 + fill, Math.round(o.top.y) - 3, 30 - fill, 5);
                }
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.hitmarks) {
                const groundY = getGroundY(o.e)!;
                if (this.project(camera, o.e.x, groundY - o.e.height / 2, o.e.z, width, height, this.hitPos)) {
                    this.drawHitmarks(controller, o.e, this.hitPos, loopCycle);
                }
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.chatY !== undefined) {
                this.drawChat(o.e, o.head.x, o.chatY, loopCycle);
            }
        }
    }

    // The markers layer (Markers.ts): lines and tile outlines on the ground, the tiles under marked npcs and players,
    // respawn pies, and floor item labels with their value. A point is projected at the ground height of its tile.
    private drawMarkers(
        controller: LiveController,
        camera: Camera,
        extra: OverlayExtra,
        maxLevel: number,
        width: number,
        height: number,
        npcMarked: Map<LiveEntity, string>,
    ): void {
        const ctx = this.ctx;
        const cx = camera.getPosX();
        const cz = camera.getPosZ();
        const near = (x: number, z: number, d: number = MARKER_DISTANCE) => Math.abs(x - cx) <= d && Math.abs(z - cz) <= d;
        const point = (tx: number, tz: number, l: number, out: ScreenPos): ScreenPos | undefined => {
            const fx = Math.round(tx * 128);
            const fz = Math.round(tz * 128);
            const y = extra.groundAt(fx, fz, l);
            return y === undefined ? undefined : this.project(camera, fx, y, fz, width, height, out);
        };
        const c = this.tilePts;
        const tile = (x: number, z: number, l: number, size: number, colour: string, fill: boolean, text?: string) => {
            if (
                !point(x, z, l, c[0]) ||
                !point(x + size, z, l, c[1]) ||
                !point(x + size, z + size, l, c[2]) ||
                !point(x, z + size, l, c[3])
            ) {
                return;
            }
            ctx.beginPath();
            ctx.moveTo(c[0].x, c[0].y);
            ctx.lineTo(c[1].x, c[1].y);
            ctx.lineTo(c[2].x, c[2].y);
            ctx.lineTo(c[3].x, c[3].y);
            ctx.closePath();
            if (fill) {
                ctx.globalAlpha = 0.25;
                ctx.fillStyle = colour;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            ctx.strokeStyle = colour;
            ctx.stroke();
            if (text) {
                const mid = point(x + size / 2, z + size / 2, l, this.lineMidPt);
                if (mid) this.drawText(text, mid.x, mid.y - 6, colour);
            }
        };
        // No floor limit (Follow Level off) draws every floor, as the entities do.
        const top = Number.isFinite(maxLevel) ? maxLevel : 3;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.textAlign = "center";
        ctx.font = "16px 'OSRS Small', sans-serif";
        // Lines follow the ground: the part within MARKER_DISTANCE of the camera, one point a tile.
        for (const line of markers.lines) {
            if (line.l > top) continue;
            const seg = clipSegment(
                line.x0,
                line.z0,
                line.x1,
                line.z1,
                cx - MARKER_DISTANCE,
                cz - MARKER_DISTANCE,
                cx + MARKER_DISTANCE,
                cz + MARKER_DISTANCE,
                this.clipScratch,
            );
            if (!seg) continue;
            const x0 = seg[0];
            const z0 = seg[1];
            const x1 = seg[2];
            const z1 = seg[3];
            const steps = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0))));
            ctx.strokeStyle = line.colour;
            ctx.beginPath();
            let open = false;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const p = point(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, line.l, this.lineMidPt);
                if (!p) {
                    open = false;
                    continue;
                }
                if (open) ctx.lineTo(p.x, p.y);
                else ctx.moveTo(p.x, p.y);
                open = true;
            }
            ctx.stroke();
            if (line.label) {
                const mid = point((x0 + x1) / 2, (z0 + z1) / 2, line.l, this.lineMidPt);
                if (mid) this.drawText(line.label, mid.x, mid.y - 4, line.colour);
            }
        }
        for (const t of markers.tiles) {
            if (t.l <= top && near(t.x, t.z)) tile(t.x, t.z, t.l, t.size, t.colour, !!t.fill, t.label);
        }
        for (const [n, colour] of npcMarked) {
            const size = n.size || 1;
            const x = n.x / 128 - size / 2;
            const z = n.z / 128 - size / 2;
            if (n.level <= top && near(x, z)) tile(x, z, n.level, size, colour, false);
        }
        if (markers.players.size > 0) {
            for (const p of controller.world.players.values()) {
                const colour = markers.playerColour(p.getName());
                const x = p.x / 128 - 0.5;
                const z = p.z / 128 - 0.5;
                if (colour && p.level <= top && near(x, z)) tile(x, z, p.level, 1, colour, false);
            }
        }
        // Pies: green fills as the rock or tree comes back, over red, as the Mining plugin draws them.
        for (const pie of markers.pies) {
            if (pie.l > top || !near(pie.x, pie.z)) continue;
            const center = point(pie.x + 0.5, pie.z + 0.5, pie.l, this.lineMidPt);
            if (!center) continue;
            const r = 8;
            const y = center.y - 24;
            ctx.beginPath();
            ctx.arc(center.x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = "#ff0000";
            ctx.fill();
            if (pie.p > 0) {
                ctx.beginPath();
                ctx.moveTo(center.x, y);
                ctx.arc(center.x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pie.p);
                ctx.closePath();
                ctx.fillStyle = "#00ff00";
                ctx.fill();
            }
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#000000";
            ctx.beginPath();
            ctx.arc(center.x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 2;
        }
        // Floor item labels: one line a kind of item on the tile, the value from the page's prices, in RuneLite's tiers.
        const state = controller.worldState;
        if (markers.groundOn && state) {
            const counts = this.objCounts;
            for (const t of state.objTiles.values()) {
                if (t.level > top || !near(t.x, t.z, LABEL_DISTANCE)) continue;
                const center = point(t.x + 0.5, t.z + 0.5, t.level, this.lineMidPt);
                if (!center) continue;
                counts.clear();
                for (const o of t.objs) counts.set(o.id, (counts.get(o.id) ?? 0) + o.count);
                let y = center.y - 6;
                for (const [id, count] of counts) {
                    const name = extra.objName(id);
                    if (!name) continue;
                    const lower = name.toLowerCase();
                    const price = markers.groundPrices.get(lower) ?? (lower === "coins" ? 1 : undefined);
                    const value = price === undefined ? undefined : price * count;
                    if (value !== undefined && value < markers.groundMin) continue;
                    const text = name + (count > 1 ? " (" + count + ")" : "") + (value !== undefined ? " (" + shortValue(value) + " gp)" : "");
                    this.drawText(text, center.x, y, value === undefined ? "#ffffff" : groundColour(value));
                    y -= 14;
                }
            }
        }
        ctx.restore();
    }

    private resetGrid(width: number, height: number): void {
        const cols = Math.ceil(width / GRID_CELL);
        const rows = Math.ceil(height / GRID_CELL);
        if (cols !== this.gridCols || rows !== this.gridRows) {
            this.gridCols = cols;
            this.gridRows = rows;
            this.grid = new Uint8Array(cols * rows);
        } else {
            this.grid.fill(0);
        }
    }

    // Claims the cells under a screen rect; false (claiming nothing) if any are taken, unless forced.
    private occupy(x0: number, y0: number, x1: number, y1: number, force: boolean): boolean {
        const c0 = Math.max(0, Math.floor(x0 / GRID_CELL));
        const c1 = Math.min(this.gridCols - 1, Math.floor(x1 / GRID_CELL));
        const r0 = Math.max(0, Math.floor(y0 / GRID_CELL));
        const r1 = Math.min(this.gridRows - 1, Math.floor(y1 / GRID_CELL));
        if (!force) {
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    if (this.grid[r * this.gridCols + c]) {
                        return false;
                    }
                }
            }
        }
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                this.grid[r * this.gridCols + c] = 1;
            }
        }
        return true;
    }

    private measure(font: "plain" | "bold", text: string): number {
        const key = font + text;
        let width = this.textWidths.get(key);
        if (width === undefined) {
            if (this.textWidths.size > 4096) {
                this.textWidths.clear();
            }
            const ctx = this.ctx;
            const previous = ctx.font;
            ctx.font = font === "bold" ? "16px 'OSRS Bold', sans-serif" : "16px 'OSRS Small', sans-serif";
            width = ctx.measureText(text).width;
            ctx.font = previous;
            this.textWidths.set(key, width);
        }
        return width;
    }

    private drawChat(e: LiveEntity, x: number, y: number, loopCycle: number): void {
        const ctx = this.ctx;
        const text = e.chatMessage ?? "";
        ctx.font = "16px 'OSRS Bold', sans-serif";
        let colour = CHAT_COLOURS[0];
        if (e.chatColour < CHAT_COLOURS.length) {
            colour = CHAT_COLOURS[e.chatColour];
        } else {
            // flash1-3 / glow1-3: cycle through a few colours like the client's animated text.
            const phase = Math.floor(loopCycle / 10) % 3;
            colour = FLASH_COLOURS[phase];
        }

        if (e.chatEffect === 1) {
            // wave: per-character vertical sine, as the client draws it.
            const width = this.measure("bold", text);
            let cx = x - width / 2;
            ctx.textAlign = "left";
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const dy = Math.sin(i / 2 + loopCycle / 5) * 2;
                this.drawText(ch, cx, y + dy, colour);
                cx += this.measure("bold", ch);
            }
            ctx.textAlign = "center";
            return;
        }
        this.drawText(text, x, y, colour);
    }

    // Client.drawEntityOverlays: sprite at (x - 12, y - 12), damage in the 11px font centred
    // at y + 4 in black, then one pixel up and left in white.
    private drawHitmarks(controller: LiveController, e: LiveEntity, pos: ScreenPos, loopCycle: number): void {
        const ctx = this.ctx;
        ctx.font = "16px 'OSRS Small', sans-serif";
        for (let i = 0; i < 4; i++) {
            if (e.damageCycles[i] <= loopCycle) {
                continue;
            }
            const [ox, oy] = HITMARK_OFFSETS[i];
            const x = Math.round(pos.x) + ox;
            const y = Math.round(pos.y) + oy;
            const sprite = this.getHitmark(controller, e.damageTypes[i]);
            if (sprite) {
                ctx.drawImage(sprite, x - 12, y - 12);
            }
            const value = String(e.damageValues[i]);
            ctx.fillStyle = "#000000";
            ctx.fillText(value, x, y + 4);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(value, x - 1, y + 3);
        }
    }

    // Client.drawEntityOverlays: each icon at (x - 12, y - 30), the next 25px lower. Names and
    // chat are ours, not the client's, so the stack moves up to sit above them when they're shown.
    private drawHeadIcons(controller: LiveController, o: OverlayEntity): void {
        if (this.headIconSource !== controller.headIconSprites) {
            this.headIconSource = controller.headIconSprites;
            this.headIcons = controller.headIconSprites.map(spriteToCanvas);
        }
        let ceiling = Infinity;
        if (o.name) {
            ceiling = o.nameY - 13;
        }
        if (o.chatY !== undefined) {
            ceiling = Math.min(ceiling, o.chatY - 14);
        }
        const x = Math.round(o.top.x) - 12;
        let y = Math.round(Math.min(o.top.y - 30, ceiling - o.headIcons.length * HEAD_ICON_STEP));
        for (const icon of o.headIcons) {
            const sprite = this.headIcons[icon];
            if (sprite) {
                this.ctx.drawImage(sprite, x, y);
            }
            y += HEAD_ICON_STEP;
        }
    }

    private getHitmark(controller: LiveController, type: number): HTMLCanvasElement | undefined {
        if (this.hitmarkSource !== controller.hitmarkSprites) {
            this.hitmarkSource = controller.hitmarkSprites;
            this.hitmarks = controller.hitmarkSprites.map(spriteToCanvas);
        }
        return this.hitmarks[type];
    }

    private drawText(text: string, x: number, y: number, colour: string, alpha: number = 1): void {
        const ctx = this.ctx;
        if (alpha !== 1) {
            ctx.globalAlpha = alpha;
        }
        ctx.fillStyle = "#000000";
        ctx.fillText(text, x + 1, y + 1);
        ctx.fillStyle = colour;
        ctx.fillText(text, x, y);
        if (alpha !== 1) {
            ctx.globalAlpha = 1;
        }
    }

    private project(
        camera: Camera,
        fineX: number,
        fineY: number,
        fineZ: number,
        width: number,
        height: number,
        out: ScreenPos,
    ): ScreenPos | undefined {
        const clip = this.clip;
        vec4.set(clip, fineX / 128, fineY / 128, fineZ / 128, 1);
        vec4.transformMat4(clip, clip, camera.viewProjMatrix);
        if (clip[3] <= 0.01) {
            return undefined;
        }
        const ndcX = clip[0] / clip[3];
        const ndcY = clip[1] / clip[3];
        if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) {
            return undefined;
        }
        out.x = (ndcX * 0.5 + 0.5) * width;
        out.y = (1 - (ndcY * 0.5 + 0.5)) * height;
        return out;
    }
}

function compareOverlayDistance(a: OverlayEntity, b: OverlayEntity): number {
    return a.followed ? -1 : b.followed ? 1 : a.distance - b.distance;
}

function compareFarDistance(a: FarName, b: FarName): number {
    return a.distance - b.distance;
}

function hasActiveHitmark(e: LiveEntity, loopCycle: number): boolean {
    const cycles = e.damageCycles;
    for (let i = 0; i < cycles.length; i++) {
        if (cycles[i] > loopCycle) {
            return true;
        }
    }
    return false;
}

// How much of a point (tiles from the camera) the fog leaves visible, 1 clear to 0 gone: the
// shaders' rounded-box fog, 1 - fogFactorLinear(-sdRoundedBox(...), 0, fogDepth).
function getFogVisibility(dx: number, dz: number, renderDistance: number, fogDepth: number): number {
    const qx = Math.abs(dx) - renderDistance + FOG_CORNER_ROUNDING;
    const qz = Math.abs(dz) - renderDistance + FOG_CORNER_ROUNDING;
    const sd = Math.min(Math.max(qx, qz), 0) + Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) - FOG_CORNER_ROUNDING;
    return Math.min(Math.max(-sd / fogDepth, 0), 1);
}

function formatNpcName(npc: LiveNpc): string {
    const level = npc.getCombatLevel();
    return level > 0 ? `${npc.getName()} (level-${level})` : npc.getName();
}

// The overhead icons the client draws for an entity: a player's headicons bits (protect from
// melee/missiles/magic, retribution, smite, redemption, skull...) or an npc type's icon.
function fillHeadIcons(e: LiveEntity, out: number[]): void {
    if (e instanceof LivePlayer) {
        const bits = e.appearance?.headIcons ?? 0;
        for (let icon = 0; icon < 8; icon++) {
            if ((bits & (1 << icon)) !== 0) {
                out.push(icon);
            }
        }
    } else if (e instanceof LiveNpc) {
        const icon = e.npcType?.headIconPrayer ?? -1;
        if (icon >= 0) {
            out.push(icon);
        }
    }
}

// Palette sprite -> canvas at its full size, sub-image at its crop offset (index 0 is clear),
// so drawing the canvas at (x, y) matches the client's plotSprite(x, y).
function spriteToCanvas(sprite: IndexedSprite): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(sprite.width, 1);
    canvas.height = Math.max(sprite.height, 1);
    if (sprite.subWidth > 0 && sprite.subHeight > 0) {
        const ctx = canvas.getContext("2d")!;
        const image = ctx.createImageData(sprite.subWidth, sprite.subHeight);
        for (let i = 0; i < sprite.pixels.length; i++) {
            const index = sprite.pixels[i];
            if (index === 0) {
                continue;
            }
            const rgb = sprite.palette[index];
            image.data[i * 4] = (rgb >> 16) & 0xff;
            image.data[i * 4 + 1] = (rgb >> 8) & 0xff;
            image.data[i * 4 + 2] = rgb & 0xff;
            image.data[i * 4 + 3] = 0xff;
        }
        ctx.putImageData(image, sprite.xOffset, sprite.yOffset);
    }
    return canvas;
}
