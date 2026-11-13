// Markers: highlights that an embedding page asks the 3D view to draw, as RuneLite overlays do. One message carries
// all of them and replaces the ones before: {overlay: {tiles, pies, lines, players, npcs, ground}}.
//   tiles   [{x, z, l, colour, label?, fill?, size?}]  tile outlines (Ground Markers, Tile Indicators, Death Indicator)
//   pies    [{x, z, l, p}]                             respawn pies over a tile, p from 0 to 1 (Mining, Woodcutting)
//   lines   [{x0, z0, x1, z1, l, colour, label?}]      lines on the ground in tile coordinates (Multi-Lines)
//   players {lower-case name: colour}                  name and tile colour of a player (Player Indicators)
//   npcs    [{types?, nids?, colour}]                  npcs by type id or by index (NPC Indicators)
//   ground  {prices: {item name: gp}, min}             floor item labels with their value, hidden below min (Ground Items)
// A colour is "#rrggbb". Lists are capped, so a page cannot slow the frame down with a huge message. The store is an
// object with methods, so their names survive the production build and the page can check for them.

export type MarkTile = { x: number; z: number; l: number; colour: string; label?: string; fill?: boolean; size: number };
export type MarkPie = { x: number; z: number; l: number; p: number };
export type MarkLine = { x0: number; z0: number; x1: number; z1: number; l: number; colour: string; label?: string };
export type NpcMark = { types: Set<number>; nids: Set<number>; colour: string };

const COLOUR = /^#[0-9a-f]{6}$/i;
const coord = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 16384;
const level = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3;
const label = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, 40) : undefined);
const list = (v: unknown, cap: number): unknown[] => (Array.isArray(v) ? v.slice(0, cap) : []);

export class MarkerStore {
    tiles: MarkTile[] = [];
    pies: MarkPie[] = [];
    lines: MarkLine[] = [];
    players: Map<string, string> = new Map();
    npcs: NpcMark[] = [];
    groundPrices: Map<string, number> = new Map();
    groundMin = 0;
    groundOn = false;

    setOverlay(raw: unknown): void {
        const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        this.tiles = list(o.tiles, 600).flatMap((t: any) =>
            t && coord(t.x) && coord(t.z) && level(t.l) && COLOUR.test(t.colour)
                ? [{ x: t.x, z: t.z, l: t.l, colour: t.colour, label: label(t.label), fill: t.fill === true, size: Number.isInteger(t.size) && t.size >= 1 && t.size <= 5 ? t.size : 1 }]
                : [],
        );
        this.pies = list(o.pies, 300).flatMap((p: any) =>
            p && coord(p.x) && coord(p.z) && level(p.l) && typeof p.p === "number" && p.p >= 0 && p.p <= 1 ? [{ x: p.x, z: p.z, l: p.l, p: p.p }] : [],
        );
        this.lines = list(o.lines, 3000).flatMap((s: any) =>
            s && coord(s.x0) && coord(s.z0) && coord(s.x1) && coord(s.z1) && level(s.l) && COLOUR.test(s.colour)
                ? [{ x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1, l: s.l, colour: s.colour, label: label(s.label) }]
                : [],
        );
        this.players = new Map();
        if (o.players && typeof o.players === "object" && !Array.isArray(o.players)) {
            for (const [name, colour] of Object.entries(o.players as Record<string, unknown>).slice(0, 300)) {
                if (/^[a-z0-9_ -]{1,12}$/.test(name) && typeof colour === "string" && COLOUR.test(colour)) this.players.set(name, colour);
            }
        }
        const ids = (v: unknown) => new Set(list(v, 200).filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 65536));
        this.npcs = list(o.npcs, 20).flatMap((n: any) => (n && COLOUR.test(n.colour) ? [{ types: ids(n.types), nids: ids(n.nids), colour: n.colour }] : []));
        const g = o.ground && typeof o.ground === "object" ? (o.ground as Record<string, unknown>) : null;
        this.groundOn = !!g;
        this.groundPrices = new Map();
        this.groundMin = 0;
        if (g) {
            if (g.prices && typeof g.prices === "object") {
                for (const [name, gp] of Object.entries(g.prices as Record<string, unknown>).slice(0, 6000)) {
                    if (typeof gp === "number" && Number.isFinite(gp) && gp >= 0) this.groundPrices.set(name.toLowerCase(), gp);
                }
            }
            this.groundMin = typeof g.min === "number" && g.min >= 0 ? g.min : 0;
        }
    }

    playerColour(name: string | undefined): string | undefined {
        return name ? this.players.get(name.toLowerCase()) : undefined;
    }

    npcColour(nid: number, type: number): string | undefined {
        for (const m of this.npcs) if (m.nids.has(nid) || m.types.has(type)) return m.colour;
        return undefined;
    }
}

// RuneLite's Ground Items value tiers: white below 20K, then light blue, green, orange and pink at 20K, 100K, 1M and 10M.
export function groundColour(value: number): string {
    return value >= 10_000_000 ? "#ff66b2" : value >= 1_000_000 ? "#ff9600" : value >= 100_000 ? "#99ff99" : value >= 20_000 ? "#66b2ff" : "#ffffff";
}

// "1.2K", "15K", "3.4M", as the Ground Items labels show a value.
export function shortValue(gp: number): string {
    if (gp >= 10_000_000) return Math.floor(gp / 1_000_000) + "M";
    if (gp >= 1_000_000) return (Math.floor(gp / 100_000) / 10).toString() + "M";
    if (gp >= 10_000) return Math.floor(gp / 1000) + "K";
    if (gp >= 1000) return (Math.floor(gp / 100) / 10).toString() + "K";
    return String(Math.round(gp));
}

// The part of the segment (x0, z0)-(x1, z1) inside the rectangle, or null (Liang-Barsky): a long ground line keeps the
// part near the camera, though its middle is far away.
export function clipSegment(x0: number, z0: number, x1: number, z1: number, minX: number, minZ: number, maxX: number, maxZ: number): [number, number, number, number] | null {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const p = [-dx, dx, -dz, dz];
    const q = [x0 - minX, maxX - x0, z0 - minZ, maxZ - z0];
    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return null;
            continue;
        }
        const r = q[i] / p[i];
        if (p[i] < 0) {
            if (r > t1) return null;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return null;
            if (r < t1) t1 = r;
        }
    }
    return t0 < t1 ? [x0 + t0 * dx, z0 + t0 * dz, x0 + t1 * dx, z0 + t1 * dz] : null;
}

export const markers = new MarkerStore();
