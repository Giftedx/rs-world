import { MarkerStore, groundColour, shortValue } from "./Markers";

describe("markers", () => {
    test("an overlay message keeps only valid marks, within the caps", () => {
        const m = new MarkerStore();
        m.setOverlay({
            tiles: [
                { x: 3100, z: 3700, l: 0, colour: "#ff0000", label: "Death", fill: true },
                { x: -1, z: 3700, l: 0, colour: "#ff0000" },
                { x: 3100, z: 3700, l: 9, colour: "#ff0000" },
                { x: 3100, z: 3700, l: 0, colour: "red" },
            ],
            pies: [{ x: 3059, z: 3884, l: 0, p: 0.25 }, { x: 3059, z: 3884, l: 0, p: 2 }],
            lines: [{ x0: 3008, z0: 3520, x1: 3392, z1: 3520, l: 0, colour: "#ff0000", label: "Wilderness 1" }],
            players: { goondelf: "#00ffff", "Bad Name!": "#ffffff", ours: "#00ff00" },
            npcs: [{ types: [1, 2, -5], nids: [77], colour: "#00ffff" }, { types: [3] }],
            ground: { prices: { "Rune scimitar": 15000, Bad: -1 }, min: 1000 },
        });
        expect(m.tiles).toEqual([{ x: 3100, z: 3700, l: 0, colour: "#ff0000", label: "Death", fill: true, size: 1 }]);
        expect(m.pies).toEqual([{ x: 3059, z: 3884, l: 0, p: 0.25 }]);
        expect(m.lines.length).toBe(1);
        expect(m.playerColour("Goondelf")).toBe("#00ffff");
        expect(m.playerColour("Bad Name!")).toBeUndefined();
        expect(m.npcColour(77, 999)).toBe("#00ffff");
        expect(m.npcColour(5, 2)).toBe("#00ffff");
        expect(m.npcColour(5, 3)).toBeUndefined();
        expect(m.groundOn).toBe(true);
        expect(m.groundPrices.get("rune scimitar")).toBe(15000);
        expect(m.groundPrices.has("bad")).toBe(false);
        expect(m.groundMin).toBe(1000);
        m.setOverlay({ tiles: Array.from({ length: 700 }, () => ({ x: 1, z: 1, l: 0, colour: "#ffffff" })) });
        expect(m.tiles.length).toBe(600);
        expect(m.players.size).toBe(0);
        expect(m.groundOn).toBe(false);
    });

    test("floor item values use RuneLite's tiers and short forms", () => {
        expect(groundColour(500)).toBe("#ffffff");
        expect(groundColour(20_000)).toBe("#66b2ff");
        expect(groundColour(150_000)).toBe("#99ff99");
        expect(groundColour(2_000_000)).toBe("#ff9600");
        expect(groundColour(10_000_000)).toBe("#ff66b2");
        expect(shortValue(950)).toBe("950");
        expect(shortValue(1250)).toBe("1.2K");
        expect(shortValue(15000)).toBe("15K");
        expect(shortValue(3_400_000)).toBe("3.4M");
        expect(shortValue(12_000_000)).toBe("12M");
    });
});
