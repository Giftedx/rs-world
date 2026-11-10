// Gesture math for touch input. Touch mirrors the mouse: one finger drags like the left button,
// two fingers pan like a right drag and pinch like the wheel.

export interface TouchPoint {
    clientX: number;
    clientY: number;
}

// Wheel pixels per e-fold of pinch spread. Wheel zoom scales by exp(0.0015 per pixel) in ortho and
// while following, so there the view tracks the fingers.
export const PINCH_WHEEL_PIXELS = 1 / 0.0015;

// Pixels two fingers must move or spread before a guarded gesture counts as a pan or a pinch.
export const TWO_FINGER_INTENT_PIXELS = 16;

export type TwoFingerIntent = "undecided" | "pinch" | "pan";

export function getTouchMidpoint(a: TouchPoint, b: TouchPoint): [number, number] {
    return [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
}

// Finger spread in pixels, at least 1 so a ratio of two spreads is always finite.
export function getTouchDistance(a: TouchPoint, b: TouchPoint): number {
    return Math.max(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), 1);
}

// Wheel pixels for a change of finger spread. Spreading the fingers gives a negative delta (zoom
// in), as scrolling the wheel away from you does. Halving the spread doubles an orbit distance.
export function getPinchWheelDelta(lastDistance: number, distance: number): number {
    return Math.log(lastDistance / distance) * PINCH_WHEEL_PIXELS;
}

// Tells a pinch from a two-finger drag: whichever of the midpoint travel and the spread change
// first passes the threshold. A pinch always moves the midpoint a little; while a player is
// followed that drift must not pan, because a pan stops following.
export function getTwoFingerIntent(midpointTravel: number, spreadChange: number): TwoFingerIntent {
    const travel = Math.abs(midpointTravel);
    const spread = Math.abs(spreadChange);
    if (Math.max(travel, spread) < TWO_FINGER_INTENT_PIXELS) {
        return "undecided";
    }
    return spread >= travel ? "pinch" : "pan";
}
