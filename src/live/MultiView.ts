import { Camera } from "../mapviewer/Camera";
import { LiveController } from "./LiveController";
import { LiveEntity } from "./LiveEntity";
import { FarPlayerLabel } from "./LiveEntityRenderer";
import { LiveOverlay } from "./LiveOverlay";
import {
    DEFAULT_GAP,
    DEFAULT_RATIO,
    LayoutOptions,
    PaneRect,
    TRANSITION_MS,
    easeOutCubic,
    mainFirst,
    mixRect,
    paneAt,
    shrunkRect,
    tileRects,
} from "./MultiLayout";
import {
    MultiLayoutInfo,
    MultiStatus,
    multiLayoutInfo,
    paneLabel,
    paneMessageName,
    resolveFollow,
} from "./embed";

// Multi-view: up to 16 followed players in tiled panes, all drawn by the one WebGL renderer. Panes share
// the GL context, the cache, the loaded map squares, the zone state and the baked entity models; each
// pane has its own camera, its own small feed subscription (the feed streams one area per connection)
// and its own overlay canvas. The first pane's feed carries the roster and hands it to the others.
//
// An embedding page drives it with ?multi=a,b,c or a {multi: [...]} message; a click on a pane only
// tells the page which one. On its own page the viewer splits with "+ View" or a player's "View"
// menu entry, a click selects a pane for the camera controls, and each pane has a name box and a
// close button.
//
// The panes are tiled (MultiLayout): a change of the panes, their order, the layout or the main pane
// moves each pane from where it is to its new rectangle in TRANSITION_MS. A new pane grows and fades
// in at its place; a closed pane shrinks and fades out, and is drawn until it is gone. On the way
// back to the single view the selected pane grows to the full window. While panes move, the GL view
// of each is drawn every frame at its rectangle; its DOM frame follows with a transform and its name
// overlay is not drawn again until the move ends.

export type PaneHandlers = {
    rename(pane: MultiPane, name: string): void;
    close(pane: MultiPane): void;
};

export type PaneState = "" | "shown" | "finding" | "offline";

// Pointer travel (CSS px) under which a press and release on a pane is a click.
const CLICK_SLOP = 8;
// The share of its rectangle a new pane starts at and a closed pane ends at.
const ENTER_SCALE = 0.6;

