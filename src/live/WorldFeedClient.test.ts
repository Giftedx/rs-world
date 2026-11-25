// Unit tests for the world feed client's silence check: an open socket that streams an area and gets no data for
// SILENT_FEED_MS is dropped and opened again; a socket with no area, or on a hidden page, is kept.
import { SILENT_FEED_MS, WorldFeedClient } from "./WorldFeedClient";

class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static made: FakeSocket[] = [];
    readyState = FakeSocket.CONNECTING;
    sent: string[] = [];
    closed?: [number | undefined, string | undefined];
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onerror?: () => void;
    onclose?: (e: unknown) => void;
    constructor(readonly url: string) {
        FakeSocket.made.push(this);
    }
    send(s: string): void {
        this.sent.push(s);
    }
    close(code?: number, reason?: string): void {
        this.closed = [code, reason];
        this.readyState = FakeSocket.CLOSING;
    }
    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }
}

function handlers() {
    const statuses: string[] = [];
    return {
        statuses,
        onHello() {},
        onTick() {},
        onRoster() {},
        onStatus(status: string, error?: string) {
            statuses.push(error ? `${status}: ${error}` : status);
        },
    };
}

const realWebSocket = (global as any).WebSocket;
beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.made = [];
    (global as any).WebSocket = FakeSocket;
});
afterEach(() => {
    jest.useRealTimers();
    (global as any).WebSocket = realWebSocket;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

test("an open socket that streams an area and gets no data for 15 s is dropped and opened again", () => {
    const h = handlers();
    const feed = new WorldFeedClient("ws://feed/worldfeed", h as any);
    feed.connect();
    const first = FakeSocket.made[0];
    first.open();
    feed.setArea(3200, 3200, 64, 64);

    jest.advanceTimersByTime(SILENT_FEED_MS - 1000);
    first.onmessage!({ data: JSON.stringify({ t: "tick", k: 1 }) });
    jest.advanceTimersByTime(SILENT_FEED_MS - 1000);
    expect(first.closed).toBeUndefined();

    // The check runs every 5 s, and the new socket opens 300 ms after the drop.
    jest.advanceTimersByTime(6000);
    expect(first.closed).toEqual([4000, "No data"]);
    expect(h.statuses).toContain("closed: no data for 15 s");
    expect(FakeSocket.made).toHaveLength(2);
    expect(feed.ws).toBe(FakeSocket.made[1]);

    // The dropped socket's late close does not open a third one.
    first.onclose?.({ code: 1006, reason: "" });
    jest.advanceTimersByTime(20_000);
    expect(FakeSocket.made).toHaveLength(2);
    feed.close();
});

test("a socket with no area is kept: the feed sends nothing to it", () => {
    const feed = new WorldFeedClient("ws://feed/worldfeed", handlers() as any);
    feed.connect();
    FakeSocket.made[0].open();
    jest.advanceTimersByTime(SILENT_FEED_MS * 3);
    expect(FakeSocket.made[0].closed).toBeUndefined();
    expect(FakeSocket.made).toHaveLength(1);
    feed.close();
});

test("a hidden page subscribes to nothing, so its silence does not drop the socket", () => {
    const feed = new WorldFeedClient("ws://feed/worldfeed", handlers() as any);
    feed.connect();
    FakeSocket.made[0].open();
    feed.setArea(3200, 3200, 64, 64);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    jest.advanceTimersByTime(SILENT_FEED_MS * 3);
    expect(FakeSocket.made[0].closed).toBeUndefined();

    // Shown again: the silence counts from then.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    jest.advanceTimersByTime(SILENT_FEED_MS - 1000);
    expect(FakeSocket.made[0].closed).toBeUndefined();
    jest.advanceTimersByTime(6000);
    expect(FakeSocket.made[0].closed).toEqual([4000, "No data"]);
    feed.close();
});
