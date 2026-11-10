import { vec3 } from "gl-matrix";
import { URLSearchParamsInit } from "react-router-dom";

import { OsrsMenuEntry } from "../components/rs/menu/OsrsMenu";
import { LiveController, MAX_AREA_RADIUS, getDefaultFeedUrl } from "../live/LiveController";
import {
    DEFAULT_GAP,
    DEFAULT_MULTI_DISTANCE,
    DEFAULT_RATIO,
    LayoutOptions,
    MAX_PANES,
    parseGap,
    parseLayoutMode,
    parseMultiDistance,
    parseMultiNames,
    parseRatio,
    reorderBy,
} from "../live/MultiLayout";
import { MultiPane, MultiView } from "../live/MultiView";
import {
    EMBED,
    paneMessageName,
    postMultiLayout,
    postMultiPick,
    postMultiStatus,
} from "../live/embed";
import { WorldState } from "../live/WorldState";
import { MenuTargetType } from "../rs/MenuEntry";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { CacheLoaderFactory, getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { BasTypeLoader } from "../rs/config/bastype/BasTypeLoader";
import { LocTypeLoader } from "../rs/config/loctype/LocTypeLoader";
import { NpcTypeLoader } from "../rs/config/npctype/NpcTypeLoader";
import { ObjTypeLoader } from "../rs/config/objtype/ObjTypeLoader";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { VarManager } from "../rs/config/vartype/VarManager";
import { MapFileIndex, getMapSquareId } from "../rs/map/MapFileIndex";
import { SeqFrameLoader } from "../rs/model/seq/SeqFrameLoader";
import { Pathfinder } from "../rs/pathfinder/Pathfinder";
import { TextureLoader } from "../rs/texture/TextureLoader";
import { isTouchDevice } from "../util/DeviceUtil";
import { LoadedCache } from "./Caches";
import { Camera, CameraView, ProjectionType } from "./Camera";
import { InputManager } from "./InputManager";
import { MapManager } from "./MapManager";
import { MapViewerRenderer } from "./MapViewerRenderer";
import { NpcSpawn } from "./data/npc/NpcSpawn";
import { WebGLMapViewerRenderer } from "./webgl/WebGLMapViewerRenderer";
import { RenderDataWorkerPool } from "./worker/RenderDataWorkerPool";

const CACHED_MAP_IMAGE_PREFIX = "/map-images/";

export class MapViewer {
    inputManager: InputManager = new InputManager();
    camera: Camera = new Camera(3242, -26, 3202, -245, 1862);

    pathfinder: Pathfinder = new Pathfinder();

    renderer: MapViewerRenderer;

    // Cache
    loadedCache!: LoadedCache;
    cacheSystem!: CacheSystem;
    loaderFactory!: CacheLoaderFactory;

    textureLoader!: TextureLoader;
    seqTypeLoader!: SeqTypeLoader;
    seqFrameLoader!: SeqFrameLoader;

    locTypeLoader!: LocTypeLoader;
    objTypeLoader!: ObjTypeLoader;
    npcTypeLoader!: NpcTypeLoader;

    basTypeLoader!: BasTypeLoader;

    varManager!: VarManager;

    mapFileIndex!: MapFileIndex;

    isNewTextureAnim: boolean = false;

    // Settings

    // Tile distance. Follows the zoom: the renderer sets it every frame.
    renderDistance: number = 128;
    // Map square distance
    unloadDistance: number = 2;
    // Map square distance
    lodDistance: number = 3;

    tooltips: boolean = !isTouchDevice;

    // State
    needsSearchParamUpdate: boolean = false;
    lastTimeSearchParamsUpdated: number = 0;

    menuOpen: boolean = false;
    menuOpenedFrame: number = 0;
    menuX: number = -1;
    menuY: number = -1;
    menuEntries: OsrsMenuEntry[] = [];

    debugText?: string;

    mapImageUrls: Map<number, string> = new Map();
    minimapImageUrls: Map<number, string> = new Map();
    loadingMapImageIds: Set<number> = new Set();

    cameraSpeed: number = 1;

    // Live world feed (players + npcs from an rs-sdk server). ?live=<ws url> overrides the
    // default, ?live=off disables it.
    liveUrl: string | undefined = getDefaultFeedUrl();
    liveParam: string | undefined;
    live?: LiveController;
    followParam: string | undefined;
    // Locs, ground objs, projectiles and map anims from every feed (one store for all views).
    worldState?: WorldState;

    // Multi-view (?multi=a,b,c or a {multi: [...]} message): one renderer, up to 16 panes that each
    // follow a player. While it is on, camera and live are the selected pane's.
    multi?: MultiView;
    // The names asked for, kept for a feed that starts later.
    multiNames?: string[];
    // Pane view distance in tiles (?md=).
    multiRenderDistance: number = DEFAULT_MULTI_DISTANCE;
    // The tiling of the panes (?tile=<mode> or a {multiLayout} message), kept for a multi-view
    // that starts later.
    multiLayout: LayoutOptions = { mode: "grid", gap: DEFAULT_GAP, ratio: DEFAULT_RATIO };
    // The asked name of the main pane.
    multiMain?: string;
    multiAnimate: boolean = true;
    // False: the embedding page draws the pane names and frames ({multiChrome: false}).
    multiChrome: boolean = true;
    // The colour between panes: for the GL clear and as CSS.
    multiGapColor: Float32Array = new Float32Array([0.07, 0.07, 0.07, 1]);
    multiGapCss: string = "#121212";

    constructor(
        readonly workerPool: RenderDataWorkerPool,
        public npcSpawns: NpcSpawn[],
        readonly mapImageCache: Cache,
        cache: LoadedCache,
    ) {
        this.renderer = new WebGLMapViewerRenderer(this);
        this.initCache(cache);
    }

    getSearchParams(): URLSearchParamsInit {
        const cx = this.camera.getPosX().toFixed(2).toString();
        const cy = -this.camera.getPosY().toFixed(2).toString();
        const cz = this.camera.getPosZ().toFixed(2).toString();

        const yaw = this.camera.yaw & 2047;

        const p = (this.camera.pitch | 0).toString();
        const y = yaw.toString();

        const params: any = {
            cx,
            cy,
            cz,
            p,
            y,
        };

        if (this.camera.projectionType === ProjectionType.ORTHO) {
            params["pt"] = "o";
            params["z"] = this.camera.orthoZoom.toString();
        }

        if (this.liveParam !== undefined) {
            params["live"] = this.liveParam;
        }
        if (this.multi) {
            const multiParams: any = {
                multi: this.multi.panes.map((p) => p.getAsked() ?? "").join(","),
            };
            if (this.liveParam !== undefined) {
                multiParams["live"] = this.liveParam;
            }
            if (this.multiRenderDistance !== DEFAULT_MULTI_DISTANCE) {
                multiParams["md"] = this.multiRenderDistance.toString();
            }
            if (this.multiLayout.mode !== "grid") {
                multiParams["tile"] = this.multiLayout.mode;
            }
            return multiParams;
        }
        const followName = this.live?.followName ?? this.live?.pendingFollow;
        if (followName) {
            params["follow"] = followName;
        }

        params["v"] = 1;

        return params;
    }

    applySearchParams(searchParams: URLSearchParams) {
        const cx = searchParams.get("cx");
        const cy = searchParams.get("cy");
        const cz = searchParams.get("cz");

        const pitch = searchParams.get("p");
        const yaw = searchParams.get("y");

        const v = searchParams.get("v");

        if (searchParams.get("pt") === "o") {
            this.camera.projectionType = ProjectionType.ORTHO;
        }

        const live = searchParams.get("live");
        if (live !== null) {
            this.liveParam = live;
            const url = live === "off" || live === "0" || live === "" ? undefined : live;
            if (url !== this.liveUrl) {
                this.liveUrl = url;
                this.initLive();
            }
        }

        const multi = searchParams.get("multi");
        if (multi !== null) {
            this.multiRenderDistance =
                parseMultiDistance(searchParams.get("md")) ?? this.multiRenderDistance;
            this.multiLayout.mode = parseLayoutMode(searchParams.get("tile")) ?? this.multiLayout.mode;
            this.setMulti(parseMultiNames(multi));
        }

        const follow = searchParams.get("follow");
        if (follow && !this.multiNames) {
            this.followParam = follow;
            if (this.live) {
                this.live.pendingFollow = follow;
            }
        }

        const zoom = searchParams.get("z");
        if (zoom) {
            this.camera.orthoZoom = parseInt(zoom);
        }

        if (cx && cy && cz) {
            const pos = vec3.fromValues(parseFloat(cx), -parseFloat(cy), parseFloat(cz));
            this.camera.pos = pos;
        }
        if (pitch) {
            this.camera.pitch = parseInt(pitch);
            if (!v) {
                this.camera.pitch = -this.camera.pitch;
            }
        }
        if (yaw) {
            this.camera.yaw = parseInt(yaw);
            if (!v) {
                this.camera.yaw = 2048 - this.camera.yaw;
            }
        }
    }

    init(): void {
        this.workerPool.loadCachedMapImages().then((mapImageUrls) => {
            mapImageUrls.forEach((value, key) => this.mapImageUrls.set(key, value));
        });
    }

    initCache(cache: LoadedCache): void {
        this.loadedCache = cache;
        this.cacheSystem = CacheSystem.fromFiles(cache.type, cache.files);
        this.loaderFactory = getCacheLoaderFactory(cache.info, this.cacheSystem);
        this.workerPool.initCache(cache, this.npcSpawns);
        this.clearMapImageUrls();

        this.textureLoader = this.loaderFactory.getTextureLoader();
        this.seqTypeLoader = this.loaderFactory.getSeqTypeLoader();
        this.seqFrameLoader = this.loaderFactory.getSeqFrameLoader();
        this.locTypeLoader = this.loaderFactory.getLocTypeLoader();
        this.objTypeLoader = this.loaderFactory.getObjTypeLoader();
        this.npcTypeLoader = this.loaderFactory.getNpcTypeLoader();
        this.basTypeLoader = this.loaderFactory.getBasTypeLoader();

        this.varManager = new VarManager(this.loaderFactory.getVarBitTypeLoader());
        const questTypeLoader = this.loaderFactory.getQuestTypeLoader();
        if (questTypeLoader) {
            this.varManager.setQuestsCompleted(questTypeLoader);
        }

        const mapFileLoader = this.loaderFactory.getMapFileLoader();
        this.mapFileIndex = mapFileLoader.mapFileIndex;

        this.isNewTextureAnim = cache.info.game === "runescape" && cache.info.revision >= 681;

        this.renderer.initCache();

        this.initLive();

        this.updateSearchParams();
    }

    initLive(): void {
        const multiNames = this.multi
            ? this.multi.panes.map((p) => p.getAsked()).filter((n): n is string => !!n)
            : this.multiNames;
        if (this.multi) {
            // The panes' controllers include this.live.
            this.multi.stop();
            this.multi = undefined;
            this.live = undefined;
        }
        this.live?.stop();
        this.live = undefined;
        this.worldState?.clear();
        this.worldState = undefined;
        // The live layer needs player kits/spotanims, only built for pre-dat2 (rs-sdk) caches.
        if (this.liveUrl && this.loaderFactory?.getIdkTypeLoader) {
            this.worldState = new WorldState(
                this.locTypeLoader,
                this.seqTypeLoader,
                this.seqFrameLoader,
                this.loaderFactory.getSpotAnimTypeLoader?.(),
            );
            this.live = new LiveController(
                this.liveUrl,
                this.npcTypeLoader,
                this.seqTypeLoader,
                this.seqFrameLoader,
                this.loaderFactory.getSpotAnimTypeLoader?.(),
                this.worldState,
            );
            if (this.followParam) {
                this.live.pendingFollow = this.followParam;
            }
            this.live.hitmarkSprites = this.loaderFactory.getHitmarkSprites?.() ?? [];
            this.live.headIconSprites = this.loaderFactory.getHeadIconSprites?.() ?? [];
            if (multiNames && multiNames.length > 0) {
                this.setMulti(multiNames);
            }
        }
        // Live npcs replace the static spawn list; without a feed, fall back to it.
        this.renderer.setLoadNpcs?.(!this.live);
    }

    // Shows these players side by side, one pane each (at most 16); an empty list returns to the
    // single view. Panes that already follow an asked player are kept.
    setMulti(asked: string[]): void {
        const names = asked.slice(0, MAX_PANES);
        this.multiNames = names.length > 0 ? names : undefined;
        if (!this.live || !this.liveUrl) {
            // No feed yet: initLive applies the names.
            return;
        }
        if (names.length === 0) {
            this.leaveMulti();
            return;
        }
        const multi = this.enterMulti();
        if (multi.closing) {
            // Asked for again on the way out: the wall stays.
            multi.closing = false;
            multi.onClosed = undefined;
            multi.panes[multi.active].live.flights = false;
        }
        const spare = multi.panes.slice();
        const panes = names.map((name) => {
            const key = name.toLowerCase();
            const index = spare.findIndex(
                (p) =>
                    p.asked?.toLowerCase() === key ||
                    (!p.asked && (p.live.followName ?? p.live.pendingFollow)?.toLowerCase() === key),
            );
            if (index === -1) {
                return undefined;
            }
            const pane = spare.splice(index, 1)[0];
            pane.asked = name;
            return pane;
        });
        const from = multi.panes[multi.active].camera;
        const next = panes.map((kept, i) => {
            if (kept) {
                return kept;
            }
            // The single view that just became a pane takes a new name. Any other pane keeps its
            // player until it closes, so a pane that moves is always the same player.
            const fresh = spare.findIndex((p) => p.enter !== "");
            const pane = fresh === -1 ? this.makePane(from) : spare.splice(fresh, 1)[0];
            pane.asked = names[i];
            pane.live.unfollow();
            pane.live.pendingFollow = names[i];
            return pane;
        });
        // The panes left in spare close: reorder() fades them out and onRetired stops their feeds.
        multi.reorder(next);
        if (multi.embedded) {
            multi.setActive(0);
        }
        this.applyMultiLayout();
        this.wireRoster();
        this.syncActivePane();
        this.updateSearchParams();
    }

    // {multiLayout: {mode, main, gap, ratio, animate, color}}: the tiling of the panes. A part that
    // is absent or out of range keeps its value. main is a pane's name or its number in the asked
    // order; color (#rrggbb) is the colour of the gaps.
    setMultiLayout(spec: unknown): void {
        if (!spec || typeof spec !== "object") {
            return;
        }
        const d = spec as Record<string, unknown>;
        const layout = this.multiLayout;
        layout.mode = parseLayoutMode(d.mode) ?? layout.mode;
        layout.gap = parseGap(d.gap) ?? layout.gap;
        layout.ratio = parseRatio(d.ratio) ?? layout.ratio;
        if (typeof d.animate === "boolean") {
            this.multiAnimate = d.animate;
        }
        if (typeof d.color === "string" && /^#[0-9a-f]{6}$/i.test(d.color)) {
            const rgb = parseInt(d.color.slice(1), 16);
            this.multiGapColor[0] = (rgb >> 16) / 255;
            this.multiGapColor[1] = ((rgb >> 8) & 255) / 255;
            this.multiGapColor[2] = (rgb & 255) / 255;
            this.multiGapCss = d.color;
        }
        if (typeof d.main === "string") {
            this.multiMain = d.main;
        } else if (typeof d.main === "number") {
            this.multiMain = this.multi?.findPane(d.main)?.getAsked() ?? this.multiMain;
        }
        this.applyMultiLayout();
        this.updateSearchParams();
    }

    // Hands the layout settings to the panes. The panes move only when a setting changed.
    private applyMultiLayout(): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        const { mode, gap, ratio } = this.multiLayout;
        const options = multi.options;
        if (options.mode !== mode || options.gap !== gap || options.ratio !== ratio) {
            options.mode = mode;
            options.gap = gap;
            options.ratio = ratio;
            multi.relayout();
        }
        multi.animate = this.multiAnimate;
        multi.setChrome(this.multiChrome);
        multi.setGapColor(this.multiGapCss);
        if (this.multiMain !== undefined) {
            multi.setMain(multi.findPane(this.multiMain) ?? multi.main);
        }
    }

    // {multiOrder: [names]}: the same panes in a new order. No pane follows another player, so no
    // feed changes. A name that has no pane is skipped; a pane that is not named keeps its place
    // after the named ones.
    setMultiOrder(names: string[]): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        const keys = names.map((name) => name.toLowerCase());
        const next = reorderBy(multi.panes, keys, (pane) => pane.getAsked()?.toLowerCase() ?? "");
        if (next.every((pane, i) => pane === multi.panes[i])) {
            return;
        }
        multi.reorder(next);
        this.multiNames = next.map((p) => p.getAsked()).filter((n): n is string => !!n);
        this.wireRoster();
        this.syncActivePane();
        this.updateSearchParams();
    }

    // {multiFocus: name | number}: selects a pane. Camera input acts on it, and it is the pane
    // that stays when the viewer returns to the single view.
    setMultiFocus(ref: unknown): void {
        const multi = this.multi;
        const pane = multi?.findPane(ref);
        if (!multi || !pane) {
            return;
        }
        multi.setActive(multi.panes.indexOf(pane));
        this.syncActivePane();
        // With a layout change on its way, the next frame reports the new rectangles and this pane.
        if (!multi.layoutPending()) {
            multi.onLayout?.(multi.layoutInfo(performance.now()));
        }
    }

    // {multiChrome: false}: the page draws the pane names and frames; the viewer draws none.
    setMultiChrome(on: boolean): void {
        this.multiChrome = on;
        this.multi?.setChrome(on);
    }

    // View distance of every pane, in tiles.
    setMultiDistance(tiles: number): void {
        this.multiRenderDistance = tiles;
        for (const pane of this.multi?.panes ?? []) {
            pane.live.maxAreaRadius = tiles;
        }
    }

    canAddPane(): boolean {
        return !!this.live && !!this.liveUrl && (this.multi?.panes.length ?? 1) < MAX_PANES;
    }

    // Splits the single view into panes, or adds one more. The new pane starts at the selected
    // pane's camera and is selected, so the Live panel's list picks who it follows.
    addPane(name?: string): void {
        if (!this.canAddPane()) {
            return;
        }
        const multi = this.enterMulti();
        const pane = this.makePane(multi.panes[multi.active].camera);
        if (name) {
            pane.asked = name;
            pane.live.pendingFollow = name;
        }
        multi.addPane(pane);
        multi.setActive(multi.panes.length - 1);
        this.wireRoster();
        this.syncActivePane();
        this.updateSearchParams();
    }

    // Closes a pane; with one left, back to the single view (its feed keeps running).
    removePane(pane: MultiPane): void {
        const multi = this.multi;
        if (!multi || multi.panes.length <= 1) {
            return;
        }
        // The pane fades out; onRetired stops its feed.
        multi.removePane(pane);
        if (multi.panes.length === 1) {
            this.leaveMulti();
            return;
        }
        this.wireRoster();
        this.syncActivePane();
        this.updateSearchParams();
    }

    // The selected pane is what the camera controls, the Live panel and click menus act on.
    syncActivePane(): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        const pane = multi.panes[multi.active];
        this.camera = pane.camera;
        this.live = pane.live;
    }

    // The single view becomes the first pane.
    private enterMulti(): MultiView {
        if (this.multi) {
            return this.multi;
        }
        const live = this.live!;
        const multi = new MultiView(EMBED, (pane, index) => {
            const asked = pane.getAsked();
            if (EMBED && asked) {
                postMultiPick(paneMessageName(asked), index);
            }
        });
        multi.onLayout = postMultiLayout;
        multi.onRetired = (pane) => {
            pane.live.rosterListeners.length = 0;
            pane.live.stop();
        };
        live.maxAreaRadius = this.multiRenderDistance;
        live.flights = false;
        const first = new MultiPane(this.camera, live, undefined, this.paneHandlers());
        // The single view shrinks from the full window to its place.
        first.enter = "full";
        multi.addPane(first);
        multi.setActive(0);
        this.multi = multi;
        this.applyMultiLayout();
        return multi;
    }

    // Back to the single view: the selected pane carries on as it, the others stop.
    private leaveMulti(): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        const keep = multi.panes[multi.active];
        if (!multi.closing && multi.close()) {
            // The selected pane grows to the full window first. A follow that arrives meanwhile
            // is a flight, as in the single view.
            keep.live.flights = true;
            // After the frame that draws the pane at full size.
            multi.onClosed = () => void Promise.resolve().then(() => this.leaveMulti());
            return;
        }
        for (const pane of multi.panes) {
            if (pane !== keep) {
                pane.live.stop();
            }
        }
        multi.detach();
        this.multi = undefined;
        this.multiNames = undefined;
        keep.live.maxAreaRadius = MAX_AREA_RADIUS;
        keep.live.flights = true;
        keep.live.rosterListeners.length = 0;
        keep.live.feed.setRoster(true);
        this.camera = keep.camera;
        this.live = keep.live;
        postMultiStatus({ names: [], shown: [], offline: [] });
        this.updateSearchParams();
    }

    // A pane with its own camera (copied from another pane's) and its own feed connection.
    private makePane(from: Camera): MultiPane {
        const first = this.multi?.panes[0]?.live ?? this.live!;
        const camera = new Camera(from.pos[0], from.pos[1], from.pos[2], from.pitch, from.yaw);
        camera.projectionType = from.projectionType;
        const live = new LiveController(
            this.liveUrl!,
            this.npcTypeLoader,
            this.seqTypeLoader,
            this.seqFrameLoader,
            this.loaderFactory.getSpotAnimTypeLoader?.(),
            this.worldState,
            false,
        );
        live.hitmarkSprites = first.hitmarkSprites;
        live.headIconSprites = first.headIconSprites;
        live.options = { ...first.options };
        live.maxAreaRadius = this.multiRenderDistance;
        live.flights = false;
        // Start from the roster we already have, so a name is found right away.
        const roster = first.rosterSnapshot();
        if (roster) {
            live.world.applyRoster(roster);
        }
        return new MultiPane(camera, live, undefined, this.paneHandlers());
    }

    private paneHandlers() {
        if (EMBED) {
            return undefined;
        }
        return {
            rename: (pane: MultiPane, name: string) => {
                pane.asked = name || undefined;
                pane.live.unfollow();
                pane.live.pendingFollow = name || undefined;
                this.updateSearchParams();
            },
            close: (pane: MultiPane) => this.removePane(pane),
        };
    }

    // Only the first pane's feed subscribes to the roster; it hands each roster to the others.
    private wireRoster(): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        const last = multi.panes.map((p) => p.live.rosterSnapshot()).find((r) => r);
        multi.panes.forEach((pane, i) => {
            pane.live.rosterListeners.length = 0;
            pane.live.feed.setRoster(i === 0);
        });
        const source = multi.panes[0].live;
        source.rosterListeners.push((roster) => {
            for (const pane of multi.panes) {
                if (pane.live !== source) {
                    pane.live.world.applyRoster(roster);
                }
            }
        });
        // A pane that takes over the roster has none of its own until the next one arrives.
        if (last && source.world.rosterTick === -1) {
            source.world.applyRoster(last);
        }
    }

    /**
     * Sets the camera position to a new arbitrary position
     * @param newView Any of the items you want to move: Position, pitch, yaw
     */
    setCamera(newView: Partial<CameraView>): void {
        if (newView.position) {
            vec3.copy(this.camera.pos, newView.position);
        }
        if (newView.pitch !== undefined) {
            this.camera.pitch = newView.pitch;
        }
        if (newView.yaw !== undefined) {
            this.camera.yaw = newView.yaw;
        }
        if (newView.fov !== undefined) {
            this.camera.fov = newView.fov;
        }
        if (newView.orthoZoom !== undefined) {
            this.camera.orthoZoom = newView.orthoZoom;
        }
        this.camera.updated = true;
    }

    updateSearchParams(): void {
        this.needsSearchParamUpdate = true;
        this.lastTimeSearchParamsUpdated = performance.now();
    }

    closeMenu = () => {
        this.menuOpen = false;
        this.menuX = -1;
        this.menuY = -1;
        this.renderer.canvas.focus();
    };

    resetMenu = () => {
        this.closeMenu();
        this.menuOpenedFrame = 0;
    };

    onExamine = (entry: OsrsMenuEntry) => {
        let lookupType: string | undefined;
        switch (entry.targetType) {
            case MenuTargetType.NPC:
                lookupType = "npc";
                break;
            case MenuTargetType.LOC:
                lookupType = "object";
                break;
            case MenuTargetType.OBJ:
                lookupType = "item";
                break;
        }
        if (lookupType) {
            window.open(
                `https://oldschool.runescape.wiki/w/Special:Lookup?type=${lookupType}&id=${entry.targetId}`,
                "_blank",
            );
        }
        this.closeMenu();
    };

    updateVars(): void {
        this.workerPool.setVars(this.varManager.values);
    }

    static getCachedMapImageUrl(mapX: number, mapY: number): string {
        return CACHED_MAP_IMAGE_PREFIX + `${mapX}_${mapY}.png`;
    }

    async queueLoadMapImage(mapX: number, mapY: number) {
        const mapManager = this.renderer.mapManager;
        const mapId = getMapSquareId(mapX, mapY);
        if (
            this.loadingMapImageIds.size > this.workerPool.size * 4 ||
            this.mapImageUrls.has(mapId) ||
            this.loadingMapImageIds.has(mapId) ||
            mapManager.invalidMapIds.has(mapId) ||
            mapManager.loadingMapIds.has(mapId)
        ) {
            return;
        }
        this.loadingMapImageIds.add(mapId);

        const minimapData = await this.workerPool.queueMapImage(mapX, mapY, 0, true);
        if (minimapData) {
            const url = URL.createObjectURL(minimapData.minimapBlob);
            this.setMapImageUrl(mapX, mapY, url, false);
        } else {
            mapManager.invalidMapIds.add(mapId);
        }

        this.loadingMapImageIds.delete(mapId);
    }

    getMapImageUrl(mapX: number, mapY: number, minimap: boolean): string | undefined {
        if (mapX < 0 || mapY < 0 || mapX >= MapManager.MAX_MAP_X || mapY >= MapManager.MAX_MAP_Y) {
            return undefined;
        }
        const urls = minimap ? this.minimapImageUrls : this.mapImageUrls;
        if (minimap) {
            this.renderer.mapManager.loadMap(mapX, mapY);
        } else {
            this.queueLoadMapImage(mapX, mapY);
        }
        const mapId = getMapSquareId(mapX, mapY);
        return urls.get(mapId);
    }

    setMapImageUrl(
        mapX: number,
        mapY: number,
        url: string,
        minimap: boolean,
        cache: boolean = true,
    ): void {
        const mapId = getMapSquareId(mapX, mapY);
        const urls = minimap ? this.minimapImageUrls : this.mapImageUrls;
        const old = urls.get(mapId);
        if (old) {
            URL.revokeObjectURL(old);
        }
        if (cache) {
            fetch(url).then((resp) => {
                if (resp.ok) {
                    const request = new Request(MapViewer.getCachedMapImageUrl(mapX, mapY), {
                        headers: {
                            "RS-Cache-Name": this.loadedCache.info.name,
                        },
                    });
                    this.mapImageCache.put(request, resp);
                }
            });
        }
        urls.set(mapId, url);
    }

    clearMapImageUrls(): void {
        for (const url of this.mapImageUrls.values()) {
            URL.revokeObjectURL(url);
        }
        for (const url of this.minimapImageUrls.values()) {
            URL.revokeObjectURL(url);
        }
        this.mapImageUrls.clear();
        this.minimapImageUrls.clear();
        this.loadingMapImageIds.clear();
    }
}
