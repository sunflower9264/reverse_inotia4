import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import {
  datasetUrl,
  loadDatasetBundle,
  loadFeatureAtlas,
  loadMapData,
  loadMemorytextManifest,
  loadTileAtlas,
  loadWorldmapImage,
} from "./data";
import { renderMap, type HoverCell, type RenderToggles } from "./render";
import type {
  DatasetBundle,
  MapData,
  ManifestMap,
  PassthroughAudioAsset,
  PassthroughImageAsset,
  MemoryTextEntry,
  MemoryTextManifest,
  WorldmapManifest,
  WorldmapRegionEntry,
} from "./types";

const TILE_SIZE = 16;
const MEMORYTEXT_PAGE_SIZE = 10;
const AUDIO_PAGE_SIZE = 10;
const MEMORYTEXT_COLOR_MAP: Record<string, string> = {
  A: "#0000BF",
  C: "#00FF00",
  G: "#808080",
  L: "#C81200",
  M: "#00FF4E",
  O: "#006CFF",
  P: "#C000FF",
  Q: "#6B9EBD",
  R: "#0000FF",
  S: "#FFB400",
  T: "#FF7878",
  V: "#FF009C",
  W: "#FFFFFF",
  Y: "#00FFFC",
};

type Route =
  | { kind: "index" }
  | { kind: "map"; mapId: number }
  | { kind: "worldmap"; mapId: number | null }
  | { kind: "memorytext"; textId: number | null }
  | { kind: "gallery" }
  | { kind: "audio" };

type MemoryTextToken =
  | { kind: "text"; text: string; colorCode: string | null }
  | { kind: "break"; paragraph: boolean };

interface MemoryTextGroup {
  entries: MemoryTextEntry[];
  startTextId: number;
  endTextId: number;
  entryCount: number;
  isDialogueGroup: boolean;
  previewText: string;
}

interface MemoryTextGroupViewModel extends MemoryTextGroup {
  matchedEntryIds: number[];
  matchedEntryCount: number;
}

function parseRoute(hash: string): Route {
  if (hash === "#/gallery") {
    return { kind: "gallery" };
  }
  if (hash === "#/audio") {
    return { kind: "audio" };
  }
  const memorytextMatch = hash.match(/^#\/memorytext(?:\/(\d+))?$/);
  if (memorytextMatch) {
    return { kind: "memorytext", textId: memorytextMatch[1] ? Number(memorytextMatch[1]) : null };
  }
  const worldmapMatch = hash.match(/^#\/worldmap(?:\/(\d+))?$/);
  if (worldmapMatch) {
    return { kind: "worldmap", mapId: worldmapMatch[1] ? Number(worldmapMatch[1]) : null };
  }
  const match = hash.match(/^#\/map\/(\d+)$/);
  if (match) {
    return { kind: "map", mapId: Number(match[1]) };
  }
  return { kind: "index" };
}

function findWorldmapRegion(manifest: WorldmapManifest, mapId: number | null): WorldmapRegionEntry | null {
  if (mapId == null) {
    return null;
  }
  return manifest.regions.find((region) => region.map_ids.includes(mapId)) ?? null;
}

function formatPacked(packed: number): string {
  if (packed < 0) {
    return "empty";
  }
  return `${packed & 0x7ff}${(packed & 0x800) !== 0 ? " (flip)" : ""}`;
}

function formatHex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function buildPageWindow(currentPage: number, totalPages: number): number[] {
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function stripMemoryTextMarkup(text: string): string {
  return text
    .replace(/\$[A-Z]/g, "")
    .replace(/&P/g, "\n\n")
    .replace(/&N/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function pickMemoryTextPreview(entries: MemoryTextEntry[], matchedEntryIds: number[] = []): string {
  const matchedEntryIdSet = matchedEntryIds.length ? new Set(matchedEntryIds) : null;
  const pickEntry = (preferMatched: boolean, requireText: boolean) =>
    entries.find((entry) => {
      if (preferMatched && !matchedEntryIdSet?.has(entry.text_id)) {
        return false;
      }
      if (!requireText) {
        return true;
      }
      return stripMemoryTextMarkup(entry.text).length > 0;
    });

  const previewEntry =
    pickEntry(true, true) ??
    pickEntry(false, true) ??
    pickEntry(true, false) ??
    entries[0];

  return previewEntry ? stripMemoryTextMarkup(previewEntry.text) || "(empty)" : "(empty)";
}

function groupConsecutiveEntries(entries: MemoryTextEntry[]): MemoryTextGroup[] {
  if (entries.length === 0) {
    return [];
  }
  const groups: MemoryTextGroup[] = [];
  let current: MemoryTextEntry[] = [entries[0]];
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].text_id === entries[i - 1].text_id + 1) {
      current.push(entries[i]);
    } else {
      groups.push({
        entries: current,
        startTextId: current[0].text_id,
        endTextId: current[current.length - 1].text_id,
        entryCount: current.length,
        isDialogueGroup: current.some((entry) => entry.has_markup),
        previewText: pickMemoryTextPreview(current),
      });
      current = [entries[i]];
    }
  }
  groups.push({
    entries: current,
    startTextId: current[0].text_id,
    endTextId: current[current.length - 1].text_id,
    entryCount: current.length,
    isDialogueGroup: current.some((entry) => entry.has_markup),
    previewText: pickMemoryTextPreview(current),
  });
  return groups;
}

function matchesMemoryTextSearch(entry: MemoryTextEntry, normalizedSearch: string): boolean {
  if (!normalizedSearch) {
    return true;
  }
  return [
    `${entry.text_id}`,
    entry.text,
    stripMemoryTextMarkup(entry.text),
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalizedSearch);
}

function parseMemoryTextMarkup(text: string): MemoryTextToken[] {
  const tokens: MemoryTextToken[] = [];
  let buffer = "";
  let activeColor: string | null = null;

  const flush = () => {
    if (!buffer) {
      return;
    }
    tokens.push({ kind: "text", text: buffer, colorCode: activeColor });
    buffer = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];

    if (ch === "&" && next) {
      if (next === "N") {
        flush();
        tokens.push({ kind: "break", paragraph: false });
        index += 1;
        continue;
      }
      if (next === "P") {
        flush();
        tokens.push({ kind: "break", paragraph: true });
        index += 1;
        continue;
      }
    }

    if (ch === "$" && next && /[A-Z]/.test(next)) {
      flush();
      activeColor = next === "B" ? null : next;
      index += 1;
      continue;
    }

    buffer += ch;
  }

  flush();
  return tokens;
}

function MemoryTextPreview({ text, compact = false }: { text: string; compact?: boolean }) {
  const tokens = parseMemoryTextMarkup(text);
  if (!tokens.length) {
    return <p className="muted-note">当前条目为空文本。</p>;
  }

  return (
    <div className={compact ? "memorytext-preview memorytext-preview--compact" : "memorytext-preview"}>
      {tokens.map((token, index) => {
        if (token.kind === "break") {
          return token.paragraph ? (
            <div key={`break-${index}`} className="memorytext-preview__paragraph-break" />
          ) : (
            <br key={`break-${index}`} />
          );
        }
        const color = token.colorCode ? MEMORYTEXT_COLOR_MAP[token.colorCode] ?? "var(--accent)" : undefined;
        return (
          <span
            key={`text-${index}`}
            className={token.colorCode ? "memorytext-preview__segment memorytext-preview__segment--marked" : "memorytext-preview__segment"}
            style={color ? { color } : undefined}
          >
            {token.text}
          </span>
        );
      })}
    </div>
  );
}

function ToggleChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? "toggle-chip toggle-chip--active" : "toggle-chip"}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function StatCard({
  eyebrow,
  value,
  detail,
}: {
  eyebrow: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="stat-card">
      <p className="stat-card__eyebrow">{eyebrow}</p>
      <p className="stat-card__value">{value}</p>
      <p className="stat-card__detail">{detail}</p>
    </article>
  );
}

function AssetCard({
  asset,
  active,
  onClick,
}: {
  asset: PassthroughImageAsset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? "asset-card asset-card--active" : "asset-card"}
      onClick={onClick}
      type="button"
    >
      <div className="asset-card__media">
        <img className="asset-card__thumb" src={datasetUrl(asset.path)} alt={asset.label} loading="lazy" />
      </div>
      <div className="asset-card__body">
        <div className="asset-card__meta">
          <span className="map-card__badge">{asset.width} x {asset.height}</span>
          <span className="map-card__badge">{formatBytes(asset.file_size)}</span>
        </div>
        <h3>{asset.label}</h3>
        <p>{asset.source_name}</p>
      </div>
    </button>
  );
}

