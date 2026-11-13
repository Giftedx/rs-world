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

    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "live-overlay";
        this.ctx = this.canvas.getContext("2d")!;
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
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;

        const { options, world } = controller;
        const loopCycle = world.loopCycle;
        const followed = controller.getFollowed();

        const entities: LiveEntity[] = [];
        if (options.showPlayers) {
            entities.push(...world.players.values());
        }
        if (options.showNpcs) {
            entities.push(...world.npcs.values());
        }

        // Npcs that the page marked: their names show in the mark colour.
        const npcMarked = new Map<LiveEntity, string>();
        if (markers.npcs.length > 0) {
            for (const [nid, n] of world.npcs) {
                const colour = markers.npcColour(nid, n.npcType?.id ?? -1);
                if (colour) npcMarked.set(n, colour);
            }
        }

        // 1. What each nearby entity wants drawn, and where.
        const overlays: OverlayEntity[] = [];
        for (const e of entities) {
            if (e.level > maxLevel) {
                continue;
            }
            const dx = e.x / 128 - camera.getPosX();
            const dz = e.z / 128 - camera.getPosZ();
            const isFollowed = e === followed;
            const near = isFollowed || (Math.abs(dx) <= LABEL_DISTANCE && Math.abs(dz) <= LABEL_DISTANCE);
            const nameAlpha = isFollowed ? 1 : getFogVisibility(dx, dz, renderDistance, fogDepth);

            const isPlayer = e instanceof LivePlayer;
            const marked = isPlayer ? markers.playerColour(e.getName()) : npcMarked.get(e);
            const showName =
                nameAlpha > 0 && (isFollowed || (isPlayer ? options.showPlayerNames : (options.showNpcNames || !!marked) && near));
            // Same windows as the client: health bar for 300 cycles after a hit, hitmarks 70.
            const combat = near && options.showCombat && e.combatCycle > loopCycle + 100 && e.totalHealth > 0;
            const chat = near && options.showChat && e.chatMessage !== null && e.chatTimer > 0;
            const hitmarks = near && options.showCombat && e.damageCycles.some((cycle) => cycle > loopCycle);
            const headIcons = near ? getHeadIcons(e) : [];
            if (!showName && !combat && !chat && !hitmarks && headIcons.length === 0) {
                continue;
            }

            const groundY = getGroundY(e);
            if (groundY === undefined) {
                continue;
            }
            // The client anchors the health bar 15 units above the head and chat at the head.
            const top = this.project(camera, e.x, groundY - e.height - 15, e.z, width, height);
            const head = this.project(camera, e.x, groundY - e.height, e.z, width, height);
            if (!top || !head) {
                continue;
            }

            overlays.push({
                e,
                distance: dx * dx + dz * dz,
                followed: isFollowed,
                top,
                head,
                name: showName && !(isPlayer && isNameHidden(e.getName())) ? (isPlayer ? e.getName() : formatNpcName(e as LiveNpc)) : undefined,
                nameColour: isFollowed ? "#ff981f" : marked ? marked : isPlayer && isNameHighlighted(e.getName()) ? "#ffc21a" : isPlayer ? "#ffffff" : "#ffff00",
                nameAlpha: isFollowed || !isPlayer || !!marked || isNameHighlighted(e.getName()) ? nameAlpha : nameAlpha * OTHER_NAME_ALPHA,
                nameY: top.y - 8,
                chatY: chat ? head.y : undefined,
                combat,
                hitmarks,
                headIcons,
            });
        }

        // Players drawn from the roster outside the streamed area only have a name.
        const farNames: FarName[] = [];
        if (options.showPlayerNames) {
            for (const p of farLabels) {
                const dx = p.x / 128 - camera.getPosX();
                const dz = p.z / 128 - camera.getPosZ();
                const alpha = getFogVisibility(dx, dz, renderDistance, fogDepth);
                const top = alpha > 0 ? this.project(camera, p.x, p.groundY - p.height - 15, p.z, width, height) : undefined;
                if (top && !isNameHidden(p.name)) {
                    farNames.push({ name: p.name, alpha, distance: dx * dx + dz * dz, top, placed: false });
                }
            }
        }

        // 2. Place labels: followed first, then nearest. Chat outranks names, and the streamed
        // area's names outrank the roster's, which are further away.
        overlays.sort((a, b) => (a.followed ? -1 : b.followed ? 1 : a.distance - b.distance));
        this.resetGrid(width, height);
        for (const o of overlays) {
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
        for (const o of overlays) {
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
        farNames.sort((a, b) => a.distance - b.distance);
        for (const n of farNames) {
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
                const ours = isNameHighlighted(n.name);
                this.drawText(n.name, n.top.x, n.top.y - 8, ours ? "#ffc21a" : "#ffffff", ours ? n.alpha : n.alpha * OTHER_NAME_ALPHA);
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
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.combat) {
                const e = o.e;
                const fill = Math.min(((e.health * 30) / e.totalHealth) | 0, 30);
                const x = Math.round(o.top.x);
                const y = Math.round(o.top.y);
                ctx.fillStyle = "#00ff00";
                ctx.fillRect(x - 15, y - 3, fill, 5);
                ctx.fillStyle = "#ff0000";
                ctx.fillRect(x - 15 + fill, y - 3, 30 - fill, 5);
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.hitmarks) {
                const groundY = getGroundY(o.e)!;
                const mid = this.project(camera, o.e.x, groundY - o.e.height / 2, o.e.z, width, height);
                if (mid) {
                    this.drawHitmarks(controller, o.e, mid, loopCycle);
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
        const point = (tx: number, tz: number, l: number) => {
            const fx = Math.round(tx * 128);
            const fz = Math.round(tz * 128);
            const y = extra.groundAt(fx, fz, l);
            return y === undefined ? undefined : this.project(camera, fx, y, fz, width, height);
        };
        const tile = (x: number, z: number, l: number, size: number, colour: string, fill: boolean, text?: string) => {
            const c = [point(x, z, l), point(x + size, z, l), point(x + size, z + size, l), point(x, z + size, l)];
            if (c.some((p) => !p)) {
                return;
            }
            ctx.beginPath();
            ctx.moveTo(c[0]!.x, c[0]!.y);
            for (let i = 1; i < 4; i++) ctx.lineTo(c[i]!.x, c[i]!.y);
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
                const mid = point(x + size / 2, z + size / 2, l);
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
            const c = clipSegment(line.x0, line.z0, line.x1, line.z1, cx - MARKER_DISTANCE, cz - MARKER_DISTANCE, cx + MARKER_DISTANCE, cz + MARKER_DISTANCE);
            if (!c) continue;
            const s = { ...line, x0: c[0], z0: c[1], x1: c[2], z1: c[3] };
            const steps = Math.max(1, Math.round(Math.max(Math.abs(s.x1 - s.x0), Math.abs(s.z1 - s.z0))));
            ctx.strokeStyle = s.colour;
            ctx.beginPath();
            let open = false;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const p = point(s.x0 + (s.x1 - s.x0) * t, s.z0 + (s.z1 - s.z0) * t, s.l);
                if (!p) {
                    open = false;
                    continue;
                }
                if (open) ctx.lineTo(p.x, p.y);
                else ctx.moveTo(p.x, p.y);
                open = true;
            }
            ctx.stroke();
            if (s.label) {
                const mid = point((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2, s.l);
                if (mid) this.drawText(s.label, mid.x, mid.y - 4, s.colour);
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
            const c = point(pie.x + 0.5, pie.z + 0.5, pie.l);
            if (!c) continue;
            const r = 8;
            const y = c.y - 24;
            ctx.beginPath();
            ctx.arc(c.x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = "#ff0000";
            ctx.fill();
            if (pie.p > 0) {
                ctx.beginPath();
                ctx.moveTo(c.x, y);
                ctx.arc(c.x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pie.p);
                ctx.closePath();
                ctx.fillStyle = "#00ff00";
                ctx.fill();
            }
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#000000";
            ctx.beginPath();
            ctx.arc(c.x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 2;
        }
        // Floor item labels: one line a kind of item on the tile, the value from the page's prices, in RuneLite's tiers.
        const state = controller.worldState;
        if (markers.groundOn && state) {
            for (const t of state.objTiles.values()) {
                if (t.level > top || !near(t.x, t.z, LABEL_DISTANCE)) continue;
                const c = point(t.x + 0.5, t.z + 0.5, t.level);
                if (!c) continue;
                const counts = new Map<number, number>();
                for (const o of t.objs) counts.set(o.id, (counts.get(o.id) ?? 0) + o.count);
                let y = c.y - 6;
                for (const [id, count] of counts) {
                    const name = extra.objName(id);
                    if (!name) continue;
                    const lower = name.toLowerCase();
                    const price = markers.groundPrices.get(lower) ?? (lower === "coins" ? 1 : undefined);
                    const value = price === undefined ? undefined : price * count;
                    if (value !== undefined && value < markers.groundMin) continue;
                    const text = name + (count > 1 ? " (" + count + ")" : "") + (value !== undefined ? " (" + shortValue(value) + " gp)" : "");
                    this.drawText(text, c.x, y, value === undefined ? "#ffffff" : groundColour(value));
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
            colour = ["#ff0000", "#00ff00", "#00ffff"][phase];
        }

        if (e.chatEffect === 1) {
            // wave: per-character vertical sine, as the client draws it.
            const width = ctx.measureText(text).width;
            let cx = x - width / 2;
            ctx.textAlign = "left";
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const dy = Math.sin(i / 2 + loopCycle / 5) * 2;
                this.drawText(ch, cx, y + dy, colour);
                cx += ctx.measureText(ch).width;
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
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#000000";
        ctx.fillText(text, x + 1, y + 1);
        ctx.fillStyle = colour;
        ctx.fillText(text, x, y);
        ctx.globalAlpha = 1;
    }

    private project(camera: Camera, fineX: number, fineY: number, fineZ: number, width: number, height: number): ScreenPos | undefined {
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
        return {
            x: (ndcX * 0.5 + 0.5) * width,
            y: (1 - (ndcY * 0.5 + 0.5)) * height,
        };
    }
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
function getHeadIcons(e: LiveEntity): number[] {
    const icons: number[] = [];
    if (e instanceof LivePlayer) {
        const bits = e.appearance?.headIcons ?? 0;
        for (let icon = 0; icon < 8; icon++) {
            if ((bits & (1 << icon)) !== 0) {
                icons.push(icon);
            }
        }
    } else if (e instanceof LiveNpc) {
        const icon = e.npcType?.headIconPrayer ?? -1;
        if (icon >= 0) {
            icons.push(icon);
        }
    }
    return icons;
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
