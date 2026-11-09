# 长程记忆 · Step 5 UI 与控制台

Step 1 底座、Step 2 写入、Step 3 读取、Step 4 反馈与生命周期、Step 5 UI 与控制台已完成。
「设置 → 记忆库」直读 SQLite（库路径 / 条数 / 向量 / 体积 / 模型 / 分层），
提供参数滑块、本轮注入列表、热 / 温 / 冷分层筛选；卡片点开可见 truth、activation、来源，
支持置顶 / 删除 / 整理重复。
压缩时产出 `summary + facts`，事实写 SQLite；每轮用户输入前检索一次，相关记忆拼进 `system prompt`；
每轮结束时按 `MEM_MARK` 与检索结果结算激活度、衰减并按阈值分层。

## 目录

```
si/app/memory/
├─ worker.js             Node Worker：embedding + SQLite 的所有调用入口
├─ db.js                 SQLite 建表 / Upsert / 向量检索 / FTS(BM25) / 统计
├─ schema.sql            memories / vectors / meta
├─ embed.js              bge-small-zh-v1.5 int8 (ONNX) + CLS pooling + L2
├─ tokenizer.js          BERT WordPiece 分词（只依赖 tokenizer.json）
├─ normalize.js          Step 2：NFKC / 同义词 / 枚举归一 + 三元组哈希主键
├─ retrieve.js           Step 3：双路召回融合 / 阈值 / VIP / 打分 / 截断 / Prompt
├─ lifecycle.js          Step 4：MEM_MARK 结算 / 幂律衰减 / 分层 / 挂起删除（纯函数）
├─ selftest.js           Step 1 自测（不碰 UI）
├─ step2.test.js         Step 2 自测（归一化 + 三层合并 + 事务）
├─ step3.test.js         Step 3 自测（打分规则 + 双路召回 + 注入）
├─ step4.test.js         Step 4 自测（结算 / 衰减 / 分层 / 删除 / 标记清理）
└─ electron-selftest.js  Electron 原生模块兼容性自测

si/app/memory-host.js    主进程：模型按需下载 + Worker 生命周期 + IPC 转发
```

## 读取链路（Step 3）

`sendMessage()` 在发请求前 `await refreshLongMemory(用户输入)`：

1. **向量召回**：用户原始输入直接过 bge-small，暴力余弦 Top-K（默认 12）。
2. **关键词召回**：把输入切 3 字窗口（FTS trigram，`OR`）+ 2 字窗口（LIKE 兜底），
   只命中向量没覆盖的记忆时补算一次相似度。
3. **硬过滤**：`similarity < θ_sim`（默认 0.45）丢弃。
4. **去重**：先按主键去重，再按 `normalizeText(fact)|polarity` 去重——
   旧库里「同一句话、同义 object 归一化不同」会留下两条主键，读取时也只注入一条。
5. **元信息拦截**：提示词 / 记忆机制 / 动作库 / 工具 / 测试过程这类「系统元信息」永不注入
   （写入侧 `normalize.isMetaFact` 也会直接丢弃，防止下一轮自我循环）。
6. **VIP 通道**：`pinned=1` 或「**用户自己的** `constraint`」，过阈值就强制注入，
   不参与排序竞争（最多 4 条）。`char` / `world` 的 constraint 不走 VIP——它们经常是从系统提示里抄回来的。
7. **普通排序**：`score = similarity^1.5 × truth × f(log(activation)) × type_weight`
   （`f = max(0.2, log1p(activation))`；constraint 1.6 / promise 1.25 / preference 1.15 / event 0.8）。
8. **截断**：普通记忆最多 `longMemoryMax`（默认 6），VIP 之外总字数 ≤ `longMemoryMaxChars`（默认 360）。
9. **拼装**：编号 `M1..Mn` 后写入 system prompt；编号只给系统用，并提示可用
   `<<<MEM_MARK wrong=M1>>>` 标记错误记忆（编号在轮次结束时由 Step 4 结算）。
   `retrieve` 同时返回 `candidateKeys`（过阈值、进入排序的全部候选），供结算区分「未注入」。

设置项：`longMemoryTheta=0.45`、`longMemoryMax=6`、`longMemoryMaxChars=360`（Step 5 已做成滑块），
总开关沿用 `memoryEnabled`。模型未下载时**跳过本轮检索**并在后台开始下载，不阻塞聊天。

## 反馈与生命周期（Step 4）

`runAgent()` 的 `finally` 里，真实完成的一轮会调用 `settleLongMemory(turnMarks)`：

