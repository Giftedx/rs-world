import { Camera } from "../mapviewer/Camera";
import { LiveController } from "./LiveController";
import { LiveEntity } from "./LiveEntity";
import { FarPlayerLabel } from "./LiveEntityRenderer";
import { LiveOverlay } from "./LiveOverlay";
import { PaneRect, layoutRects, paneAt } from "./MultiLayout";
import { MultiStatus, paneLabel, paneMessageName, resolveFollow } from "./embed";

// Multi-view: up to 16 followed players in a grid, all drawn by the one WebGL renderer. Panes share
// the GL context, the cache, the loaded map squares, the zone state and the baked entity models; each
// pane has its own camera, its own small feed subscription (the feed streams one area per connection)
// and its own overlay canvas. The first pane's feed carries the roster and hands it to the others.
//
// An embedding page drives it with ?multi=a,b,c or a {multi: [...]} message; a click on a pane only
// tells the page which one. On its own page the viewer splits with "+ View" or a player's "View"
// menu entry, a click selects a pane for the camera controls, and each pane has a name box and a
// close button.

export type PaneHandlers = {
    rename(pane: MultiPane, name: string): void;
    close(pane: MultiPane): void;
};

export type PaneState = "" | "shown" | "finding" | "offline";

// Pointer travel (CSS px) under which a press and release on a pane is a click.
const CLICK_SLOP = 8;

export class MultiPane {
    readonly overlay = new LiveOverlay();
    farLabels: FarPlayerLabel[] = [];
    rect: PaneRect = { x: 0, y: 0, w: 1, h: 1 };
    // Highest floor this pane draws (its player's floor).
    level?: number;
    state: PaneState = "";
    readonly frame: HTMLDivElement;
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
    panes: MultiPane[] = [];
    active: number = 0;
    stopped: boolean = false;
    readonly root: HTMLDivElement;
    private width = -1;
    private height = -1;
    private dirty = true;
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

    addPane(pane: MultiPane): void {
        this.panes.push(pane);
        this.root.appendChild(pane.frame);
        this.dirty = true;
        this.lastStatusAt = 0;
    }

    removePane(pane: MultiPane): void {
        const index = this.panes.indexOf(pane);
        if (index === -1) {
            return;
        }
        const activePane = this.panes[this.active];
        this.panes.splice(index, 1);
        pane.frame.remove();
        this.dirty = true;
        this.lastStatusAt = 0;
        const next =
            activePane === pane
                ? Math.min(index, this.panes.length - 1)
                : this.panes.indexOf(activePane);
        this.active = -1;
        this.setActive(Math.max(next, 0));
    }

    // Puts the panes in a new order (the same panes, or fewer).
    reorder(panes: MultiPane[]): void {
        const activePane = this.panes[this.active];
        this.panes = panes;
        for (const pane of panes) {
            this.root.appendChild(pane.frame);
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
        }
        if (this.root.parentElement !== container) {
            container.appendChild(this.root);
        }
    }

    private unlisten(): void {
        this.canvas?.removeEventListener("pointerdown", this.onDown, { capture: true });
        this.canvas?.removeEventListener("pointerup", this.onUp, { capture: true });
        this.canvas?.removeEventListener("wheel", this.onWheel, { capture: true });
        this.canvas = undefined;
    }

    // Leaves the panes' controllers running (one of them carries on as the single view).
    detach(): void {
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

    // Rects are in CSS pixels of the GL canvas.
    layout(width: number, height: number): void {
        const n = this.panes.length;
        if (n === 0 || (!this.dirty && width === this.width && height === this.height)) {
            return;
        }
        this.width = width;
        this.height = height;
        this.dirty = false;
        const rects = layoutRects(n, width, height);
        for (let i = 0; i < n; i++) {
            const rect = rects[i];
            const pane = this.panes[i];
            pane.rect = rect;
            const style = pane.frame.style;
            style.left = `${rect.x}px`;
            style.top = `${rect.y}px`;
            style.width = `${rect.w}px`;
            style.height = `${rect.h}px`;
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
