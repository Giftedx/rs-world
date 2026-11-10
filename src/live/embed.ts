// Embedded use (the swarm dashboard's map window).
// ?embed=1 hides the UI chrome (settings panel, live and info panels, minimap, fps) and frames the followed player
// from a higher, steeper orbit that suits a wide, short window.
// ?hideNames=a,b and ?hideNamesFrom=<url> (a JSON array of names, fetched with CORS) list players whose nameplates are
// never drawn. The URL form lets an embedding page hide a name without putting it in its own page.
// A follow target of MAIN_MARK means "the first hidden name".

const params = new URLSearchParams(window.location.search);

export const EMBED = params.get("embed") === "1";
// ?flight=0 restores the old instant jump (kept to measure against).
export const FLIGHT = params.get("flight") !== "0";
// ?cache=0 drops the recently-visited square cache (the old behaviour), to measure against.
export const SQUARE_CACHE = params.get("cache") === "0" ? 0 : 160;

// Reports how long a follow change took until the destination was fully loaded (the embedding page shows it).
// ms: from the follow change until no square in view is blank. blankFrames: frames in between that showed any.
export function postTiming(mode: "flight" | "snap", ms: number, tiles: number, frames: number, blankFrames: number, holdFrames: number): void {
    if (window.parent !== window) window.parent.postMessage({ viewerTiming: { mode, ms: Math.round(ms), tiles: Math.round(tiles), frames, blankFrames, holdFrames } }, "*");
}
// ?ml=<0-3> sets the highest floor drawn from the first frame; a {maxLevel} message changes it.
export const isFloor = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3;
const firstFloor = parseInt(params.get("ml") ?? "");
export const FIRST_MAX_LEVEL: number | undefined = isFloor(firstFloor) ? firstFloor : undefined;
export const MAIN_MARK = "⟦MAIN⟧";

// Embed camera: about 20 tiles out at roughly 50 degrees down, so the player and a few tiles around them fill
// a 2:1 frame without the horizon taking the top half.
export const EMBED_FOLLOW_DISTANCE = 20;
export const EMBED_FOLLOW_PITCH = -290;

const hidden = new Set<string>(
    (params.get("hideNames") ?? "")
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
);
let hiddenOrder: string[] = [...hidden];

const from = params.get("hideNamesFrom");
// False while the ?hideNamesFrom list is still on its way: until then no name is known to be safe to print.
let hiddenSettled = !from;
if (from) {
    fetch(from, { mode: "cors", cache: "no-store" })
        .then((r) => r.json())
        .then((list: unknown) => {
            if (!Array.isArray(list)) return;
            for (const n of list) if (typeof n === "string" && n) hidden.add(n.toLowerCase());
            hiddenOrder = [...hiddenOrder, ...list.filter((n): n is string => typeof n === "string" && !!n)];
        })
        .catch(() => {
            /* the dashboard is down: no extra hidden names */
        })
        .finally(() => {
            hiddenSettled = true;
        });
}

// ?highlightFrom=<url> (a JSON array, fetched with CORS): players drawn with a gold nameplate (our accounts).
const highlighted = new Set<string>();
const hl = params.get("highlightFrom");
if (hl) {
    fetch(hl, { mode: "cors", cache: "no-store" })
        .then((r) => r.json())
        .then((list: unknown) => {
            if (Array.isArray(list)) for (const n of list) if (typeof n === "string" && n) highlighted.add(n.toLowerCase());
        })
        .catch(() => {
            /* no highlight */
        });
}
export function isNameHighlighted(name: string | undefined): boolean {
    return !!name && highlighted.has(name.toLowerCase());
}
// In embed mode other players' names are dimmed, so ours stand out.
export const OTHER_NAME_ALPHA = EMBED ? 0.45 : 1;

export function isNameHidden(name: string | undefined): boolean {
    return !!name && hidden.has(name.toLowerCase());
}

// Resolves the marker to the real name once the hidden list has loaded; undefined means "not yet".
export function resolveFollow(name: string): string | undefined {
    if (name !== MAIN_MARK) return name;
    return hiddenOrder[0];
}

// ?probe=1 puts the viewer on window.mapViewer, so a test page can read its state.
export const PROBE = params.get("probe") === "1";

// Multi-view (?multi=a,b,c or a {multi: [...]} message): several followed players in one frame.

// The text a pane may print for the player it was asked to follow: nothing for a hidden name, for the
// marker, and for any name while the hidden list has not arrived.
export function paneLabel(asked: string | undefined): string {
    if (!asked || asked === MAIN_MARK || !hiddenSettled || isNameHidden(asked)) return "";
    return asked;
}

// The name a message to the embedding page may carry for a pane: a hidden name goes out as the marker.
export function paneMessageName(asked: string): string {
    return asked === MAIN_MARK || isNameHidden(asked) ? MAIN_MARK : asked;
}

export type MultiStatus = { names: string[]; shown: string[]; offline: string[] };

let lastMultiStatus = "";
// Tells the embedding page which of the asked names have their player on screen and which are not online
// (a name in neither list is still being found). Posted when it changes; names stay in the asked order.
export function postMultiStatus(status: MultiStatus): void {
    const text = JSON.stringify(status);
    if (text === lastMultiStatus) return;
    lastMultiStatus = text;
    if (window.parent !== window) window.parent.postMessage({ viewerMulti: status }, "*");
}

// A click or tap on a pane: the page can switch to a single follow of that player.
export function postMultiPick(name: string, index: number): void {
    if (window.parent !== window) window.parent.postMessage({ viewerMultiPick: name, index }, "*");
}

// Where the panes of the layout are going, for a page that draws its own frames over them. Rects are
// the target rectangles in CSS pixels of the viewer frame, in the asked order. A hidden name is the marker.
// animating: the panes move there over ms milliseconds from the time at (ms since the Unix epoch).
export type MultiLayoutInfo = {
    mode: string;
    main: string | null;
    focus: string | null;
    rects: { name: string; x: number; y: number; w: number; h: number }[];
    animating: boolean;
    ms: number;
    at: number;
};

export function multiLayoutInfo(
    mode: string,
    main: string | undefined,
    focus: string | undefined,
    panes: { asked: string | undefined; rect: { x: number; y: number; w: number; h: number } }[],
    left: number,
    top: number,
    animating: boolean,
    ms: number,
    at: number,
): MultiLayoutInfo {
    const rects: MultiLayoutInfo["rects"] = [];
    for (const { asked, rect } of panes) {
        if (asked) rects.push({ name: paneMessageName(asked), x: rect.x + left, y: rect.y + top, w: rect.w, h: rect.h });
    }
    return { mode, main: main ? paneMessageName(main) : null, focus: focus ? paneMessageName(focus) : null, rects, animating, ms, at };
}

// Sent when the target rectangles change and when a move ends.
export function postMultiLayout(info: MultiLayoutInfo): void {
    if (window.parent !== window) window.parent.postMessage({ viewerMultiLayout: info }, "*");
}