1. **MEM_MARK**：伪工具解析器（`pseudo-tools.js`）逐 chunk 拼回、宽松解析 `wrong=M1,M2`，
   标记整段从正文 / TTS 里清掉；同一轮多个工具轮次产生的编号会合并。
2. **编号映射**：`M1..Mn` → 本轮注入的 `memory.key`；标记了未注入的编号直接忽略。
3. **Worker 结算**（`memoryCall('settle', { injectedKeys, wrongKeys })`，单事务遍历全库）：
   - 注入且未被标记：`activation += boost`（默认 0.35），`last_hit_turn = 当前轮`，`hit_count +1`；
   - 被标记 wrong：`activation -= penalty`（默认 0.5），`miss_count +1`（不算命中）；
   - 检索到但没注入（在 `lastCandidateKeys` 里）：按半指数衰减；
   - 没进候选：正常衰减；
   - `pinned` 不衰减、不参与删除；`constraint` 的 d=0，永不衰减。
4. **幂律衰减**：`activation = base × (1 + turns_since_hit)^(-d)`。
   逐轮实现为连乘 `ratio(t) = ((1+t)/(2+t))^d`，telescoping 后与公式严格等价，不需要额外存 base。
   分档 d：约束 0 / 偏好 0.3 / 事实 0.5 / 事件 0.8（promise 0.3、plan 0.4、emotion 0.6、relation 0.4）。
5. **分层**：`activation ≤ θ_warm`（0.45）进温层（仍参与检索排序）；
   `activation ≤ θ_cold`（0.15）进冷层（`searchVectors` / FTS 默认排除，等于归档）；
   pinned / constraint 永远留在热层。激活度回升会自动回到热层。
6. **挂起删除**：冷层 + `truth ≤ 0.4` + `activation ≤ θ_cold` + 非 pinned + 非约束，
   `delete_streak +1`；连续满足 50 轮才真删（`delete_streak` 即规格里的 `pending_delete`）。
   中途被重新采纳 / 激活度回升会把计数清零。
7. **写入与生命周期的衔接**：新写入（含合并确认）的 `last_hit_turn` 从当前 `life_turn` 起算，
   不会因为 `created_turn` 是消息序号而被当成「0 轮老记忆」立刻衰减。
   `stats.lifeTurn` 是结算轮次，独立于写入用的 `turn_counter`。

默认参数都在 `lifecycle.js → DEFAULTS`，Worker `settle` 支持逐项覆盖（Step 5 已接到设置界面）。
每轮结算结果会以「记忆 · 第 N 轮结算 · 采纳 / 纠错 / 衰减 / 分层变化 / 真删 · 热 / 温 / 冷」
写进控制台（没有分层变化时不追加计数，避免刷屏）。

## UI 与控制台（Step 5）

「设置 → 记忆库」页从上到下：

1. **参数滑块**（默认折叠在「参数调节」里，点开才显示，避免平时误触；改动即时生效，下一轮检索 / 结算按新值走，松手写 localStorage）：

   | 滑块 | 设置键 | 默认/范围 | 作用 |
   | --- | --- | --- | --- |
   | 检索阈值 θ_sim | `longMemoryTheta` | 0.45 / 0.20–0.90 | 相似度低于此值的候选直接丢弃 |
   | 最多注入条数 | `longMemoryMax` | 6 / 1–12 | 普通记忆上限（VIP 另算，最多 4） |
   | 注入字数上限 | `longMemoryMaxChars` | 360 / 120–800 | 拼进系统提示的总字数 |
   | 采纳 boost | `longMemoryBoost` | 0.35 / 0–1.5 | 注入且未被标记时的激活度增量 |
   | 纠错 penalty | `longMemoryPenalty` | 0.50 / 0–2 | 被 `MEM_MARK wrong` 标记时的扣减 |
   | 衰减强度 d | `longMemoryDecay` | ×1.00 / 0.2–3 | 倍率乘到分档 d 上（约束 d=0 恒不变） |
   | 温层阈值 θ_warm | `longMemoryWarm` | 0.45 / ≥ θ_cold | 激活度 ≤ 此值进温层 |
   | 冷层阈值 θ_cold | `longMemoryCold` | 0.15 / 0.02–0.6 | 激活度 ≤ 此值进冷层（移出主索引） |
   | 挂起删除轮数 | `longMemoryDeleteTurns` | 50 / 5–200 | 连续满足删除条件多少轮才真删 |

2. **数据库信息**：库文件绝对路径、条目 / 向量 / 体积、轮次与生命周期轮次、模型、
   FTS 分词器、热 / 温 / 冷计数、指示灯图例。

