Chinese README: [docs/README.zh-CN.md](docs/README.zh-CN.md)

> Disclaimer
>
> This project is intended only for interoperability research, reverse-engineering study, and visualization of resources from APKs you have legally obtained. It does not provide APK files, game content, cheat functionality, network manipulation, or guidance for redistributing copyrighted assets. Make sure your use complies with applicable laws, platform terms, and copyright requirements.

# reverse_inotia4

`reverse_inotia4` is a local reverse-engineering toolkit for Android APK resources. It reads the single APK placed in `apk/`, extracts it into `workdir/`, parses resources from `assets/common/game_res/`, and generates a web-viewable dataset for maps, text, images, and audio.

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
│  └─ export_map_viewer_dataset.py
├─ web_viewer/
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
  - Generated local dataset consumed by the viewer

## What This Project Covers

- Decode `game.dat.jpg`
- Decode `i_tile.dat.jpg`
- Decode `i_mapfeature.dat.jpg`
- Decode `i_worldmap.dat.jpg`
- Decode `memorytext_zhhans.dat.jpg`
- Decode `m0..m415.dat.jpg`
- Export tile atlases, feature atlases, map JSON, previews, worldmap datasets, and simplified Chinese text datasets
- Detect and export passthrough PNG and OGG assets from `game_res`
- Visualize map layers, worldmap regions, memory text, images, and audio in the web viewer
- Keep the right-side detail panel sticky on desktop for long lists and large datasets
- Provide debug toggles for `grid / flip / raw flags / tile index`

## Usage

1. Put exactly one APK into `apk/`
2. Run the exporter from the repository root:

```powershell
python scripts/export_map_viewer_dataset.py
```

The script will:

- Verify that `apk/` contains exactly one APK
- Rebuild `workdir/`
- Extract the APK into `workdir/<apk_stem>/`
- Read resources from `workdir/<apk_stem>/assets/common/game_res/`
- Rebuild `web_viewer/public/`

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

## Generated Dataset

The viewer reads the generated dataset under `web_viewer/public/`:

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
├─ texts/
│  └─ memorytext_zhhans.json
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

For field-level details, see [docs/render_spec.md](docs/render_spec.md).

## Viewer Pages

- Index
  - Map list, previews, palette filtering, and entry points to worldmap, text, images, and audio
- Map page
  - Main canvas, layer toggles, debug toggles, hovered-cell details, and worldmap navigation
- Worldmap page
  - Combined `i_worldmap.dat.jpg` image, hotspot regions, and linked `map_id` groups
- Text page
  - Search, `text_id` targeting, raw memory text, and lightweight markup preview
- Image page
  - Thumbnail gallery and detail preview for passthrough PNG assets
- Audio page
  - Filterable BGM/SE lists and built-in playback for passthrough OGG assets

## Main Entry Points

- `scripts/export_map_viewer_dataset.py`
  - APK extraction, resource parsing, export, and consistency checks
- `web_viewer/src/App.tsx`
  - Main UI routes and viewer pages
- `web_viewer/src/data.ts`
  - Dataset loading
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
