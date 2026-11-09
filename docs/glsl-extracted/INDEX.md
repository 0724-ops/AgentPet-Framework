# glsl-extracted —— 抽取产物索引

本目录的**权威文件是 `chunk-*.raw.glsl`**（从 bundle 反引号模板字符串里逐字取出的 GLSL 原文，
`${...}` 处的 JS 插值保留原样）。`chunk-*.fmt.glsl` 只是**空白重排**版（在 `; { }` 与预处理行处断行/缩进），
语句内容与 raw 完全一致，便于阅读；**不要**把 fmt 当逐字证据引用。

| 文件 | 对应站点变量 | 用途 | 源字符偏移 |
|---|---|---|---|
| `chunk-h4.*` | `const h4` | 角色本体 **顶点**着色器 | 924490 |
| `chunk-p4.*` | `const p4` | 角色本体 **片元**着色器（12,110 字符） | 927011 |
| `chunk-dT.*` | `const dT` | 工具：`R205` 饱和度、`R200` base×map | 924236 |
| `chunk-d4.*` | `const d4` | 头发高光（Kajiya-Kay，`#if defined(Q5)&&defined(Q7)`） | 925019 |
| `chunk-f4.*` | `const f4` | 点光循环 `R43()`（`#define Q25 16` 盏，wrap/rim 两种积分） | 925460 |
| `chunk-cT.*` | `const cT` | 裁切/溶解场 `R223()` | 908961 |
| `chunk-aT.*` | `const aT` | 自阴影 PCF `R57()`（`sampler2DShadow`，3×3 tent） | 901279 |
| `chunk-VB.*` | `const VB` | `shadow receiver` 地面接影片元 | 908423 |
| `chunk-m4.*` | `const m4` | 描边 **顶点**（反向外扩 + fov 补偿 + `Q57` 平均法线） | 939127 |
| `chunk-g4.*` | `const g4` | 描边 **片元**（albedo 调饱和度/亮度，或 `_OutlineTintColor`） | 940297 |
| `chunk-MT.*` | `const MT` | VFX **顶点**（`HGRP/CharacterNPR_VFX` / `VFXBaseV2` 共用） | 953427 |
| `chunk-ST.*` | `const ST` | VFX 片元头部（`vfx-npr` = `ST+L4`） | 954690 |
| `chunk-L4.*` | `const L4` | VFX 片元尾部（`vfx-npr`） | 956100 |
| `chunk-D4.*` | `const D4` | VFX 片元尾部（`vfx-base-v2` = `ST+D4`） | 957973 |
| `chunks-index.json` | — | 以上 chunk 的偏移/长度索引（机器可读） | — |

## 其它目录

* `tpl/` —— 用"反引号配对法"**无差别**导出的 128 个含 GLSL 标记的模板字面量，
  含 Three.js 内置 shader chunk（用于证伪"站点自定义"）。文件名带源偏移：`tpl-###__off<start>-<end>.glsl`。
* `blocks/` —— 按"缩进行段"识别的 94 个 Three.js 内置 shader chunk（漂亮打印的那些）。
* `_glsl-manifest.json` / `_tpl-index.json` / `_blocks-index.json` —— 上述批处理的索引。

## 标识符约定

GLSL 里的 `Q###`（uniform / define / 局部变量）与 `R###`（函数 / 局部变量）是 **bundle 里真实存在**
的标识符——站点把 HGRP shader 的所有标识符做了顺序重命名。语义映射见
`../shader-notes.md` §2.6（来自 JS 里显式的 `Q名 → Unity 参数名` 表）。

## 复跑

```powershell
cd "D:\a1937\Documents\DSH Desktop\zhuochong\si"
node docs\_work\extract-chunks.mjs vendor\site\Da0XtQgu.js docs\glsl-extracted
node docs\_work\extract-tpl.mjs    vendor\site\Da0XtQgu.js docs\glsl-extracted\tpl
node docs\_work\extract-blocks.mjs vendor\site\Da0XtQgu.js docs\glsl-extracted\blocks
```