3. **本轮注入列表**：每次检索后把 `M1..Mn`、fact、相似度、排序分、激活度、分层、类型、
   VIP / 置顶通道列出来；标题行显示 `候选 / 注入 / θ_sim / 低于阈值 / 重复 / 元信息 / 限额截断`，
   模型未就绪或检索失败时显示对应原因。

4. **记忆卡片**：分层筛选（全部 / 热 / 温 / 冷，带计数）；卡片头部有分层标签，
   指示灯颜色与分层一致（绿 / 黄 / 灰）；点开看 truth、activation、命中 / 未命中、
   生命周期轮次与来源原文。

控制台每轮会出现两条记忆日志：

- `记忆 · 注入 N 条 · 候选 M（低于阈值 x · 重复 y …）：M1(0.82) M2(0.61,VIP)`
- `记忆 · 第 N 轮结算 · 采纳 a · 纠错 b · 衰减 c · 分层变化 d · 热 / 温 / 冷`

界面补充：

- 设置底栏最右新增置顶按钮，与主界面左上角 `#btn-pin` 同一开关（状态互相同步）。
- 对话窗口默认不再渲染「提示词注入」块，聊天更沉浸；完整请求仍看控制台。
  需要时可在「设置 → Agent 运行 → 在对话里显示提示词注入」打开。

## 写入链路

1. **压缩请求复用 KV Cache**：`compressContext()` 把上一次真正发出去的 `messages`
   原样回放，末尾只追加一条 user 压缩指令（`tool_choice: 'none'`），不再整段重发。
   没有可回放前缀时（刚启动 / 刚压缩过）才退回整段请求。
2. **一次返回 JSON**：`{"summary":"...","facts":[{subject,relation,object,fact,polarity,truth,source}]}`；
   `{"skip":true}` 表示无需压缩。解析容忍 Markdown 代码块和前后多余文字。
3. **本地归一化**：NFKC、去掉空白标点、同义词表（coffee → 咖啡）、枚举别名。
4. **主键本地计算**：`sha256(subject|relation|object_norm)` 前 16 位，模型不能自己生成。
5. **三层合并**（`worker.js → upsertFacts`，单事务）：
   - 哈希命中：合并到同一条；新表述更完整或极性冲突时覆盖旧表述，激活度 +0.35。
   - fact 文本命中：主键不同但 `fact` 完全相同（同义 object 归一化不同），
     subject / relation / polarity 一致时合并到已有那条（`mergedExact`），不再新增重复行。
   - 向量兜底：哈希不同但 fact 向量 ≥ 0.88，且 subject / relation / polarity 一致、数值不冲突。
   - 否则新建。
   - 每条记忆最多保留 5 条表述向量，几乎重复（>0.97）不再新增。
6. **旧库整理**：Worker 启动时自动跑一次 `dedupeExactMemories`（同 fact 文本 + 同主体/类型/极性，
   保留 pinned / 激活度最高的一条，激活度求和、truth 取最大、向量挪到保留项后删重复行）；
   「记忆库」页的「整理重复」按钮也能手动触发，结果在 `bootInfo.deduped` / `dedupe.merged`。
7. 首次写入时如果模型缺失，主进程会先下载，进度显示在设置页底栏。
8. **元信息拦截**：`normalizeFact` 命中 `META_FACT_PATTERNS`（系统提示 / 记忆块 / 动作库 / 工具 /
   token / JSON / 测试功能 / 笔记改动……）时直接丢弃，计入 `rejected`，不入库。
   压缩提示词也明确要求「只记人和世界，不记系统」。

## 自动压缩（发送前）

`sendMessage()` 在把新消息写进历史**之前**调用 `maybeAutoCompress()`：

1. 关闭开关（`settings.autoCompress=false`）→ 不做任何事，仍可用「+ → 压缩上下文」手动压缩。
2. mock / 未配置 Key → 跳过（不消耗 token）。
3. 取两个口径的较大值：本轮实际请求 `buildChatMessages()`、全部未压缩对话 `buildApiHistory(100)`；
   `used / contextWindow ≥ autoCompressAt`（默认 75%）→ 调 `compressContext({ auto: true })`：
   静默、不弹 toast、复用 KV Cache，写完摘要与事实后正常继续本轮对话。
   只看实际请求的话 `historyWindow` 较小时永远触发不了；只看全量又会在请求很小时白花一次调用。
4. 阈值可在「设置 → 统计」页用滑块调整（30%–95%）。
5. 压缩进行中，聊天与控制台的发送按钮会**灰掉并 disabled**（不是可点的停止按钮），
   避免误以为能中断或叠发第二请求；压缩结束后恢复原状态。

