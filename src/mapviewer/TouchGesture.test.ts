import { InputManager } from "./InputManager";
import {
    PINCH_WHEEL_PIXELS,
    TWO_FINGER_INTENT_PIXELS,
    getPinchWheelDelta,
    getTouchDistance,
    getTouchMidpoint,
    getTwoFingerIntent,
} from "./TouchGesture";

const at = (clientX: number, clientY: number) => ({ clientX, clientY });

describe("gesture math", () => {
    test("the midpoint of two fingers is their centroid", () => {
        expect(getTouchMidpoint(at(100, 40), at(300, 240))).toEqual([200, 140]);
    });

    test("a two-finger drag moves the midpoint by the drag and keeps the spread", () => {
        const before = getTouchMidpoint(at(100, 100), at(200, 100));
        const after = getTouchMidpoint(at(130, 60), at(230, 60));
        expect([after[0] - before[0], after[1] - before[1]]).toEqual([30, -40]);
        expect(getTouchDistance(at(130, 60), at(230, 60))).toBe(100);
    });

    test("the spread is the distance between the fingers, never under 1", () => {
        expect(getTouchDistance(at(0, 0), at(30, 40))).toBe(50);
        expect(getTouchDistance(at(7, 7), at(7, 7))).toBe(1);
    });

    test("spreading the fingers zooms in, closing them zooms out, by the same amount", () => {
        expect(getPinchWheelDelta(100, 200)).toBeLessThan(0);
        expect(getPinchWheelDelta(200, 100)).toBeCloseTo(-getPinchWheelDelta(100, 200));
        expect(getPinchWheelDelta(150, 150)).toBe(0);
    });

    test("the orbit distance follows the fingers: half the spread, twice the distance", () => {
        // LiveController.zoom and the ortho zoom scale by exp(wheelDelta * 0.0015).
        const scale = (wheelDelta: number) => Math.exp(wheelDelta * 0.0015);
        expect(scale(getPinchWheelDelta(200, 100))).toBeCloseTo(2);
        expect(scale(getPinchWheelDelta(100, 200))).toBeCloseTo(0.5);
        expect(PINCH_WHEEL_PIXELS).toBeCloseTo(1 / 0.0015);
    });

    test("pinch steps add up to the same zoom as one step", () => {
        const steps = getPinchWheelDelta(100, 130) + getPinchWheelDelta(130, 180);
        expect(steps).toBeCloseTo(getPinchWheelDelta(100, 180));
    });

    test("two fingers are a pinch or a pan by whichever moves further first", () => {
        expect(getTwoFingerIntent(TWO_FINGER_INTENT_PIXELS - 1, 3)).toBe("undecided");
        expect(getTwoFingerIntent(6, 40)).toBe("pinch");
        expect(getTwoFingerIntent(6, -40)).toBe("pinch");
        expect(getTwoFingerIntent(40, 6)).toBe("pan");
        // One finger still, the other moving: the midpoint travels half the spread change.
        expect(getTwoFingerIntent(20, 40)).toBe("pinch");
    });
});

describe("InputManager touch", () => {
    function setup() {
        const element = document.createElement("canvas");
        element.getBoundingClientRect = () => ({ left: 10, top: 20 }) as DOMRect;
        const input = new InputManager();
        input.init(element);
        const fire = (type: string, ...targetTouches: { clientX: number; clientY: number }[]) => {
            const event = new Event(type, { cancelable: true });
            Object.assign(event, { targetTouches, touches: targetTouches });
            element.dispatchEvent(event);
            return event;
        };
        return { element, input, fire };
    }

    test("one finger drags like the left button and the page does not scroll", () => {
        const { input, fire } = setup();
        expect(fire("touchstart", at(110, 120)).defaultPrevented).toBe(true);
        expect(fire("touchmove", at(140, 100)).defaultPrevented).toBe(true);
        expect(input.isDragging()).toBe(true);
        expect([input.getDeltaMouseX(), input.getDeltaMouseY()]).toEqual([-30, 20]);
        expect([input.getPanDeltaX(), input.getPanDeltaY()]).toEqual([0, 0]);
        expect(input.takeWheelDelta()).toBe(0);

        input.onFrameEnd();
        expect([input.getDeltaMouseX(), input.getDeltaMouseY()]).toEqual([0, 0]);

        fire("touchend");
        expect(input.isDragging()).toBe(false);
    });

    test("two fingers pan by the midpoint and zoom by the spread", () => {
        const { input, fire } = setup();
        fire("touchstart", at(100, 100), at(200, 100));
        fire("touchmove", at(120, 130), at(320, 130));
        expect(input.isDragging()).toBe(false);
        expect([input.getPanDeltaX(), input.getPanDeltaY()]).toEqual([70, 30]);
        expect(input.takeWheelDelta()).toBeCloseTo(getPinchWheelDelta(100, 200));
        expect(input.takeWheelDelta()).toBe(0);
    });

    test("while following, a pinch zooms and its midpoint drift does not pan", () => {
        const { input, fire } = setup();
        input.guardTouchPan = true;
        fire("touchstart", at(100, 100), at(200, 100));
        // Only the second finger moves: the midpoint drifts by half the spread change.
        fire("touchmove", at(100, 100), at(260, 100));
        input.onFrameEnd();
        fire("touchmove", at(100, 100), at(300, 100));
        expect([input.getPanDeltaX(), input.getPanDeltaY()]).toEqual([0, 0]);
        expect(input.takeWheelDelta()).toBeCloseTo(getPinchWheelDelta(100, 200));
    });

    test("while following, a two-finger drag pans after it passes the threshold", () => {
        const { input, fire } = setup();
        input.guardTouchPan = true;
        fire("touchstart", at(100, 100), at(200, 100));
        fire("touchmove", at(110, 100), at(210, 100));
        expect(input.getPanDeltaX()).toBe(0);
        fire("touchmove", at(130, 100), at(230, 100));
        // The travel that decided it is not panned.
        expect(input.getPanDeltaX()).toBe(0);
        fire("touchmove", at(150, 100), at(250, 100));
        expect([input.getPanDeltaX(), input.getPanDeltaY()]).toEqual([20, 0]);
    });

    test("lifting one of two fingers carries on as a drag without a jump", () => {
        const { input, fire } = setup();
        fire("touchstart", at(100, 100), at(200, 100));
        fire("touchmove", at(150, 150), at(250, 150));
        fire("touchend", at(250, 150));
        expect(input.isPanning()).toBe(false);
        expect(input.isDragging()).toBe(true);
        expect([input.getDeltaMouseX(), input.getDeltaMouseY()]).toEqual([0, 0]);
    });

    test("a finger held off the scene, as on the joystick, does not make a pinch", () => {
        const { element, input } = setup();
        const start = new Event("touchstart", { cancelable: true });
        Object.assign(start, {
            targetTouches: [at(110, 120)],
            touches: [at(40, 500), at(110, 120)],
        });
        element.dispatchEvent(start);
        expect(input.isDragging()).toBe(true);
        expect(input.isPanning()).toBe(false);
    });
});
