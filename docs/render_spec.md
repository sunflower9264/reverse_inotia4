> 免责声明
>
> 本文只描述基于合法取得 APK 所做的资源结构理解和导出结果契约，不提供绕过鉴权、回写打包、联机修改或未授权资源分发的方法。请仅在符合法律、版权与平台协议的前提下使用本文信息。

# Web Viewer Render Spec

本规范对应当前 viewer 运行时使用的两组数据集：

- `web_viewer/public/`
  - `m0..m415` 的静态地图显示、`worldmap` 的整图和热点映射、以及 `game_res` 中直出 PNG / OGG 的导出清单
- `web_viewer/data/texts/`
  - 简中 `memorytext_zhhans`、`game.dat.jpg`、`eventdata.dat.jpg` 关联出的文本档案

数据集分别由以下脚本生成：

- `python scripts/export_map_viewer_dataset.py`
- `python scripts/consolidate_texts.py`

如果想看“这些结构是怎么逆出来的”，请先读 [reverse_workflow.md](reverse_workflow.md)；本文只负责记录当前稳定下来的导出契约。

## 范围

包含：

- `base`
- `layer` 五槽
- `shadow1`
- `shadow2`
- `top`
- 静态 `map feature`
- `worldmap` 整图
- `worldmap` 区域热点
- 中文对白场景
- 静态名称/描述关系
- 原始 `text_id` 文本索引
- 直出 PNG 图片清单
- 直出 OGG 音频清单

不包含：

- NPC
- 掉落
- 天气
- 任务提示
- 运行时对象系统
- 编辑与回写

## 数据集结构

```text
web_viewer/public/
├─ manifest.json
├─ maps/{mapId}.json
├─ tiles/tileset_manifest.json
├─ tiles/atlas/tile_palette_set_{setId}.png
├─ features/feature_manifest.json
├─ features/atlas/feature_palette_set_{setId}.png
├─ worldmap/worldmap_manifest.json
├─ worldmap/worldmap.png
├─ extras/assets_manifest.json
├─ extras/images/*.png
├─ extras/audio/{bgm,se}/*.ogg
└─ debug/previews/m{mapId}.png

web_viewer/data/texts/
├─ consolidated_texts.json
├─ static_relationships.json
└─ event_dialogues.json
```

## 坐标与单位

- 地图逻辑单位是 tile
- 地图 cell 固定为 `16x16`
- 画布尺寸为 `width * 16` 和 `height * 16`
- 单格左上角：
  - `px = x * 16`
  - `py = y * 16`
- tile sprite 本身可以是变尺寸，并通过 `x_offset / y_offset` 延伸到 cell 外
- 静态 feature 锚点中心：
  - `x_px = x_tile * 16 + 8`
  - `y_px = y_tile * 16 + 8`

## 根清单

`manifest.json` 字段：

- `map_count`
- `tile_size`
- `passthrough_assets_manifest_path`
- `passthrough_image_count`
- `passthrough_audio_count`
- `worldmap_manifest_path`
- `maps[]`

## 直出资源清单

`extras/assets_manifest.json` 字段：

- `image_count`
- `audio_count`
- `images[]`
- `audio[]`

`images[]` 每项字段：

- `asset_id`
- `label`
- `source_name`
- `path`
- `width`
- `height`
- `file_size`

`audio[]` 每项字段：

- `asset_id`
- `label`
- `source_name`
- `path`
- `category`
- `file_size`

`maps[]` 每项字段：

- `map_id`
- `name_text_id`
- `name`
- `width`
- `height`
- `palette_set_id`
- `has_static_features`
- `preview_path`
- `raw_header_0`
- `raw_header_1`

## 文本档案清单

`web_viewer/data/texts/consolidated_texts.json` 字段：

- `description`
- `source_file`
- `language`
- `total_text_ids`
- `non_empty_entries`
- `referenced_by_tables`
- `unreferenced_count`
- `category_summary`
- `table_definitions[]`
- `entries[]`

`table_definitions[]` 每项字段：

- `table_index`
- `table_name`
- `category`
- `record_count`
- `record_size`
- `text_fields[]`
- `referenced_text_count`

`entries[]` 每项字段：

- `text_id`
- `text`
- `has_markup`
- `categories[]`
- `referenced_by[]`

`web_viewer/data/texts/static_relationships.json` 字段：

- `description`
- `language`
- `source_files`
- `npc_descriptions`
- `item_descriptions`
- `choice_sets`
- `quest_texts`

关系类条目当前覆盖：

- `npc_descriptions.entries[]`
  - `npc_id`
  - `name_text_id`
  - `name`
  - `description_text_id`
  - `description`
- `item_descriptions.entries[]`
  - `item_id`
  - `name_text_id`
  - `name`
  - `description_text_id`
  - `description`
- `choice_sets.entries[]`
  - `choice_id`
  - `prompt_text_id`
  - `prompt`
  - `options[]`
- `quest_texts.entries[]`
  - `quest_id`
  - `title_text_id`
  - `title`
  - `detail_text_id`
  - `detail`
  - `progress_text_id`
  - `progress`
  - `completion_text_id`
  - `completion`

