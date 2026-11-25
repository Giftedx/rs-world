import { memo, useEffect, useRef, useState } from "react";

import { getMapSquareId } from "../../../rs/map/MapFileIndex";
import "./MinimapContainer.css";
import { MinimapImage } from "./MinimapImage";
import compass from "./compass.png";
import minimapBlack from "./minimap-black.png";
import frame from "./minimap-frame.png";

interface Position {
    x: number;
    y: number;
}

interface MinimapContainerProps {
    yawDegrees: number;

    onCompassClick: () => void;
    onWorldMapClick: () => void;

    getPosition: () => Position;
    loadMapImageUrl: (mapX: number, mapY: number) => string | undefined;
}

export const MinimapContainer = memo(function MinimapContainer({
    yawDegrees,
    onCompassClick,
    onWorldMapClick,

    getPosition,
    loadMapImageUrl,
}: MinimapContainerProps) {
    const [minimapImages, setMinimapImages] = useState<JSX.Element[]>([]);
    const requestRef = useRef<number | undefined>();
    // The images change only when the camera's pixel offset or a square's image changes: an unchanged frame sets no
    // state, so the minimap does not re-render on each display frame.
    const shownKey = useRef("");

    const animate = (time: DOMHighResTimeStamp) => {
        const pos = getPosition();

        const cameraX = pos.x;
        const cameraY = pos.y;

        const cameraMapX = cameraX >> 6;
        const cameraMapY = cameraY >> 6;

        const offsetX = (-128 + (cameraX % 64) * 4) | 0;
        const offsetY = (-128 + (cameraY % 64) * 4) | 0;

        const urls: string[] = [];
        let key = `${cameraMapX},${cameraMapY},${offsetX},${offsetY}`;
        for (let mx = 0; mx < 3; mx++) {
            for (let my = 0; my < 3; my++) {
                const url = loadMapImageUrl(cameraMapX - 1 + mx, cameraMapY - 1 + my) ?? minimapBlack;
                urls.push(url);
                key += "|" + url;
            }
        }

        if (key !== shownKey.current) {
            shownKey.current = key;
            const images: JSX.Element[] = [];
            for (let mx = 0; mx < 3; mx++) {
                for (let my = 0; my < 3; my++) {
                    const minimapUrl = urls[mx * 3 + my];
                    if (minimapUrl) {
                        const mapId = getMapSquareId(cameraMapX - 1 + mx, cameraMapY - 1 + my);
                        const x = mx * 255 - offsetX;
                        const y = 255 * 2 - my * 255 + offsetY;

                        images.push(<MinimapImage key={mapId} src={minimapUrl} left={x} top={y} />);
                    }
                }
            }
            setMinimapImages(images);
        }

        requestRef.current = requestAnimationFrame(animate);
    };

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(requestRef.current!);
    }, []);

    return (
        <div className="minimap-container">
            <img src={frame} />

            <div
                className="minimap"
                style={{
                    transform: `rotate(${yawDegrees}deg)`,
                }}
            >
                <div className="minimap-images">{minimapImages}</div>
            </div>

            <img
                className="compass"
                style={{
                    transform: `rotate(${yawDegrees}deg)`,
                }}
                src={compass}
                onClick={onCompassClick}
            />

            <div className="worldmap-icon" onClick={onWorldMapClick} />
        </div>
    );
});
