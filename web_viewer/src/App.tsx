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
  loadTextResourceBundle,
  loadTileAtlas,
  loadWorldmapImage,
} from "./data";
import { renderMap, type HoverCell, type RenderToggles } from "./render";
import type {
  ChoiceSetEntry,
  ConsolidatedTextEntry,
  DatasetBundle,
  EventDialogueLineEntry,
  EventDialogueScene,
  EventSpeaker,
  ItemDescriptionEntry,
  ManifestMap,
  MapData,
  NpcDescriptionEntry,
  PassthroughAudioAsset,
  PassthroughImageAsset,
  QuestTextEntry,
  SpeakerCatalogEntry,
  TextResourceBundle,
  WorldmapManifest,
  WorldmapRegionEntry,
} from "./types";

const PAGE_SIZES = { dialogue: 16, relations: 18, archive: 28 } as const;
const TILE_SIZE = 16;
const AUDIO_PAGE_SIZE = 10;
const MEMORYTEXT_COLOR_MAP: Record<string, string> = {
  A: "#2a3fb6",
  C: "#137d40",
  G: "#6d6b63",
  L: "#a53f2a",
  M: "#138a64",
  O: "#2f6fae",
  P: "#9155b8",
  Q: "#597b97",
  R: "#2a52c1",
  S: "#aa6500",
  T: "#b75d5d",
  V: "#b3226a",
  W: "#efe7d8",
  Y: "#00828d",
};
const CATEGORY_LABELS: Record<string, string> = {
  choice: "选项",
  event_info: "事件文本",
  item: "物品",
  item_desc: "物品描述",
  map_info: "地图文本",
  mercenary_info: "佣兵文本",
  monster: "怪物文本",
  npc_desc: "NPC 描述",
  npc_info: "NPC 文本",
  quest_complete: "任务完成",
  quest_info: "任务文本",
  quest_reward: "任务奖励",
  skill_desc: "技能说明",
};

type ViewMode = "dialogue" | "relations" | "archive";
type RelationKind = "npc" | "item" | "quest" | "choice";
type RelationFilter = "all" | RelationKind;
type MemoryTextToken =
  | { kind: "text"; text: string; colorCode: string | null }
  | { kind: "break"; paragraph: boolean };

type RelationCard =
  | { key: string; kind: "npc"; title: string; summary: string; searchBlob: string; textIds: number[]; entry: NpcDescriptionEntry }
  | { key: string; kind: "item"; title: string; summary: string; searchBlob: string; textIds: number[]; entry: ItemDescriptionEntry }
  | { key: string; kind: "quest"; title: string; summary: string; searchBlob: string; textIds: number[]; entry: QuestTextEntry }
  | { key: string; kind: "choice"; title: string; summary: string; searchBlob: string; textIds: number[]; entry: ChoiceSetEntry };

interface DialogueCard {
  scene: EventDialogueScene;
  preview: string;
  participants: EventSpeaker[];
  dialogueCount: number;
  narrationCount: number;
  choiceCount: number;
  searchBlob: string;
}

interface ArchiveCard {
  entry: ConsolidatedTextEntry;
  preview: string;
  searchBlob: string;
}

type Route =
  | { kind: "index" }
  | { kind: "map"; mapId: number }
  | { kind: "worldmap"; mapId: number | null }
  | { kind: "gallery" }
  | { kind: "audio" }
  | { kind: "texts"; textId: number | null };

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
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

