> 免责声明
>
> 本文仅记录对合法取得 APK 的资源格式理解、互操作性分析与可视化验证流程，不包含绕过鉴权、注入、联机修改或未授权资源分发的指导。请仅在符合法律、版权与平台协议的前提下使用这些方法。

# Reverse Workflow

本文重点说明：`reverse_inotia4` 这套资源导出链路是怎么一步步逆出来的，以及每个结论是如何被验证并最终固化到脚本中的。

## 目标与边界

当前仓库聚焦的是“静态资源可读化”而不是“运行时改造”：

- 目标
  - 读出地图、tile、feature、worldmap、memorytext
  - 识别 `game_res` 中直出的 PNG 和 OGG
  - 把这些资源变成稳定的本地数据集与可视化页面
- 不做
  - 运行时 Hook
  - 网络协议分析
  - 存档/内存修改
  - 回写封包或重新打包发布

## 总体方法

逆向采用的是“样本目录 -> 代码定位 -> 二进制假设 -> 导出验证 -> 前端回归”的闭环：

1. 解压 APK，先拿到完整样本目录
2. 在 `assets/common/game_res/` 里按文件名和文件头做资源分层
3. 结合 `jadx` 与 IDA 寻找对应加载函数、渲染函数和访问路径
4. 把函数里的字段读取顺序翻译成 Python 解析器
5. 用导出后的 atlas / JSON / 图片在 viewer 里直接验证是否与引擎语义一致
6. 若显示不对，再回到字段定义和绘制顺序继续修正

## 第一步：整理样本目录

入口样本固定为：

```text
workdir/<apk_stem>/assets/common/game_res/
```

这里先做了三层区分：

- 外层压缩资源
  - 典型文件如 `game.dat.jpg`、`m0.dat.jpg`、`memorytext_zhhans.dat.jpg`
- 特殊表结构资源
  - 典型文件如 `i_tile.dat.jpg`、`i_mapfeature.dat.jpg`、`i_worldmap.dat.jpg`
- 直出资源
  - 通过文件头识别出的 PNG 和 OGG

这一步的关键不是先“全解”，而是先把资源分成“可直接显示”和“必须进一步逆向”两类。

## 第二步：从代码里找资源加载入口

静态资源的真实格式不是靠文件名猜的，而是靠引擎里的加载逻辑反推出来的。这里主要用到两条线：

- `jadx`
  - 用来确认 Java/Kotlin 层如何把资源路径传给 native 层
  - 帮助定位 `libgame.so` 的调用场景和资源名
- IDA
  - 用来分析 `lib/arm64-v8a/libgame.so`
  - 从字符串、交叉引用和调用图里找资源解包、sprite 创建、地图绘制、worldmap 构建、文本读取等函数

当前稳定用到的几个关键函数名包括：

- `SPR_Create`
- `SPR_Draw`
- `SPR_DrawFlip`
- `MAP_Draw*`
- `EXCELDATA_LoadMemoryText`
- `MEMORYTEXT_GetText`
- `WORLDMAPBUILDER_Maker`
- `X_TEXTCTRL_GetColorFromCode`

这些名字的意义不在于“记住函数名”，而在于它们分别对应：

- 资源怎么解包
- sprite 头部字段怎么解释
- flip 时坐标怎么计算
- 文本 offset table 怎么访问
- worldmap 区域映射从哪里来

## 第三步：先逆资源容器，再逆业务结构

### 1. 标准外层容器

一批 `*.dat.jpg` 文件具有统一的外层封装，特征是前几个字节形如：

- `0x01 0x00 0x5d 0x00`

结合加载函数可以确认：

- 外层使用 LZMA raw 形式
- property byte 需要拆成 `lc / lp / pb`
- 字典大小和输出大小直接存放在头部

这一步在脚本里对应 `decode_standard_outer()`。

### 2. SNASYS entry table

tile / feature / worldmap 不是简单的整块解压，而是 entry table + segment 的组合。

当前确认了两类：

- count-based SNASYS
  - 用于 `i_tile.dat.jpg`、`i_mapfeature.dat.jpg`
  - 通过单调递增的 `u24` offset table 找 entry
- direct SNASYS
  - 用于 `i_worldmap.dat.jpg`
  - offset table 固定从 `0x12` 开始

并且 entry 的 bit23 会指示“这一段还需要再做一次内层解压”。

这一步在脚本里对应：

- `detect_count_based_snasys()`
- `decode_snasys_entries()`
- `decode_direct_snasys_entries()`

## 第四步：把资源对象头和绘制语义对齐

一旦 entry 级别能切开，下一步就不是“解压”，而是“解释头部字段”。

### Tile / Worldmap sprite

通过 `SPR_Create`、`SPR_Draw`、`SPR_DrawFlip` 可以把如下字段对齐出来：

- `width`
- `height`
- `x_offset`
- `y_offset`
- `palette_id`
- 像素数据区

同时还能确认：

- 哪些类型带内嵌调色板
- 哪些类型的透明色是 `palette index 0`
- 哪些类型的透明色是 `0x2484`
- 水平翻转时的 `draw_x` 不是简单镜像，而要带上 `16 - width + x_offset`

