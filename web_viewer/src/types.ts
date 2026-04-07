export interface ManifestMap {
  map_id: number;
  name_text_id: number;
  name: string;
  width: number;
  height: number;
  palette_set_id: number;
  has_static_features: boolean;
  preview_path: string;
  raw_header_0: number;
  raw_header_1: number;
}

export interface RootManifest {
  map_count: number;
  tile_size: number;
  memorytext_manifest_path: string;
  memorytext_record_count: number;
  memorytext_non_empty_count: number;
  memorytext_markup_count: number;
  passthrough_assets_manifest_path: string;
  passthrough_image_count: number;
  passthrough_audio_count: number;
  worldmap_manifest_path: string;
  maps: ManifestMap[];
}

export interface PassthroughImageAsset {
  asset_id: string;
  label: string;
  source_name: string;
  path: string;
  width: number;
  height: number;
  file_size: number;
}

export interface PassthroughAudioAsset {
  asset_id: string;
  label: string;
  source_name: string;
  path: string;
  category: string;
  file_size: number;
}

export interface PassthroughAssetsManifest {
  image_count: number;
  audio_count: number;
  images: PassthroughImageAsset[];
  audio: PassthroughAudioAsset[];
}

export interface WorldmapSpriteEntry {
  sprite_index: number;
  x_offset: number;
  y_offset: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorldmapRegionEntry {
  sprite_index: number;
  name: string;
  map_ids: number[];
  x: number;
  y: number;
  width: number;
  height: number;
  center_x: number;
  center_y: number;
}

export interface WorldmapManifest {
  width: number;
  height: number;
  image_path: string;
  sprite_count: number;
  region_count: number;
  sprites: WorldmapSpriteEntry[];
  regions: WorldmapRegionEntry[];
}

export interface MemoryTextEntry {
  text_id: number;
  text: string;
  has_markup: boolean;
}

export interface MemoryTextManifest {
  language: string;
  resource_name: string;
  record_count: number;
  non_empty_count: number;
  markup_count: number;
  entries: MemoryTextEntry[];
}

export interface TileAtlasEntry {
  tile_id: number;
  palette_id: number | null;
  width: number;
  height: number;
  x_offset: number;
  y_offset: number;
  atlas_x: number;
  atlas_y: number;
}

export interface TilesetManifest {
  tile_size: number;
  atlas_width: number;
  atlas_height: number;
  tile_count: number;
  atlas_files: string[];
  tiles: TileAtlasEntry[];
}

export interface FeatureAtlasEntry {
  feature_id: number;
  group_id: number;
  palette_id: number;
  width: number;
  height: number;
  x_offset: number;
  y_offset: number;
  atlas_x: number;
  atlas_y: number;
}

export interface FeatureGroup {
  group_id: number;
  feature_ids: number[];
}

export interface FeatureManifest {
  atlas_width: number;
  atlas_height: number;
  atlas_files: string[];
  feature_count: number;
  features: FeatureAtlasEntry[];
  groups: FeatureGroup[];
}

export interface MapFeatureRaw {
  layer: number;
  x_tile: number;
  y_tile: number;
  x_px: number;
  y_px: number;
  feature_id: number;
  flip: boolean;
  record_offset: number;
  group_header_offset: number;
  slot_bias: number;
  record_type: number;
}

export interface IgnoredRecord {
  offset: number;
  type: number;
  section: number;
  x: number;
  y: number;
  id: number;
  flip?: boolean;
}

export interface LinkRecord {
  x: number;
  y: number;
  target_map: number;
  target_link: number;
  key: number;
}

export interface RawTailOffsets {
  base_start: number;
  base_end: number;
  total_feature_count_offset: number;
  feature_layer_counts_start: number;
  feature_layer_counts_end: number;
  entry_group_count_offset: number;
  entry_records_start: number;
  entry_records_end: number;
  link_count_offset: number;
  link_records_start: number;
  link_records_end: number;
  final_offset: number;
  total_size: number;
}

export interface MapData {
  map_id: number;
  width: number;
  height: number;
  palette_set_id: number;
  raw_header_0: number;
  raw_header_1: number;
  base_cells: number[];
  base_flags: number[];
  layer_slots: number[][];
  shadow1: number[];
  shadow2: number[];
  top: number[];
  total_feature_count: number;
  feature_layer_counts: number[];
  static_features_raw: MapFeatureRaw[];
  ignored_records: IgnoredRecord[];
  link_records: LinkRecord[];
  raw_tail_offsets: RawTailOffsets;
}

export interface DatasetBundle {
  rootManifest: RootManifest;
  tilesetManifest: TilesetManifest;
  featureManifest: FeatureManifest;
  worldmapManifest: WorldmapManifest;
  passthroughAssetsManifest: PassthroughAssetsManifest;
  tileLookup: Map<number, TileAtlasEntry>;
  featureLookup: Map<number, FeatureAtlasEntry>;
}
