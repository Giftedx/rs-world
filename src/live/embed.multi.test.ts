// The hidden-name rule for multi-view panes: a hidden name is never printed in a pane label and never
// sent in a message to the embedding page.

type Embed = typeof import("./embed");

function loadEmbed(search: string, fetchImpl?: jest.Mock): Embed {
    window.history.replaceState({}, "", "/" + search);
    (global as any).fetch = fetchImpl;
    let embed!: Embed;
    jest.isolateModules(() => {
        embed = require("./embed");
    });
    return embed;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a pane prints an ordinary name and nothing for a hidden one", () => {
    const embed = loadEmbed("?embed=1&hideNames=Secret,Other");
    expect(embed.paneLabel("Bob")).toBe("Bob");
    expect(embed.paneLabel("Secret")).toBe("");
    expect(embed.paneLabel("sEcReT")).toBe("");
    expect(embed.paneLabel("Other")).toBe("");
    expect(embed.paneLabel(embed.MAIN_MARK)).toBe("");
    expect(embed.paneLabel(undefined)).toBe("");
});

test("a message carries the marker in place of a hidden name", () => {
    const embed = loadEmbed("?embed=1&hideNames=Secret");
    expect(embed.paneMessageName("Bob")).toBe("Bob");
    expect(embed.paneMessageName("SECRET")).toBe(embed.MAIN_MARK);
    expect(embed.paneMessageName(embed.MAIN_MARK)).toBe(embed.MAIN_MARK);
    expect(embed.resolveFollow(embed.MAIN_MARK)).toBe("secret");
});

test("no name is printed until the hidden list has arrived", async () => {
    let deliver!: (list: string[]) => void;
    const fetchMock = jest.fn().mockReturnValue(
        new Promise((resolve) => {
            deliver = (list) => resolve({ json: () => Promise.resolve(list) });
        }),
    );
    const embed = loadEmbed("?embed=1&hideNamesFrom=http%3A%2F%2Fx%2Fhidden.json", fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embed.paneLabel("Bob")).toBe("");
    expect(embed.paneLabel("Secret")).toBe("");
    deliver(["Secret"]);
    await flush();
    await flush();
    expect(embed.paneLabel("Bob")).toBe("Bob");
    expect(embed.paneLabel("Secret")).toBe("");
    expect(embed.paneMessageName("Secret")).toBe(embed.MAIN_MARK);
});

test("a hidden list that fails to load still lets ordinary names print", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("down"));
    const embed = loadEmbed(
        "?embed=1&hideNames=Secret&hideNamesFrom=http%3A%2F%2Fx%2Fh.json",
        fetchMock,
    );
    expect(embed.paneLabel("Bob")).toBe("");
    await flush();
    await flush();
    expect(embed.paneLabel("Bob")).toBe("Bob");
    expect(embed.paneLabel("Secret")).toBe("");
});

test("the multi-view status is posted to the parent once per change", () => {
    const embed = loadEmbed("?embed=1");
    const post = jest.fn();
    const parent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage: post } });
    try {
        const status = { names: ["a", "b"], shown: ["a"], offline: [] };
        embed.postMultiStatus(status);
        embed.postMultiStatus({ ...status });
        embed.postMultiStatus({ ...status, shown: ["a", "b"] });
        embed.postMultiPick("b", 1);
        expect(post.mock.calls).toEqual([
            [{ viewerMulti: status }, "*"],
            [{ viewerMulti: { names: ["a", "b"], shown: ["a", "b"], offline: [] } }, "*"],
            [{ viewerMultiPick: "b", index: 1 }, "*"],
        ]);
    } finally {
        if (parent) {
            Object.defineProperty(window, "parent", parent);
        }
    }
});