function prefersReducedMotion(): boolean {
    return (
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}

function copyRect(out: PaneRect, from: PaneRect): void {
    out.x = from.x;
    out.y = from.y;
    out.w = from.w;
    out.h = from.h;
}

export class MultiPane {
    readonly overlay = new LiveOverlay();
    farLabels: FarPlayerLabel[] = [];
    // Where the pane is drawn now (CSS pixels of the GL canvas), and the move it is making.
    rect: PaneRect = { x: 0, y: 0, w: 1, h: 1 };
    readonly from: PaneRect = { x: 0, y: 0, w: 1, h: 1 };
    readonly to: PaneRect = { x: 0, y: 0, w: 1, h: 1 };
    // The rectangle the DOM frame is laid out at. While the pane moves, the frame follows with a
    // transform: nothing is laid out again and the name overlay is scaled like a picture.
    readonly box: PaneRect = { x: 0, y: 0, w: 0, h: 0 };
    // The same rectangle in framebuffer pixels (the renderer fills it each frame).
    readonly viewport: PaneRect = { x: 0, y: 0, w: 1, h: 1 };
    // 1 is fully shown. A new pane fades in from 0 and a closed pane fades out to 0.
    alpha: number = 1;
    alphaFrom: number = 1;
    alphaTo: number = 1;
    // How a pane with no rectangle yet comes in: grown from its place, or from the full window
    // (the single view that became a pane).
    enter: "" | "grow" | "full" = "grow";
    leaving: boolean = false;
    // Highest floor this pane draws (its player's floor).
    level?: number;
    state: PaneState = "";
    readonly frame: HTMLDivElement;
    // Covers the pane with the gap colour while it fades.
    readonly veil: HTMLDivElement;
    private veilAlpha: number = 1;
    readonly input?: HTMLInputElement;
    readonly nameText: HTMLSpanElement;
    readonly statusText: HTMLSpanElement;

    constructor(
        readonly camera: Camera,
        readonly live: LiveController,
        // The player this pane was asked to follow, as asked (it may be the hidden-name marker).
        public asked: string | undefined,
        handlers: PaneHandlers | undefined,
    ) {
        this.frame = document.createElement("div");
        this.frame.className = "multi-pane";

        this.overlay.canvas.classList.add("multi-pane-overlay");
        this.frame.appendChild(this.overlay.canvas);

        const label = document.createElement("div");
        label.className = "multi-pane-label";
        this.nameText = document.createElement("span");
        this.nameText.className = "multi-pane-name";
        this.statusText = document.createElement("span");
        this.statusText.className = "multi-pane-status";

        if (handlers) {
            const input = document.createElement("input");
            input.placeholder = "player name";
            input.spellcheck = false;
            input.addEventListener("keydown", (e) => {
                // Keep keys typed here away from the camera controls.
                e.stopPropagation();
                if (e.key === "Enter") {
                    handlers.rename(this, input.value.trim());
                    input.blur();
                } else if (e.key === "Escape") {
                    input.value = paneLabel(this.getAsked());
                    input.blur();
                }
            });
            input.addEventListener("keyup", (e) => e.stopPropagation());
            this.input = input;

            const close = document.createElement("button");
            close.className = "multi-pane-close";
            close.title = "Close this view";
            close.textContent = "×";
            close.addEventListener("click", (e) => {
                e.stopPropagation();
                handlers.close(this);
            });
            label.classList.add("editable");
            label.appendChild(close);
            label.appendChild(input);
        } else {
            label.appendChild(this.nameText);
        }
        label.appendChild(this.statusText);
        this.frame.appendChild(label);

        this.veil = document.createElement("div");
        this.veil.className = "multi-pane-veil";
        this.frame.appendChild(this.veil);
    }

    private fade(): void {
        if (this.alpha !== this.veilAlpha) {
            this.veilAlpha = this.alpha;
            this.veil.style.opacity = (1 - this.alpha).toFixed(3);
        }
    }

    // Lays the DOM frame out at a rectangle (the pane's own, if none is given).
    place(rect: PaneRect = this.rect): void {
        const style = this.frame.style;
        style.left = `${rect.x}px`;
        style.top = `${rect.y}px`;
        style.width = `${rect.w}px`;
        style.height = `${rect.h}px`;
        style.transform = "";
        copyRect(this.box, rect);
        this.fade();
    }

    // Moves the DOM frame to the pane's rectangle with a transform of the laid-out box.
    shift(): void {
        const rect = this.rect;
        const box = this.box;
        const sx = rect.w / Math.max(box.w, 1);
        const sy = rect.h / Math.max(box.h, 1);
        this.frame.style.transform = `translate(${rect.x - box.x}px,${
            rect.y - box.y
        }px) scale(${sx},${sy})`;
        this.fade();
    }

    // The name this pane follows, as it was asked for. A follow changed from the Live panel or a
    // menu replaces what was asked.
    getAsked(): string | undefined {
        const followed = this.live.followName ?? this.live.pendingFollow;
        if (!this.asked) {
            return followed;
        }
        const resolved = resolveFollow(this.asked);
        if (followed && resolved && followed.toLowerCase() !== resolved.toLowerCase()) {
            return followed;
        }
        return this.asked;
    }
}

export class MultiView {
    // The panes in their asked order.
    panes: MultiPane[] = [];
    // Closed panes that are still fading out.
    leaving: MultiPane[] = [];
    // Every pane to draw, the lowest first: closed panes, then the others with the main pane last.
    drawList: MultiPane[] = [];
    active: number = 0;
    stopped: boolean = false;
    readonly root: HTMLDivElement;
    readonly options: LayoutOptions = { mode: "grid", gap: DEFAULT_GAP, ratio: DEFAULT_RATIO };
    // The pane the layout puts first. Unset, or closed: the first pane in the order.
    main?: MultiPane;
    // False: a change of layout is drawn at once, with no move.
    animate: boolean = true;
    // True while panes move. The renderer then runs at the full frame rate.
    animating: boolean = false;
    // Told when the target rectangles change and when a move ends.
    onLayout?: (info: MultiLayoutInfo) => void;
    // Told when a closed pane has faded out (or the view stopped): its feed can stop.
    onRetired?: (pane: MultiPane) => void;
    // True while the selected pane grows to the full window on the way back to the single view.
    closing: boolean = false;
    onClosed?: () => void;
    private width = -1;
    private height = -1;
    private dirty = true;
    private chrome = true;
    private moveStart = 0;
    private lastStatusAt = 0;
    private canvas?: HTMLCanvasElement;
    private downX = 0;
    private downY = 0;
    private downPane = -1;

    constructor(
        // An embedding page owns the panes: no selection, a click only reports the pane.
        readonly embedded: boolean,
        readonly onPick: (pane: MultiPane, index: number) => void,
    ) {
        this.root = document.createElement("div");
        this.root.className = "multi-view" + (embedded ? " embedded" : "");
    }

    private paneUnder(e: MouseEvent): number {
        if (!this.canvas) {
            return -1;
        }
        const rect = this.canvas.getBoundingClientRect();
        return this.paneAt(e.clientX - rect.left, e.clientY - rect.top);
    }

    private readonly onDown = (e: PointerEvent) => {
        this.downX = e.clientX;
        this.downY = e.clientY;
        this.downPane = e.button === 0 ? this.paneUnder(e) : -1;
        if (!this.embedded) {
            // Clicking in a pane selects it; keys, drag, wheel, the Live panel and click menus
            // then act on that pane.
            this.setActive(this.paneUnder(e));
        }
    };

    private readonly onUp = (e: PointerEvent) => {
        const index = this.downPane;
        this.downPane = -1;
        if (
            index === -1 ||
            index !== this.paneUnder(e) ||
            Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > CLICK_SLOP
        ) {
            return;
        }
        const pane = this.panes[index];
        if (pane) {
            this.onPick(pane, index);
        }
    };

    private readonly onWheel = (e: WheelEvent) => {
        if (!this.embedded) {
            this.setActive(this.paneUnder(e));
        }
    };

    // A double click on the single view locks the pointer for the camera. On panes that a page
    // owns, a double click is the page's (it opens that pane): the pointer stays free.
    private readonly onDouble = (e: MouseEvent) => {
        if (this.embedded || !this.chrome) {
            e.stopImmediatePropagation();
        }
    };

    // True when the next frame has a layout change to start or a move to carry on.
    wantsFrames(): boolean {
        return this.animating || (this.dirty && this.panes.length > 0);
    }

    // The page draws the names and frames itself: the panes show no label and no selection.
    setChrome(on: boolean): void {
        this.chrome = on;
        this.root.classList.toggle("no-chrome", !on);
    }

    // True from a change of the panes or the layout until the frame that works out the new
    // rectangles: until then the target rectangles are the old ones.
    layoutPending(): boolean {
        return this.dirty;
    }

    // The colour of the gaps, which a fading pane is covered with.
    setGapColor(css: string): void {
        this.root.style.setProperty("--multi-gap", css);
    }

    relayout(): void {
        this.dirty = true;
    }

    setMain(pane: MultiPane | undefined): void {
        if (pane !== this.main) {
            this.main = pane;
            this.dirty = true;
        }
    }

    // The pane the layout puts first.
    mainPane(): MultiPane | undefined {
        return this.main && this.panes.includes(this.main) ? this.main : this.panes[0];
    }

    addPane(pane: MultiPane): void {
        this.panes.push(pane);
        this.root.appendChild(pane.frame);
        this.dirty = true;
        this.lastStatusAt = 0;
    }

    // Takes a pane out of the layout. It fades out where it is and is then handed to onRetired.
    private retire(pane: MultiPane, index: number): void {
        pane.leaving = true;
        if (this.main === pane) {
            // The next pane in the order takes the main place.
            this.main = this.panes[index + 1] ?? this.panes[index - 1];
        }
        if (pane.enter) {
            // Never drawn: nothing to fade.
            pane.frame.remove();
            this.onRetired?.(pane);
        } else {
            this.leaving.push(pane);
        }
    }

    removePane(pane: MultiPane): void {
        const index = this.panes.indexOf(pane);
        if (index === -1) {
            return;
        }
        const activePane = this.panes[this.active];
        this.retire(pane, index);
        this.panes.splice(index, 1);
        this.dirty = true;
        this.lastStatusAt = 0;
        const next =
            activePane === pane
                ? Math.min(index, this.panes.length - 1)
                : this.panes.indexOf(activePane);
        this.active = -1;
        this.setActive(Math.max(next, 0));
    }

    // Puts the panes in a new order. A pane that is not in the new list is closed.
    reorder(panes: MultiPane[]): void {
        const activePane = this.panes[this.active];
        // From the last to the first, so the main place goes to a pane that stays.
        for (let i = this.panes.length - 1; i >= 0; i--) {
            if (!panes.includes(this.panes[i])) {
                this.retire(this.panes[i], i);
                this.panes.splice(i, 1);
            }
        }
        this.panes = panes;
        for (const pane of panes) {
            if (pane.frame.parentElement !== this.root) {
                this.root.appendChild(pane.frame);
            }
        }
        this.dirty = true;
        this.lastStatusAt = 0;
        this.active = -1;
        this.setActive(Math.max(panes.indexOf(activePane), 0));
    }

    attach(canvas: HTMLCanvasElement, container: HTMLElement): void {
        if (this.canvas !== canvas) {
            this.unlisten();
            this.canvas = canvas;
            canvas.addEventListener("pointerdown", this.onDown, { capture: true });
            canvas.addEventListener("pointerup", this.onUp, { capture: true });
            canvas.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
            canvas.addEventListener("dblclick", this.onDouble, { capture: true });
        }
        if (this.root.parentElement !== container) {
            container.appendChild(this.root);
        }
    }

    private unlisten(): void {
        this.canvas?.removeEventListener("pointerdown", this.onDown, { capture: true });
        this.canvas?.removeEventListener("pointerup", this.onUp, { capture: true });
        this.canvas?.removeEventListener("wheel", this.onWheel, { capture: true });
        this.canvas?.removeEventListener("dblclick", this.onDouble, { capture: true });
        this.canvas = undefined;
    }

    private dropLeaving(): void {
        for (const pane of this.leaving.splice(0)) {
            pane.frame.remove();
            this.onRetired?.(pane);
        }
    }

    // The way back to the single view: the selected pane grows to the full window and the others
    // fade out, then onClosed is called. False when nothing moves (the caller leaves at once).
    close(): boolean {
        const keep = this.panes[this.active];
        if (!keep || keep.enter || this.width < 0 || !this.animate || prefersReducedMotion()) {
            return false;
        }
        this.reorder([keep]);
        this.closing = true;
        return true;
    }

    // Leaves the panes' controllers running (one of them carries on as the single view).
    detach(): void {
        this.dropLeaving();
        this.animating = false;
        this.unlisten();
        this.root.remove();
    }

    stop(): void {
        this.stopped = true;
        for (const pane of this.panes) {
            pane.live.stop();
        }
        this.panes = [];
        this.detach();
    }

    private refreshDrawList(): void {
        const list = this.drawList;
        list.length = 0;
        for (const pane of this.leaving) {
            list.push(pane);
        }
        const order = mainFirst(this.panes, this.mainPane());
        for (let i = order.length - 1; i >= 0; i--) {
            list.push(order[i]);
        }
        for (let i = 0; i < list.length; i++) {
            list[i].frame.style.zIndex = String(i);
        }
        for (let i = 0; i < this.panes.length; i++) {
            // The pane's place in the asked order, for a page that finds a clicked pane in the DOM.
            this.panes[i].frame.dataset.pane = String(i);
        }
        for (const pane of this.leaving) {
            delete pane.frame.dataset.pane;
        }
    }

    // The end of a move: every pane on its target, closed panes gone.
    private settle(): void {
        this.animating = false;
        for (const pane of this.panes) {
            copyRect(pane.rect, pane.to);
            pane.alpha = 1;
            pane.place();
        }
        this.dropLeaving();
        this.refreshDrawList();
        if (this.closing) {
            this.onClosed?.();
        }
    }

    // Starts a move to the layout's rectangles for the panes as they are now.
    private retarget(width: number, height: number, now: number, move: boolean): void {
        const order = mainFirst(this.panes, this.mainPane());
        const rects = tileRects(order.length, width, height, this.options);
        // True when every pane is on its target already: then there is nothing to move.
        let still = this.leaving.length === 0;
        for (let i = 0; i < order.length; i++) {
            const pane = order[i];
            const target = rects[i];
            if (pane.enter) {
                const full = pane.enter === "full";
                pane.rect = full
                    ? { x: 0, y: 0, w: width, h: height }
                    : shrunkRect(target, ENTER_SCALE);
                pane.alpha = full ? 1 : 0;
                pane.enter = "";
                // The frame is laid out once, at the target.
                pane.place(target);
            }
            copyRect(pane.from, pane.rect);
            copyRect(pane.to, target);
            pane.alphaFrom = pane.alpha;
            pane.alphaTo = 1;
            still =
                still &&
                pane.alpha === 1 &&
                pane.rect.x === target.x &&
                pane.rect.y === target.y &&
                pane.rect.w === target.w &&
                pane.rect.h === target.h;
        }
        for (const pane of this.leaving) {
            if (pane.alphaTo !== 0) {
                copyRect(pane.to, shrunkRect(pane.rect, ENTER_SCALE));
            }
            copyRect(pane.from, pane.rect);
            pane.alphaFrom = pane.alpha;
            pane.alphaTo = 0;
        }
        this.refreshDrawList();
        if (move && !still) {
            this.animating = true;
            this.moveStart = now;
        } else {
            this.settle();
        }
    }

    // The target rectangles in the asked order, for the embedding page. now is the frame time of
    // the layout change (performance.now() clock).
    layoutInfo(now: number): MultiLayoutInfo {
        const box = this.canvas?.getBoundingClientRect();
        return multiLayoutInfo(
            this.options.mode,
            this.mainPane()?.getAsked(),
            this.panes[this.active]?.getAsked(),
            this.panes.map((pane) => ({ asked: pane.getAsked(), rect: pane.to })),
            box ? Math.round(box.left) : 0,
            box ? Math.round(box.top) : 0,
            this.animating,
            this.animating ? TRANSITION_MS : 0,
            performance.timeOrigin + (this.animating ? this.moveStart : now),
        );
    }

    // Rects are in CSS pixels of the GL canvas. now is the frame time. A frame with no layout
    // change and no move in progress does nothing here.
    layout(width: number, height: number, now: number): void {
        if (this.panes.length === 0) {
            return;
        }
        const resized = width !== this.width || height !== this.height;
        if (this.dirty || resized) {
            // A new window size is followed at once: only a change of the panes is a move.
            const move = this.dirty && this.animate && !prefersReducedMotion();
            this.width = width;
            this.height = height;
            this.dirty = false;
            this.retarget(width, height, now, move);
            this.onLayout?.(this.layoutInfo(now));
            if (!this.animating) {
                return;
            }
        }
        if (!this.animating) {
            return;
        }
        const t = (now - this.moveStart) / TRANSITION_MS;
        if (t >= 1) {
            this.settle();
            this.onLayout?.(this.layoutInfo(now));
            return;
        }
        const e = easeOutCubic(t);
        const list = this.drawList;
        for (let i = 0; i < list.length; i++) {
            const pane = list[i];
            mixRect(pane.rect, pane.from, pane.to, e);
            pane.alpha = pane.alphaFrom + (pane.alphaTo - pane.alphaFrom) * e;
            pane.shift();
        }
    }

    paneAt(x: number, y: number): number {
        return paneAt(
            this.panes.map((p) => p.rect),
            x,
            y,
        );
    }

    setActive(index: number): void {
        if (index === this.active || index < 0 || index >= this.panes.length) {
            return;
        }
        for (const pane of this.panes) {
            pane.frame.classList.remove("active");
        }
        this.active = index;
        this.panes[index].frame.classList.add("active");
    }

    // The pane a page names: its number in the asked order, or the name it was asked with (a
    // hidden name also answers to the marker).
    findPane(ref: unknown): MultiPane | undefined {
        if (typeof ref === "number") {
            return this.panes[ref];
        }
        if (typeof ref !== "string" || !ref) {
            return undefined;
        }
        const key = ref.toLowerCase();
        return (
            this.panes.find((pane) => pane.getAsked()?.toLowerCase() === key) ??
            this.panes.find((pane) => {
                const asked = pane.getAsked();
                return !!asked && paneMessageName(asked) === ref;
            })
        );
    }

    // Twice a second: the panes' labels, and which asked names are on screen or not online. A
    // hidden name is never printed (paneLabel) and goes into the status as the marker.
    updateStatus(
        getGroundY: (e: LiveEntity) => number | undefined,
        force?: boolean,
    ): MultiStatus | undefined {
        const now = performance.now();
        if (!force && now - this.lastStatusAt < 500) {
            return undefined;
        }
        this.lastStatusAt = now;
        const status: MultiStatus = { names: [], shown: [], offline: [] };
        for (const pane of this.panes) {
            const asked = pane.getAsked();
            const label = paneLabel(asked);
            const name = asked ? resolveFollow(asked) : undefined;
            const followed = pane.live.getFollowed();

            let state: PaneState = "";
            if (asked) {
                if (followed && getGroundY(followed) !== undefined) {
                    state = "shown";
                } else if (name && !followed && pane.live.world.rosterTick !== -1) {
                    const key = name.toLowerCase();
                    const online = pane.live.world.rosterPlayers.some(
                        (r) => r[1].toLowerCase() === key,
                    );
                    state = online ? "finding" : "offline";
                    // A follow of a player who is not online is dropped. An embedding page cannot ask
                    // again by hand, so the pane takes the player up when they log in.
                    if (
                        online &&
                        this.embedded &&
                        !pane.live.followName &&
                        !pane.live.pendingFollow
                    ) {
                        pane.live.pendingFollow = pane.asked;
                    }
                } else {
                    state = "finding";
                }
                const messageName = paneMessageName(asked);
                status.names.push(messageName);
                if (state === "shown") {
                    status.shown.push(messageName);
                } else if (state === "offline") {
                    status.offline.push(messageName);
                }
            }
            pane.state = state;

            let text: string;
            if (pane.live.status !== "open") {
                text = pane.live.status;
            } else if (state === "shown") {
                // An embedding page has its own position readout; a hidden player's is not printed.
                text =
                    this.embedded || !label || !followed
                        ? ""
                        : `${followed.x >> 7}, ${followed.z >> 7}`;
            } else {
                text = state === "finding" ? "finding…" : state;
            }
            const input = pane.input;
            if (input && document.activeElement !== input && input.value !== label) {
                input.value = label;
            }
            if (pane.nameText.textContent !== label) {
                pane.nameText.textContent = label;
            }
            if (pane.statusText.textContent !== text) {
                pane.statusText.textContent = text;
            }
        }
        return status;
    }
}
