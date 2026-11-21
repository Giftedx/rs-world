import { CacheInfo } from "../../../rs/cache/CacheInfo";
import npcSpawns2004Url from "./npc-spawns-2004.json?url";

// Guard unused multi-MB JSON assets with direct env check so Webpack tree-shakes them in single-rev (289) builds.
const npcSpawns2009Url: string | undefined =
    process.env.REACT_APP_CACHE_REV === "289"
        ? undefined
        : (require("./npc-spawns-2009.json?url") as string);
const npcSpawnsOsrsUrl: string | undefined =
    process.env.REACT_APP_CACHE_REV === "289"
        ? undefined
        : (require("./npc-spawns-osrs.json?url") as string);

const npcSpawnsCache = new Map<string, Promise<NpcSpawn[]>>();

export function clearNpcSpawnsCache(): void {
    npcSpawnsCache.clear();
}

export interface NpcSpawn {
    id: number;
    name?: string;
    x: number;
    y: number;
    level: number;
}

export function getNpcSpawnsUrl(cacheInfo: CacheInfo): string {
    if (cacheInfo.game === "oldschool") {
        if (!npcSpawnsOsrsUrl) {
            throw new Error("OSRS NPC spawns are excluded in single-rev build");
        }
        return npcSpawnsOsrsUrl;
    } else if (cacheInfo.revision > 474) {
        if (!npcSpawns2009Url) {
            throw new Error("2009 NPC spawns are excluded in single-rev build");
        }
        return npcSpawns2009Url;
    } else {
        return npcSpawns2004Url;
    }
}

export function fetchNpcSpawns(url: string): Promise<NpcSpawn[]> {
    const cached = npcSpawnsCache.get(url);
    if (cached) {
        return cached;
    }
    const promise = (async () => {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed loading NPC spawns (${response.status})`);
        }
        return (await response.json()) as NpcSpawn[];
    })();
    npcSpawnsCache.set(url, promise);
    promise.catch(() => {
        if (npcSpawnsCache.get(url) === promise) {
            npcSpawnsCache.delete(url);
        }
    });
    return promise;
}

export function fetchOsrsNpcSpawns(): Promise<NpcSpawn[]> {
    if (!npcSpawnsOsrsUrl) {
        return Promise.resolve([]);
    }
    return fetchNpcSpawns(npcSpawnsOsrsUrl);
}

export function fetchLegacyNpcSpawns(): Promise<NpcSpawn[]> {
    return fetchNpcSpawns(npcSpawns2004Url);
}

export function getMapNpcSpawns(
    spawns: NpcSpawn[],
    maxLevel: number,
    mapX: number,
    mapY: number,
): NpcSpawn[] {
    return spawns.filter((obj) => {
        const npcMapX = (obj.x / 64) | 0;
        const npcMapY = (obj.y / 64) | 0;
        return mapX === npcMapX && mapY === npcMapY && obj.level <= maxLevel;
    });
}
