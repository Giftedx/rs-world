import { useCallback, useEffect, useRef, useState } from "react";
import { Joystick } from "react-joystick-component";
import { useSearchParams } from "react-router-dom";

import { RendererCanvas } from "../components/renderer/RendererCanvas";
import { OsrsMenu, OsrsMenuProps } from "../components/rs/menu/OsrsMenu";
import { MinimapContainer } from "../components/rs/minimap/MinimapContainer";
import { WorldMapMarker } from "../components/rs/worldmap/WorldMap";
import { WorldMapModal } from "../components/rs/worldmap/WorldMapModal";
import { InfoPanel } from "../live/InfoPanel";
import { LiveOverlay } from "../live/LiveOverlay";
import { LivePanel } from "../live/LivePanel";
import { parseMultiDistance, parseMultiNames } from "../live/MultiLayout";
import { markers } from "../live/Markers";
import { EMBED, PROBE, isFloor, isFrameLimit, isResolutionScale, resolveFollow } from "../live/embed";
import { RS_TO_DEGREES } from "../rs/MathConstants";
import { isMobileDevice, isTouchDevice } from "../util/DeviceUtil";
import { MapViewer } from "./MapViewer";
import "./MapViewerContainer.css";
import { MapViewerControls } from "./MapViewerControls";
import { MapViewerRenderer } from "./MapViewerRenderer";

interface MapViewerContainerProps {
    mapViewer: MapViewer;
}

// Hosts the live overlay canvas (names, chat, hitsplats) above the GL canvas, under the HUD.
function LiveOverlayCanvas({ renderer }: { renderer: MapViewerRenderer }): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const overlay: LiveOverlay | undefined = (renderer as { liveOverlay?: LiveOverlay })
            .liveOverlay;
        const container = ref.current;
        if (!overlay || !container) {
            return;
        }
        container.appendChild(overlay.canvas);
        return () => {
            overlay.canvas.remove();
        };
    }, [renderer]);

    return <div ref={ref} className="live-overlay-container" />;
}

// The info panel and the live panel's player list render only while their box is displayed. An embedding page that
// hides them (display: none, as the dashboard's client-viewer.css does) has no box to intersect, so the sorted list of
// every player online is not rebuilt four times a second for nothing. The live panel itself stays: the dashboard's
// bridge presses its "Stop" button to free the camera.
function LiveHud({ mapViewer }: { mapViewer: MapViewer }): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(typeof IntersectionObserver === "undefined");
    useEffect(() => {
        const box = ref.current;
        if (!box || typeof IntersectionObserver === "undefined") {
            return;
        }
        const observer = new IntersectionObserver((entries) =>
            setShown(entries[entries.length - 1].isIntersecting),
        );
        observer.observe(box);
        return () => observer.disconnect();
    }, []);
    return (
        <div className="live-hud" ref={ref}>
            {shown && <InfoPanel />}
            <LivePanel mapViewer={mapViewer} listShown={shown} />
        </div>
    );
}