function stripTextMarkup(text: string): string {
  return text
    .replace(/\$[A-Z]/g, "")
    .replace(/&P/g, "\n\n")
    .replace(/&N/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}

function relationLabel(kind: RelationKind): string {
  switch (kind) {
    case "npc":
      return "NPC 描述";
    case "item":
      return "物品描述";
    case "quest":
      return "任务文本";
    case "choice":
      return "选项组";
  }
}

function buildPageWindow(currentPage: number, totalPages: number): number[] {
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function parseRoute(hash: string): Route {
  if (hash === "#/gallery") {
    return { kind: "gallery" };
  }
  if (hash === "#/audio") {
    return { kind: "audio" };
  }
  const textMatch = hash.match(/^#\/texts(?:\/(\d+))?$/);
  if (textMatch) {
    return { kind: "texts", textId: textMatch[1] ? Number(textMatch[1]) : null };
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

function parseMemoryTextMarkup(text: string): MemoryTextToken[] {
  const tokens: MemoryTextToken[] = [];
  let buffer = "";
  let activeColor: string | null = null;

  const flush = () => {
    if (!buffer) return;
    tokens.push({ kind: "text", text: buffer, colorCode: activeColor });
    buffer = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === "&" && next === "N") {
      flush();
      tokens.push({ kind: "break", paragraph: false });
      index += 1;
      continue;
    }
    if (ch === "&" && next === "P") {
      flush();
      tokens.push({ kind: "break", paragraph: true });
      index += 1;
      continue;
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

function eventMentionsText(scene: EventDialogueScene, textId: number): boolean {
  return scene.entries.some((entry) => {
    if (entry.kind === "choice") {
      if (entry.choice?.prompt_text_id === textId) return true;
      return entry.choice?.options.some((option) => option.text_id === textId) ?? false;
    }
    return entry.text_id === textId;
  });
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <p className="metric-card__label">{label}</p>
      <p className="metric-card__value">{value}</p>
      <p className="metric-card__detail">{detail}</p>
    </article>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={active ? "filter-chip filter-chip--active" : "filter-chip"} onClick={onClick} type="button">
      {label}
    </button>
  );
}

function PaginationControls({
  currentPage,
  totalPages,
  onChange,
}: {
  currentPage: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="pagination">
      <button className="filter-chip" disabled={currentPage === 1} onClick={() => onChange(1)} type="button">
        首页
      </button>
      <button className="filter-chip" disabled={currentPage === 1} onClick={() => onChange(Math.max(1, currentPage - 1))} type="button">
        上一页
      </button>
      {buildPageWindow(currentPage, totalPages).map((page) => (
        <button key={page} className={page === currentPage ? "filter-chip filter-chip--active" : "filter-chip"} onClick={() => onChange(page)} type="button">
          {page}
        </button>
      ))}
      <button className="filter-chip" disabled={currentPage === totalPages} onClick={() => onChange(Math.min(totalPages, currentPage + 1))} type="button">
        下一页
      </button>
      <button className="filter-chip" disabled={currentPage === totalPages} onClick={() => onChange(totalPages)} type="button">
        末页
      </button>
    </div>
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
    } else if (next.kind === "worldmap") {
      window.location.hash = next.mapId == null ? "#/worldmap" : `#/worldmap/${next.mapId}`;
    } else if (next.kind === "gallery") {
      window.location.hash = "#/gallery";
    } else if (next.kind === "audio") {
      window.location.hash = "#/audio";
    } else if (next.kind === "texts") {
      window.location.hash = next.textId == null ? "#/texts" : `#/texts/${next.textId}`;
    } else {
      window.location.hash = `#/map/${next.mapId}`;
    }

    startTransition(() => {
      setRoute(next);
    });
  };

  return [route, navigate];
}

function TextIdButton({ textId, onOpen }: { textId: number; onOpen: (textId: number) => void }) {
  return (
    <button className="text-id-button" onClick={() => onOpen(textId)} type="button">
      #{textId}
    </button>
  );
}

function MemoryTextPreview({ text, compact = false }: { text: string; compact?: boolean }) {
  const tokens = parseMemoryTextMarkup(text);
  if (!tokens.length) return <p className="empty-note">当前条目为空文本。</p>;

  return (
    <div className={compact ? "memorytext-preview memorytext-preview--compact" : "memorytext-preview"}>
      {tokens.map((token, index) => {
        if (token.kind === "break") {
          return token.paragraph ? <div key={`break-${index}`} className="memorytext-preview__paragraph-break" /> : <br key={`break-${index}`} />;
        }
        const color = token.colorCode ? MEMORYTEXT_COLOR_MAP[token.colorCode] ?? "var(--accent-strong)" : undefined;
        return (
          <span key={`text-${index}`} className={token.colorCode ? "memorytext-preview__segment memorytext-preview__segment--marked" : "memorytext-preview__segment"} style={color ? { color } : undefined}>
            {token.text}
          </span>
        );
      })}
    </div>
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
    <button className={active ? "navigator-card navigator-card--active asset-card" : "navigator-card asset-card"} onClick={onClick} type="button">
      <div className="asset-card__media">
        <img className="asset-card__thumb" src={datasetUrl(asset.path)} alt={asset.label} loading="lazy" />
      </div>
      <div className="asset-card__body">
        <div className="navigator-card__meta">
          <span className="chip">{asset.width} x {asset.height}</span>
          <span className="chip chip--muted">{formatBytes(asset.file_size)}</span>
        </div>
        <h3 className="navigator-card__title">{asset.label}</h3>
        <p className="navigator-card__summary">{asset.source_name}</p>
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
    <button className={active ? "navigator-card navigator-card--active audio-row" : "navigator-card audio-row"} onClick={onClick} type="button">
      <div className="navigator-card__meta">
        <span className="chip">{asset.category}</span>
        <span className="chip chip--muted">{formatBytes(asset.file_size)}</span>
      </div>
      <h3 className="navigator-card__title">{asset.label}</h3>
      <p className="navigator-card__summary">{asset.source_name}</p>
    </button>
  );
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
  }, [dataset, featureAtlas, hoveredCell, mapData, selectedCell, tileAtlas, toggles, zoom]);

  const resolveCell = (event: MouseEvent<HTMLCanvasElement>): HoverCell | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = event.currentTarget.width / rect.width;
    const scaleY = event.currentTarget.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / TILE_SIZE);
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / TILE_SIZE);
    if (x < 0 || y < 0 || x >= mapData.width || y >= mapData.height) {
      return null;
    }
    return { x, y };
  };

  return (
    <div className="canvas-stage">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        width={widthPx}
        height={heightPx}
        style={{ width: `${widthPx * zoom}px`, height: `${heightPx * zoom}px`, cursor: "crosshair" }}
        onMouseMove={(event) => onHoverCell(resolveCell(event))}
        onMouseLeave={() => onHoverCell(null)}
        onClick={(event) => {
          const next = resolveCell(event);
          if (next == null) {
            return;
          }
          if (selectedCell && selectedCell.x === next.x && selectedCell.y === next.y) {
            onClickCell(null);
            return;
          }
          onClickCell(next);
        }}
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
      <img className="worldmap-image" src={image.src} alt="world map" style={{ width: `${manifest.width * scale}px`, height: `${manifest.height * scale}px` }} />
      {manifest.regions.map((region) => (
        <button
          key={region.sprite_index}
          className={selectedSpriteIndex === region.sprite_index ? "worldmap-pin worldmap-pin--active" : "worldmap-pin"}
          style={{ left: `${region.center_x * scale}px`, top: `${region.center_y * scale}px` }}
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

function TextArchiveView({
  initialTextId,
  onNavigateHome,
  onOpenTextId,
}: {
  initialTextId: number | null;
  onNavigateHome: () => void;
  onOpenTextId: (textId: number | null) => void;
}) {
  const [bundle, setBundle] = useState<TextResourceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("dialogue");
  const [dialogueSearch, setDialogueSearch] = useState("");
  const [relationSearch, setRelationSearch] = useState("");
  const [archiveSearch, setArchiveSearch] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("all");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("all");
  const [archiveCategory, setArchiveCategory] = useState("all");
  const [dialoguePage, setDialoguePage] = useState(1);
  const [relationPage, setRelationPage] = useState(1);
  const [archivePage, setArchivePage] = useState(1);
  const [selectedDialogueId, setSelectedDialogueId] = useState<number | null>(null);
  const [selectedRelationKey, setSelectedRelationKey] = useState<string | null>(null);
  const [selectedTextId, setSelectedTextId] = useState<number | null>(null);

  const deferredDialogueSearch = useDeferredValue(dialogueSearch.trim().toLowerCase());
  const deferredRelationSearch = useDeferredValue(relationSearch.trim().toLowerCase());
  const deferredArchiveSearch = useDeferredValue(archiveSearch.trim().toLowerCase());

  useEffect(() => {
    let cancelled = false;
    loadTextResourceBundle()
      .then((nextBundle) => {
        if (cancelled) return;
        setBundle(nextBundle);
        setError(null);
      })
      .catch((loadError: Error) => {
        if (cancelled) return;
        setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setDialoguePage(1);
    setSelectedDialogueId(null);
  }, [deferredDialogueSearch, speakerFilter]);
  useEffect(() => {
    setRelationPage(1);
    setSelectedRelationKey(null);
  }, [deferredRelationSearch, relationFilter]);
  useEffect(() => {
    setArchivePage(1);
    setSelectedTextId(null);
  }, [deferredArchiveSearch, archiveCategory]);

  const relationCards: RelationCard[] = bundle
    ? [
        ...bundle.relationships.npc_descriptions.entries.map((entry) => ({
          key: `npc:${entry.npc_id}`,
          kind: "npc" as const,
          title: entry.name || `NPC #${entry.npc_id}`,
          summary: stripTextMarkup(entry.description || "暂无描述。"),
          searchBlob: [entry.npc_id, entry.name, entry.description, entry.name_text_id, entry.description_text_id, "npc"].join(" ").toLowerCase(),
          textIds: [entry.name_text_id, entry.description_text_id].filter((value) => value >= 0),
          entry,
        })),
        ...bundle.relationships.item_descriptions.entries.map((entry) => ({
          key: `item:${entry.item_id}`,
          kind: "item" as const,
          title: entry.name || `物品 #${entry.item_id}`,
          summary: stripTextMarkup(entry.description || "暂无描述。"),
          searchBlob: [entry.item_id, entry.name, entry.description, entry.name_text_id, entry.description_text_id, "item"].join(" ").toLowerCase(),
          textIds: [entry.name_text_id, entry.description_text_id].filter((value) => value >= 0),
          entry,
        })),
        ...bundle.relationships.quest_texts.entries.map((entry) => ({
          key: `quest:${entry.quest_id}`,
          kind: "quest" as const,
          title: entry.title || `任务 #${entry.quest_id}`,
          summary: stripTextMarkup(entry.detail || entry.progress || entry.completion || "暂无正文。"),
          searchBlob: [entry.quest_id, entry.title, entry.detail, entry.progress, entry.completion, "quest"].join(" ").toLowerCase(),
          textIds: [entry.title_text_id, entry.detail_text_id, entry.progress_text_id, entry.completion_text_id].filter((value) => value >= 0),
          entry,
        })),
        ...bundle.relationships.choice_sets.entries.map((entry) => ({
          key: `choice:${entry.choice_id}`,
          kind: "choice" as const,
          title: stripTextMarkup(entry.prompt || `选择 #${entry.choice_id}`),
          summary: entry.options.map((option) => stripTextMarkup(option.text)).join(" / "),
          searchBlob: [entry.choice_id, entry.prompt, ...entry.options.map((option) => option.text), "choice"].join(" ").toLowerCase(),
          textIds: [entry.prompt_text_id, ...entry.options.map((option) => option.text_id)].filter((value) => value >= 0),
          entry,
        })),
      ]
    : [];

  const dialogueCards: DialogueCard[] = bundle
    ? bundle.dialogues.events.map((scene) => {
        const participantsByKey = new Map<string, EventSpeaker>();
        let dialogueCount = 0;
        let narrationCount = 0;
        let choiceCount = 0;
        const searchParts: string[] = [scene.event_index.toString(), scene.event_code.toString(), scene.preview_text];

        for (const entry of scene.entries) {
          if (entry.kind === "choice") {
            choiceCount += 1;
            if (entry.choice) searchParts.push(entry.choice.prompt, ...entry.choice.options.map((option) => option.text));
            continue;
          }
          if (entry.kind === "dialogue") {
            dialogueCount += 1;
            if (entry.speaker) {
              participantsByKey.set(entry.speaker.key, entry.speaker);
              searchParts.push(entry.speaker.label);
            }
          } else {
            narrationCount += 1;
          }
          searchParts.push(entry.text_id.toString(), entry.plain_text, entry.text);
        }

        return {
          scene,
          preview: stripTextMarkup(scene.preview_text),
          participants: [...participantsByKey.values()],
          dialogueCount,
          narrationCount,
          choiceCount,
          searchBlob: searchParts.join(" ").toLowerCase(),
        };
      })
    : [];

  const archiveCards: ArchiveCard[] = bundle
    ? bundle.consolidated.entries.map((entry) => ({
        entry,
        preview: stripTextMarkup(entry.text),
        searchBlob: [entry.text_id, entry.text, stripTextMarkup(entry.text), ...(entry.categories ?? []), ...(entry.referenced_by ?? []).flatMap((ref) => [ref.table, ref.category])].join(" ").toLowerCase(),
      }))
    : [];

  const filteredDialogueCards = dialogueCards.filter((card) => {
    if (speakerFilter !== "all" && !card.participants.some((participant) => participant.key === speakerFilter)) return false;
    if (!deferredDialogueSearch) return true;
    return card.searchBlob.includes(deferredDialogueSearch);
  });

  const filteredRelationCards = relationCards.filter((card) => {
    if (relationFilter !== "all" && card.kind !== relationFilter) return false;
    if (!deferredRelationSearch) return true;
    return card.searchBlob.includes(deferredRelationSearch);
  });

  const filteredArchiveCards = archiveCards.filter((card) => {
    if (archiveCategory !== "all" && !(card.entry.categories ?? []).includes(archiveCategory)) return false;
    if (!deferredArchiveSearch) return true;
    return card.searchBlob.includes(deferredArchiveSearch);
  });

  const dialoguePageCount = Math.max(1, Math.ceil(filteredDialogueCards.length / PAGE_SIZES.dialogue));
  const relationPageCount = Math.max(1, Math.ceil(filteredRelationCards.length / PAGE_SIZES.relations));
  const archivePageCount = Math.max(1, Math.ceil(filteredArchiveCards.length / PAGE_SIZES.archive));
  const activeDialoguePage = Math.min(dialoguePage, dialoguePageCount);
  const activeRelationPage = Math.min(relationPage, relationPageCount);
  const activeArchivePage = Math.min(archivePage, archivePageCount);
  const visibleDialogueCards = filteredDialogueCards.slice((activeDialoguePage - 1) * PAGE_SIZES.dialogue, activeDialoguePage * PAGE_SIZES.dialogue);
  const visibleRelationCards = filteredRelationCards.slice((activeRelationPage - 1) * PAGE_SIZES.relations, activeRelationPage * PAGE_SIZES.relations);
  const visibleArchiveCards = filteredArchiveCards.slice((activeArchivePage - 1) * PAGE_SIZES.archive, activeArchivePage * PAGE_SIZES.archive);

  useEffect(() => {
    if (viewMode !== "dialogue") return;
    if (!filteredDialogueCards.length) {
      setSelectedDialogueId(null);
      return;
    }
    const index = selectedDialogueId == null ? -1 : filteredDialogueCards.findIndex((card) => card.scene.event_index === selectedDialogueId);
    if (index < 0) {
      setSelectedDialogueId(filteredDialogueCards[0].scene.event_index);
      return;
    }
    const targetPage = Math.floor(index / PAGE_SIZES.dialogue) + 1;
    if (targetPage !== activeDialoguePage) setDialoguePage(targetPage);
  }, [activeDialoguePage, filteredDialogueCards, selectedDialogueId, viewMode]);

  useEffect(() => {
    if (viewMode !== "relations") return;
    if (!filteredRelationCards.length) {
      setSelectedRelationKey(null);
      return;
    }
    const index = selectedRelationKey == null ? -1 : filteredRelationCards.findIndex((card) => card.key === selectedRelationKey);
    if (index < 0) {
      setSelectedRelationKey(filteredRelationCards[0].key);
      return;
    }
    const targetPage = Math.floor(index / PAGE_SIZES.relations) + 1;
    if (targetPage !== activeRelationPage) setRelationPage(targetPage);
  }, [activeRelationPage, filteredRelationCards, selectedRelationKey, viewMode]);

  useEffect(() => {
    if (viewMode !== "archive") return;
    if (!filteredArchiveCards.length) {
      setSelectedTextId(null);
      return;
    }
    const index = selectedTextId == null ? -1 : filteredArchiveCards.findIndex((card) => card.entry.text_id === selectedTextId);
    if (index < 0) {
      setSelectedTextId(filteredArchiveCards[0].entry.text_id);
      return;
    }
    const targetPage = Math.floor(index / PAGE_SIZES.archive) + 1;
    if (targetPage !== activeArchivePage) setArchivePage(targetPage);
  }, [activeArchivePage, filteredArchiveCards, selectedTextId, viewMode]);

  useEffect(() => {
    if (initialTextId == null) {
      return;
    }
    startTransition(() => {
      setViewMode("archive");
      setArchiveCategory("all");
      setArchiveSearch(String(initialTextId));
      setSelectedTextId(initialTextId);
    });
  }, [initialTextId]);

  const selectedDialogueCard =
    (selectedDialogueId == null ? visibleDialogueCards[0] : filteredDialogueCards.find((card) => card.scene.event_index === selectedDialogueId)) ??
    visibleDialogueCards[0] ??
    null;
  const selectedRelationCard =
    (selectedRelationKey == null ? visibleRelationCards[0] : filteredRelationCards.find((card) => card.key === selectedRelationKey)) ??
    visibleRelationCards[0] ??
    null;
  const selectedArchiveCard =
    (selectedTextId == null ? visibleArchiveCards[0] : filteredArchiveCards.find((card) => card.entry.text_id === selectedTextId)) ??
    visibleArchiveCards[0] ??
    null;

  const topCategories = bundle ? Object.entries(bundle.consolidated.category_summary).sort((left, right) => right[1] - left[1]).slice(0, 10) : [];
  const linkedRelations = selectedArchiveCard ? relationCards.filter((card) => card.textIds.includes(selectedArchiveCard.entry.text_id)).slice(0, 8) : [];
  const linkedScenes = bundle && selectedArchiveCard ? bundle.dialogues.events.filter((scene) => eventMentionsText(scene, selectedArchiveCard.entry.text_id)).slice(0, 8) : [];
  const sourceFiles = bundle ? [...new Set([bundle.consolidated.source_file, ...bundle.relationships.source_files, ...bundle.dialogues.source_files])] : [];

  const openArchiveText = (textId: number) => {
    onOpenTextId(textId);
    startTransition(() => {
      setViewMode("archive");
      setArchiveCategory("all");
      setArchiveSearch(String(textId));
      setSelectedTextId(textId);
    });
  };

  const openScene = (eventIndex: number) => {
    startTransition(() => {
      setViewMode("dialogue");
      setDialogueSearch("");
      setSpeakerFilter("all");
      setSelectedDialogueId(eventIndex);
    });
  };

  const activeSearch = viewMode === "dialogue" ? dialogueSearch : viewMode === "relations" ? relationSearch : archiveSearch;
  const setActiveSearch = (value: string) => {
    if (viewMode === "dialogue") {
      setDialogueSearch(value);
      return;
    }
    if (viewMode === "relations") {
      setRelationSearch(value);
      return;
    }
    setArchiveSearch(value);
  };

  const changeDialoguePage = (page: number) => {
    const nextPage = Math.max(1, Math.min(page, dialoguePageCount));
    const nextLead = filteredDialogueCards[(nextPage - 1) * PAGE_SIZES.dialogue];
    setDialoguePage(nextPage);
    setSelectedDialogueId(nextLead?.scene.event_index ?? null);
  };

  const changeRelationPage = (page: number) => {
    const nextPage = Math.max(1, Math.min(page, relationPageCount));
    const nextLead = filteredRelationCards[(nextPage - 1) * PAGE_SIZES.relations];
    setRelationPage(nextPage);
    setSelectedRelationKey(nextLead?.key ?? null);
  };

  const changeArchivePage = (page: number) => {
    const nextPage = Math.max(1, Math.min(page, archivePageCount));
    const nextLead = filteredArchiveCards[(nextPage - 1) * PAGE_SIZES.archive];
    setArchivePage(nextPage);
    setSelectedTextId(nextLead?.entry.text_id ?? null);
  };

  return (
    <div className="app-shell app-shell--text-archive">
      <div className="ambient-noise" />
      <div className="ambient-blot ambient-blot--left" />
      <div className="ambient-blot ambient-blot--right" />

      <header className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">reverse_inotia4 / text archive</p>
          <h1>艾诺迪亚 IV 文本档案馆</h1>
          <p className="hero-description">这个页面现在按“剧情对白 / 描述关系 / 原始文本”三种阅读路径组织资源，能直接顺着人物和对象关系浏览文本。</p>
          <div className="viewer-actions">
            <button className="ghost-button" onClick={onNavigateHome} type="button">
              返回资源索引
            </button>
          </div>
        </div>
        <div className="hero-metrics">
          <MetricCard label="对白场景" value={bundle ? formatCount(bundle.dialogues.event_count) : "…"} detail="来自 eventdata" />
          <MetricCard label="命名说话人" value={bundle ? formatCount(bundle.dialogues.speaker_catalog.length) : "…"} detail="主角 / NPC / 运行时角色" />
          <MetricCard label="静态关系" value={bundle ? formatCount(relationCards.length) : "…"} detail="名称 -> 描述 / 问题 -> 选项" />
          <MetricCard label="原始文本" value={bundle ? formatCount(bundle.consolidated.non_empty_entries) : "…"} detail="简中非空条目" />
        </div>
      </header>

      <section className="toolbar-panel">
        <div className="mode-strip">
          <FilterChip active={viewMode === "dialogue"} label="剧情对白" onClick={() => setViewMode("dialogue")} />
          <FilterChip active={viewMode === "relations"} label="描述关系" onClick={() => setViewMode("relations")} />
          <FilterChip active={viewMode === "archive"} label="原始文本" onClick={() => setViewMode("archive")} />
        </div>

        <div className="toolbar-main">
          <label className="search-panel">
            <span>{viewMode === "dialogue" ? "对白检索" : viewMode === "relations" ? "关系检索" : "原始文本检索"}</span>
            <input
              className="search-input"
              value={activeSearch}
              onChange={(event) => setActiveSearch(event.target.value)}
              placeholder={
                viewMode === "dialogue"
                  ? "按人物、场景号或台词搜索"
                  : viewMode === "relations"
                    ? "按名字、描述或选项搜索"
                    : "按 text_id、分类或正文搜索"
              }
            />
          </label>

          <div className="toolbar-meta">
            {viewMode === "dialogue" ? (
              <>
                <label className="compact-select">
                  <span>说话人</span>
                  <select value={speakerFilter} onChange={(event) => setSpeakerFilter(event.target.value)}>
                    <option value="all">全部角色</option>
                    {bundle?.dialogues.speaker_catalog.map((item: SpeakerCatalogEntry) => (
                      <option key={item.speaker.key} value={item.speaker.key}>
                        {item.speaker.label} ({item.line_count})
                      </option>
                    ))}
                  </select>
                </label>
                <p className="toolbar-note">{formatCount(filteredDialogueCards.length)} / {bundle ? formatCount(bundle.dialogues.event_count) : "0"} 个场景</p>
              </>
            ) : null}

            {viewMode === "relations" ? (
              <>
                <div className="chip-row">
                  <FilterChip active={relationFilter === "all"} label="全部" onClick={() => setRelationFilter("all")} />
                  <FilterChip active={relationFilter === "npc"} label="NPC" onClick={() => setRelationFilter("npc")} />
                  <FilterChip active={relationFilter === "item"} label="物品" onClick={() => setRelationFilter("item")} />
                  <FilterChip active={relationFilter === "quest"} label="任务" onClick={() => setRelationFilter("quest")} />
                  <FilterChip active={relationFilter === "choice"} label="选项" onClick={() => setRelationFilter("choice")} />
                </div>
                <p className="toolbar-note">{formatCount(filteredRelationCards.length)} / {formatCount(relationCards.length)} 个条目</p>
              </>
            ) : null}

            {viewMode === "archive" ? (
              <>
                <label className="compact-select">
                  <span>分类</span>
                  <select value={archiveCategory} onChange={(event) => setArchiveCategory(event.target.value)}>
                    <option value="all">全部分类</option>
                    {topCategories.map(([category, count]) => (
                      <option key={category} value={category}>
                        {categoryLabel(category)} ({count})
                      </option>
                    ))}
                    {bundle
                      ? Object.keys(bundle.consolidated.category_summary)
                          .sort()
                          .filter((category) => !topCategories.some(([top]) => top === category))
                          .map((category) => (
                            <option key={category} value={category}>
                              {categoryLabel(category)} ({bundle.consolidated.category_summary[category]})
                            </option>
                          ))
                      : null}
                  </select>
                </label>
                <p className="toolbar-note">{formatCount(filteredArchiveCards.length)} / {bundle ? formatCount(bundle.consolidated.non_empty_entries) : "0"} 条文本</p>
              </>
            ) : null}
          </div>
        </div>
      </section>

      {error ? <section className="error-banner">{error}</section> : null}

      {!bundle ? (
        <section className="loading-panel">正在读取对白、关系和原始文本档案…</section>
      ) : (
        <main className="workspace">
          <aside className="navigator-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Navigator</p>
                <h2>{viewMode === "dialogue" ? "剧情对白" : viewMode === "relations" ? "描述关系" : "原始文本"}</h2>
              </div>
              <p className="panel-header__detail">{viewMode === "dialogue" ? "按场景阅读整段剧情。" : viewMode === "relations" ? "按业务对象直接读关系文本。" : "按 text_id 与分类反查原文。"}</p>
            </div>

            <div className="navigator-list">
              {viewMode === "dialogue"
                ? visibleDialogueCards.map((card) => (
                    <button
                      key={card.scene.event_index}
                      className={selectedDialogueCard?.scene.event_index === card.scene.event_index ? "navigator-card navigator-card--active" : "navigator-card"}
                      onClick={() => setSelectedDialogueId(card.scene.event_index)}
                      type="button"
                    >
                      <div className="navigator-card__meta">
                        <span className="chip">scene #{card.scene.event_index}</span>
                        <span className="chip">{card.dialogueCount} 句对白</span>
                        {card.choiceCount ? <span className="chip">{card.choiceCount} 次选项</span> : null}
                      </div>
                      <h3 className="navigator-card__title">{card.preview || `场景 #${card.scene.event_index}`}</h3>
                      <p className="navigator-card__summary">{card.participants.length ? card.participants.slice(0, 4).map((participant) => participant.label).join(" / ") : "以旁白或叙述为主"}</p>
                    </button>
                  ))
                : null}

              {viewMode === "relations"
                ? visibleRelationCards.map((card) => (
                    <button
                      key={card.key}
                      className={selectedRelationCard?.key === card.key ? "navigator-card navigator-card--active" : "navigator-card"}
                      onClick={() => setSelectedRelationKey(card.key)}
                      type="button"
                    >
                      <div className="navigator-card__meta">
                        <span className="chip">{relationLabel(card.kind)}</span>
                      </div>
                      <h3 className="navigator-card__title">{card.title}</h3>
                      <p className="navigator-card__summary">{card.summary || "暂无摘要。"}</p>
                    </button>
                  ))
                : null}

              {viewMode === "archive"
                ? visibleArchiveCards.map((card) => (
                    <button
                      key={card.entry.text_id}
                      className={selectedArchiveCard?.entry.text_id === card.entry.text_id ? "navigator-card navigator-card--active" : "navigator-card"}
                      onClick={() => setSelectedTextId(card.entry.text_id)}
                      type="button"
                    >
                      <div className="navigator-card__meta">
                        <span className="chip">#{card.entry.text_id}</span>
                        {(card.entry.categories ?? []).slice(0, 2).map((category) => (
                          <span key={category} className="chip chip--muted">
                            {categoryLabel(category)}
                          </span>
                        ))}
                      </div>
                      <h3 className="navigator-card__title archive-title">{card.preview.slice(0, 36) || `text #${card.entry.text_id}`}</h3>
                      <p className="navigator-card__summary">{card.preview || "原文为空。"}</p>
                    </button>
                  ))
                : null}

              {viewMode === "dialogue" && visibleDialogueCards.length === 0 ? <div className="empty-state">没有匹配的场景。</div> : null}
              {viewMode === "relations" && visibleRelationCards.length === 0 ? <div className="empty-state">没有匹配的关系条目。</div> : null}
              {viewMode === "archive" && visibleArchiveCards.length === 0 ? <div className="empty-state">没有匹配的原始文本。</div> : null}
            </div>

            <PaginationControls
              currentPage={viewMode === "dialogue" ? activeDialoguePage : viewMode === "relations" ? activeRelationPage : activeArchivePage}
              totalPages={viewMode === "dialogue" ? dialoguePageCount : viewMode === "relations" ? relationPageCount : archivePageCount}
              onChange={(page) => {
                if (viewMode === "dialogue") {
                  changeDialoguePage(page);
                  return;
                }
                if (viewMode === "relations") {
                  changeRelationPage(page);
                  return;
                }
                changeArchivePage(page);
              }}
            />
          </aside>

          <section className="stage-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Stage</p>
                <h2>{viewMode === "dialogue" ? "剧情阅读" : viewMode === "relations" ? "关系阅读" : "原文检查"}</h2>
              </div>
              <p className="panel-header__detail">{viewMode === "dialogue" ? "台词、旁白和选项同屏阅读。" : viewMode === "relations" ? "名称和描述拆成更接近页面消费的结构。" : "保留原始 text_id、分类与表引用。"}</p>
            </div>

            <div className="stage-body">
              {viewMode === "dialogue" && selectedDialogueCard ? (
                <>
                  <section className="feature-block feature-block--hero">
                    <div className="feature-block__meta">
                      <span className="chip">scene #{selectedDialogueCard.scene.event_index}</span>
                      <span className="chip">event code {selectedDialogueCard.scene.event_code}</span>
                      <span className="chip">{selectedDialogueCard.scene.entry_count} 条记录</span>
                    </div>
                    <h3 className="feature-block__title">{selectedDialogueCard.preview || "未命名场景"}</h3>
                    <div className="speaker-cloud">
                      {selectedDialogueCard.participants.map((speaker) => (
                        <button
                          key={speaker.key}
                          className={speaker.key === speakerFilter ? "speaker-pill speaker-pill--active" : "speaker-pill"}
                          onClick={() => setSpeakerFilter(speaker.key)}
                          type="button"
                        >
                          {speaker.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="transcript-panel">
                    {selectedDialogueCard.scene.entries.map((entry) => {
                      if (entry.kind === "choice") {
                        return (
                          <article key={`${entry.command_index}-choice`} className="scene-entry scene-entry--choice">
                            <div className="scene-entry__meta">
                              <span className="chip">choice #{entry.choice_id}</span>
                              <span className="chip">opcode {entry.opcode}</span>
                            </div>
                            <h4 className="scene-entry__speaker">玩家选项</h4>
                            {entry.choice ? (
                              <>
                                <div className="scene-choice__prompt">
                                  <MemoryTextPreview text={entry.choice.prompt} />
                                  <TextIdButton textId={entry.choice.prompt_text_id} onOpen={openArchiveText} />
                                </div>
                                <div className="scene-choice__options">
                                  {entry.choice.options.map((option) => (
                                    <div key={`${entry.choice_id}-${option.slot}`} className="choice-option">
                                      <span className="choice-option__slot">{option.slot}</span>
                                      <MemoryTextPreview text={option.text} compact />
                                      <TextIdButton textId={option.text_id} onOpen={openArchiveText} />
                                    </div>
                                  ))}
                                </div>
                              </>
                            ) : (
                              <p className="empty-note">该选项组尚未能解析出具体文本。</p>
                            )}
                          </article>
                        );
                      }

                      const line = entry as EventDialogueLineEntry;
                      const isPlayer = line.kind === "dialogue" && line.speaker?.type === "player";
                      const className = ["scene-entry", line.kind === "narration" ? "scene-entry--narration" : "", line.kind === "overlay_text" ? "scene-entry--overlay" : "", isPlayer ? "scene-entry--player" : ""].filter(Boolean).join(" ");
                      return (
                        <article key={`${line.command_index}-${line.sequence}`} className={className}>
                          <div className="scene-entry__meta">
                            <span className="chip">{line.kind}</span>
                            <span className="chip">opcode {line.opcode}</span>
                            <TextIdButton textId={line.text_id} onOpen={openArchiveText} />
                          </div>
                          <h4 className="scene-entry__speaker">{line.kind === "dialogue" ? line.speaker?.label ?? "未知说话人" : line.kind === "narration" ? "旁白" : "覆盖文字"}</h4>
                          <MemoryTextPreview text={line.text} />
                        </article>
                      );
                    })}
                  </section>
                </>
              ) : null}

              {viewMode === "relations" && selectedRelationCard ? (
                <>
                  <section className="feature-block feature-block--hero">
                    <div className="feature-block__meta">
                      <span className="chip">{relationLabel(selectedRelationCard.kind)}</span>
                    </div>
                    <h3 className="feature-block__title">{selectedRelationCard.title}</h3>
                    <p className="feature-block__copy">{selectedRelationCard.summary || "暂无正文。"}</p>
                    <div className="chip-row">
                      {selectedRelationCard.textIds.map((textId) => (
                        <TextIdButton key={textId} textId={textId} onOpen={openArchiveText} />
                      ))}
                    </div>
                  </section>

                  {(selectedRelationCard.kind === "npc" || selectedRelationCard.kind === "item") ? (
                    <section className="feature-grid">
                      <article className="feature-block">
                        <p className="feature-block__section-label">名称</p>
                        <MemoryTextPreview text={selectedRelationCard.entry.name || "未命名"} />
                      </article>
                      <article className="feature-block">
                        <p className="feature-block__section-label">描述</p>
                        <MemoryTextPreview text={selectedRelationCard.entry.description || "暂无描述。"} />
                      </article>
                    </section>
                  ) : null}

                  {selectedRelationCard.kind === "quest" ? (
                    <section className="feature-grid">
                      <article className="feature-block">
                        <p className="feature-block__section-label">任务名</p>
                        <MemoryTextPreview text={selectedRelationCard.entry.title || "未命名任务"} />
                      </article>
                      <article className="feature-block">
                        <p className="feature-block__section-label">任务详情</p>
                        <MemoryTextPreview text={selectedRelationCard.entry.detail || "暂无详情。"} />
                      </article>
                      <article className="feature-block">
                        <p className="feature-block__section-label">进行中</p>
                        <MemoryTextPreview text={selectedRelationCard.entry.progress || "暂无进行中文本。"} />
                      </article>
                      <article className="feature-block">
                        <p className="feature-block__section-label">完成文本</p>
                        <MemoryTextPreview text={selectedRelationCard.entry.completion || "暂无完成文本。"} />
                      </article>
                    </section>
                  ) : null}

                  {selectedRelationCard.kind === "choice" ? (
                    <section className="feature-grid">
                      <article className="feature-block feature-block--wide">
                        <p className="feature-block__section-label">题面</p>
                        <div className="scene-choice__prompt">
                          <MemoryTextPreview text={selectedRelationCard.entry.prompt || "暂无题面。"} />
                          <TextIdButton textId={selectedRelationCard.entry.prompt_text_id} onOpen={openArchiveText} />
                        </div>
                      </article>
                      <article className="feature-block feature-block--wide">
                        <p className="feature-block__section-label">选项</p>
                        <div className="scene-choice__options">
                          {selectedRelationCard.entry.options.map((option) => (
                            <div key={`${selectedRelationCard.entry.choice_id}-${option.slot}`} className="choice-option">
                              <span className="choice-option__slot">{option.slot}</span>
                              <MemoryTextPreview text={option.text} compact />
                              <TextIdButton textId={option.text_id} onOpen={openArchiveText} />
                            </div>
                          ))}
                        </div>
                      </article>
                    </section>
                  ) : null}
                </>
              ) : null}

              {viewMode === "archive" && selectedArchiveCard ? (
                <>
                  <section className="feature-block feature-block--hero">
                    <div className="feature-block__meta">
                      <span className="chip">text #{selectedArchiveCard.entry.text_id}</span>
                      {selectedArchiveCard.entry.has_markup ? <span className="chip">markup</span> : null}
                      <span className="chip">{(selectedArchiveCard.entry.referenced_by ?? []).length} 处引用</span>
                    </div>
                    <h3 className="feature-block__title">{selectedArchiveCard.preview.slice(0, 80) || `text #${selectedArchiveCard.entry.text_id}`}</h3>
                    <div className="chip-row">
                      {(selectedArchiveCard.entry.categories ?? []).map((category) => (
                        <button key={category} className={archiveCategory === category ? "filter-chip filter-chip--active" : "filter-chip"} onClick={() => setArchiveCategory(category)} type="button">
                          {categoryLabel(category)}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="feature-grid">
                    <article className="feature-block">
                      <p className="feature-block__section-label">格式化预览</p>
                      <MemoryTextPreview text={selectedArchiveCard.entry.text} />
                    </article>
                    <article className="feature-block">
                      <p className="feature-block__section-label">原始文本</p>
                      <pre className="text-raw">{selectedArchiveCard.entry.text}</pre>
                    </article>
                    <article className="feature-block feature-block--wide">
                      <p className="feature-block__section-label">引用表</p>
                      <div className="reference-grid">
                        {(selectedArchiveCard.entry.referenced_by ?? []).length ? selectedArchiveCard.entry.referenced_by?.map((reference, index) => (
                          <div key={`${reference.table}-${reference.field_offset}-${index}`} className="reference-chip">
                            <strong>{reference.table}</strong>
                            <span>{reference.category}</span>
                            <span>field {reference.field_offset}</span>
                          </div>
                        )) : <p className="empty-note">当前没有记录到引用表。</p>}
                      </div>
                    </article>
                  </section>
                </>
              ) : null}
            </div>
          </section>

          <aside className="inspector-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Inspector</p>
                <h2>关联线索</h2>
              </div>
              <p className="panel-header__detail">这里放全局统计、快速过滤和跨视图跳转。</p>
            </div>

            <div className="inspector-stack">
              <section className="inspector-card">
                <h3>数据范围</h3>
                <dl className="definition-list">
                  <div><dt>language</dt><dd>{bundle.consolidated.language}</dd></div>
                  <div><dt>source files</dt><dd>{sourceFiles.join(", ")}</dd></div>
                  <div><dt>categories</dt><dd>{formatCount(Object.keys(bundle.consolidated.category_summary).length)}</dd></div>
                  <div><dt>non-empty</dt><dd>{formatCount(bundle.consolidated.non_empty_entries)}</dd></div>
                </dl>
              </section>

              {viewMode === "dialogue" ? (
                <>
                  <section className="inspector-card">
                    <h3>高频说话人</h3>
                    <div className="speaker-list">
                      {bundle.dialogues.speaker_catalog.slice(0, 12).map((item: SpeakerCatalogEntry) => (
                        <button key={item.speaker.key} className={speakerFilter === item.speaker.key ? "speaker-pill speaker-pill--active" : "speaker-pill"} onClick={() => setSpeakerFilter(item.speaker.key)} type="button">
                          {item.speaker.label}
                          <span>{item.line_count}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  {selectedDialogueCard ? (
                    <section className="inspector-card">
                      <h3>当前场景</h3>
                      <dl className="definition-list">
                        <div><dt>event index</dt><dd>{selectedDialogueCard.scene.event_index}</dd></div>
                        <div><dt>participants</dt><dd>{selectedDialogueCard.participants.length}</dd></div>
                        <div><dt>dialogue</dt><dd>{selectedDialogueCard.dialogueCount}</dd></div>
                        <div><dt>narration</dt><dd>{selectedDialogueCard.narrationCount}</dd></div>
                        <div><dt>choice</dt><dd>{selectedDialogueCard.choiceCount}</dd></div>
                      </dl>
                    </section>
                  ) : null}
                </>
              ) : null}

              {viewMode === "relations" ? (
                <>
                  <section className="inspector-card">
                    <h3>关系总览</h3>
                    <div className="mini-stats">
                      <div><span>NPC</span><strong>{bundle.relationships.npc_descriptions.count}</strong></div>
                      <div><span>物品</span><strong>{bundle.relationships.item_descriptions.count}</strong></div>
                      <div><span>任务</span><strong>{bundle.relationships.quest_texts.count}</strong></div>
                      <div><span>选项</span><strong>{bundle.relationships.choice_sets.count}</strong></div>
                    </div>
                  </section>
                  {selectedRelationCard ? (
                    <section className="inspector-card">
                      <h3>文本定位</h3>
                      <div className="chip-row">
                        {selectedRelationCard.textIds.map((textId) => (
                          <TextIdButton key={textId} textId={textId} onOpen={openArchiveText} />
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              ) : null}

              {viewMode === "archive" ? (
                <>
                  <section className="inspector-card">
                    <h3>常用分类</h3>
                    <div className="chip-row">
                      {topCategories.map(([category]) => (
                        <button key={category} className={archiveCategory === category ? "filter-chip filter-chip--active" : "filter-chip"} onClick={() => setArchiveCategory(category)} type="button">
                          {categoryLabel(category)}
                        </button>
                      ))}
                    </div>
                  </section>
                  {selectedArchiveCard ? (
                    <>
                      <section className="inspector-card">
                        <h3>关联关系</h3>
                        {linkedRelations.length ? (
                          <div className="link-stack">
                            {linkedRelations.map((card) => (
                              <button key={card.key} className="inspector-link" onClick={() => { setViewMode("relations"); setRelationFilter("all"); setRelationSearch(""); setSelectedRelationKey(card.key); }} type="button">
                                <span>{relationLabel(card.kind)}</span>
                                <strong>{card.title}</strong>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="empty-note">这条文本暂时没有命中静态关系导出。</p>
                        )}
                      </section>
                      <section className="inspector-card">
                        <h3>关联场景</h3>
                        {linkedScenes.length ? (
                          <div className="link-stack">
                            {linkedScenes.map((scene) => (
                              <button key={scene.event_index} className="inspector-link" onClick={() => openScene(scene.event_index)} type="button">
                                <span>scene #{scene.event_index}</span>
                                <strong>{stripTextMarkup(scene.preview_text) || `场景 #${scene.event_index}`}</strong>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="empty-note">这条文本没有命中对白场景。</p>
                        )}
                      </section>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}

function App() {
  const [route, navigate] = useHashRoute();
  const [dataset, setDataset] = useState<DatasetBundle | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
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

  const deferredMapSearch = useDeferredValue(mapSearch.trim().toLowerCase());
  const deferredImageSearch = useDeferredValue(imageSearch.trim().toLowerCase());
  const deferredAudioSearch = useDeferredValue(audioSearch.trim().toLowerCase());

  useEffect(() => {
    let cancelled = false;
    loadDatasetBundle()
      .then((bundle) => {
        if (cancelled) {
          return;
        }
        setDataset(bundle);
        setDatasetError(null);
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        setDatasetError(error.message);
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
        if (cancelled) {
          return;
        }
        setMapData(nextMap);
        setMapError(null);
        setHoveredCell(null);
        setSelectedCell(null);
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        setMapError(error.message);
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
        if (cancelled) {
          return;
        }
        setTileAtlas(tileImage);
        setFeatureAtlas(featureImage);
        setAtlasError(null);
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        setAtlasError(error.message);
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
        if (cancelled) {
          return;
        }
        setWorldmapImage(image);
        setWorldmapError(null);
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        setWorldmapError(error.message);
      });

    return () => {
      cancelled = true;
    };
  }, [dataset]);

  useEffect(() => {
    if (route.kind !== "worldmap" || !dataset) {
      setSelectedWorldmapSpriteIndex(null);
      return;
    }
    const region = findWorldmapRegion(dataset.worldmapManifest, route.mapId);
    setSelectedWorldmapSpriteIndex(region?.sprite_index ?? dataset.worldmapManifest.regions[0]?.sprite_index ?? null);
  }, [dataset, route]);

  useEffect(() => {
    if (route.kind !== "audio") {
      return;
    }
    setAudioPage(1);
  }, [audioCategory, deferredAudioSearch, route.kind]);

  const currentManifestEntry =
    route.kind === "map" && dataset ? dataset.rootManifest.maps.find((entry) => entry.map_id === route.mapId) ?? null : null;
  const manifestMapLookup = dataset ? new Map(dataset.rootManifest.maps.map((entry) => [entry.map_id, entry])) : new Map<number, ManifestMap>();
  const paletteOptions = dataset ? [...new Set(dataset.rootManifest.maps.map((entry) => entry.palette_set_id))].sort((left, right) => left - right) : [];

  const filteredMaps = dataset
    ? dataset.rootManifest.maps.filter((entry) => {
        if (paletteFilter !== "all" && entry.palette_set_id !== paletteFilter) {
          return false;
        }
        if (!deferredMapSearch) {
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
          .includes(deferredMapSearch);
      })
    : [];

  const filteredImages = dataset
    ? dataset.passthroughAssetsManifest.images.filter((entry) => {
        if (!deferredImageSearch) {
          return true;
        }
        return [entry.label, entry.source_name, `${entry.width}x${entry.height}`]
          .join(" ")
          .toLowerCase()
          .includes(deferredImageSearch);
      })
    : [];

  const filteredAudio = dataset
    ? dataset.passthroughAssetsManifest.audio.filter((entry) => {
        if (audioCategory !== "all" && entry.category !== audioCategory) {
          return false;
        }
        if (!deferredAudioSearch) {
          return true;
        }
        return [entry.label, entry.source_name, entry.category].join(" ").toLowerCase().includes(deferredAudioSearch);
      })
    : [];

  const audioPageCount = Math.max(1, Math.ceil(filteredAudio.length / AUDIO_PAGE_SIZE));
  const activeAudioPage = Math.min(audioPage, audioPageCount);
  const audioPageStart = (activeAudioPage - 1) * AUDIO_PAGE_SIZE;
  const audioPageEnd = Math.min(audioPageStart + AUDIO_PAGE_SIZE, filteredAudio.length);
  const pagedAudio = filteredAudio.slice(audioPageStart, audioPageEnd);

  const selectedImage =
    route.kind === "gallery"
      ? (selectedImageId != null ? filteredImages.find((entry) => entry.asset_id === selectedImageId) ?? null : filteredImages[0] ?? null)
      : null;
  const selectedAudio =
    route.kind === "audio"
      ? (selectedAudioId != null ? filteredAudio.find((entry) => entry.asset_id === selectedAudioId) ?? null : filteredAudio[0] ?? null)
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
            layerSlots: mapData.layer_slots[index],
            shadow1: mapData.shadow1[index],
            shadow2: mapData.shadow2[index],
            top: mapData.top[index],
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

  const toggleFlag = (key: keyof RenderToggles) => {
    setToggles((current) => ({ ...current, [key]: !current[key] }));
  };

  if (route.kind === "texts") {
    return (
      <TextArchiveView
        initialTextId={route.textId}
        onNavigateHome={() => navigate({ kind: "index" })}
        onOpenTextId={(textId) => navigate({ kind: "texts", textId })}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="ambient-noise" />
      <div className="ambient-blot ambient-blot--left" />
      <div className="ambient-blot ambient-blot--right" />

      {route.kind === "index" ? (
        <>
          <header className="hero-panel">
            <div className="hero-copy">
              <p className="eyebrow">reverse_inotia4 / resource viewer</p>
              <h1>Web 资源查看器</h1>
              <p className="hero-description">
                入口页继续保留地图、世界地图、图片和音乐预览；新的文本关系浏览器被单独收进 `#/texts`，
                不再挤占原来的资源视图。
              </p>
            </div>
            <div className="hero-metrics">
              <MetricCard label="地图" value={dataset ? formatCount(dataset.rootManifest.map_count) : "…"} detail="m0..m415 全量索引" />
              <MetricCard label="世界地图" value={dataset ? formatCount(dataset.worldmapManifest.region_count) : "…"} detail="区域热点可点击" />
              <MetricCard label="图片" value={dataset ? formatCount(dataset.rootManifest.passthrough_image_count) : "…"} detail="game_res 直出 PNG" />
              <MetricCard label="音频" value={dataset ? formatCount(dataset.rootManifest.passthrough_audio_count) : "…"} detail="BGM 与 SE" />
            </div>
          </header>

          <section className="toolbar-panel">
            <div className="toolbar-main">
              <label className="search-panel">
                <span>地图检索</span>
                <input className="search-input" value={mapSearch} onChange={(event) => setMapSearch(event.target.value)} placeholder="例如 m109 / 潘德利 / 45x45 / palette 7" />
              </label>
              <div className="toolbar-meta">
                <label className="compact-select">
                  <span>palette</span>
                  <select
                    value={paletteFilter}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPaletteFilter(value === "all" ? "all" : Number(value));
                    }}
                  >
                    <option value="all">全部</option>
                    {paletteOptions.map((paletteId) => (
                      <option key={paletteId} value={paletteId}>
                        palette {paletteId}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="ghost-button" onClick={() => navigate({ kind: "worldmap", mapId: null })} type="button">
                  世界地图
                </button>
                <button className="ghost-button" onClick={() => navigate({ kind: "texts", textId: null })} type="button">
                  文本档案
                </button>
                <button className="ghost-button" onClick={() => navigate({ kind: "gallery" })} type="button">
                  图片资源
                </button>
                <button className="ghost-button" onClick={() => navigate({ kind: "audio" })} type="button">
                  音频资源
                </button>
              </div>
            </div>
          </section>

          {datasetError ? <section className="error-banner">{datasetError}</section> : null}

          {!dataset ? (
            <section className="loading-panel">正在读取地图、世界地图、图片和音频资源索引…</section>
          ) : (
            <main className="map-grid">
              {filteredMaps.map((entry) => (
                <button key={entry.map_id} className="navigator-card map-card" onClick={() => navigate({ kind: "map", mapId: entry.map_id })} type="button">
                  <img className="map-card__preview" src={datasetUrl(entry.preview_path)} alt={`map ${entry.map_id}`} loading="lazy" />
                  <div className="navigator-card__meta">
                    <span className="chip">m{entry.map_id}</span>
                    <span className="chip chip--muted">palette {entry.palette_set_id}</span>
                    {entry.has_static_features ? <span className="chip chip--muted">feature</span> : null}
                  </div>
                  <h2 className="navigator-card__title">m{entry.map_id}</h2>
                  <p className="navigator-card__summary">{entry.name}</p>
                  <p className="navigator-card__summary">
                    {entry.width} x {entry.height} tiles
                  </p>
                </button>
              ))}
            </main>
          )}
        </>
      ) : route.kind === "gallery" ? (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / passthrough png</p>
              <h1>未加密图片资源</h1>
              <p className="viewer-subtitle">这里展示 `game_res` 里能直接还原的 PNG 资源，左侧清单，右侧大图预览。</p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              <button className="ghost-button" onClick={() => navigate({ kind: "texts", textId: null })} type="button">
                文本档案
              </button>
              {selectedImage ? (
                <button className="ghost-button" onClick={() => window.open(datasetUrl(selectedImage.path), "_blank", "noopener")} type="button">
                  打开原图
                </button>
              ) : null}
            </div>
          </header>

          {datasetError ? <section className="error-banner">{datasetError}</section> : null}

          <main className="viewer-layout viewer-layout--gallery">
            <section className="stage-panel">
              <div className="stage-toolbar">
                <label className="search-panel">
                  <span>图片检索</span>
                  <input className="search-input" value={imageSearch} onChange={(event) => setImageSearch(event.target.value)} placeholder="按文件名、尺寸或来源路径搜索" />
                </label>
                <p className="toolbar-note">{dataset ? `${formatCount(filteredImages.length)} / ${formatCount(dataset.rootManifest.passthrough_image_count)} 张图片` : "…"}</p>
              </div>
              <div className="asset-gallery">
                {dataset ? (
                  filteredImages.length ? (
                    filteredImages.map((asset) => (
                      <AssetCard key={asset.asset_id} asset={asset} active={selectedImage?.asset_id === asset.asset_id} onClick={() => setSelectedImageId(asset.asset_id)} />
                    ))
                  ) : (
                    <div className="loading-panel">没有匹配的图片资源。</div>
                  )
                ) : (
                  <div className="loading-panel">正在读取图片资源…</div>
                )}
              </div>
            </section>

            <aside className="inspector-panel">
              <section className="inspector-card">
                <h3>图片预览</h3>
                {selectedImage ? (
                  <div className="asset-preview-frame">
                    <img className="asset-preview" src={datasetUrl(selectedImage.path)} alt={selectedImage.label} />
                  </div>
                ) : (
                  <p className="empty-note">先从左侧选一张图片。</p>
                )}
              </section>

              {selectedImage ? (
                <section className="inspector-card">
                  <h3>资源信息</h3>
                  <dl className="definition-list">
                    <div><dt>label</dt><dd>{selectedImage.label}</dd></div>
                    <div><dt>size</dt><dd>{selectedImage.width} x {selectedImage.height}</dd></div>
                    <div><dt>file size</dt><dd>{formatBytes(selectedImage.file_size)}</dd></div>
                    <div><dt>source</dt><dd>{selectedImage.source_name}</dd></div>
                    <div><dt>path</dt><dd>{selectedImage.path}</dd></div>
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
              <p className="viewer-subtitle">这里保留 OGG 资源浏览和播放器，支持按 BGM / SE 过滤。</p>
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
              <div className="stage-toolbar stage-toolbar--stack">
                <label className="search-panel">
                  <span>音频检索</span>
                  <input className="search-input" value={audioSearch} onChange={(event) => setAudioSearch(event.target.value)} placeholder="按文件名、分类或来源搜索" />
                </label>
                <div className="chip-row">
                  <FilterChip active={audioCategory === "all"} label="全部" onClick={() => setAudioCategory("all")} />
                  <FilterChip active={audioCategory === "BGM"} label="BGM" onClick={() => setAudioCategory("BGM")} />
                  <FilterChip active={audioCategory === "SE"} label="SE" onClick={() => setAudioCategory("SE")} />
                </div>
                <p className="toolbar-note">
                  {dataset ? `显示第 ${audioPageStart + 1}-${audioPageEnd || 0} 条 / 共 ${formatCount(filteredAudio.length)} 条` : "…"}
                </p>
              </div>

              <div className="audio-list">
                {dataset ? (
                  pagedAudio.length ? (
                    pagedAudio.map((asset) => (
                      <AudioTrackRow key={asset.asset_id} asset={asset} active={selectedAudio?.asset_id === asset.asset_id} onClick={() => setSelectedAudioId(asset.asset_id)} />
                    ))
                  ) : (
                    <div className="loading-panel">没有匹配的音频资源。</div>
                  )
                ) : (
                  <div className="loading-panel">正在读取音频资源…</div>
                )}
              </div>

              <PaginationControls currentPage={activeAudioPage} totalPages={audioPageCount} onChange={setAudioPage} />
            </section>

            <aside className="inspector-panel">
              {selectedAudio ? (
                <section className="inspector-card">
                  <h3>当前播放</h3>
                  <div className="audio-player-shell">
                    <div className="audio-player-shell__meta">
                      <span className="chip">{selectedAudio.category}</span>
                      <span className="chip chip--muted">{formatBytes(selectedAudio.file_size)}</span>
                    </div>
                    <h4>{selectedAudio.label}</h4>
                    <p className="toolbar-note">{selectedAudio.source_name}</p>
                    <audio className="audio-player" controls preload="none" src={datasetUrl(selectedAudio.path)} />
                  </div>
                </section>
              ) : (
                <section className="inspector-card">
                  <h3>当前播放</h3>
                  <p className="empty-note">先从左侧选一个音频条目。</p>
                </section>
              )}
            </aside>
          </main>
        </>
      ) : route.kind === "worldmap" ? (
        <>
          <header className="viewer-header">
            <div>
              <p className="eyebrow">reverse_inotia4 / world map</p>
              <h1>世界地图</h1>
              <p className="viewer-subtitle">点击热点查看区域覆盖的地图，并可以跳回具体地图页。</p>
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
              <div className="canvas-scroll">
                {dataset && worldmapImage ? (
                  <WorldmapCanvas image={worldmapImage} manifest={dataset.worldmapManifest} selectedSpriteIndex={selectedWorldmapSpriteIndex} onSelectRegion={setSelectedWorldmapSpriteIndex} />
                ) : (
                  <div className="loading-panel">正在读取 worldmap 组合图…</div>
                )}
              </div>
            </section>

            <aside className="inspector-panel">
              <section className="inspector-card">
                <h3>区域信息</h3>
                {selectedWorldmapRegion ? (
                  <div className="hover-report">
                    <p className="hover-report__title">{selectedWorldmapRegion.name}</p>
                    <dl className="definition-list">
                      <div><dt>sprite</dt><dd>{selectedWorldmapRegion.sprite_index}</dd></div>
                      <div><dt>bounds</dt><dd>{selectedWorldmapRegion.width} x {selectedWorldmapRegion.height} @ {selectedWorldmapRegion.x}, {selectedWorldmapRegion.y}</dd></div>
                      <div><dt>map count</dt><dd>{selectedWorldmapRegion.map_ids.length}</dd></div>
                    </dl>
                    <div className="worldmap-map-list">
                      {selectedWorldmapRegion.map_ids.map((mapId) => (
                        <button key={mapId} className={route.mapId === mapId ? "worldmap-map-chip worldmap-map-chip--active" : "worldmap-map-chip"} onClick={() => navigate({ kind: "map", mapId })} type="button">
                          {manifestMapLookup.get(mapId)?.name ?? `m${mapId}`}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="empty-note">先选择一个区域热点。</p>
                )}
              </section>
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
                  ? `${currentManifestEntry.width} x ${currentManifestEntry.height} tiles, palette ${currentManifestEntry.palette_set_id}, text id ${currentManifestEntry.name_text_id}`
                  : "加载中…"}
              </p>
            </div>
            <div className="viewer-actions">
              <button className="ghost-button" onClick={() => navigate({ kind: "index" })} type="button">
                返回索引
              </button>
              <button className="ghost-button" onClick={() => navigate({ kind: "worldmap", mapId: route.mapId })} type="button">
                世界地图定位
              </button>
              {currentManifestEntry ? (
                <button className="ghost-button" onClick={() => navigate({ kind: "texts", textId: currentManifestEntry.name_text_id })} type="button">
                  打开地图名文本
                </button>
              ) : null}
              {currentManifestEntry ? (
                <button className="ghost-button" onClick={() => window.open(datasetUrl(currentManifestEntry.preview_path), "_blank", "noopener")} type="button">
                  打开整图预览
                </button>
              ) : null}
            </div>
          </header>

          {mapError ? <section className="error-banner">{mapError}</section> : null}
          {atlasError ? <section className="error-banner">{atlasError}</section> : null}

          <main className="viewer-layout">
            <section className="stage-panel">
              <div className="stage-toolbar stage-toolbar--stack">
                <div className="zoom-strip">
                  <span>缩放</span>
                  <input className="zoom-slider" type="range" min="1" max="5" step="0.25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
                  <span>{zoom.toFixed(2)}x</span>
                </div>
                <div className="chip-row">
                  <FilterChip active={toggles.base} label="base" onClick={() => toggleFlag("base")} />
                  <FilterChip active={toggles.shadow1} label="shadow1" onClick={() => toggleFlag("shadow1")} />
                  <FilterChip active={toggles.shadow2} label="shadow2" onClick={() => toggleFlag("shadow2")} />
                  <FilterChip active={toggles.layer} label="layer" onClick={() => toggleFlag("layer")} />
                  <FilterChip active={toggles.feature} label="feature" onClick={() => toggleFlag("feature")} />
                  <FilterChip active={toggles.top} label="top" onClick={() => toggleFlag("top")} />
                  <FilterChip active={toggles.grid} label="grid" onClick={() => toggleFlag("grid")} />
                </div>
              </div>

              <div className="canvas-scroll">
                {dataset && mapData && tileAtlas && featureAtlas ? (
                  <MapCanvas dataset={dataset} mapData={mapData} tileAtlas={tileAtlas} featureAtlas={featureAtlas} toggles={toggles} zoom={zoom} hoveredCell={hoveredCell} selectedCell={selectedCell} onHoverCell={setHoveredCell} onClickCell={setSelectedCell} />
                ) : (
                  <div className="loading-panel">正在准备当前地图的 atlas 与 JSON…</div>
                )}
              </div>
            </section>

            <aside className="inspector-panel">
              <section className="inspector-card">
                <h3>调试图层</h3>
                <div className="chip-row">
                  <FilterChip active={toggles.showFlip} label="flip" onClick={() => toggleFlag("showFlip")} />
                  <FilterChip active={toggles.showTileIndex} label="tile index" onClick={() => toggleFlag("showTileIndex")} />
                  <FilterChip active={toggles.showRawFlags} label="raw flags" onClick={() => toggleFlag("showRawFlags")} />
                </div>
              </section>

              {mapData ? (
                <section className="inspector-card">
                  <h3>地图概览</h3>
                  <dl className="definition-list">
                    <div><dt>size</dt><dd>{mapData.width} x {mapData.height}</dd></div>
                    <div><dt>palette</dt><dd>{mapData.palette_set_id}</dd></div>
                    <div><dt>features</dt><dd>{mapData.total_feature_count}</dd></div>
                    <div><dt>feature layers</dt><dd>{mapData.feature_layer_counts.join(" / ")}</dd></div>
                    <div><dt>ignored</dt><dd>{mapData.ignored_records.length}</dd></div>
                    <div><dt>links</dt><dd>{mapData.link_records.length}</dd></div>
                  </dl>
                </section>
              ) : null}

              <section className="inspector-card">
                <h3>选中格</h3>
                {hoveredInfo && selectedCell ? (
                  <dl className="definition-list">
                    <div><dt>cell</dt><dd>({selectedCell.x}, {selectedCell.y}) / index {hoveredInfo.index}</dd></div>
                    <div><dt>base tile</dt><dd>{hoveredInfo.baseCell >= 0 ? hoveredInfo.baseCell : "empty"}</dd></div>
                    <div><dt>base flags</dt><dd>{hoveredInfo.baseFlags} ({formatHex(hoveredInfo.baseFlags)})</dd></div>
                    <div><dt>shadow</dt><dd>{hoveredInfo.shadow1} / {hoveredInfo.shadow2}</dd></div>
                    <div><dt>top</dt><dd>{hoveredInfo.top}</dd></div>
                    <div><dt>layers</dt><dd>{hoveredInfo.layerSlots.join(", ")}</dd></div>
                    <div><dt>features</dt><dd>{hoveredInfo.featuresAtCell.length}</dd></div>
                    <div><dt>links</dt><dd>{hoveredInfo.linksAtCell.length}</dd></div>
                  </dl>
                ) : (
                  <p className="empty-note">点击画布格子查看 tile id、flags 和 link 信息。</p>
                )}
              </section>
            </aside>
          </main>
        </>
      )}
    </div>
  );
}

export default App;
