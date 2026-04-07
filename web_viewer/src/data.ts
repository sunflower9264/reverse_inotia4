import type {
  ConsolidatedTextsDataset,
  DatasetBundle,
  EventDialoguesDataset,
  FeatureAtlasEntry,
  FeatureManifest,
  MapData,
  PassthroughAssetsManifest,
  RootManifest,
  StaticRelationshipsDataset,
  TextResourceBundle,
  TileAtlasEntry,
  TilesetManifest,
  WorldmapManifest,
} from "./types";
import consolidatedTextsUrl from "../data/texts/consolidated_texts.json?url";
import eventDialoguesUrl from "../data/texts/event_dialogues.json?url";
import staticRelationshipsUrl from "../data/texts/static_relationships.json?url";

const jsonCache = new Map<string, Promise<unknown>>();
const imageCache = new Map<string, Promise<HTMLImageElement>>();

const basePath = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

export function datasetUrl(path: string): string {
  return `${basePath}${path}`;
}

async function fetchJsonUrl<T>(url: string, label: string): Promise<T> {
  if (!jsonCache.has(url)) {
    jsonCache.set(
      url,
      fetch(url).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load ${label}: ${response.status} ${response.statusText}`);
        }
        return response.json();
      }),
    );
  }
  return jsonCache.get(url) as Promise<T>;
}

async function fetchJson<T>(path: string): Promise<T> {
  return fetchJsonUrl(datasetUrl(path), path);
}

function loadImage(path: string): Promise<HTMLImageElement> {
  const url = datasetUrl(path);
  if (!imageCache.has(url)) {
    imageCache.set(
      url,
      new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Failed to load image: ${path}`));
        image.src = url;
      }),
    );
  }
  return imageCache.get(url) as Promise<HTMLImageElement>;
}

export async function loadDatasetBundle(): Promise<DatasetBundle> {
  const rootManifest = await fetchJson<RootManifest>("manifest.json");
  const [tilesetManifest, featureManifest, worldmapManifest, passthroughAssetsManifest] = await Promise.all([
    fetchJson<TilesetManifest>("tiles/tileset_manifest.json"),
    fetchJson<FeatureManifest>("features/feature_manifest.json"),
    fetchJson<WorldmapManifest>(rootManifest.worldmap_manifest_path),
    fetchJson<PassthroughAssetsManifest>(rootManifest.passthrough_assets_manifest_path),
  ]);

  const tileLookup = new Map<number, TileAtlasEntry>();
  const featureLookup = new Map<number, FeatureAtlasEntry>();

  for (const tile of tilesetManifest.tiles) {
    tileLookup.set(tile.tile_id, tile);
  }

  for (const feature of featureManifest.features) {
    featureLookup.set(feature.feature_id, feature);
  }

  return {
    rootManifest,
    tilesetManifest,
    featureManifest,
    worldmapManifest,
    passthroughAssetsManifest,
    tileLookup,
    featureLookup,
  };
}

export function loadMapData(mapId: number): Promise<MapData> {
  return fetchJson<MapData>(`maps/${mapId}.json`);
}

export function loadTileAtlas(setId: number): Promise<HTMLImageElement> {
  return loadImage(`tiles/atlas/tile_palette_set_${String(setId).padStart(2, "0")}.png`);
}

export function loadFeatureAtlas(setId: number): Promise<HTMLImageElement> {
  return loadImage(`features/atlas/feature_palette_set_${String(setId).padStart(2, "0")}.png`);
}

export function loadWorldmapImage(path: string): Promise<HTMLImageElement> {
  return loadImage(path);
}

export function loadConsolidatedTexts(): Promise<ConsolidatedTextsDataset> {
  return fetchJsonUrl<ConsolidatedTextsDataset>(consolidatedTextsUrl, "data/texts/consolidated_texts.json");
}

export function loadStaticRelationships(): Promise<StaticRelationshipsDataset> {
  return fetchJsonUrl<StaticRelationshipsDataset>(staticRelationshipsUrl, "data/texts/static_relationships.json");
}

export function loadEventDialogues(): Promise<EventDialoguesDataset> {
  return fetchJsonUrl<EventDialoguesDataset>(eventDialoguesUrl, "data/texts/event_dialogues.json");
}

export async function loadTextResourceBundle(): Promise<TextResourceBundle> {
  const [consolidated, relationships, dialogues] = await Promise.all([
    loadConsolidatedTexts(),
    loadStaticRelationships(),
    loadEventDialogues(),
  ]);

  return {
    consolidated,
    relationships,
    dialogues,
  };
}