export function MapViewerContainer({ mapViewer }: MapViewerContainerProps): JSX.Element {
    const [searchParams, setSearchParams] = useSearchParams();

    const renderer = mapViewer.renderer;

    // ?embed=1 (the swarm dashboard): no settings panel, live/info panels, minimap or joysticks.
    const [hideUi, setHideUi] = useState(EMBED);
    const [fps, setFps] = useState(0);
    const [cameraYaw, setCameraYaw] = useState(mapViewer.camera.getYaw());
    const [isWorldMapOpen, setWorldMapOpen] = useState<boolean>(false);
    // With several views the minimap would cover the top-left one, so it's hidden.
    const [isMultiView, setMultiView] = useState<boolean>(false);

    const [menuProps, setMenuProps] = useState<OsrsMenuProps | undefined>(undefined);

    const requestRef = useRef<number | undefined>();

    useEffect(() => {
        if (process.env.NODE_ENV === "development" || PROBE) {
            // Handy for poking at live state from the devtools console. Use the renderer's
            // viewer: in StrictMode the app builds two viewers and the first one renders.
            (window as any).mapViewer = renderer.mapViewer;
        }
    }, [renderer]);

    // Embedded use (the swarm dashboard): change the followed player, frame cap or resolution by postMessage,
    // so the parent never reloads the frame. ?fps=N caps the frame rate from the start.
    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        const fps = Number(q.get("fps"));
        if (isFrameLimit(fps)) renderer.fpsLimit = fps;
        // ?scale=0.5 renders at half resolution: about a quarter of the pixel work.
        const scale = Number(q.get("scale"));
        if (isResolutionScale(scale)) renderer.resolutionScale = scale;
        const onMessage = (e: MessageEvent) => {
            const d = e.data;
            if (!d || typeof d !== "object") return;
            // Only the embedding page (or this window) drives the view: another window or frame could otherwise
            // set a frame rate or resolution that stops or crashes it.
            if (e.source !== window.parent && e.source !== window) return;
            // {multi: [names...]} shows those players side by side (at most 16); {multi: []} returns to the
            // single view. {multiDistance: tiles} sets the panes' view distance.
            const md = parseMultiDistance(d.multiDistance);
            if (md !== undefined) renderer.mapViewer.setMultiDistance(md);
            if (Array.isArray(d.multi)) renderer.mapViewer.setMulti(parseMultiNames(d.multi));
            // {multiChrome: false}: the page draws the pane names and frames. {multiLayout: {...}} sets the tiling,
            // {multiOrder: [names]} reorders the panes and {multiFocus: name | number} selects one.
            if (typeof d.multiChrome === "boolean") renderer.mapViewer.setMultiChrome(d.multiChrome);
            if (d.multiLayout) renderer.mapViewer.setMultiLayout(d.multiLayout);
            if (Array.isArray(d.multiOrder)) renderer.mapViewer.setMultiOrder(parseMultiNames(d.multiOrder));
            if (typeof d.multiFocus === "string" || Number.isInteger(d.multiFocus)) renderer.mapViewer.setMultiFocus(d.multiFocus);
            const live = renderer.mapViewer.live;
            if (typeof d.follow === "string" && live) {
                // The asked name, with the hidden-name mark resolved: a mark for the player already followed is no
                // change. A follow of the current player also drops an older ask that is still waiting (an offline
                // player), so that player's login later does not take the camera.
                const asked = (resolveFollow(d.follow) ?? d.follow).toLowerCase();
                if (live.followName?.toLowerCase() !== asked) live.pendingFollow = d.follow;
                else live.pendingFollow = undefined;
            }
            if (isFrameLimit(d.fps)) renderer.fpsLimit = d.fps;
            if (isResolutionScale(d.scale)) renderer.resolutionScale = d.scale;
            // {overlay: {...}}: the highlights to draw (Markers.ts); each message replaces the ones before.
            if (d.overlay !== undefined) markers.setOverlay(d.overlay);
            // {capture: {id}}: the next frame as a JPEG, sent back as {viewerCapture: {id, url}} to the origin that asked.
            if (d.capture && typeof d.capture.id === "string" && d.capture.id.length > 0 && e.source === window.parent && e.origin !== "null")
                renderer.requestCapture(d.capture.id.slice(0, 40), e.origin);
            // Roof removal: the page names the highest floor to draw.
            if (isFloor(d.maxLevel)) renderer.setFloorLimit(d.maxLevel);
            // {warm: [[x, z], ...]} lists the places the page may follow next.
            if (Array.isArray(d.warm)) {
                const isTile = (t: unknown): t is [number, number] =>
                    Array.isArray(t) && Number.isFinite(t[0]) && Number.isFinite(t[1]);
                renderer.setWarmTiles(d.warm.filter(isTile).slice(0, 16));
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [renderer]);

    // The React state changes only after the renderer draws a frame: with a frame limit (?fps=20) on a fast screen,
    // most display frames draw nothing, and a state change on each of them re-rendered this tree for no new picture.
    const shownFrame = useRef(-1);
    const shownMenu = useRef("");
    // The fps counter changes twice a second: each change re-renders this tree.
    const fpsShownAt = useRef(0);

    const animate = (time: DOMHighResTimeStamp) => {
        // The address holds the camera and the followed name; an embedding page reads them from it. It is written
        // 200 ms after the camera rests, and every 500 ms while it keeps moving: a followed player moves it every frame,
        // so a wait for rest alone never wrote the address while following.
        if (mapViewer.needsSearchParamUpdate) {
            const now = performance.now();
            if (
                now - mapViewer.lastTimeSearchParamsUpdated > 200 ||
                now - mapViewer.searchParamsWrittenAt > 500
            ) {
                setSearchParams(mapViewer.getSearchParams(), { replace: true });
                mapViewer.needsSearchParamUpdate = false;
                mapViewer.searchParamsWrittenAt = now;
            }
        }

        const frame = renderer.stats.frameCount;
        if (frame !== shownFrame.current) {
            shownFrame.current = frame;
            if (!hideUi) {
                setMultiView(!!mapViewer.multi);
                if (time - fpsShownAt.current >= 500) {
                    fpsShownAt.current = time;
                    setFps(Math.round(renderer.stats.frameTimeFps));
                }
                setCameraYaw(mapViewer.camera.getYaw());
            }

            const entries = mapViewer.menuEntries;
            if (entries.length > 0 && mapViewer.menuX !== -1 && mapViewer.menuY !== -1) {
                // The renderer builds a new list each frame: an unchanged menu keeps its props.
                let key = `${mapViewer.menuX},${mapViewer.menuY},${mapViewer.menuOpen}`;
                for (const e of entries) {
                    key += `|${e.option}:${e.targetType}:${e.targetId}:${e.targetName}:${e.targetLevel}`;
                }
                if (key !== shownMenu.current) {
                    shownMenu.current = key;
                    setMenuProps({
                        x: mapViewer.menuX,
                        y: mapViewer.menuY,
                        tooltip: !mapViewer.menuOpen,
                        entries,
                    });
                }
            } else if (shownMenu.current !== "") {
                shownMenu.current = "";
                setMenuProps(undefined);
            }
        }

        requestRef.current = requestAnimationFrame(animate);
    };

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(requestRef.current!);
    }, [searchParams, hideUi]);

    const resetCameraYaw = useCallback(() => {
        mapViewer.camera.setYaw(0);
    }, [mapViewer]);

    const openWorldMap = useCallback(() => {
        setWorldMapOpen(true);
    }, []);

    const closeWorldMap = useCallback(() => {
        setWorldMapOpen(false);
        renderer.canvas.focus();
    }, [renderer]);

    const onMapClicked = useCallback(
        (x: number, y: number) => {
            mapViewer.live?.unfollow(true);
            mapViewer.camera.pos[0] = x;
            mapViewer.camera.pos[2] = y;
            mapViewer.camera.updated = true;
            closeWorldMap();
        },
        [mapViewer, closeWorldMap],
    );

    const getMapPosition = useCallback(() => {
        const x = mapViewer.camera.getPosX();
        const y = mapViewer.camera.getPosZ();

        return {
            x,
            y,
        };
    }, [mapViewer]);

    // Live players on the world map: everyone online from the feed's roster, plus the camera.
    const getWorldMapMarkers = useCallback((): WorldMapMarker[] => {
        const markers: WorldMapMarker[] = [];
        const live = mapViewer.live;
        if (live) {
            const followed = live.followName?.toLowerCase();
            for (const [slot, name, x, z, level, combat] of live.world.rosterPlayers) {
                markers.push({
                    key: "p" + slot,
                    x,
                    y: z,
                    label: `${name} (level-${combat})${level > 0 ? `, floor ${level}` : ""}`,
                    color: name.toLowerCase() === followed ? "#ff981f" : "#ffffff",
                });
            }
        }
        markers.push({
            key: "camera",
            x: mapViewer.camera.getPosX(),
            y: mapViewer.camera.getPosZ(),
            label: "Camera",
            color: "#00ffff",
        });
        return markers;
    }, [mapViewer]);

    const onWorldMapMarkerClick = useCallback(
        (marker: WorldMapMarker) => {
            const live = mapViewer.live;
            if (!live || marker.key === "camera") {
                return;
            }
            const entry = live.world.rosterPlayers.find((p) => "p" + p[0] === marker.key);
            if (entry) {
                live.goToPlayer(entry[1], mapViewer.camera);
                closeWorldMap();
            }
        },
        [mapViewer, closeWorldMap],
    );

    const loadMapImageUrl = useCallback(
        (mapX: number, mapY: number) => {
            return mapViewer.getMapImageUrl(mapX, mapY, false);
        },
        [mapViewer],
    );

    const loadMinimapImageUrl = useCallback(
        (mapX: number, mapY: number) => {
            return mapViewer.getMapImageUrl(mapX, mapY, true);
        },
        [mapViewer],
    );

    return (
        <div className={"map-viewer max-height" + (isMobileDevice ? " mobile" : "")}>
            <LiveOverlayCanvas renderer={renderer} />

            {menuProps && <OsrsMenu {...menuProps} />}

            <MapViewerControls renderer={renderer} hideUi={hideUi || EMBED} setHideUi={EMBED ? () => {} : setHideUi} />

            {!hideUi && (
                <span>
                    <div className="hud left-top">
                        {!isMultiView && (
                            <MinimapContainer
                                yawDegrees={(2047 - cameraYaw) * RS_TO_DEGREES}
                                onCompassClick={resetCameraYaw}
                                onWorldMapClick={openWorldMap}
                                getPosition={getMapPosition}
                                loadMapImageUrl={loadMinimapImageUrl}
                            />
                        )}

                        <div className="fps-counter content-text">{fps}</div>
                        <div className="fps-counter content-text">{mapViewer.debugText}</div>
                    </div>
                    <LiveHud mapViewer={mapViewer} />
                    <WorldMapModal
                        isOpen={isWorldMapOpen}
                        onRequestClose={closeWorldMap}
                        onDoubleClick={onMapClicked}
                        getPosition={getMapPosition}
                        loadMapImageUrl={loadMapImageUrl}
                        getMarkers={getWorldMapMarkers}
                        onMarkerClick={onWorldMapMarkerClick}
                    />
                </span>
            )}

            {!hideUi && isTouchDevice && (
                <div className="joystick-container left" role="group" aria-label="Move camera">
                    <Joystick
                        size={75}
                        baseColor="radial-gradient(circle, #3e3529, #211d17)"
                        stickColor="radial-gradient(circle at 40% 30%, #b39b70, #6d593c)"
                        stickSize={40}
                        move={mapViewer.inputManager.onPositionJoystickMove}
                        stop={mapViewer.inputManager.onPositionJoystickStop}
                    ></Joystick>
                </div>
            )}

            <RendererCanvas renderer={renderer} />
        </div>
    );
}