function AudioTrackRow({
  asset,
  active,
  onClick,
}: {
  asset: PassthroughAudioAsset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? "audio-row audio-row--active" : "audio-row"}
      onClick={onClick}
      type="button"
    >
      <div className="audio-row__meta">
        <span className="map-card__badge">{asset.category}</span>
        <span className="map-card__badge">{formatBytes(asset.file_size)}</span>
      </div>
      <h3>{asset.label}</h3>
      <p>{asset.source_name}</p>
    </button>
  );
}

function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const syncRoute = () => {
      startTransition(() => {
        setRoute(parseRoute(window.location.hash));
      });
    };
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  const navigate = (next: Route) => {
    if (next.kind === "index") {
      window.location.hash = "#/";
      startTransition(() => {
        setRoute({ kind: "index" });
      });
      return;
    }

    if (next.kind === "worldmap") {
      window.location.hash = next.mapId == null ? "#/worldmap" : `#/worldmap/${next.mapId}`;
      startTransition(() => {
        setRoute(next);
      });
      return;
    }

    if (next.kind === "gallery") {
      window.location.hash = "#/gallery";
      startTransition(() => {
        setRoute(next);
      });
      return;
    }

    if (next.kind === "audio") {
      window.location.hash = "#/audio";
      startTransition(() => {
        setRoute(next);
      });
      return;
    }

    if (next.kind === "memorytext") {
      window.location.hash = next.textId == null ? "#/memorytext" : `#/memorytext/${next.textId}`;
      startTransition(() => {
        setRoute(next);
      });
      return;
    }

    window.location.hash = `#/map/${next.mapId}`;
    startTransition(() => {
      setRoute(next);
    });
  };

  return [route, navigate];
}

function MapCanvas({
  dataset,
  mapData,
  tileAtlas,
  featureAtlas,
  toggles,
  zoom,
  hoveredCell,
  selectedCell,
  onHoverCell,
  onClickCell,
}: {
  dataset: DatasetBundle;
  mapData: MapData;
  tileAtlas: HTMLImageElement;
  featureAtlas: HTMLImageElement;
  toggles: RenderToggles;
  zoom: number;
  hoveredCell: HoverCell | null;
  selectedCell: HoverCell | null;
  onHoverCell: (value: HoverCell | null) => void;
  onClickCell: (value: HoverCell | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const widthPx = mapData.width * TILE_SIZE;
  const heightPx = mapData.height * TILE_SIZE;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    renderMap({
      ctx,
      mapData,
      tileAtlas,
      featureAtlas,
      tileLookup: dataset.tileLookup,
      featureLookup: dataset.featureLookup,
      toggles,
      hoveredCell,
      selectedCell,
      zoom,
    });
  }, [dataset, featureAtlas, hoveredCell, selectedCell, mapData, tileAtlas, toggles, zoom]);

  const handleMove = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = event.currentTarget.width / rect.width;
    const scaleY = event.currentTarget.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / TILE_SIZE);
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / TILE_SIZE);
    if (x < 0 || y < 0 || x >= mapData.width || y >= mapData.height) {
      onHoverCell(null);
      return;
    }
    onHoverCell({ x, y });
  };

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = event.currentTarget.width / rect.width;
    const scaleY = event.currentTarget.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / TILE_SIZE);
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / TILE_SIZE);
    if (x < 0 || y < 0 || x >= mapData.width || y >= mapData.height) {
      return;
    }
    if (selectedCell && selectedCell.x === x && selectedCell.y === y) {
      onClickCell(null);
    } else {
      onClickCell({ x, y });
    }
  };

  return (
    <div className="canvas-stage">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        width={widthPx}
        height={heightPx}
        style={{ width: `${widthPx * zoom}px`, height: `${heightPx * zoom}px`, cursor: "crosshair" }}
        onMouseMove={handleMove}
        onClick={handleClick}
        onMouseLeave={() => onHoverCell(null)}
      />
    </div>
  );
}

function WorldmapCanvas({
  image,
  manifest,
  selectedSpriteIndex,
  onSelectRegion,
}: {
  image: HTMLImageElement;
  manifest: WorldmapManifest;
  selectedSpriteIndex: number | null;
  onSelectRegion: (spriteIndex: number) => void;
}) {
  const scale = 2;

  return (
    <div className="worldmap-stage" style={{ width: `${manifest.width * scale}px`, height: `${manifest.height * scale}px` }}>
      <img
        className="worldmap-image"
        src={image.src}
        alt="world map"
        style={{ width: `${manifest.width * scale}px`, height: `${manifest.height * scale}px` }}
      />
      {manifest.regions.map((region) => (
        <button
          key={region.sprite_index}
          className={selectedSpriteIndex === region.sprite_index ? "worldmap-pin worldmap-pin--active" : "worldmap-pin"}
          style={{
            left: `${region.center_x * scale}px`,
            top: `${region.center_y * scale}px`,
          }}
          onClick={() => onSelectRegion(region.sprite_index)}
          title={`${region.name} (${region.map_ids.length})`}
          type="button"
        >
          {region.map_ids.length}
        </button>
      ))}
    </div>
  );
}

