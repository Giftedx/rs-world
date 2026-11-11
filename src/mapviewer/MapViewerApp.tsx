import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { registerSerializer } from "threads";
import WebFont from "webfontloader";

import { OsrsLoadingBar } from "../components/rs/loading/OsrsLoadingBar";
import { DownloadProgress } from "../rs/cache/CacheFiles";
import { formatBytes } from "../util/BytesUtil";
import { isSharedMemorySupported, isTouchDevice, isWallpaperEngine } from "../util/DeviceUtil";
import { fetchCacheList, loadCacheFiles } from "./Caches";
import { MapViewer } from "./MapViewer";
import { MapViewerContainer } from "./MapViewerContainer";
import { fetchNpcSpawns, getNpcSpawnsUrl } from "./data/npc/NpcSpawn";
import { WebGLMapViewerRenderer } from "./webgl/WebGLMapViewerRenderer";
import { renderDataLoaderSerializer } from "./worker/RenderDataLoader";
import { RenderDataWorkerPool } from "./worker/RenderDataWorkerPool";

registerSerializer(renderDataLoaderSerializer);

WebFont.load({
    custom: {
        families: ["OSRS Bold", "OSRS Small"],
    },
});

const cachesPromise = fetchCacheList();

// Without shared memory each worker receives its own copy of the cache, so such a page gets two workers:
// with prewarmed squares they serve a follow change as fast as four, for one cache copy more.
// ?workers=N (1 to 8) sets the count: an embedding page that knows the device can ask for more or fewer.
const askedWorkers = Number(new URLSearchParams(window.location.search).get("workers"));
const workerPool = RenderDataWorkerPool.create(
    Number.isInteger(askedWorkers) && askedWorkers >= 1 && askedWorkers <= 8
        ? askedWorkers
        : isWallpaperEngine
          ? 1
          : !isSharedMemorySupported || isTouchDevice
            ? 2
            : 4,
);

function MapViewerApp() {
    const [searchParams, setSearchParams] = useSearchParams();

    const [errorMessage, setErrorMessage] = useState<string>();
    const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>();
    const [mapViewer, setMapViewer] = useState<MapViewer>();

    useEffect(() => {
        const abortController = new AbortController();

        const load = async () => {
            if (!WebGLMapViewerRenderer.isSupported()) {
                setErrorMessage("WebGL2 is not supported. Please update your browser or OS.");
                return;
            }

            const cacheList = await cachesPromise;
            if (!cacheList) {
                setErrorMessage("Failed to load cache list");
                throw new Error("No caches found");
            }

            const cacheInfo = cacheList.latest;

            const [cache, npcSpawns] = await Promise.all([
                loadCacheFiles(cacheInfo, abortController.signal, setDownloadProgress),
                fetchNpcSpawns(getNpcSpawnsUrl(cacheInfo)),
            ]);

            const mapImageCache = await caches.open("map-images");

            const mapViewer = new MapViewer(
                workerPool,
                npcSpawns,
                mapImageCache,
                cache,
                searchParams,
            );
            mapViewer.init();

            setDownloadProgress(undefined);
            setMapViewer(mapViewer);
        };

        load().catch((error: unknown) => {
            if (abortController.signal.aborted) {
                return;
            }
            console.error(error);
            setDownloadProgress(undefined);
            setErrorMessage(
                error instanceof Error ? error.message : "Failed to load the world. Please reload.",
            );
        });

        return () => {
            abortController.abort();
        };
    }, []);

    let content: JSX.Element | undefined;
    if (errorMessage) {
        content = <div className="center-container max-height content-text">{errorMessage}</div>;
    } else if (downloadProgress) {
        const formattedCacheSize = formatBytes(downloadProgress.total);
        const progress = ((downloadProgress.current / downloadProgress.total) * 100) | 0;
        content = (
            <div className="center-container max-height">
                <OsrsLoadingBar
                    text={`Downloading cache (${formattedCacheSize})`}
                    progress={progress}
                />
            </div>
        );
    } else if (mapViewer) {
        content = <MapViewerContainer mapViewer={mapViewer} />;
    }

    return <div className="App max-height">{content}</div>;
}

export default MapViewerApp;