放在发送前的原因：若先 `pushChat` 再压缩，当前这条用户消息会被折进摘要、本轮就发不出去了。
另外压缩前会检查「回放前缀是否覆盖整段待压缩对话」（`lastRequestStartSeq`）；
覆盖不了就退回整段请求，避免 `historyWindow` 之外的旧对话被悄悄丢掉。

## 模型：首次按需下载

`models/bge-small-zh-v1.5/` **不进仓库**，配置在 `app/components.json` 的 `memory` 段：

```json
"memory": {
  "dir": "models/bge-small-zh-v1.5",
  "sources": ["https://hf-mirror.com/...", "https://huggingface.co/..."],
  "files": [
    { "path": "config.json", "bytes": 716 },
    { "path": "tokenizer.json", "bytes": 439125 },
    { "path": "onnx/model_quantized.onnx", "bytes": 24010842 }
  ]
}
```

- 下载源按顺序回退：hf-mirror → HuggingFace。
- 每个文件先写 `.part` 再 rename，取消/失败会清理临时文件。
- 进度复用主进程任务中心（`task:update`），设置页底栏可见。

## IPC（preload 已暴露）

```js
petApi.memoryStatus()
petApi.memoryEnsureModel({ force })
petApi.memoryCall('retrieve', { query, thetaSim, maxInject, maxChars })
petApi.memoryCall('upsertFacts', { facts, turn, sourceText })
petApi.memoryCall('settle', { injectedKeys, wrongKeys })   // Step 4：轮次结束结算
petApi.memoryCall('pin' | 'delete' | 'dedupe' | 'stats' | 'list' | 'search' | 'searchText' | 'reset' | ...)
```

库路径：`app.getPath('userData')/memory.db`（WAL）。

## 自测

```powershell
cd si/app
npm run memory:selftest        # Step 1：SQLite / FTS / 向量
npm run memory:selftest:step2  # Step 2：归一化 / 三层合并 / 事务
npm run memory:selftest:step3  # Step 3：打分 / 双路召回 / VIP / 注入
npm run memory:selftest:step4  # Step 4：MEM_MARK / 结算 / 衰减 / 分层 / 删除
npm run memory:selftest:electron
```

Step 2 自测覆盖：归一化 10 条规则、主键一致性、同义词哈希合并、极性覆盖、
向量兜底合并（>0.88）、数值冲突新建、同批重复、`source_text` / `created_turn` 落库、
系统元信息拦截（`isMetaFact`）。

Step 3 自测覆盖：truth/activation/type_weight 打分单调性、θ_sim 过滤、VIP 前置、
同主键去重、同 fact 文本去重、字数截断、关键词切分、Prompt 拼装、元信息不注入、
只有用户的 constraint 走 VIP；以及真实 Worker 的语义召回、2 字关键词召回、无关输入不注入、
pinned 走 VIP、元信息写入被拒、同 fact 不同 object 的 exact 合并且只建一条、`dedupe` 合并旧重复行。

Step 4 自测覆盖：MEM_MARK 宽松解析与流式清理（标记不进正文）、注入采纳 / wrong 纠错、
候选未注入的半衰减、未进候选的正常衰减、约束与 pinned 不衰减、幂律连乘与公式严格一致、
温层 / 冷层阈值、挂起删除计数与真删、激活度回升后计数清零；
以及真实 Worker 的 `settle` 事务（采纳 / 纠错 / 半衰减 / 分层 / 连续 3 轮后删除）。

## 数据

- 旧版 localStorage 记忆**不再迁移**，新库初始化即清空重来。
- 设置页「记忆库」已改为直读 SQLite：
  - 顶部显示数据库绝对路径（默认 `%APPDATA%/si-pet/memory.db`）、条目数、向量数、体积、向量模型；
  - 卡片复用旧视觉（类型标签 + 指示灯 + 置顶 / 删除），指示灯颜色与「分层」一致：
    绿 = 热层 / 黄 = 温层 / 灰 = 冷层（激活度、置信度在悬停提示与展开详情里看）；
  - 点卡片展开：truth（置信度）、activation（激活度）、主体 / 类型、object_norm、分层、
    命中 / 未命中、轮次、更新时间、主键、来源原文；
  - 「刷新」「整理重复」直接调用 Worker（`list` / `stats` / `dedupe`），置顶 / 删除调用 `pin` / `delete`；
  - 「归档」标签仍是压缩摘要（localStorage），与 SQLite 记忆库互不影响。
- 自测用临时库，跑完即删（`memory/.tmp/`，已在 gitignore）。

## 依赖

- `better-sqlite3` 13（NAPI 预编译，Electron 36 / Node 22 直接可用，无需 rebuild）
- `onnxruntime-node` 1.31（win32-x64 预编译）