`web_viewer/data/texts/event_dialogues.json` 字段：

- `description`
- `language`
- `source_files`
- `event_count`
- `eventdata_record_count`
- `eventdata_record_size`
- `opcode_kinds`
- `kind_counts`
- `speaker_catalog[]`
- `events[]`

`events[]` 每项字段：

- `event_index`
- `event_code`
- `event_type`
- `data_start_index`
- `command_count`
- `ui_flag`
- `entry_count`
- `preview_text`
- `entries[]`

`entries[]` 当前分两类：

- 对白/旁白/覆盖文字
  - `kind`
  - `text_id`
  - `text`
  - `plain_text`
  - `speaker`
- 选项
  - `kind == "choice"`
  - `choice_id`
  - `choice`

## Worldmap 清单

`worldmap/worldmap_manifest.json` 字段：

- `width`
- `height`
- `image_path`
- `sprite_count`
- `region_count`
- `sprites[]`
- `regions[]`

`sprites[]` 每项字段：

- `sprite_index`
- `x_offset`
- `y_offset`
- `x`
- `y`
- `width`
- `height`

`regions[]` 每项字段：

- `sprite_index`
- `name`
- `map_ids`
- `x`
- `y`
- `width`
- `height`
- `center_x`
- `center_y`

worldmap 使用像素坐标，不复用地图 cell 网格。

## 地图 JSON

`maps/{mapId}.json` 主要字段：

- `map_id`
- `width`
- `height`
- `palette_set_id`
- `raw_header_0`
- `raw_header_1`
- `base_cells`
- `base_flags`
- `layer_slots`
- `shadow1`
- `shadow2`
- `top`
- `total_feature_count`
- `feature_layer_counts`
- `static_features_raw`
- `ignored_records`
- `link_records`
- `raw_tail_offsets`

长度约定：

- `base_cells.length == width * height`
- `base_flags.length == width * height`
- `shadow1.length == width * height`
- `shadow2.length == width * height`
- `top.length == width * height`
- `layer_slots.length == width * height`
- `layer_slots[i].length == 5`

空值统一为 `-1`。

## Atlas 清单

`tiles/tileset_manifest.json` 每个条目提供：

- `tile_id`
- `palette_id`
- `width`
- `height`
- `x_offset`
- `y_offset`
- `atlas_x`
- `atlas_y`

`features/feature_manifest.json` 每个条目提供：

- `feature_id`
- `group_id`
- `palette_id`
- `width`
- `height`
- `x_offset`
- `y_offset`
- `atlas_x`
- `atlas_y`

tile atlas 不是固定 `16x16` 网格，而是变尺寸 sprite 的紧凑打包。

viewer 运行时不再换色，直接按地图的 `palette_set_id` 选择对应 atlas PNG。

`palette_id == null` 表示该 tile 使用资源内嵌调色板，导出阶段已经直接烘进 atlas。

## Worldmap 资源解码

`i_worldmap.dat.jpg` 不走地图 tile 的外层封装，而是直接使用 SNASYS entry table：

- `u32le[0:4]` 是 entry 数量
- entry offset table 从绝对偏移 `0x12` 开始
- 每个 offset 取 24 bit
- 若 offset 的 bit23 置位，则对应 entry 需先做内层解压

当前数据集导出 `94` 个 worldmap sprite。

worldmap sprite 沿用和 tile 相同的头部字段：

- `width = u16le[1:3]`
- `height = u16le[3:5]`
- `x_offset = s16le[5:7]`
- `y_offset = s16le[7:9]`

其中主要是带内嵌调色板的 indexed sprite，导出阶段已解码并按 `x_offset / y_offset` 合成为单张 `worldmap.png`。

区域热点来自 `WORLDMAPBUILDER_Maker` 中的 `sprite_index -> map_id[]` 映射。

## Memorytext 资源解码

`memorytext_zhhans.dat.jpg` 走标准外层压缩容器，解压后结构和 `MEMORYTEXT_GetText` 的访问逻辑一致：

- `u32le[0:4]` 是记录总数
- 后面紧跟 `record_count` 个 `u24` offset
- `MEMORYTEXT_GetText(id)` 实际读取 `base + 4 + id * 3` 的 offset，再直接返回该位置的字符串指针
- 字符串本体是 UTF-8，并以 `0x00` 结尾

当前文本导出不会再直接产出单独的 `texts/memorytext_zhhans.json`。取而代之的是：

- `consolidated_texts.json`
  - 保留原始 `text_id -> text` 关系、分类和表引用
- `static_relationships.json`
  - 输出 `名称 -> 描述`、`题面 -> 选项` 这类静态关系
- `event_dialogues.json`
  - 输出 `speaker + text + choice` 这类事件对白结构

其中 `consolidated_texts.json` 的文本条目会额外标记：

- `has_markup == true` 当文本包含 `$` 或 `&` 控制标记

viewer 仍然对常见标记做基础解释：

- `&N` -> 换行
- `&P` -> 段落分隔
- `$B` -> 恢复默认颜色
- `$R / $S / $G` 等 -> 按 `X_TEXTCTRL_GetColorFromCode` 的颜色码做文本高亮

