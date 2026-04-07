import type { FeatureAtlasEntry, MapData, TileAtlasEntry } from "./types";

export interface RenderToggles {
  base: boolean;
  layer: boolean;
  shadow1: boolean;
  shadow2: boolean;
  feature: boolean;
  top: boolean;
  grid: boolean;
  showFlip: boolean;
  showTileIndex: boolean;
  showRawFlags: boolean;
}

export interface HoverCell {
  x: number;
  y: number;
}

interface RenderMapOptions {
  ctx: CanvasRenderingContext2D;
  mapData: MapData;
  tileAtlas: CanvasImageSource;
  featureAtlas: CanvasImageSource;
  tileLookup: Map<number, TileAtlasEntry>;
  featureLookup: Map<number, FeatureAtlasEntry>;
  toggles: RenderToggles;
  hoveredCell: HoverCell | null;
  selectedCell: HoverCell | null;
  zoom: number;
}

const TILE_SIZE = 16;

function mirroredTileLeft(xOffset: number, width: number): number {
  return TILE_SIZE - width + xOffset;
}

function drawFlipped(
  ctx: CanvasRenderingContext2D,
  atlas: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
): void {
  ctx.save();
  ctx.translate(dx + sw, dy);
  ctx.scale(-1, 1);
  ctx.drawImage(atlas, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.restore();
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  atlas: CanvasImageSource,
  tileEntry: TileAtlasEntry,
  dx: number,
  dy: number,
  flip: boolean,
): void {
  const drawX = dx + (flip ? mirroredTileLeft(tileEntry.x_offset, tileEntry.width) : -tileEntry.x_offset);
  const drawY = dy - tileEntry.y_offset;
  if (flip) {
    drawFlipped(ctx, atlas, tileEntry.atlas_x, tileEntry.atlas_y, tileEntry.width, tileEntry.height, drawX, drawY);
    return;
  }
  ctx.drawImage(
    atlas,
    tileEntry.atlas_x,
    tileEntry.atlas_y,
    tileEntry.width,
    tileEntry.height,
    drawX,
    drawY,
    tileEntry.width,
    tileEntry.height,
  );
}

function mirroredAnchorLeft(anchorX: number, width: number): number {
  return width - 1 - anchorX;
}

function drawFeature(
  ctx: CanvasRenderingContext2D,
  atlas: CanvasImageSource,
  entry: FeatureAtlasEntry,
  xPx: number,
  yPx: number,
  flip: boolean,
): void {
  const anchorX = flip ? mirroredAnchorLeft(entry.x_offset, entry.width) : entry.x_offset;
  const drawX = xPx - anchorX;
  const drawY = yPx - entry.y_offset;

  if (flip) {
    drawFlipped(ctx, atlas, entry.atlas_x, entry.atlas_y, entry.width, entry.height, drawX, drawY);
    return;
  }

  ctx.drawImage(
    atlas,
    entry.atlas_x,
    entry.atlas_y,
    entry.width,
    entry.height,
    drawX,
    drawY,
    entry.width,
    entry.height,
  );
}

function packedInfo(packed: number): { id: number; flip: boolean } {
  return {
    id: packed & 0x7ff,
    flip: (packed & 0x800) !== 0,
  };
}

function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  mapData: MapData,
  toggles: RenderToggles,
  zoom: number,
): void {
  if (!toggles.showTileIndex && !toggles.showRawFlags && !toggles.showFlip) {
    return;
  }

  const fontSize = zoom >= 4 ? 6 : zoom >= 2.5 ? 5 : 0;
  if (fontSize > 0 && (toggles.showTileIndex || toggles.showRawFlags)) {
    ctx.save();
    ctx.font = `${fontSize}px "Chivo Mono", monospace`;
    ctx.textBaseline = "top";
    for (let y = 0; y < mapData.height; y += 1) {
      for (let x = 0; x < mapData.width; x += 1) {
        const index = y * mapData.width + x;
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;

        const lines: string[] = [];
        if (toggles.showTileIndex) {
          lines.push(mapData.base_cells[index] >= 0 ? `${mapData.base_cells[index]}` : "...");
        }
        if (toggles.showRawFlags) {
          lines.push(`f:${mapData.base_flags[index].toString(16).padStart(2, "0")}`);
        }
        if (!lines.length) {
          continue;
        }

        const panelHeight = lines.length * (fontSize + 1) + 1;
        ctx.fillStyle = "rgba(7, 10, 14, 0.68)";
        ctx.fillRect(px + 1, py + 1, TILE_SIZE - 2, panelHeight);
        ctx.fillStyle = "#f7e8bf";
        lines.forEach((line, lineIndex) => {
          ctx.fillText(line, px + 2, py + 2 + lineIndex * (fontSize + 1));
        });
      }
    }
    ctx.restore();
  }

  if (toggles.showFlip) {
    ctx.save();
    ctx.strokeStyle = "rgba(248, 177, 81, 0.9)";
    ctx.lineWidth = 1;
    for (let y = 0; y < mapData.height; y += 1) {
      for (let x = 0; x < mapData.width; x += 1) {
        const index = y * mapData.width + x;
        const baseFlip = (mapData.base_flags[index] & 0x04) !== 0;
        const shadowFlip = [mapData.shadow1[index], mapData.shadow2[index], mapData.top[index]].some(
          (packed) => packed >= 0 && (packed & 0x800) !== 0,
        );
        const layerFlip = mapData.layer_slots[index].some((packed) => packed >= 0 && (packed & 0x800) !== 0);
        if (!baseFlip && !shadowFlip && !layerFlip) {
          continue;
        }
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;
        ctx.beginPath();
        ctx.moveTo(px + 2, py + 2);
        ctx.lineTo(px + TILE_SIZE - 2, py + TILE_SIZE - 2);
        ctx.moveTo(px + TILE_SIZE - 2, py + 2);
        ctx.lineTo(px + 2, py + TILE_SIZE - 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 1) {
    ctx.beginPath();
    ctx.moveTo(x * TILE_SIZE + 0.5, 0);
    ctx.lineTo(x * TILE_SIZE + 0.5, height * TILE_SIZE);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y * TILE_SIZE + 0.5);
    ctx.lineTo(width * TILE_SIZE, y * TILE_SIZE + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderMap({
  ctx,
  mapData,
  tileAtlas,
  featureAtlas,
  tileLookup,
  featureLookup,
  toggles,
  hoveredCell,
  selectedCell,
  zoom,
}: RenderMapOptions): void {
  const widthPx = mapData.width * TILE_SIZE;
  const heightPx = mapData.height * TILE_SIZE;

  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < mapData.height; y += 1) {
    for (let x = 0; x < mapData.width; x += 1) {
      const index = y * mapData.width + x;
      const dx = x * TILE_SIZE;
      const dy = y * TILE_SIZE;

      if (toggles.base) {
        const tileId = mapData.base_cells[index];
        const tileEntry = tileLookup.get(tileId);
        if (tileEntry) {
          drawTile(ctx, tileAtlas, tileEntry, dx, dy, (mapData.base_flags[index] & 0x04) !== 0);
        }
      }

      if (toggles.shadow1) {
        const packed = mapData.shadow1[index];
        if (packed >= 0) {
          const info = packedInfo(packed);
          const tileEntry = tileLookup.get(info.id);
          if (tileEntry) {
            drawTile(ctx, tileAtlas, tileEntry, dx, dy, info.flip);
          }
        }
      }

      if (toggles.shadow2) {
        const packed = mapData.shadow2[index];
        if (packed >= 0) {
          const info = packedInfo(packed);
          const tileEntry = tileLookup.get(info.id);
          if (tileEntry) {
            drawTile(ctx, tileAtlas, tileEntry, dx, dy, info.flip);
          }
        }
      }

      if (toggles.layer) {
        for (const packed of mapData.layer_slots[index]) {
          if (packed < 0) {
            continue;
          }
          const info = packedInfo(packed);
          const tileEntry = tileLookup.get(info.id);
          if (tileEntry) {
            drawTile(ctx, tileAtlas, tileEntry, dx, dy, info.flip);
          }
        }
      }

    }
  }

  if (toggles.feature) {
    const orderedFeatures = [...mapData.static_features_raw].sort((left, right) => {
      return (
        left.layer - right.layer ||
        left.y_px - right.y_px ||
        left.x_px - right.x_px ||
        left.feature_id - right.feature_id
      );
    });
    for (const feature of orderedFeatures) {
      const entry = featureLookup.get(feature.feature_id);
      if (!entry) {
        continue;
      }
      drawFeature(ctx, featureAtlas, entry, feature.x_px, feature.y_px, feature.flip);
    }
  }

  if (toggles.top) {
    for (let y = 0; y < mapData.height; y += 1) {
      for (let x = 0; x < mapData.width; x += 1) {
        const index = y * mapData.width + x;
        const packed = mapData.top[index];
        if (packed < 0) {
          continue;
        }
        const info = packedInfo(packed);
        const tileEntry = tileLookup.get(info.id);
        if (!tileEntry) {
          continue;
        }
        drawTile(ctx, tileAtlas, tileEntry, x * TILE_SIZE, y * TILE_SIZE, info.flip);
      }
    }
  }

  drawDebugOverlay(ctx, mapData, toggles, zoom);

  if (toggles.grid) {
    drawGrid(ctx, mapData.width, mapData.height);
  }

  if (selectedCell) {
    ctx.save();
    ctx.strokeStyle = "#5ba8f7";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      selectedCell.x * TILE_SIZE + 0.5,
      selectedCell.y * TILE_SIZE + 0.5,
      TILE_SIZE - 1,
      TILE_SIZE - 1,
    );
    ctx.restore();
  }

  if (hoveredCell && (!selectedCell || hoveredCell.x !== selectedCell.x || hoveredCell.y !== selectedCell.y)) {
    ctx.save();
    ctx.strokeStyle = "#f7e8bf";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      hoveredCell.x * TILE_SIZE + 0.75,
      hoveredCell.y * TILE_SIZE + 0.75,
      TILE_SIZE - 1.5,
      TILE_SIZE - 1.5,
    );
    ctx.restore();
  }
}
