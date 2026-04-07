Chinese README: [docs/README.zh-CN.md](docs/README.zh-CN.md)

> Disclaimer
>
> This project is intended only for interoperability research, reverse-engineering study, and visualization of resources from APKs you have legally obtained. It does not provide APK files, game content, cheat functionality, network manipulation, or guidance for redistributing copyrighted assets. Make sure your use complies with applicable laws, platform terms, and copyright requirements.

# reverse_inotia4

`reverse_inotia4` is a local reverse-engineering toolkit for Android APK resources. It reads the single APK placed in `apk/`, extracts it into `workdir/`, parses resources from `assets/common/game_res/`, and generates web-viewable datasets for maps, worldmap, text, images, and audio.

## Documentation

- [Chinese README](docs/README.zh-CN.md)
  - Full Chinese project overview and usage guide
- [docs/reverse_workflow.md](docs/reverse_workflow.md)
  - How the resource formats were reversed, validated, and turned into scripts
- [docs/render_spec.md](docs/render_spec.md)
  - Contract and field-level structure of the generated `web_viewer/public/` dataset

## Repository Layout

```text
.
├─ apk/
│  └─ .gitkeep
├─ data/
│  └─ worldmap_regions.json
├─ docs/
│  ├─ README.zh-CN.md
│  ├─ render_spec.md
│  └─ reverse_workflow.md
├─ ida/
│  └─ dump_key_functions.py
├─ scripts/
│  ├─ consolidate_texts.py
│  └─ export_map_viewer_dataset.py
├─ web_viewer/
│  ├─ data/
│  │  └─ texts/
│  ├─ public/
│  │  └─ .gitkeep
│  ├─ src/
│  ├─ index.html
│  ├─ package.json
│  ├─ package-lock.json
│  ├─ tsconfig.json
│  └─ vite.config.ts
└─ workdir/
```

- `apk/`
  - Place exactly one input APK here
- `workdir/`
  - Auto-generated extraction workspace
- `web_viewer/public/`
  - Generated local dataset for maps, worldmap, images, and audio
- `web_viewer/data/texts/`
  - Generated Chinese text archive datasets consumed by the text viewer

## What This Project Covers

- Decode `game.dat.jpg`
- Decode `i_tile.dat.jpg`
- Decode `i_mapfeature.dat.jpg`
- Decode `i_worldmap.dat.jpg`
- Decode `memorytext_zhhans.dat.jpg`
- Decode `m0..m415.dat.jpg`
- Export tile atlases, feature atlases, map JSON, previews, worldmap datasets, and passthrough asset manifests
- Export simplified Chinese text archive datasets:
  - `consolidated_texts.json`
  - `static_relationships.json`
  - `event_dialogues.json`
- Detect and export passthrough PNG and OGG assets from `game_res`
- Visualize map layers, worldmap regions, dialogue/text relationships, images, and audio in the web viewer
- Keep the right-side detail panel sticky on desktop for long lists and large datasets
- Provide debug toggles for `grid / flip / raw flags / tile index`

## Usage

1. Put exactly one APK into `apk/`
2. Build the map / worldmap / image / audio dataset:

```powershell
python scripts/export_map_viewer_dataset.py
```

This script will:

- Verify that `apk/` contains exactly one APK
- Rebuild `workdir/`
- Extract the APK into `workdir/<apk_stem>/`
- Read resources from `workdir/<apk_stem>/assets/common/game_res/`
- Rebuild `web_viewer/public/`
- Read worldmap region labels from `data/worldmap_regions.json`

3. Build the simplified Chinese text archive dataset:

```powershell
python scripts/consolidate_texts.py
```

This script will:

- Reuse or rebuild `workdir/`
- Read `memorytext_zhhans.dat.jpg`, `game.dat.jpg`, and `eventdata.dat.jpg`
- Write `consolidated_texts.json`, `static_relationships.json`, and `event_dialogues.json`
- Rebuild `web_viewer/data/texts/`

If `apk/` contains zero APKs or more than one APK, the script exits with an error instead of choosing one automatically.

## Run the Viewer

Install dependencies once:

```powershell
cd web_viewer
npm install
```

Development mode:

```powershell
cd web_viewer
npm run dev
```

Production build:

```powershell
cd web_viewer
npm run build
```

## Generated Datasets

The viewer reads map / worldmap / image / audio data from `web_viewer/public/`:

```text
web_viewer/public/
├─ manifest.json
├─ maps/{mapId}.json
├─ tiles/
│  ├─ tileset_manifest.json
│  └─ atlas/tile_palette_set_{setId}.png
├─ features/
│  ├─ feature_manifest.json
│  └─ atlas/feature_palette_set_{setId}.png
├─ worldmap/
│  ├─ worldmap_manifest.json
│  └─ worldmap.png
├─ extras/
│  ├─ assets_manifest.json
│  ├─ images/*.png
│  └─ audio/{bgm,se}/*.ogg
└─ debug/
   └─ previews/m{mapId}.png
```

The text archive is generated separately under `web_viewer/data/texts/`:

```text
web_viewer/data/texts/
├─ consolidated_texts.json
├─ static_relationships.json
└─ event_dialogues.json
```

For field-level details, see [docs/render_spec.md](docs/render_spec.md).

## Viewer Pages

- Index
  - Map list, previews, palette filtering, and entry points to worldmap, text, images, and audio
- Map page
  - Main canvas, layer toggles, debug toggles, hovered-cell details, and worldmap navigation
- Worldmap page
  - Combined `i_worldmap.dat.jpg` image, hotspot regions, and linked `map_id` groups
- Text archive page
  - Dialogue scenes, static name/description relationships, and raw `text_id` lookup
- Image page
  - Thumbnail gallery and detail preview for passthrough PNG assets
- Audio page
  - Filterable BGM/SE lists and built-in playback for passthrough OGG assets

## Main Entry Points

- `scripts/export_map_viewer_dataset.py`
  - APK extraction plus map / worldmap / image / audio export
- `scripts/consolidate_texts.py`
  - Simplified Chinese text consolidation, static relationship export, and event dialogue export
- `web_viewer/src/App.tsx`
  - Main UI routes and viewer pages
- `web_viewer/src/data.ts`
  - `public/` dataset loading plus bundled text archive loading
- `web_viewer/src/render.ts`
  - Map rendering logic
- `docs/reverse_workflow.md`
  - Reverse-engineering workflow and validation strategy
- `docs/render_spec.md`
  - Stable dataset contract

## Notes

- `web_viewer/public/` is generated locally and is not meant to be committed as source data
- `workdir/` is rebuilt on each export run
- Production build artifacts are not part of the source of truth
- `ida/dump_key_functions.py` is kept only as a lightweight helper script