## Tile 资源解码

`i_tile.dat` 当前支持两类 tile sprite：

- `0x03 / 0x83`
  - 原始索引像素
  - `width = u16le[1:3]`
  - `height = u16le[3:5]`
  - `x_offset = s16le[5:7]`
  - `y_offset = s16le[7:9]`
  - `palette_id = byte[9]`
  - 像素数据从 offset `10` 开始，长度 `width * height`
- `0x01 / 0x81`
  - 资源内嵌调色板的 bitpacked tile
  - `width / height / x_offset / y_offset` 头部字段沿用同一布局
  - `palette_count = byte[9] + 1`
  - 调色板区从 offset `10` 开始，长度 `palette_count * 2`
  - `bpp = max(1, ceil(log2(palette_count)))`
  - 像素区按“每行独立按字节对齐”解包

透明规则按原引擎 `SPR_Create` 对齐：

- `0x01`: 无透明
- `0x81`: palette 中值为 `0x2484` 的颜色透明
- `0x03`: 无透明
- `0x83`: palette index `0` 透明

tile atlas 中的每个条目都已经是可直接绘制的 RGBA sprite。

## Tile 绘制

tile 的 `x_offset / y_offset` 表示 sprite 锚点相对于左上角的偏移，和原引擎 `SPR_Draw / SPR_DrawFlip` 一致。

不翻转时：

- `draw_x = px - x_offset`
- `draw_y = py - y_offset`

水平翻转时：

- `draw_x = px + (16 - width + x_offset)`
- `draw_y = py - y_offset`

## Base 解码

原始 `m*.dat` 头部：

- `byte[2] = width`
- `byte[3] = height`

base 区从 offset `4` 开始，长度为 `width * height * 2`。

每格两字节解码：

- `tile_id = byte1 | ((byte0 & 0x07) << 8)`
- `base_flags = byte0 >> 4`

当前确认的 base 翻转规则：

- `base_flags & 0x04` 时做水平翻转

## Layer / Shadow / Top 解码

base 区之后的读取顺序：

1. `u16 total_feature_count`
2. `u16 feature_layer_counts[4]`
3. `u8 entry_group_count`
4. `entry_group_count` 个 group

每个 group：

- `u8 header`
- `u16 repeat_count`
- `repeat_count` 个 4 字节 record

每个 record：

- `x = byte0`
- `y = byte1`
- `type_and_flags = byte2`
- `low = byte3`

解码：

- `record_type = type_and_flags >> 4`
- `flip = (type_and_flags & 0x08) != 0`
- `id = low | ((type_and_flags & 0x07) << 8)`
- `section = header >> 4`

viewer 只消费：

- `record_type == 0`
- `record_type == 4`

映射关系：

- `record_type == 0` 且 `section == 0` -> `layer_slots`
- `record_type == 0` 且 `section == 1` -> `shadow1`
- `record_type == 0` 且 `section == 2` -> `shadow2`
- `record_type == 0` 且 `section == 3` -> `top`
- `record_type == 4` -> `static_features_raw`

其余记录保留到 `ignored_records`。

### 五槽 layer 规则

当 `section == 0 && record_type == 0` 时：

- `slot_bias = 1 if (header & 0x0C) else 0`
- `start = 2 if (header & 0x0C) else 1`
- 候选顺序是：
  - `header & 0x0C == 0` 时为 `[0, 1, 2, 3, 4]`
  - `header & 0x0C != 0` 时为 `[1, 2, 3, 4]`

打包值：

- `packed = id | 0x800` 当 `flip == true`
- 否则 `packed = id`

`shadow1 / shadow2 / top / layer_slots[*]` 都沿用这个 packed 表示。

viewer 解码 packed：

- `tile_id = packed & 0x7FF`
- `flip = (packed & 0x800) != 0`

`base / shadow1 / shadow2 / top / layer_slots` 使用同一套 tile atlas 和 tile 绘制规则。

## 静态 Feature

`static_features_raw[]` 每项字段：

- `layer`
- `x_tile`
- `y_tile`
- `x_px`
- `y_px`
- `feature_id`
- `flip`
- `record_offset`
- `group_header_offset`

锚点规则：

- 不翻转：`anchor_x = x_offset`
- 水平翻转：`anchor_x = width - 1 - x_offset`

绘制坐标：

- `draw_x = x_px - anchor_x`
- `draw_y = y_px - y_offset`

绘制顺序按 `(layer, y_px, x_px, feature_id)` 排序。

## 渲染顺序

viewer 必须和 exporter 保持同序：

1. `base`
2. `shadow1 + shadow2`
3. `layer_slots[0..4]`
4. `static feature`
5. `top`

## 调试要求

viewer 至少支持：

- `base`
- `shadow1`
- `shadow2`
- `layer`
- `feature`
- `top`
- `grid`
- `flip`
- `raw flags`
- `tile index`

悬停单格至少展示：

- `x / y`
- `base tile id`
- `base flags`
- `layer slots`
- `shadow1`
- `shadow2`
- `top`
- `palette_set_id`
- `base` 原始偏移
- `record_offset`
- `group_header_offset`
