> 免责声明
>
> 本项目仅用于对合法取得 APK 的资源结构做互操作性研究、逆向学习与可视化验证，不提供 APK、本体游戏内容、联机/作弊能力，也不鼓励分发未经授权的原始资源。使用、修改或分享本仓库前，请自行确认符合当地法律、平台协议与版权要求。

# reverse_inotia4

`reverse_inotia4` 是一个围绕 Android APK 资源逆向整理出来的本地工具链：它会从 `apk/` 中读取唯一 APK，自动解压到 `workdir/`，解析 `assets/common/game_res/` 中的资源，再生成一个可直接浏览地图、文本、图片和音频的 Web viewer 数据集。

## 文档入口

- [仓库根目录英文 README](../README.md)
  - 英文总览、快速上手和仓库结构
- [reverse_workflow.md](reverse_workflow.md)
  - 重点说明这套资源格式是怎么逆出来的，包含样本筛选、函数定位、格式验证和导出落地
- [render_spec.md](render_spec.md)
  - 当前 `web_viewer/public/` 数据集的契约和字段定义

## 目录结构

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
  - 用户放入待处理的唯一 APK
- `workdir/`
  - 脚本自动解压 APK 的工作目录
- `web_viewer/public/`
  - 从 APK 生成的本地数据集，运行时唯一数据源

## 这套逆向主线做了什么

1. 先把 APK 解压到 `workdir/<apk_stem>/`
2. 锁定 `assets/common/game_res/` 作为主要样本目录
3. 结合 `jadx`、IDA 和导出脚本，逆出地图、tile、feature、worldmap、memorytext 的二进制结构
4. 用文件头识别 `game_res` 中未加密的 PNG 和 OGG 资源
5. 将上述理解固化到 `scripts/export_map_viewer_dataset.py`
6. 用 `web_viewer` 对逆向结果做可视化回归验证

更详细的方法和验证思路见 [reverse_workflow.md](reverse_workflow.md)。

## 当前能力

- 解析 `game.dat.jpg`
- 解析 `i_tile.dat.jpg`
- 解析 `i_mapfeature.dat.jpg`
- 解析 `i_worldmap.dat.jpg`
- 解析 `memorytext_zhhans.dat.jpg`
- 解析 `m0..m415.dat.jpg`
- 导出 tile atlas、feature atlas、地图 JSON、预览图、worldmap 数据集和简中文本清单
- 导出 `game_res` 中未加密的 PNG 图片和 OGG 音频清单
- 在网页里显示 `base / layer / shadow1 / shadow2 / top / static feature`
- 在网页里显示世界地图整图与区域热点
- 在网页里显示 `memorytext` 检索、原始文本和格式化预览
- 在网页里显示未加密图片缩略图浏览与大图预览
- 在网页里显示 BGM / SE 音频列表与内置播放器
- 地图、文本、图片、音频页面右侧详情面板在桌面端保持粘性侧栏
- 提供 `grid / flip / raw flags / tile index` 调试开关

## 使用方式

1. 把唯一的 APK 放进 `apk/`
2. 在仓库根目录执行：

```powershell
python scripts/export_map_viewer_dataset.py
```

脚本会自动：

- 检查 `apk/` 中是否恰好存在 1 个 APK
- 清空并重建 `workdir/`
- 将 APK 解压到 `workdir/<apk_stem>/`
- 从 `workdir/<apk_stem>/assets/common/game_res/` 读取资源
- 重建 `web_viewer/public/`

如果 `apk/` 中没有 APK，或者有多个 APK，脚本会直接报错，不会自动挑选。

## 启动 Viewer

首次使用先安装依赖：

```powershell
cd web_viewer
npm install
```

开发模式：

```powershell
cd web_viewer
npm run dev
```

生产构建：

```powershell
cd web_viewer
npm run build
```

## 生成数据集

运行时真正读取的是本地生成后的 `web_viewer/public/`，主要结构如下：

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

字段级别的契约说明见 [render_spec.md](render_spec.md)。

## Viewer 页面

- 地图索引页
  - 地图编号、地图中文名、宽高、palette set、缩略图、世界地图入口、文本资源入口
- 地图查看页
  - 主画布、图层开关、调试开关、悬停格详情、worldmap 跳转
- 世界地图页
  - `i_worldmap.dat.jpg` 合成整图、热点区域、`map_id` 列表
- 文本资源页
  - `memorytext_zhhans.dat.jpg` 检索、`text_id` 定位、原始文本和轻量标记预览
- 图片资源页
  - `game_res` 直出 PNG 的缩略图浏览、大图预览和来源信息
- 音频资源页
  - `game_res/SOUND` 中的 BGM / SE OGG 列表、筛选和播放器

## 代码入口

- `scripts/export_map_viewer_dataset.py`
  - 主导出脚本，负责 APK 解压、资源解析、导出和校验
- `web_viewer/src/App.tsx`
  - 资源索引页和各个 viewer 页面
- `web_viewer/src/data.ts`
  - `public/` 数据加载
- `web_viewer/src/render.ts`
  - 地图绘制逻辑
- `reverse_workflow.md`
  - 逆向方法、样本策略与验证流程
- `render_spec.md`
  - 当前数据与渲染契约

## 说明

- `web_viewer/public/` 是本地生成物，不作为仓库内容提交
- `workdir/` 是本地解压工作目录，每次导出前会完整重建
- 生产构建产物不作为仓库主线内容保留
- `ida/dump_key_functions.py` 仅作为轻量辅助脚本保留