function App() {
  const [route, navigate] = useHashRoute();
  const [dataset, setDataset] = useState<DatasetBundle | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [memorytextManifest, setMemorytextManifest] = useState<MemoryTextManifest | null>(null);
  const [memorytextError, setMemorytextError] = useState<string | null>(null);
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [tileAtlas, setTileAtlas] = useState<HTMLImageElement | null>(null);
  const [featureAtlas, setFeatureAtlas] = useState<HTMLImageElement | null>(null);
  const [worldmapImage, setWorldmapImage] = useState<HTMLImageElement | null>(null);
  const [atlasError, setAtlasError] = useState<string | null>(null);
  const [worldmapError, setWorldmapError] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<HoverCell | null>(null);
  const [selectedCell, setSelectedCell] = useState<HoverCell | null>(null);
  const [selectedWorldmapSpriteIndex, setSelectedWorldmapSpriteIndex] = useState<number | null>(null);
  const [mapSearch, setMapSearch] = useState("");
  const [imageSearch, setImageSearch] = useState("");
  const [audioSearch, setAudioSearch] = useState("");
  const [audioCategory, setAudioCategory] = useState<"all" | "BGM" | "SE">("all");
  const [memorytextSearch, setMemorytextSearch] = useState("");
  const [memorytextDialogueOnly, setMemorytextDialogueOnly] = useState(false);
  const [memorytextPage, setMemorytextPage] = useState(1);
  const [audioPage, setAudioPage] = useState(1);
  const [paletteFilter, setPaletteFilter] = useState<number | "all">("all");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [toggles, setToggles] = useState<RenderToggles>({
    base: true,
    layer: true,
    shadow1: true,
    shadow2: true,
    feature: true,
    top: true,
    grid: false,
    showFlip: false,
    showTileIndex: false,
    showRawFlags: false,
  });

  const deferredMapSearch = useDeferredValue(mapSearch);
  const deferredImageSearch = useDeferredValue(imageSearch);
  const deferredAudioSearch = useDeferredValue(audioSearch);
  const deferredMemorytextSearch = useDeferredValue(memorytextSearch);
  const memorytextRouteId = route.kind === "memorytext" ? route.textId : null;
  const memorytextEntryRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    let cancelled = false;
    loadDatasetBundle()
      .then((bundle) => {
        if (!cancelled) {
          setDataset(bundle);
          setDatasetError(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setDatasetError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (route.kind !== "map") {
      setMapData(null);
      setMapError(null);
      setHoveredCell(null);
      setSelectedCell(null);
      return;
    }

    let cancelled = false;
    loadMapData(route.mapId)
      .then((nextMap) => {
        if (!cancelled) {
          setMapData(nextMap);
          setMapError(null);
          setHoveredCell(null);
          setSelectedCell(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setMapError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [route]);

  useEffect(() => {
    if (!mapData) {
      setTileAtlas(null);
      setFeatureAtlas(null);
      setAtlasError(null);
      return;
    }

    let cancelled = false;
    Promise.all([loadTileAtlas(mapData.palette_set_id), loadFeatureAtlas(mapData.palette_set_id)])
      .then(([tileImage, featureImage]) => {
        if (!cancelled) {
          setTileAtlas(tileImage);
          setFeatureAtlas(featureImage);
          setAtlasError(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setAtlasError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mapData]);

  useEffect(() => {
    if (!dataset) {
      setWorldmapImage(null);
      setWorldmapError(null);
      return;
    }
    let cancelled = false;
    loadWorldmapImage(dataset.worldmapManifest.image_path)
      .then((image) => {
        if (!cancelled) {
          setWorldmapImage(image);
          setWorldmapError(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setWorldmapError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  useEffect(() => {
    if (!dataset || route.kind !== "memorytext") {
      return;
    }
    if (memorytextManifest) {
      return;
    }

    let cancelled = false;
    loadMemorytextManifest(dataset.rootManifest.memorytext_manifest_path)
      .then((manifest) => {
        if (!cancelled) {
          setMemorytextManifest(manifest);
          setMemorytextError(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setMemorytextError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dataset, memorytextManifest, route.kind]);

  useEffect(() => {
    if (route.kind !== "worldmap" || !dataset) {
      setSelectedWorldmapSpriteIndex(null);
      return;
    }
    const region = findWorldmapRegion(dataset.worldmapManifest, route.mapId);
    setSelectedWorldmapSpriteIndex(region?.sprite_index ?? dataset.worldmapManifest.regions[0]?.sprite_index ?? null);
  }, [dataset, route]);

  useEffect(() => {
    if (route.kind !== "memorytext" || memorytextRouteId != null) {
      return;
    }
    setMemorytextPage(1);
  }, [deferredMemorytextSearch, memorytextDialogueOnly, memorytextRouteId, route.kind]);

  useEffect(() => {
    if (route.kind !== "audio") {
      return;
    }
    setAudioPage(1);
  }, [deferredAudioSearch, audioCategory, route.kind]);

  const currentManifestEntry =
    route.kind === "map" && dataset ? dataset.rootManifest.maps.find((item) => item.map_id === route.mapId) ?? null : null;
  const manifestMapLookup = dataset ? new Map(dataset.rootManifest.maps.map((item) => [item.map_id, item])) : new Map<number, ManifestMap>();

  const paletteOptions = dataset
    ? [...new Set(dataset.rootManifest.maps.map((entry) => entry.palette_set_id))].sort((left, right) => left - right)
    : [];
  const normalizedMapSearch = deferredMapSearch.trim().toLowerCase();
  const normalizedImageSearch = deferredImageSearch.trim().toLowerCase();
  const normalizedAudioSearch = deferredAudioSearch.trim().toLowerCase();
  const normalizedMemorytextSearch = deferredMemorytextSearch.trim().toLowerCase();

  let filteredMaps: ManifestMap[] = [];
  if (dataset) {
    filteredMaps = dataset.rootManifest.maps.filter((entry) => {
      if (paletteFilter !== "all" && entry.palette_set_id !== paletteFilter) {
        return false;
      }
      if (!normalizedMapSearch) {
        return true;
      }
      return [
        `m${entry.map_id}`,
        `${entry.map_id}`,
        entry.name,
        `${entry.width}x${entry.height}`,
        `palette ${entry.palette_set_id}`,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedMapSearch);
    });
  }

  const filteredImages =
    dataset == null
      ? []
      : dataset.passthroughAssetsManifest.images.filter((entry) => {
          if (!normalizedImageSearch) {
            return true;
          }
          return [entry.label, entry.source_name, `${entry.width}x${entry.height}`]
            .join(" ")
            .toLowerCase()
            .includes(normalizedImageSearch);
        });

  const filteredAudio =
    dataset == null
      ? []
      : dataset.passthroughAssetsManifest.audio.filter((entry) => {
          if (audioCategory !== "all" && entry.category !== audioCategory) {
            return false;
          }
          if (!normalizedAudioSearch) {
            return true;
          }
          return [entry.label, entry.source_name, entry.category]
            .join(" ")
            .toLowerCase()
            .includes(normalizedAudioSearch);
        });

  const audioPageCount = Math.max(1, Math.ceil(filteredAudio.length / AUDIO_PAGE_SIZE));
  const activeAudioPage = Math.min(audioPage, audioPageCount);
  const audioPageStart = (activeAudioPage - 1) * AUDIO_PAGE_SIZE;
  const audioPageEnd = Math.min(audioPageStart + AUDIO_PAGE_SIZE, filteredAudio.length);
  const pagedAudio = filteredAudio.slice(audioPageStart, audioPageEnd);

  const selectedImage =
    route.kind === "gallery" && dataset
      ? (selectedImageId != null
          ? filteredImages.find((entry) => entry.asset_id === selectedImageId) ?? null
          : filteredImages[0] ?? null)
      : null;

  const selectedAudio =
    route.kind === "audio" && dataset
      ? (selectedAudioId != null
          ? filteredAudio.find((entry) => entry.asset_id === selectedAudioId) ?? null
          : filteredAudio[0] ?? null)
      : null;

  useEffect(() => {
    if (route.kind !== "gallery") {
      setSelectedImageId(null);
      return;
    }
    const fallback = filteredImages[0]?.asset_id ?? null;
    if (selectedImageId == null || !filteredImages.some((entry) => entry.asset_id === selectedImageId)) {
      setSelectedImageId(fallback);
    }
  }, [filteredImages, route.kind, selectedImageId]);

  useEffect(() => {
    if (route.kind !== "audio") {
      setSelectedAudioId(null);
      return;
    }
    const fallback = filteredAudio[0]?.asset_id ?? null;
    if (selectedAudioId == null || !filteredAudio.some((entry) => entry.asset_id === selectedAudioId)) {
      setSelectedAudioId(fallback);
    }
  }, [filteredAudio, route.kind, selectedAudioId]);

  const hoveredInfo =
    mapData && selectedCell
      ? (() => {
          const index = selectedCell.y * mapData.width + selectedCell.x;
          return {
            index,
            baseCell: mapData.base_cells[index],
            baseFlags: mapData.base_flags[index],
            baseOffset: mapData.raw_tail_offsets.base_start + index * 2,
            shadow1: mapData.shadow1[index],
            shadow2: mapData.shadow2[index],
            top: mapData.top[index],
            layerSlots: mapData.layer_slots[index],
            featuresAtCell: mapData.static_features_raw.filter(
              (feature) => feature.x_tile === selectedCell.x && feature.y_tile === selectedCell.y,
            ),
            linksAtCell: mapData.link_records.filter(
              (record) => record.x === selectedCell.x && record.y === selectedCell.y,
            ),
          };
        })()
      : null;

  const selectedWorldmapRegion =
    route.kind === "worldmap" && dataset
      ? dataset.worldmapManifest.regions.find((region) => region.sprite_index === selectedWorldmapSpriteIndex) ?? null
      : null;

  const allMemorytextGroups = memorytextManifest == null ? [] : groupConsecutiveEntries(memorytextManifest.entries);
  const filteredMemorytextGroups = allMemorytextGroups.reduce<MemoryTextGroupViewModel[]>((groups, group) => {
    if (memorytextDialogueOnly && !group.isDialogueGroup) {
      return groups;
    }

    const matchedEntryIds = normalizedMemorytextSearch
      ? group.entries
          .filter((entry) => matchesMemoryTextSearch(entry, normalizedMemorytextSearch))
          .map((entry) => entry.text_id)
      : [];

    if (normalizedMemorytextSearch && matchedEntryIds.length === 0) {
      return groups;
    }

    groups.push({
      ...group,
      previewText: pickMemoryTextPreview(group.entries, matchedEntryIds),
      matchedEntryIds,
      matchedEntryCount: matchedEntryIds.length,
    });

    return groups;
  }, []);

  const filteredMemorytextEntryCount = filteredMemorytextGroups.reduce((sum, group) => sum + group.entryCount, 0);
  const memorytextPageCount = Math.max(1, Math.ceil(filteredMemorytextGroups.length / MEMORYTEXT_PAGE_SIZE));
  const activeMemorytextPage = Math.min(memorytextPage, memorytextPageCount);
  const memorytextPageStart = filteredMemorytextGroups.length === 0 ? 0 : (activeMemorytextPage - 1) * MEMORYTEXT_PAGE_SIZE;
  const pagedMemorytextGroups = filteredMemorytextGroups.slice(
    memorytextPageStart,
    memorytextPageStart + MEMORYTEXT_PAGE_SIZE,
  );
  const memorytextPageEnd = memorytextPageStart + pagedMemorytextGroups.length;
  const totalGroupEntryCount = pagedMemorytextGroups.reduce((sum, group) => sum + group.entries.length, 0);

  const selectedMemorytextGroup: MemoryTextGroupViewModel | null =
    route.kind === "memorytext"
      ? (memorytextRouteId != null
          ? filteredMemorytextGroups.find(
              (group) => memorytextRouteId >= group.startTextId && memorytextRouteId <= group.endTextId,
            ) ?? null
          : pagedMemorytextGroups[0] ?? filteredMemorytextGroups[0] ?? null)
      : null;

  const selectedMemorytextEntry: MemoryTextEntry | null =
    route.kind === "memorytext" && selectedMemorytextGroup
      ? (memorytextRouteId != null
          ? selectedMemorytextGroup.entries.find((entry) => entry.text_id === memorytextRouteId) ?? null
          : selectedMemorytextGroup.entries.find((entry) => selectedMemorytextGroup.matchedEntryIds.includes(entry.text_id)) ??
            selectedMemorytextGroup.entries[0] ??
            null)
      : null;

  const selectedMemorytextMatchedEntrySet = selectedMemorytextGroup
    ? new Set(selectedMemorytextGroup.matchedEntryIds)
    : null;

  useEffect(() => {
    if (route.kind !== "memorytext" || memorytextRouteId == null) {
      return;
    }

    const isVisible = filteredMemorytextGroups.some(
      (group) => memorytextRouteId >= group.startTextId && memorytextRouteId <= group.endTextId,
    );

    if (!isVisible) {
      navigate({ kind: "memorytext", textId: null });
    }
  }, [filteredMemorytextGroups, memorytextRouteId, route.kind]);

  useEffect(() => {
    if (route.kind !== "memorytext") {
      return;
    }

    if (memorytextRouteId != null) {
      const groupIndex = filteredMemorytextGroups.findIndex(
        (group) => memorytextRouteId >= group.startTextId && memorytextRouteId <= group.endTextId,
      );
      if (groupIndex >= 0) {
        const targetPage = Math.floor(groupIndex / MEMORYTEXT_PAGE_SIZE) + 1;
        if (targetPage !== memorytextPage) {
          setMemorytextPage(targetPage);
        }
        return;
      }
    }

    if (activeMemorytextPage !== memorytextPage) {
      setMemorytextPage(activeMemorytextPage);
    }
  }, [activeMemorytextPage, filteredMemorytextGroups, memorytextPage, memorytextRouteId, route.kind]);

  useEffect(() => {
    if (route.kind !== "memorytext" || !selectedMemorytextEntry) {
      return;
    }

    const selectedNode = memorytextEntryRefs.current.get(selectedMemorytextEntry.text_id);
    if (!selectedNode) {
      return;
    }

    selectedNode.scrollIntoView({
      block: "nearest",
      behavior: memorytextRouteId != null ? "smooth" : "auto",
    });
  }, [memorytextRouteId, route.kind, selectedMemorytextEntry?.text_id, selectedMemorytextGroup?.startTextId]);

  return (
    <div className="app-shell">
      <div className="ambient-grid" />
      {route.kind === "index" ? (
        <>
          <header className="hero-panel">
            <div>
              <p className="eyebrow">reverse_inotia4 / resource viewer</p>
              <h1>Web 资源查看器</h1>
              <p className="hero-copy">
                现在这套 viewer 同时覆盖静态地图、世界地图、`memorytext_zhhans` 文本资源，以及
                `game_res` 里未加密的 PNG 图片和 OGG 音频。地图页继续保留图层开关、flags、tile index 和 raw
                offset，用来对照 `MAP_Draw*` 的静态渲染行为。
              </p>
            </div>
            <div className="hero-controls">
              <label className="search-card">
                <span>地图检索</span>
                <input
                  className="search-input"
                  value={mapSearch}
                  onChange={(event) => setMapSearch(event.target.value)}
                  placeholder="比如 m109 / 潘德利 / 45x45 / palette 7"
                />
              </label>
              <div className="filter-row">
                <select
                  className="palette-select"
                  value={paletteFilter}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPaletteFilter(value === "all" ? "all" : Number(value));
                  }}
                >
                  <option value="all">全部 palette set</option>
                  {paletteOptions.map((paletteId) => (
                    <option key={paletteId} value={paletteId}>
                      palette {paletteId}
                    </option>
                  ))}
                </select>
                <button className="ghost-button" onClick={() => navigate({ kind: "worldmap", mapId: null })} type="button">
                  世界地图
                </button>
                <button className="ghost-button" onClick={() => navigate({ kind: "memorytext", textId: null })} type="button">
                  文本资源
                </button>
                <button className="ghost-button" onClick={() => navigate({ kind: "gallery" })} type="button">
                  图片资源
                </button>
                <button className="ghost-button" onClick={() => navigate({ kind: "audio" })} type="button">
                  音频资源
                </button>
              </div>
            </div>
          </header>

          {datasetError ? <section className="error-banner">{datasetError}</section> : null}

          {dataset ? (
            <>
              <section className="stats-grid">
                <StatCard eyebrow="地图" value={`${dataset.rootManifest.map_count}`} detail="m0..m415 全量索引" />
                <StatCard eyebrow="tile atlas" value={`${dataset.tilesetManifest.tile_count}`} detail="按 palette set 预着色" />
                <StatCard
                  eyebrow="feature atlas"
                  value={`${dataset.featureManifest.feature_count}`}
                  detail="静态 feature 已映射到 atlas"
                />
                <StatCard
                  eyebrow="文本"
                  value={`${dataset.rootManifest.memorytext_non_empty_count}`}
                  detail="简中 memorytext 非空条目"
                />
                <StatCard
                  eyebrow="worldmap"
                  value={`${dataset.worldmapManifest.region_count}`}
                  detail="可点击区域热点"
                />
                <StatCard
                  eyebrow="PNG"
                  value={`${dataset.rootManifest.passthrough_image_count}`}
                  detail="game_res 直出图片"
                />
                <StatCard
                  eyebrow="音频"
                  value={`${dataset.rootManifest.passthrough_audio_count}`}
                  detail="BGM 与 SE OGG"
                />
              </section>

              <main className="map-grid">
                {filteredMaps.map((entry) => (
                  <button
                    key={entry.map_id}
                    className="map-card"
                    onClick={() => navigate({ kind: "map", mapId: entry.map_id })}
                    type="button"
                  >
                    <div className="map-card__media">
                      <img
                        className="map-card__preview"
                        src={datasetUrl(entry.preview_path)}
                        alt={`map ${entry.map_id}`}
                        loading="lazy"
                      />
                      <div className="map-card__badge-strip">
                        <span className="map-card__badge">m{entry.map_id}</span>
                        <span className="map-card__badge">palette {entry.palette_set_id}</span>
                        {entry.has_static_features ? <span className="map-card__badge">feature</span> : null}
                      </div>
                    </div>
                    <div className="map-card__body">
                      <h2>m{entry.map_id}</h2>
                      <p className="map-card__title">{entry.name}</p>
                      <p>
                        {entry.width} x {entry.height} tiles
                      </p>
                      <p>
                        headers {formatHex(entry.raw_header_0)} / {formatHex(entry.raw_header_1)}
                      </p>
                    </div>
                  </button>
                ))}
              </main>
            </>
          ) : (
            <section className="loading-panel">正在读取地图、atlas、worldmap、文本、图片和音频资源索引…</section>
          )}
        </>
      ) : route.kind === "gallery" ? (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / passthrough png</p>
              <h1>未加密图片资源</h1>
              <p className="viewer-subtitle">
                这里展示 `game_res` 里按文件头识别出的直出 PNG。导出阶段已经把伪装成 `.jpg` 的原始资源复制成可直接浏览的
                PNG 文件。
              </p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              <button className="ghost-button" onClick={() => navigate({ kind: "audio" })} type="button">
                音频资源
              </button>
              {selectedImage ? (
                <button
                  className="ghost-button"
                  onClick={() => window.open(datasetUrl(selectedImage.path), "_blank", "noopener")}
                  type="button"
                >
                  打开原图
                </button>
              ) : null}
            </div>
          </header>

          {datasetError ? <section className="error-banner">{datasetError}</section> : null}

          <main className="viewer-layout viewer-layout--gallery">
            <section className="stage-panel">
              <div className="stage-toolbar">
                <label className="search-card search-card--inline">
                  <span>图片检索</span>
                  <input
                    className="search-input"
                    value={imageSearch}
                    onChange={(event) => setImageSearch(event.target.value)}
                    placeholder="按文件名、尺寸或来源路径搜索"
                  />
                </label>
                <div className="filter-row">
                  {dataset ? (
                    <p className="muted-note">
                      当前图片 {filteredImages.length} / {dataset.rootManifest.passthrough_image_count}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="asset-gallery">
                {dataset ? (
                  filteredImages.length ? (
                    filteredImages.map((asset) => (
                      <AssetCard
                        key={asset.asset_id}
                        asset={asset}
                        active={selectedImage?.asset_id === asset.asset_id}
                        onClick={() => setSelectedImageId(asset.asset_id)}
                      />
                    ))
                  ) : (
                    <div className="loading-panel loading-panel--stage">没有匹配的图片资源。</div>
                  )
                ) : (
                  <div className="loading-panel loading-panel--stage">正在读取未加密 PNG 清单…</div>
                )}
              </div>
            </section>

            <aside className="inspector-panel">
              <section className="sidebar-card">
                <div className="sidebar-card__header">
                  <h2>图片预览</h2>
                  <p>选中一张图片后，这里会显示更大的透明底预览。</p>
                </div>
                {selectedImage ? (
                  <div className="asset-preview-frame">
                    <img className="asset-preview" src={datasetUrl(selectedImage.path)} alt={selectedImage.label} />
                  </div>
                ) : (
                  <p className="muted-note">先从左侧挑一张 PNG 资源。</p>
                )}
              </section>

              {selectedImage ? (
                <section className="sidebar-card">
                  <div className="sidebar-card__header">
                    <h2>资源信息</h2>
                    <p>保留原始来源名，同时给出导出后的浏览器路径。</p>
                  </div>
                  <dl className="definition-list">
                    <div>
                      <dt>label</dt>
                      <dd>{selectedImage.label}</dd>
                    </div>
                    <div>
                      <dt>size</dt>
                      <dd>
                        {selectedImage.width} x {selectedImage.height}
                      </dd>
                    </div>
                    <div>
                      <dt>file size</dt>
                      <dd>{formatBytes(selectedImage.file_size)}</dd>
                    </div>
                    <div>
                      <dt>source</dt>
                      <dd>{selectedImage.source_name}</dd>
                    </div>
                    <div>
                      <dt>public path</dt>
                      <dd>{selectedImage.path}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
            </aside>
          </main>
        </>
      ) : route.kind === "audio" ? (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / ogg audio</p>
              <h1>音乐与音效资源</h1>
              <p className="viewer-subtitle">
                这里展示 `game_res/SOUND` 下按文件头识别出的 OGG 资源，包含 BGM 与 SE 两组。导出阶段会把伪装后缀统一转成
                可直接播放的 `.ogg`。
              </p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              <button className="ghost-button" onClick={() => navigate({ kind: "gallery" })} type="button">
                图片资源
              </button>
            </div>
          </header>

          {datasetError ? <section className="error-banner">{datasetError}</section> : null}

          <main className="viewer-layout viewer-layout--audio">
            <section className="stage-panel">
              <div className="stage-toolbar">
                <label className="search-card search-card--inline">
                  <span>音频检索</span>
                  <input
                    className="search-input"
                    value={audioSearch}
                    onChange={(event) => setAudioSearch(event.target.value)}
                    placeholder="按文件名、分类或来源路径搜索"
                  />
                </label>
                <div className="filter-row">
                  <ToggleChip active={audioCategory === "all"} label="all" onClick={() => setAudioCategory("all")} />
                  <ToggleChip active={audioCategory === "BGM"} label="BGM" onClick={() => setAudioCategory("BGM")} />
                  <ToggleChip active={audioCategory === "SE"} label="SE" onClick={() => setAudioCategory("SE")} />
                  {dataset ? (
                    <p className="muted-note">
                      当前音频 {filteredAudio.length} / {dataset.rootManifest.passthrough_audio_count}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="audio-list">
                {dataset ? (
                  pagedAudio.length ? (
                    pagedAudio.map((asset) => (
                      <AudioTrackRow
                        key={asset.asset_id}
                        asset={asset}
                        active={selectedAudio?.asset_id === asset.asset_id}
                        onClick={() => setSelectedAudioId(asset.asset_id)}
                      />
                    ))
                  ) : (
                    <div className="loading-panel loading-panel--stage">没有匹配的音频资源。</div>
                  )
                ) : (
                  <div className="loading-panel loading-panel--stage">正在读取 OGG 清单…</div>
                )}
              </div>

              {filteredAudio.length > AUDIO_PAGE_SIZE ? (
                <div className="pagination-strip">
                  <div className="pagination-strip__status">
                    显示第 {audioPageStart + 1}-{audioPageEnd} 条 / 共 {filteredAudio.length} 条
                  </div>
                  <div className="filter-row">
                    <button
                      className="ghost-button"
                      disabled={activeAudioPage === 1}
                      onClick={() => setAudioPage(1)}
                      type="button"
                    >
                      首页
                    </button>
                    <button
                      className="ghost-button"
                      disabled={activeAudioPage === 1}
                      onClick={() => setAudioPage((current) => Math.max(1, current - 1))}
                      type="button"
                    >
                      上一页
                    </button>
                    {buildPageWindow(activeAudioPage, audioPageCount).map((page) => (
                      <button
                        key={page}
                        className={page === activeAudioPage ? "toggle-chip toggle-chip--active" : "toggle-chip"}
                        onClick={() => setAudioPage(page)}
                        type="button"
                      >
                        {page}
                      </button>
                    ))}
                    <button
                      className="ghost-button"
                      disabled={activeAudioPage === audioPageCount}
                      onClick={() => setAudioPage((current) => Math.min(audioPageCount, current + 1))}
                      type="button"
                    >
                      下一页
                    </button>
                    <button
                      className="ghost-button"
                      disabled={activeAudioPage === audioPageCount}
                      onClick={() => setAudioPage(audioPageCount)}
                      type="button"
                    >
                      末页
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <aside className="inspector-panel">
              <section className="sidebar-card">
                <div className="sidebar-card__header">
                  <h2>播放器</h2>
                  <p>优先做资源对照和试听，保持和现有 viewer 的检查式工作流一致。</p>
                </div>
                {selectedAudio ? (
                  <div className="audio-player-shell">
                    <div className="audio-player-shell__meta">
                      <span className="map-card__badge">{selectedAudio.category}</span>
                      <span className="map-card__badge">{formatBytes(selectedAudio.file_size)}</span>
                    </div>
                    <p className="hover-report__title">{selectedAudio.label}</p>
                    <audio className="audio-player" controls preload="none" src={datasetUrl(selectedAudio.path)} />
                  </div>
                ) : (
                  <p className="muted-note">先从左侧挑一条 BGM 或 SE。</p>
                )}
              </section>

              {selectedAudio ? (
                <section className="sidebar-card">
                  <div className="sidebar-card__header">
                    <h2>资源信息</h2>
                    <p>导出后的浏览器路径与原始来源路径一并保留。</p>
                  </div>
                  <dl className="definition-list">
                    <div>
                      <dt>label</dt>
                      <dd>{selectedAudio.label}</dd>
                    </div>
                    <div>
                      <dt>category</dt>
                      <dd>{selectedAudio.category}</dd>
                    </div>
                    <div>
                      <dt>file size</dt>
                      <dd>{formatBytes(selectedAudio.file_size)}</dd>
                    </div>
                    <div>
                      <dt>source</dt>
                      <dd>{selectedAudio.source_name}</dd>
                    </div>
                    <div>
                      <dt>public path</dt>
                      <dd>{selectedAudio.path}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
            </aside>
          </main>
        </>
      ) : route.kind === "memorytext" ? (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / memory text</p>
              <h1>简中文本资源</h1>
              <p className="viewer-subtitle">
                资源来自 `memorytext_zhhans.dat.jpg`。`EXCELDATA_LoadMemoryText` 会先载入整表，
                `MEMORYTEXT_GetText(id)` 再按 `u32 count + u24 offset table` 直接取字符串指针。
              </p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              {route.textId != null ? (
                <button className="ghost-button" onClick={() => navigate({ kind: "memorytext", textId: null })} type="button">
                  清除定位
                </button>
              ) : null}
            </div>
          </header>

          {memorytextError ? <section className="error-banner">{memorytextError}</section> : null}

          <main className="viewer-layout viewer-layout--memorytext">
            <section className="stage-panel">
              <div className="stage-toolbar">
                <label className="search-card search-card--inline">
                  <span>文本检索</span>
                  <input
                    className="search-input"
                    value={memorytextSearch}
                    onChange={(event) => setMemorytextSearch(event.target.value)}
                    placeholder="按 text id 或内容搜索，比如 5000 / 格鲁曼 / 黑暗骑士"
                  />
                </label>
                <div className="filter-row">
                  <ToggleChip
                    active={memorytextDialogueOnly}
                    label="对话组"
                    onClick={() => setMemorytextDialogueOnly((current) => !current)}
                  />
                  {memorytextManifest ? (
                    <p className="muted-note">
                      当前结果 {filteredMemorytextEntryCount} 条 / {filteredMemorytextGroups.length} 组
                      {filteredMemorytextGroups.length ? `，第 ${activeMemorytextPage} / ${memorytextPageCount} 页` : ""}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="memorytext-browser">
                <div className="memorytext-group-list">
                  {memorytextManifest ? (
                    filteredMemorytextGroups.length ? (
                      pagedMemorytextGroups.map((group) => {
                        const isActive = selectedMemorytextGroup?.startTextId === group.startTextId;
                        const focusTextId = group.matchedEntryIds[0] ?? group.startTextId;
                        return (
                          <button
                            key={group.startTextId}
                            className={isActive ? "memorytext-group-nav memorytext-group-nav--active" : "memorytext-group-nav"}
                            onClick={() => navigate({ kind: "memorytext", textId: focusTextId })}
                            type="button"
                          >
                            <div className="memorytext-group-nav__meta">
                              <span className="map-card__badge">
                                {group.entryCount === 1
                                  ? `#${group.startTextId}`
                                  : `#${group.startTextId}..#${group.endTextId}`}
                              </span>
                              <span className="map-card__badge">{group.entryCount} 条</span>
                              {group.isDialogueGroup ? <span className="map-card__badge">dialogue</span> : null}
                              {group.matchedEntryCount ? (
                                <span className="map-card__badge">{group.matchedEntryCount} 命中</span>
                              ) : null}
                            </div>
                            <p className="memorytext-group-nav__title">
                              {group.entryCount === 1 ? "单条文本" : group.isDialogueGroup ? "连续对话组" : "连续文本组"}
                            </p>
                            <p className="memorytext-group-nav__excerpt">{group.previewText}</p>
                          </button>
                        );
                      })
                    ) : (
                      <div className="loading-panel loading-panel--stage">没有匹配的文本分组。</div>
                    )
                  ) : (
                    <div className="loading-panel loading-panel--stage">正在读取 `memorytext_zhhans` 导出结果…</div>
                  )}
                </div>

                <div className="memorytext-transcript-panel">
                  {selectedMemorytextGroup ? (
                    <>
                      <div className="memorytext-transcript__header">
                        <div>
                          <p className="eyebrow">
                            {selectedMemorytextGroup.entryCount === 1
                              ? `group #${selectedMemorytextGroup.startTextId}`
                              : `group #${selectedMemorytextGroup.startTextId}..#${selectedMemorytextGroup.endTextId}`}
                          </p>
                          <h2>{selectedMemorytextGroup.isDialogueGroup ? "连续对话阅读" : "连续文本上下文"}</h2>
                          <p className="muted-note">
                            搜索只高亮命中行，但会保留整组上下文，方便顺着连续文本往下读。
                          </p>
                        </div>
                        <div className="memorytext-transcript__summary">
                          <span className="map-card__badge">{selectedMemorytextGroup.entryCount} 条</span>
                          {selectedMemorytextGroup.isDialogueGroup ? (
                            <span className="map-card__badge">dialogue</span>
                          ) : null}
                          {selectedMemorytextGroup.matchedEntryCount ? (
                            <span className="map-card__badge">
                              {selectedMemorytextGroup.matchedEntryCount} 命中
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="memorytext-transcript">
                        {selectedMemorytextGroup.entries.map((entry, index) => {
                          const isActive = selectedMemorytextEntry?.text_id === entry.text_id;
                          const isMatched = selectedMemorytextMatchedEntrySet?.has(entry.text_id) ?? false;
                          const lineClassName = [
                            "memorytext-line",
                            isActive ? "memorytext-line--active" : "",
                            isMatched ? "memorytext-line--matched" : "",
                            entry.has_markup ? "memorytext-line--marked" : "",
                          ]
                            .filter(Boolean)
                            .join(" ");

                          return (
                            <button
                              key={entry.text_id}
                              ref={(node) => {
                                if (node) {
                                  memorytextEntryRefs.current.set(entry.text_id, node);
                                } else {
                                  memorytextEntryRefs.current.delete(entry.text_id);
                                }
                              }}
                              className={lineClassName}
                              onClick={() => navigate({ kind: "memorytext", textId: entry.text_id })}
                              type="button"
                            >
                              <div className="memorytext-line__rail" aria-hidden="true">
                                <span className="memorytext-line__dot" />
                                {index < selectedMemorytextGroup.entries.length - 1 ? (
                                  <span className="memorytext-line__thread" />
                                ) : null}
                              </div>

                              <div className="memorytext-line__body">
                                <div className="memorytext-line__meta">
                                  <span className="map-card__badge">#{entry.text_id}</span>
                                  {entry.has_markup ? <span className="map-card__badge">markup</span> : null}
                                  {isMatched ? <span className="map-card__badge">match</span> : null}
                                </div>
                                <MemoryTextPreview text={entry.text} compact />
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="memorytext-transcript memorytext-transcript--empty">
                      <p className="muted-note">
                        先从左侧选择一组文本，或者直接用 `#/memorytext/5000` 这样的路由定位。
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {filteredMemorytextGroups.length > 0 ? (
                <div className="pagination-strip">
                  <div className="pagination-strip__status">
                    显示第 {memorytextPageStart + 1}-{memorytextPageEnd} 组（{totalGroupEntryCount} 条） / 共 {filteredMemorytextGroups.length} 组
                  </div>
                  <div className="filter-row">
                    <button
                      className="ghost-button"
                      disabled={activeMemorytextPage === 1}
                      onClick={() => { navigate({ kind: "memorytext", textId: null }); setMemorytextPage(1); }}
                      type="button"
                    >
                      首页
                    </button>
                    <button
                      className="ghost-button"
                      disabled={activeMemorytextPage === 1}
                      onClick={() => { navigate({ kind: "memorytext", textId: null }); setMemorytextPage((current) => Math.max(1, current - 1)); }}
                      type="button"
                    >
                      上一页
                    </button>
                    {buildPageWindow(activeMemorytextPage, memorytextPageCount).map((page) => (
                      <button
                        key={page}
                        className={page === activeMemorytextPage ? "toggle-chip toggle-chip--active" : "toggle-chip"}
                        onClick={() => { navigate({ kind: "memorytext", textId: null }); setMemorytextPage(page); }}
                        type="button"
                      >
                        {page}
                      </button>
                    ))}
                    <button
                      className="ghost-button"
                      disabled={activeMemorytextPage === memorytextPageCount}
                      onClick={() => { navigate({ kind: "memorytext", textId: null }); setMemorytextPage((current) => Math.min(memorytextPageCount, current + 1)); }}
                      type="button"
                    >
                      下一页
                    </button>
                    <button
                      className="ghost-button"
                      disabled={activeMemorytextPage === memorytextPageCount}
                      onClick={() => { navigate({ kind: "memorytext", textId: null }); setMemorytextPage(memorytextPageCount); }}
                      type="button"
                    >
                      末页
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <aside className="inspector-panel">
              <section className="sidebar-card">
                <div className="sidebar-card__header">
                  <h2>聚焦文本</h2>
                  <p>右侧保持检查器角色，聚焦当前选中行，同时保留格式化预览和原始文本。</p>
                </div>
                {selectedMemorytextEntry ? (
                  <div className="hover-report">
                    <dl className="definition-list">
                      <div>
                        <dt>text id</dt>
                        <dd>{selectedMemorytextEntry.text_id}</dd>
                      </div>
                      <div>
                        <dt>group</dt>
                        <dd>
                          {selectedMemorytextGroup?.entryCount === 1
                            ? `#${selectedMemorytextGroup.startTextId}`
                            : `#${selectedMemorytextGroup?.startTextId}..#${selectedMemorytextGroup?.endTextId}`}
                        </dd>
                      </div>
                      <div>
                        <dt>context</dt>
                        <dd>
                          {selectedMemorytextGroup?.entryCount ?? 0} 条
                          {selectedMemorytextGroup?.isDialogueGroup ? " / dialogue" : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>markup</dt>
                        <dd>{selectedMemorytextEntry.has_markup ? "yes" : "no"}</dd>
                      </div>
                      <div>
                        <dt>length</dt>
                        <dd>{selectedMemorytextEntry.text.length}</dd>
                      </div>
                    </dl>

                    <div className="mini-section">
                      <h3>格式化预览</h3>
                      <MemoryTextPreview text={selectedMemorytextEntry.text} />
                    </div>

                    <div className="mini-section">
                      <h3>原始文本</h3>
                      <pre className="memorytext-raw">{selectedMemorytextEntry.text}</pre>
                    </div>
                  </div>
                ) : (
                  <p className="muted-note">先从左侧选一组文本，或者直接用 `#/memorytext/5000` 这样的路由定位。</p>
                )}
              </section>

              {memorytextManifest ? (
                <section className="sidebar-card">
                  <div className="sidebar-card__header">
                    <h2>数据范围</h2>
                    <p>当前只导出简体中文 `memorytext_zhhans.dat.jpg`。</p>
                  </div>
                  <dl className="definition-list">
                    <div>
                      <dt>record count</dt>
                      <dd>{memorytextManifest.record_count}</dd>
                    </div>
                    <div>
                      <dt>non-empty</dt>
                      <dd>{memorytextManifest.non_empty_count}</dd>
                    </div>
                    <div>
                      <dt>with markup</dt>
                      <dd>{memorytextManifest.markup_count}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
            </aside>
          </main>
        </>
      ) : route.kind === "worldmap" ? (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / world map</p>
              <h1>世界地图</h1>
              <p className="viewer-subtitle">
                由 `i_worldmap.dat.jpg` 组合出的整图，热点来自 `WORLDMAPBUILDER_Maker` 抽取的 `map_id` 到 `sprite_index`
                映射。
              </p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              {route.mapId != null ? (
                <button className="ghost-button" onClick={() => navigate({ kind: "map", mapId: route.mapId! })} type="button">
                  回到 m{route.mapId}
                </button>
              ) : null}
            </div>
          </header>

          {worldmapError ? <section className="error-banner">{worldmapError}</section> : null}

          <main className="viewer-layout viewer-layout--worldmap">
            <section className="stage-panel">
              <div className="stage-toolbar">
                <p className="muted-note">
                  点击热点可以查看该区域覆盖的地图 ID；从地图详情页进入时，会自动高亮当前地图所在区域。
                </p>
              </div>
              <div className="canvas-scroll">
                {dataset && worldmapImage ? (
                  <WorldmapCanvas
                    image={worldmapImage}
                    manifest={dataset.worldmapManifest}
                    selectedSpriteIndex={selectedWorldmapSpriteIndex}
                    onSelectRegion={setSelectedWorldmapSpriteIndex}
                  />
                ) : (
                  <div className="loading-panel loading-panel--stage">正在读取 worldmap 组合图…</div>
                )}
              </div>
            </section>

            <aside className="inspector-panel">
              <section className="sidebar-card">
                <div className="sidebar-card__header">
                  <h2>区域信息</h2>
                  <p>每个热点对应一个 `sprite_index`，并映射到一组地图 ID。</p>
                </div>
                {selectedWorldmapRegion ? (
                  <div className="hover-report">
                    <p className="hover-report__title worldmap-region-name">{selectedWorldmapRegion.name}</p>
                    <dl className="definition-list">
                      <div>
                        <dt>sprite index</dt>
                        <dd>{selectedWorldmapRegion.sprite_index}</dd>
                      </div>
                      <div>
                        <dt>bounds</dt>
                        <dd>
                          {selectedWorldmapRegion.width} x {selectedWorldmapRegion.height} @ {selectedWorldmapRegion.x},{" "}
                          {selectedWorldmapRegion.y}
                        </dd>
                      </div>
                      <div>
                        <dt>map count</dt>
                        <dd>{selectedWorldmapRegion.map_ids.length}</dd>
                      </div>
                    </dl>
                    <div className="mini-section">
                      <h3>覆盖地图</h3>
                      <div className="worldmap-map-list">
                        {selectedWorldmapRegion.map_ids.map((mapId) => (
                          <button
                            key={mapId}
                            className={route.mapId === mapId ? "map-card__badge worldmap-map-chip worldmap-map-chip--active" : "map-card__badge worldmap-map-chip"}
                            onClick={() => navigate({ kind: "map", mapId })}
                            title={manifestMapLookup.get(mapId)?.name ?? `m${mapId}`}
                            type="button"
                          >
                            m{mapId}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="muted-note">先点一个热点，或者从某张地图详情页跳进来。</p>
                )}
              </section>

              {dataset ? (
                <section className="sidebar-card">
                  <div className="sidebar-card__header">
                    <h2>数据范围</h2>
                    <p>当前 worldmap 数据集已经写入 `public/worldmap/`。</p>
                  </div>
                  <dl className="definition-list">
                    <div>
                      <dt>canvas</dt>
                      <dd>
                        {dataset.worldmapManifest.width} x {dataset.worldmapManifest.height}
                      </dd>
                    </div>
                    <div>
                      <dt>sprites</dt>
                      <dd>{dataset.worldmapManifest.sprite_count}</dd>
                    </div>
                    <div>
                      <dt>regions</dt>
                      <dd>{dataset.worldmapManifest.region_count}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
            </aside>
          </main>
        </>
      ) : (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / static map</p>
              <h1>{currentManifestEntry ? `m${currentManifestEntry.map_id} · ${currentManifestEntry.name}` : `m${route.mapId}`}</h1>
              <p className="viewer-subtitle">
                {currentManifestEntry
                  ? `${currentManifestEntry.width} x ${currentManifestEntry.height} tiles, palette set ${currentManifestEntry.palette_set_id}, text id ${currentManifestEntry.name_text_id}`
                  : "加载中…"}
              </p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              {route.kind === "map" ? (
                <button className="ghost-button" onClick={() => navigate({ kind: "worldmap", mapId: route.mapId })} type="button">
                  世界地图定位
                </button>
              ) : null}
              {currentManifestEntry ? (
                <button
                  className="ghost-button"
                  onClick={() => navigate({ kind: "memorytext", textId: currentManifestEntry.name_text_id })}
                  type="button"
                >
                  打开地图名文本
                </button>
              ) : null}
              {currentManifestEntry ? (
                <button
                  className="ghost-button"
                  onClick={() => window.open(datasetUrl(currentManifestEntry.preview_path), "_blank", "noopener")}
                  type="button"
                >
                  打开整图预览
                </button>
              ) : null}
            </div>
          </header>

          {mapError ? <section className="error-banner">{mapError}</section> : null}
          {atlasError ? <section className="error-banner">{atlasError}</section> : null}

          <main className="viewer-layout">
            <section className="stage-panel">
              <div className="stage-toolbar">
                <div className="zoom-strip">
                  <span>缩放</span>
                  <input
                    className="zoom-slider"
                    type="range"
                    min="1"
                    max="5"
                    step="0.25"
                    value={zoom}
                    onChange={(event) => setZoom(Number(event.target.value))}
                  />
                  <span>{zoom.toFixed(2)}x</span>
                </div>
                <div className="toggle-rack">
                  <ToggleChip active={toggles.base} label="base" onClick={() => setToggles((current) => ({ ...current, base: !current.base }))} />
                  <ToggleChip
                    active={toggles.shadow1}
                    label="shadow1"
                    onClick={() => setToggles((current) => ({ ...current, shadow1: !current.shadow1 }))}
                  />
                  <ToggleChip
                    active={toggles.shadow2}
                    label="shadow2"
                    onClick={() => setToggles((current) => ({ ...current, shadow2: !current.shadow2 }))}
                  />
                  <ToggleChip active={toggles.layer} label="layer" onClick={() => setToggles((current) => ({ ...current, layer: !current.layer }))} />
                  <ToggleChip
                    active={toggles.feature}
                    label="feature"
                    onClick={() => setToggles((current) => ({ ...current, feature: !current.feature }))}
                  />
                  <ToggleChip active={toggles.top} label="top" onClick={() => setToggles((current) => ({ ...current, top: !current.top }))} />
                </div>
              </div>

              <div className="canvas-scroll">
                {dataset && mapData && tileAtlas && featureAtlas ? (
                  <MapCanvas
                    dataset={dataset}
                    mapData={mapData}
                    tileAtlas={tileAtlas}
                    featureAtlas={featureAtlas}
                    toggles={toggles}
                    zoom={zoom}
                    hoveredCell={hoveredCell}
                    selectedCell={selectedCell}
                    onHoverCell={setHoveredCell}
                    onClickCell={setSelectedCell}
                  />
                ) : (
                  <div className="loading-panel loading-panel--stage">正在准备当前地图的 atlas 与 JSON…</div>
                )}
              </div>
            </section>

            <aside className="inspector-panel">
              <section className="sidebar-card">
                <div className="sidebar-card__header">
                  <h2>调试图层</h2>
                  <p>把导出脚本的 pass 逻辑拆开核对。</p>
                </div>
                <div className="toggle-column">
                  <ToggleChip active={toggles.grid} label="grid" onClick={() => setToggles((current) => ({ ...current, grid: !current.grid }))} />
                  <ToggleChip
                    active={toggles.showFlip}
                    label="flip"
                    onClick={() => setToggles((current) => ({ ...current, showFlip: !current.showFlip }))}
                  />
                  <ToggleChip
                    active={toggles.showTileIndex}
                    label="tile index"
                    onClick={() => setToggles((current) => ({ ...current, showTileIndex: !current.showTileIndex }))}
                  />
                  <ToggleChip
                    active={toggles.showRawFlags}
                    label="raw flags"
                    onClick={() => setToggles((current) => ({ ...current, showRawFlags: !current.showRawFlags }))}
                  />
                </div>
              </section>

              {mapData ? (
                <section className="sidebar-card">
                  <div className="sidebar-card__header">
                    <h2>地图概览</h2>
                    <p>直接来自 `maps/{'{mapId}'}.json`。</p>
                  </div>
                  <dl className="definition-list">
                    <div>
                      <dt>size</dt>
                      <dd>
                        {mapData.width} x {mapData.height}
                      </dd>
                    </div>
                    <div>
                      <dt>palette</dt>
                      <dd>{mapData.palette_set_id}</dd>
                    </div>
                    <div>
                      <dt>feature total</dt>
                      <dd>{mapData.total_feature_count}</dd>
                    </div>
                    <div>
                      <dt>feature layers</dt>
                      <dd>{mapData.feature_layer_counts.join(" / ")}</dd>
                    </div>
                    <div>
                      <dt>ignored records</dt>
                      <dd>{mapData.ignored_records.length}</dd>
                    </div>
                    <div>
                      <dt>link records</dt>
                      <dd>{mapData.link_records.length}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}

              <section className="sidebar-card">
                <div className="sidebar-card__header">
                  <h2>选中格</h2>
                  <p>点击画布格子查看 tile id、flags、layer slots 与原始偏移。</p>
                </div>
                {hoveredInfo && selectedCell ? (
                  <div className="hover-report">
                    <div className="hover-report__actions">
                      <button
                        className="ghost-button"
                        onClick={() => setSelectedCell(null)}
                        type="button"
                      >
                        清除选中
                      </button>
                    </div>
                    <p className="hover-report__title">
                      cell ({selectedCell.x}, {selectedCell.y}) / index {hoveredInfo.index}
                    </p>
                    <dl className="definition-list">
                      <div>
                        <dt>base tile</dt>
                        <dd>{hoveredInfo.baseCell >= 0 ? hoveredInfo.baseCell : "empty"}</dd>
                      </div>
                      <div>
                        <dt>base flags</dt>
                        <dd>
                          {hoveredInfo.baseFlags} ({formatHex(hoveredInfo.baseFlags)})
                        </dd>
                      </div>
                      <div>
                        <dt>base raw offset</dt>
                        <dd>{hoveredInfo.baseOffset}</dd>
                      </div>
                      <div>
                        <dt>shadow1</dt>
                        <dd>{formatPacked(hoveredInfo.shadow1)}</dd>
                      </div>
                      <div>
                        <dt>shadow2</dt>
                        <dd>{formatPacked(hoveredInfo.shadow2)}</dd>
                      </div>
                      <div>
                        <dt>top</dt>
                        <dd>{formatPacked(hoveredInfo.top)}</dd>
                      </div>
                      <div>
                        <dt>layer slots</dt>
                        <dd>{hoveredInfo.layerSlots.map((value, slot) => `#${slot}:${formatPacked(value)}`).join(" | ")}</dd>
                      </div>
                      <div>
                        <dt>entry stream</dt>
                        <dd>
                          {mapData?.raw_tail_offsets.entry_records_start}..{mapData?.raw_tail_offsets.entry_records_end}
                        </dd>
                      </div>
                    </dl>

                    <div className="mini-section">
                      <h3>static features</h3>
                      {hoveredInfo.featuresAtCell.length ? (
                        <ul className="chip-list">
                          {hoveredInfo.featuresAtCell.map((feature) => (
                            <li key={`${feature.record_offset}-${feature.feature_id}`}>
                              id {feature.feature_id} / layer {feature.layer} / offset {feature.record_offset}
                              {feature.flip ? " / flip" : ""}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-note">当前格无静态 feature 锚点。</p>
                      )}
                    </div>

                    <div className="mini-section">
                      <h3>map links</h3>
                      {hoveredInfo.linksAtCell.length ? (
                        <ul className="chip-list">
                          {hoveredInfo.linksAtCell.map((link, linkIndex) => (
                            <li key={`${link.target_map}-${link.target_link}-${linkIndex}`}>
                              to m{link.target_map} / link {link.target_link} / key {link.key}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-note">当前格无 link record。</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="muted-note">点击画布上的格子来查看当前格的 base、layer、feature 和偏移信息。</p>
                )}
              </section>

              {currentManifestEntry ? (
                <section className="sidebar-card">
                  <div className="sidebar-card__header">
                    <h2>整图预览</h2>
                    <p>导出脚本的 full-static 缩略图。</p>
                  </div>
                  <img
                    className="sidebar-preview"
                    src={datasetUrl(currentManifestEntry.preview_path)}
                    alt={`map ${currentManifestEntry.map_id} preview`}
                  />
                </section>
              ) : null}
            </aside>
          </main>
        </>
      )}
    </div>
  );
}

export default App;
