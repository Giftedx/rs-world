import { FeedHello, FeedMessage, FeedRoster, FeedTick } from "./protocol";

export type FeedStatus = "connecting" | "open" | "closed";

export type WorldFeedHandlers = {
    onHello(hello: FeedHello): void;
    onTick(tick: FeedTick): void;
    onRoster(roster: FeedRoster): void;
    onStatus(status: FeedStatus, error?: string): void;
};

type Area = { x: number; z: number; w: number; h: number };

const MAX_RECONNECT_DELAY_MS = 15_000;
const INITIAL_RECONNECT_DELAY_MS = 300;
const HEARTBEAT_INTERVAL_MS = 30_000;
// The feed sends a tick about every 400 ms to a subscribed area, an empty one too. A socket that stays open with no
// data for this long is dead (a sleep or a network change can leave it half open), so it is dropped and opened again.
export const SILENT_FEED_MS = 15_000;
const SILENCE_CHECK_MS = 5_000;

// Keeps one WebSocket to the engine's /worldfeed open, re-subscribing after reconnects.
export class WorldFeedClient {
    ws?: WebSocket;
    status: FeedStatus = "closed";
    error?: string;
    hello?: FeedHello;

    area?: Area;
    roster: boolean = false;

    bytesReceived: number = 0;
    messagesReceived: number = 0;

    // While the tab is hidden nothing is drawn, so the feed streams nothing (the socket stays
    // open); showing it again resubscribes, and the server starts the area over (reset).
    // Read live: the page can be shown before the listener is added.
    private get hidden(): boolean {
        return typeof document !== "undefined" && document.hidden;
    }

    private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private silenceTimer?: ReturnType<typeof setInterval>;
    private lastDataAt = 0;
    private stopped = false;

    constructor(
        readonly url: string,
        readonly handlers: WorldFeedHandlers,
    ) {}

    connect(): void {
        this.stopped = false;
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
        this.open();
    }

    close(): void {
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.onVisibilityChange);
        }
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        clearInterval(this.silenceTimer);
        this.ws?.close();
        this.ws = undefined;
        this.setStatus("closed");
    }

    reconnect(): void {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        clearInterval(this.silenceTimer);
        const previous = this.ws;
        this.ws = undefined;
        if (previous && previous.readyState < WebSocket.CLOSING) {
            previous.close(1000, "Manual reconnect");
        }
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.error = undefined;
        this.stopped = false;
        this.open();
    }

    // Tile rectangle to stream, all levels. Only sent when it changes.
    setArea(x: number, z: number, w: number, h: number): void {
        const area = { x: x | 0, z: z | 0, w: w | 0, h: h | 0 };
        const current = this.area;
        if (
            current &&
            current.x === area.x &&
            current.z === area.z &&
            current.w === area.w &&
            current.h === area.h
        ) {
            return;
        }
        this.area = area;
        this.sendArea();
    }

    setRoster(on: boolean): void {
        if (this.roster === on) {
            return;
        }
        this.roster = on;
        this.sendRoster();
    }

    private onVisibilityChange = (): void => {
        // A hidden page subscribes to nothing, so the silence before it is shown again does not count.
        this.lastDataAt = Date.now();
        this.sendArea();
        this.sendRoster();
    };

    // True when an open socket that streams an area has sent nothing for SILENT_FEED_MS.
    isSilent(now: number): boolean {
        const area = this.area;
        return (
            this.ws?.readyState === WebSocket.OPEN &&
            !this.hidden &&
            !!area &&
            area.w > 0 &&
            area.h > 0 &&
            now - this.lastDataAt > SILENT_FEED_MS
        );
    }

    private dropSilent(ws: WebSocket): void {
        if (this.ws !== ws || !this.isSilent(Date.now())) {
            return;
        }
        // onclose of a half-open socket can come minutes later: forget it now and open a new one.
        clearInterval(this.heartbeatTimer);
        clearInterval(this.silenceTimer);
        this.ws = undefined;
        try {
            ws.close(4000, "No data");
        } catch {
            /* already closing */
        }
        this.setStatus("closed", `no data for ${SILENT_FEED_MS / 1000} s`);
        this.scheduleReconnect();
    }

    private open(): void {
        this.setStatus("connecting");
        let ws: WebSocket;
        try {
            ws = new WebSocket(this.url);
        } catch (e) {
            this.setStatus("closed", String(e));
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            if (this.stopped || this.ws !== ws) {
                ws.close();
                return;
            }
            this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
            this.lastDataAt = Date.now();
            this.setStatus("open");
            this.sendArea();
            if (this.roster) {
                this.sendRoster();
            }
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = setInterval(() => {
                if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ t: "ping" }));
                }
            }, HEARTBEAT_INTERVAL_MS);
            clearInterval(this.silenceTimer);
            this.silenceTimer = setInterval(() => this.dropSilent(ws), SILENCE_CHECK_MS);
        };

        ws.onmessage = (event) => {
            if (this.ws === ws) {
                this.lastDataAt = Date.now();
            }
            if (typeof event.data !== "string") {
                return;
            }
            this.bytesReceived += event.data.length;
            this.messagesReceived++;
            let msg: FeedMessage;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            switch (msg.t) {
                case "hello":
                    this.hello = msg;
                    this.handlers.onHello(msg);
                    break;
                case "tick":
                    this.handlers.onTick(msg);
                    break;
                case "roster":
                    this.handlers.onRoster(msg);
                    break;
            }
        };

        ws.onerror = () => {
            this.error = "connection error";
        };

        ws.onclose = (event) => {
            if (this.ws !== ws) {
                return;
            }
            clearInterval(this.heartbeatTimer);
            clearInterval(this.silenceTimer);
            this.ws = undefined;
            const reason =
                event.reason ||
                this.error ||
                (event.code !== 1000 ? `closed (${event.code})` : undefined);
            this.setStatus("closed", reason);
            this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped) {
            return;
        }
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }

    private sendArea(): void {
        if (this.area) {
            this.send(
                this.hidden ? { t: "sub", x: 0, z: 0, w: 0, h: 0 } : { t: "sub", ...this.area },
            );
        }
    }

    private sendRoster(): void {
        this.send({ t: "roster", on: this.roster && !this.hidden });
    }

    private send(msg: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private setStatus(status: FeedStatus, error?: string): void {
        this.status = status;
        this.error = error;
        this.handlers.onStatus(status, error);
    }
}
