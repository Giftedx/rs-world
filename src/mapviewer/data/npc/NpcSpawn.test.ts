jest.mock("./npc-spawns-2004.json?url", () => "/static/media/npc-spawns-2004.json", {
    virtual: true,
});
jest.mock("./npc-spawns-2009.json?url", () => "/static/media/npc-spawns-2009.json", {
    virtual: true,
});
jest.mock("./npc-spawns-osrs.json?url", () => "/static/media/npc-spawns-osrs.json", {
    virtual: true,
});

describe("NpcSpawn memoization and single-rev guard", () => {
    const origFetch = (globalThis as any).fetch;
    const origRev = process.env.REACT_APP_CACHE_REV;

    afterEach(() => {
        (globalThis as any).fetch = origFetch;
        if (origRev === undefined) {
            delete process.env.REACT_APP_CACHE_REV;
        } else {
            process.env.REACT_APP_CACHE_REV = origRev;
        }
    });

    test("memoizes concurrent and repeat fetchNpcSpawns calls and evicts failures", async () => {
        const spawns = [{ id: 1, x: 3200, y: 3200, level: 0 }];
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 })
            .mockResolvedValue({ ok: true, json: async () => spawns });
        (globalThis as any).fetch = fetchMock;

        const { fetchNpcSpawns, clearNpcSpawnsCache } = require("./NpcSpawn");
        clearNpcSpawnsCache();

        await expect(fetchNpcSpawns("/npc-spawns-2004.json")).rejects.toThrow(/503/);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [a, b] = await Promise.all([
            fetchNpcSpawns("/npc-spawns-2004.json"),
            fetchNpcSpawns("/npc-spawns-2004.json"),
        ]);
        const c = await fetchNpcSpawns("/npc-spawns-2004.json");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(a).toBe(spawns);
        expect(b).toBe(spawns);
        expect(c).toBe(spawns);
    });

    test("excludes oldschool and >474 spawn bundles when REACT_APP_CACHE_REV=289", () => {
        process.env.REACT_APP_CACHE_REV = "289";
        let NpcSpawn!: typeof import("./NpcSpawn");
        jest.isolateModules(() => {
            NpcSpawn = require("./NpcSpawn");
        });
        expect(
            NpcSpawn.getNpcSpawnsUrl({
                name: "rs-sdk-289",
                game: "runescape",
                environment: "live",
                revision: 289,
                timestamp: "",
                size: 1,
            }),
        ).toBe("/static/media/npc-spawns-2004.json");
        expect(() =>
            NpcSpawn.getNpcSpawnsUrl({
                name: "osrs",
                game: "oldschool",
                environment: "live",
                revision: 220,
                timestamp: "",
                size: 1,
            }),
        ).toThrow(/excluded/i);
        expect(() =>
            NpcSpawn.getNpcSpawnsUrl({
                name: "rs2-2009",
                game: "runescape",
                environment: "live",
                revision: 550,
                timestamp: "",
                size: 1,
            }),
        ).toThrow(/excluded/i);
    });
});