这一层是 atlas 和 worldmap 能正确显示的前提。

### Base / Layer / Shadow / Top

地图结构的逆向重点不是头部，而是尾部的 record stream。

从 `MAP_Draw*` 一类函数里可以看出：

- `byte[2] / byte[3]` 是地图宽高
- base 区每格 2 字节
- 后续是一套按 group 组织的 entry stream
- `header >> 4` 决定 section
- `type_and_flags >> 4` 决定 record_type

最终将 tail records 稳定分类成：

- `layer_slots`
- `shadow1`
- `shadow2`
- `top`
- `static_features_raw`
- `ignored_records`

这一步最重要的不是“能解析”，而是“必须和引擎实际绘制顺序一致”。否则 atlas 看似正常，但叠层关系和 flip 会错。

## 第五步：从访问模式逆文本和 worldmap

### MemoryText

`EXCELDATA_LoadMemoryText` 与 `MEMORYTEXT_GetText` 给出了一条非常明确的访问路径：

- 开头是 `u32 record_count`
- 后面是 `record_count` 个 `u24 offset`
- `id` 会直接索引 offset table
- offset 指向 UTF-8 字符串本体

这类结构的优势是验证很直接：

- count 不对就会越界
- offset 不单调就会读串
- 字符串终止不对就会污染后续记录

### Worldmap

worldmap 逆向分两部分：

- `i_worldmap.dat.jpg` 自身的 sprite 数据
- `sprite_index -> map_id[]` 的区域映射

前者来自 direct SNASYS + sprite 头部；
后者来自对 `WORLDMAPBUILDER_Maker` 的逆向整理，并沉淀为：

- `data/worldmap_regions.json`

这个文件既是逆向结果，也是后续导出脚本的稳定输入。

## 第六步：识别不需要解密的资源

在 `game_res` 里，并不是所有看起来像 `.jpg` 的文件都需要走自定义解码。

当前脚本直接按文件头识别：

- PNG
  - `89 50 4E 47 0D 0A 1A 0A`
- OGG
  - `4F 67 67 53`

因此图片和音频这条线的策略不是“逆格式”，而是：

1. 扫描 `game_res`
2. 读取前 16 字节
3. 按真实格式分类
4. 复制为浏览器友好的扩展名
5. 写入 `extras/assets_manifest.json`

这一步是目前图片页和音频页的数据来源。

## 第七步：把逆向结果固化为导出脚本

所有稳定下来的理解都落到了：

- `scripts/export_map_viewer_dataset.py`
- `scripts/consolidate_texts.py`

它承担了三个角色：

- 资源读取器
  - 负责 APK 解压、目录准备、容器解码、entry 切分
- 导出器
  - `export_map_viewer_dataset.py` 负责 atlas、地图 JSON、worldmap、PNG、OGG 的输出
  - `consolidate_texts.py` 负责 `memorytext_zhhans`、`game.dat.jpg`、`eventdata.dat.jpg` 关联出的文本档案输出
- 校验器
  - 负责 tile coverage 检查，以及通过 viewer 进行视觉回归

逆向一旦进入“脚本可以重复跑通”的阶段，信息才算真正沉淀下来；否则只是一次性的分析结论。

## 第八步：用 Viewer 反向验证逆向结果

这个仓库里的 `web_viewer` 不是展示层附属物，而是逆向流程的一部分。

它主要用来验证：

- 地图宽高、tile id 和 flags 是否读对
- layer / shadow / top 的顺序是否正确
- feature 锚点和 flip 是否正确
- worldmap hotspot 是否落在正确区域
- 中文对白、静态名称/描述关系和原始 `text_id` 引用是否合理
- PNG / OGG 是否被正确识别并导出

具体做法是：

- 地图页对照 `grid / flip / raw flags / tile index`
- worldmap 页检查热点和 `map_id` 列表
- 文本档案页检查对白场景、关系导出和原文引用
- 图片/音频页检查文件头识别和导出路径是否正确

## 当前可信度较高的结论

这些部分已经比较稳定，可以直接作为后续扩展的基础：

- 标准外层 LZMA raw 容器
- count-based 与 direct 两类 SNASYS
- tile / worldmap sprite 头部字段
- base 与 tail record 的主要结构
- memorytext 的 `u32 + u24 table`
- passthrough PNG / OGG 的文件头识别

## 仍然故意没有展开的范围

当前仓库没有试图完整覆盖以下方向：

- NPC / runtime object
- AI / 战斗逻辑
- UI 动画脚本
- 存档、联网、支付、广告相关逻辑
- 原始资源回写与重打包

这些都不是当前 viewer 数据导出的必要条件，所以暂时不引入到主线。

## 如果要继续扩展新的资源类型

建议仍按同一条闭环来做：

1. 先找样本目录和文件头特征
2. 再找加载函数和访问函数
3. 把字段读取顺序翻成最小 Python 解析器
4. 先导出成简单 JSON / 图片 / 音频
5. 最后再接进 `web_viewer` 做可视化验证

如果某一步无法被脚本复现，就说明逆向还没真正收敛，应该继续回到调用链和样本对照里修正。
