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

export interface ConsolidatedTextReference {
  table: string;
  table_index: number;
  category: string;
  field_offset: number;
}

export interface ConsolidatedTextField {
  field_offset: number;
  hit_count: number;
  hit_ratio: number;
}

export interface ConsolidatedTextTableDefinition {
  table_index: number;
  table_name: string;
  category: string;
  record_count: number;
  record_size: number;
  text_fields: ConsolidatedTextField[];
  referenced_text_count: number;
}

export interface ConsolidatedTextEntry {
  text_id: number;
  text: string;
  has_markup?: boolean;
  categories?: string[];
  referenced_by?: ConsolidatedTextReference[];
}

export interface ConsolidatedTextsDataset {
  description: string;
  source_file: string;
  language: string;
  total_text_ids: number;
  non_empty_entries: number;
  referenced_by_tables: number;
  unreferenced_count: number;
  category_summary: Record<string, number>;
  table_definitions: ConsolidatedTextTableDefinition[];
  entries: ConsolidatedTextEntry[];
}

export interface StaticRelationshipSection<T> {
  table_name: string;
  count: number;
  entries: T[];
}

export interface NpcDescriptionEntry {
  relation_id: number;
  npc_id: number;
  name_text_id: number;
  name: string;
  description_text_id: number;
  description: string;
}

export interface ItemDescriptionEntry {
  relation_id: number;
  item_id: number;
  name_text_id: number;
  name: string;
  description_text_id: number;
  description: string;
}

export interface ChoiceOptionEntry {
  slot: number;
  text_id: number;
  text: string;
}

export interface ChoiceSetEntry {
  choice_id: number;
  prompt_text_id: number;
  prompt: string;
  options: ChoiceOptionEntry[];
}

export interface QuestTextEntry {
  quest_id: number;
  title_text_id: number;
  title: string;
  detail_text_id: number;
  detail: string;
  progress_text_id: number;
  progress: string;
  completion_text_id: number;
  completion: string;
}

export interface StaticRelationshipsDataset {
  description: string;
  language: string;
  source_files: string[];
  npc_descriptions: StaticRelationshipSection<NpcDescriptionEntry>;
  item_descriptions: StaticRelationshipSection<ItemDescriptionEntry>;
  choice_sets: StaticRelationshipSection<ChoiceSetEntry>;
  quest_texts: StaticRelationshipSection<QuestTextEntry>;
}

export interface EventSpeaker {
  key: string;
  type: string;
  object_type: number;
  object_id: number;
  label: string;
  name_text_id?: number;
  resolved: boolean;
  source: string;
}

export interface EventDialogueLineEntry {
  sequence: number;
  command_index: number;
  opcode: number;
  kind: "dialogue" | "narration" | "overlay_text";
  raw_object_type: number;
  raw_object_id: number;
  raw_param: number;
  text_id: number;
  text: string;
  plain_text: string;
  speaker?: EventSpeaker;
}

export interface EventChoiceCommandEntry {
  sequence: number;
  command_index: number;
  opcode: number;
  kind: "choice";
  choice_id: number;
  choice?: ChoiceSetEntry;
  raw_object_type: number;
  raw_object_id: number;
  raw_param: number;
}

export type EventDialogueEntry = EventDialogueLineEntry | EventChoiceCommandEntry;

export interface EventDialogueScene {
  event_index: number;
  event_code: number;
  event_type: number;
  data_start_index: number;
  command_count: number;
  ui_flag: number;
  entry_count: number;
  preview_text: string;
  entries: EventDialogueEntry[];
}

export interface SpeakerCatalogEntry {
  speaker: EventSpeaker;
  line_count: number;
}

export interface EventDialoguesDataset {
  description: string;
  language: string;
  source_files: string[];
  event_count: number;
  eventdata_record_count: number;
  eventdata_record_size: number;
  opcode_kinds: Record<string, string>;
  kind_counts: Record<string, number>;
  speaker_catalog: SpeakerCatalogEntry[];
  events: EventDialogueScene[];
}

export interface TextResourceBundle {
  consolidated: ConsolidatedTextsDataset;
  relationships: StaticRelationshipsDataset;
  dialogues: EventDialoguesDataset;
}
