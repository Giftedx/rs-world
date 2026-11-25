// Unit tests for the bounds on the frame limit and the resolution scale that the URL and the embedding page may set.
import { isFrameLimit, isResolutionScale } from "./embed";

test("a frame limit is 1 to 999 frames a second", () => {
    for (const ok of [1, 20, 60, 999, 1.5]) expect(isFrameLimit(ok)).toBe(true);
    for (const bad of [0, 0.001, -5, 1000, NaN, Infinity, "20", null, undefined])
        expect(isFrameLimit(bad)).toBe(false);
});

test("a resolution scale is 0.1 to 4 rendered pixels per CSS pixel", () => {
    for (const ok of [0.1, 0.5, 1, 2, 4]) expect(isResolutionScale(ok)).toBe(true);
    for (const bad of [0, 0.05, 4.5, 40, -1, NaN, "1", null])
        expect(isResolutionScale(bad)).toBe(false);
});
