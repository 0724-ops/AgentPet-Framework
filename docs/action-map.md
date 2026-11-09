# 动作映射表（给外壳 / LLM 用）

> 数据源：`kernels/0.1.2/assets/si/clips/chr_0036_jsspsi/_index.json`（由 `kernels/0.1.2/tools/inject-clip-meta.js` 从剪影片元数据生成）。
> 本文由 `kernels/0.1.2/tools/gen-action-map.js` 自动生成，**动作名与时长不会和资产脱节**；中文释义来自 `kernels/0.1.2/actions.json`。
> 视觉对照：[待机/过渡](shots/sheet-idle.png) · [状态姿态](shots/sheet-pose.png) · [动作](shots/sheet-action.png)

## 0. 三个概念，先对齐

| 概念 | 含义 | 内核行为 |
|---|---|---|
| **状态（loop）** | 去了就一直待着，直到被换掉 | `loop:true` → 永远 `busy:true`，LLM 的追加动作会排队等，必须 `interrupt` 或 `reset` 才能出来 |
| **动作（once）** | 演一遍就结束 | 播完抛 `action_finished{reason:'completed'}` → 队列继续 |
| **过渡（start/end）** | 状态进出的过渡剪辑 | 本身是一次性动作，**拼在状态前后用**，不要单独当"动作"给 LLM |

一条经验：**大姿态（坐/躺/抱臂）必须走 `start → loop → end` 三段**，直接 `play(loop)` 会像"飘"过去。

## 1. 意图 → 动作速查（写 prompt / 命令解析用这张）

| 意图（举例） | 动作 | 类型 | 时长 | 说明 |
|---|---|---|---|---|
| 打招呼 / 你好 / 再见 | dialog_single_wave | 动作 | 4.17s | 单次，播完自动回待机 |
| 点头 / 同意 / 收到 | dialog_virtual_single_idle_nod | 动作 | 1.33s | 最轻的反馈，适合频繁用 |
| 摇头 / 不同意 / 无奈 | dialog_virtual_single_idle_shake | 动作 | 2.33s |  |
| 说话（带手势） | dialog_virtual_single_idle_talkhands | 动作 | 4.58s | 和语音/气泡配合 |
| 坐下 | interact_sit_start → interact_sit_loop | 链 | 3.75s + 循环 | 起身用 interact_sit_end |
| 坐下（椅子/高台） | dialog_state_sit_loop | 状态 | 18.17s | ⚠️ 比站立高 27cm，没椅子会悬空 |
| 站起来 | interact_sit_end | 过渡 | 4.00s | 播完回待机 |
| 放松 / 休息 | idle_to_relax → relax_loop | 链 | 2.87s + 循环 |  |
| 抱臂 / 不耐烦 | dialog_state_holdarm_start → dialog_state_holdarm_loop → dialog_state_holdarm_end | 链 | 2.10 / 2.17 / 4.13 | 神态型状态的标准写法 |
| 生气 | dialog_state_angry02_start → _loop → _end | 链 | 1.42 / 2.67 / 2.17 |  |
| 惊讶 | dialog_state_surprise_start → _loop → _end | 链 | 1.60 / 2.70 / 1.80 |  |
| 沉思 / 想事情 | dialog_state_muse_start → _loop → _end | 链 | 3.77 / 2.67 / 4.57 |  |
| 指 / 指向某处 | dialog_state_point_start → _loop → _end | 链 | 3.13 / 2.37 / 2.83 |  |
| 咳嗽 | dialog_state_cough_start → _loop → _end | 链 | 2.20 / 3.60 / 2.00 |  |
| 端庄 / 正式 | dialog_state_dignified_start → _loop → _end | 链 | 3.33 / 3.33 / 2.67 |  |
| 半举手 / 提问 | dialog_state_halfraise_start → _loop → _end | 链 | 2.00 / 2.42 / 2.83 |  |
| 抱胸 | dialog_state_chesthugging1_start → _loop → _end | 链 | 1.90 / 4.85 / 2.17 |  |
| 责备 / 训人 | dialog_state_censure_start → _loop → _end | 链 | 13.33 / 3.33 / 2.92 | 注意 start 有 13s |
| 施法 / 咏唱 | dialog_state_spell_start → dialog_state_spell_loop | 链 | 2.17 + 8.53 循环 | 没有 end，用 reset 退出 |
| 整理仪容 | dialog_state_adjust_loop | 状态 | 6.93s | 没有 start/end |
| 阅读 / 看书 | dialog_state_sitread_loop | 状态 | 5.17s | 低姿 |
| 玩闹 | dialog_state_play02_loop | 状态 | 2.52s |  |
| 边走边说 | dialog_state_walkandtalk_start → _loop → _end | 链 | 9.50 / 5.67 / 16.67 | 根位移已中和 |
| 走路 | walk_loop_sp_01 | 状态 | 7.72s | 原地走 |
| 战斗待机 | battle_loop | 状态 | 2.00s |  |
| 攻击 | battle_attack_01 … 05 | 动作 | 5.3–9.0s | 有根位移，已被内核中和 |
| 放技能 | battle_normal_skill_1 / battle_skill_ult | 动作 | 5.58 / 7.12 |  |
| 受击 | battle_hit_heavy | 动作 | 2.43s |  |
| 倒下 | battle_dead | 动作 | 3.93s | 播完需 reset 才能起身 |
| 抽卡演出 | gacha | 动作 | 11.42s | 整段演出 |
| 登场 | ui_overview_start_01 | 动作 | 12.42s | 盒子小的时候慎用 |

## 2. 状态链（过渡剪辑组合）

> 格式：`<起> → <循环> → <止>`。缺项的说明该剪辑站点没导出，退出时用 `reset()`。

| 状态 | 起 | 循环 | 止 |
|---|---|---|---|
| 战斗待机 | — | `battle_loop` | — |
| 腾空 | `battle_air_start` | — | `battle_air_end` |
| 攻击4 | `battle_attack_04_start` | — | — |
| 被击飞 | `battle_blown_start` | — | `battle_blown_end` |
| 眩晕 | — | — | `battle_stun_end` |
| 整理 | — | `dialog_state_adjust_loop` | — |
| 生气 | `dialog_state_angry02_start` | `dialog_state_angry02_loop` | `dialog_state_angry02_end` |
| 责备 | `dialog_state_censure_start` | `dialog_state_censure_loop` | `dialog_state_censure_end` |
| 抱胸 | `dialog_state_chesthugging1_start` | `dialog_state_chesthugging1_loop` | `dialog_state_chesthugging1_end` |
| 抱胸(变体) | `dialog_state_chesthugging3_start` | — | `dialog_state_chesthugging3_end` |
| 抱胸(变体尾段) | `dialog_state_chesthugging3_derived_tail_start` | — | `dialog_state_chesthugging3_derived_tail_end` |
| 咳嗽 | `dialog_state_cough_start` | `dialog_state_cough_loop` | `dialog_state_cough_end` |
| 端庄 | `dialog_state_dignified_start` | `dialog_state_dignified_loop` | `dialog_state_dignified_end` |
| 半举手 | `dialog_state_halfraise_start` | `dialog_state_halfraise_loop` | `dialog_state_halfraise_end` |
| 抱臂 | `dialog_state_holdarm_start` | `dialog_state_holdarm_loop` | `dialog_state_holdarm_end` |
| 对话待机 | — | `dialog_state_idle_loop` | — |
| 沉思 | `dialog_state_muse_start` | `dialog_state_muse_loop` | `dialog_state_muse_end` |
| 玩闹 | — | `dialog_state_play02_loop` | — |
| 指 | `dialog_state_point_start` | `dialog_state_point_loop` | `dialog_state_point_end` |
| 坐（高台） | — | `dialog_state_sit_loop` | — |
| 坐(低姿) | `dialog_state_sit2_start` | `dialog_state_sit2_loop` | `dialog_state_sit2_end` |
| 阅读 | — | `dialog_state_sitread_loop` | — |
| 施法 | `dialog_state_spell_start` | `dialog_state_spell_loop` | — |
| 惊讶 | `dialog_state_surprise_start` | `dialog_state_surprise_loop` | `dialog_state_surprise_end` |
| 边走边说 | `dialog_state_walkandtalk_start` | `dialog_state_walkandtalk_loop` | `dialog_state_walkandtalk_end` |
| 叉腰 | `dialog_virtual_state_akimbo1_start` | — | `dialog_virtual_state_akimbo1_end` |
| 左叉腰 | `dialog_virtual_state_akimboleft_start` | — | `dialog_virtual_state_akimboleft_end` |
| 右叉腰 | `dialog_virtual_state_akimboright_start` | — | `dialog_virtual_state_akimboright_end` |
| 戴耳机 | `dialog_virtual_state_earphone_start` | — | `dialog_virtual_state_earphone_end` |
| 自我介绍 | `dialog_virtual_state_introduction_start` | — | `dialog_virtual_state_introduction_end` |
| 挠头 | `dialog_virtual_state_scratchhead_start` | — | `dialog_virtual_state_scratchhead_end` |
| 思考 | `dialog_virtual_state_think1_start` | — | `dialog_virtual_state_think1_end` |
| 操作绳索 | `interact_rope_start` | — | `interact_rope_end` |
| interact_rope_d | — | — | `interact_rope_d_end` |
| 坐下（地面） | `interact_sit_start` | `interact_sit_loop` | `interact_sit_end` |
| relax | — | `relax_loop` | — |
| ui_relax | — | `ui_relax_loop` | — |

## 3. 全部循环状态（28 条）

| 动作 | 时长 | 中文 | 备注 |
|---|---|---|---|
| `battle_loop` | 2.00s | 战斗待机 | 双手微抬、身体前倾的备战态 |
| `dialog_state_adjust_loop` | 6.93s | 整理 | 低头整理衣摆/袖口 |
| `dialog_state_angry02_loop` | 2.67s | 生气 | 侧身抱臂+皱眉 |
| `dialog_state_censure_loop` | 3.33s | 责备 | 双手叉腰的训人姿态 |
| `dialog_state_chesthugging1_loop` | 4.85s | 抱胸 | 单臂环胸，防御/小得意 |
| `dialog_state_cough_loop` | 3.60s | 咳嗽 | 手掩口轻咳 |
| `dialog_state_dignified_loop` | 3.33s | 端庄 | 双手交叠身前，正式站姿 |
| `dialog_state_halfraise_loop` | 2.42s | 半举手 | 一只手抬到胸前，像提问 |
| `dialog_state_holdarm_loop` | 2.17s | 抱臂 | 双臂环抱，适合“不耐烦/等你说” |
| `dialog_state_idle_loop` | 2.00s | 对话待机 | 对话场景的站姿（比总览待机更“收敛”） |
| `dialog_state_muse_loop` | 2.67s | 沉思 | 手托下巴 |
| `dialog_state_play02_loop` | 2.52s | 玩闹 | 手在胸前摆弄 |
| `dialog_state_point_loop` | 2.37s | 指 | 抬手向前指 |
| `dialog_state_sit_loop` | 18.17s | 坐下（高台） | 坐在椅子/台阶上的姿态，比站立高 27cm，**盒子里没椅子会悬空** |
| `dialog_state_sit2_loop` | 2.00s | 坐下（低姿） | 重心极低（y=0.11），接近跪坐/趴伏 |
| `dialog_state_sitread_loop` | 5.17s | 坐着看书 | 坐着低头阅读 |
| `dialog_state_spell_loop` | 8.53s | 施法 | 掌心向上的咏唱姿势 |
| `dialog_state_surprise_loop` | 2.70s | 惊讶 | 双手抬起、身体后仰 |
| `dialog_state_walkandtalk_loop` | 5.67s | 边走边说 | 行走 + 手势，有根位移（已中和） |
| `interact_sit_loop` | 3.83s | 坐在地上 | 盘腿坐，**推荐**当“坐下”状态用（高度正确） |
| `relax_loop` | 3.00s | 放松 | 肩放松、双手垂在身侧，适合长时间挂着 |
| `ui_overview_loop_01` | 2.50s | 总览待机 | **默认待机**，桌宠常态。双手自然下垂、光翼展开 |
| `ui_relax_loop` | 3.00s | 放松（UI） | 与 relax_loop 基本相同，UI 界面用 |
| `uiteam_idle_01` | 2.48s | 队伍站位 1 | 编队里的站姿，姿态偏侧身；当待机变化用可以 |
| `uiteam_idle_02` | 2.50s | 队伍站位 2 | 同上，另有手部姿势 |
| `uiteam_idle_03` | 2.50s | 队伍站位 3 | 同上，正面站立 |
| `uiteam_idle_04` | 2.50s | 队伍站位 4 | 同上，抬腿站姿 |
| `walk_loop_sp_01` | 7.72s | 走路 | **原地走**（根位移已被内核中和），适合“走来走去”的假象 |

## 4. 全部一次性动作（75 条）

| 动作 | 时长 | 中文 | 备注 |
|---|---|---|---|
| `battle_air_end` | 5.82s | 腾空·落 | 5.82s |
| `battle_air_start` | 1.07s | 腾空·起 | 1.07s，**会上飞 5 单位**，桌宠慎用 |
| `battle_attack_01` | 5.65s | 攻击 1 | 5.65s，长枪突刺（有 4.2 单位根位移，已中和） |
| `battle_attack_02` | 6.83s | 攻击 2 | 6.83s |
| `battle_attack_03` | 5.33s | 攻击 3 | 5.33s |
| `battle_attack_04` | 8.97s | 攻击 4 | 8.97s，多段 |
| `battle_attack_04_start` | 2.42s | 攻击4·前摇 | 2.42s |
| `battle_attack_05` | 6.32s | 攻击 5 | 6.32s |
| `battle_blown_end` | 2.97s | 被击飞·落 | 2.97s |
| `battle_blown_start` | 0.87s | 被击飞·起 | 0.87s |
| `battle_dead` | 3.93s | 倒下 | 3.93s，倒地不再起身（播完需 reset） |
| `battle_hit_heavy` | 2.43s | 受重击 | 2.43s，被打退后仰 |
| `battle_normal_skill_1` | 5.58s | 普攻技能 | 5.58s，抬手咏唱并释放 |
| `battle_skill_ult` | 7.12s | 终极技 | 7.12s，大范围爆发（会腾空 1.4 单位） |
| `battle_stun_end` | 1.00s | 眩晕·结束 | 1.0s |
| `battle_to_idle` | 4.08s | 战斗→待机 | 4.08s，从战斗态收回 |
| `dialog_single_wave` | 4.17s | 挥手 | **打招呼/道别**。已修正为单次播放（4.17s） **（原剪辑标了 loop，已被内核降级为单次）** |
| `dialog_state_angry02_end` | 2.17s | 生气·止 | 退出该状态的过渡 |
| `dialog_state_angry02_start` | 1.42s | 生气·起 | 进入该状态的过渡 |
| `dialog_state_censure_end` | 2.92s | 责备·止 | 退出该状态的过渡 |
| `dialog_state_censure_start` | 13.33s | 责备·起 | 进入该状态的过渡 |
| `dialog_state_chesthugging1_end` | 2.17s | 抱胸·止 | 退出该状态的过渡 |
| `dialog_state_chesthugging1_start` | 1.90s | 抱胸·起 | 进入该状态的过渡 |
| `dialog_state_chesthugging3_derived_tail_end` | 1.95s | 抱胸(变体尾段)·止 | 退出该状态的过渡 |
| `dialog_state_chesthugging3_derived_tail_start` | 1.42s | 抱胸(变体尾段)·起 | 进入该状态的过渡 |
| `dialog_state_chesthugging3_end` | 1.95s | 抱胸(变体)·止 | 退出该状态的过渡 |
| `dialog_state_chesthugging3_start` | 1.42s | 抱胸(变体)·起 | 进入该状态的过渡 |
| `dialog_state_cough_end` | 2.00s | 咳嗽·止 | 退出该状态的过渡 |
| `dialog_state_cough_start` | 2.20s | 咳嗽·起 | 进入该状态的过渡 |
| `dialog_state_dignified_end` | 2.67s | 端庄·止 | 退出该状态的过渡 |
| `dialog_state_dignified_start` | 3.33s | 端庄·起 | 进入该状态的过渡 |
| `dialog_state_halfraise_end` | 2.83s | 半举手·止 | 退出该状态的过渡 |
| `dialog_state_halfraise_start` | 2.00s | 半举手·起 | 进入该状态的过渡 |
| `dialog_state_holdarm_end` | 4.13s | 抱臂·止 | 4.13s |
| `dialog_state_holdarm_start` | 2.10s | 抱臂·起 | 2.10s |
| `dialog_state_muse_end` | 4.57s | 沉思·止 | 退出该状态的过渡 |
| `dialog_state_muse_start` | 3.77s | 沉思·起 | 进入该状态的过渡 |
| `dialog_state_point_end` | 2.83s | 指·止 | 退出该状态的过渡 |
| `dialog_state_point_start` | 3.13s | 指·起 | 进入该状态的过渡 |
| `dialog_state_sit2_end` | 5.25s | 坐(低姿)·止 | 退出该状态的过渡 |
| `dialog_state_sit2_start` | 5.12s | 坐(低姿)·起 | 进入该状态的过渡 |
| `dialog_state_spell_start` | 2.17s | 施法·起 | 进入该状态的过渡 |
| `dialog_state_surprise_end` | 1.80s | 惊讶·止 | 退出该状态的过渡 |
| `dialog_state_surprise_start` | 1.60s | 惊讶·起 | 进入该状态的过渡 |
| `dialog_state_walkandtalk_end` | 16.67s | 边走边说·止 | 退出该状态的过渡 |
| `dialog_state_walkandtalk_start` | 9.50s | 边走边说·起 | 进入该状态的过渡 |
| `dialog_virtual_single_idle_nod` | 1.33s | 点头 | 1.33s，同意/回应 **（原剪辑标了 loop，已被内核降级为单次）** |
| `dialog_virtual_single_idle_shake` | 2.33s | 摇头 | 2.33s，否认/无奈 **（原剪辑标了 loop，已被内核降级为单次）** |
| `dialog_virtual_single_idle_talkhands` | 4.58s | 双手比划 | 4.58s，边说话边做手势 **（原剪辑标了 loop，已被内核降级为单次）** |
| `dialog_virtual_single_idle_talklefthand1` | 2.83s | 左手比划 | 2.83s **（原剪辑标了 loop，已被内核降级为单次）** |
| `dialog_virtual_single_idle_talkrighthand1` | 2.83s | 右手比划 | 2.83s **（原剪辑标了 loop，已被内核降级为单次）** |
| `dialog_virtual_state_akimbo1_end` | 2.08s | 叉腰·止 | 退出该状态的过渡 |
| `dialog_virtual_state_akimbo1_start` | 1.33s | 叉腰·起 | 进入该状态的过渡 |
| `dialog_virtual_state_akimboleft_end` | 3.15s | 左叉腰·止 | 退出该状态的过渡 |
| `dialog_virtual_state_akimboleft_start` | 1.93s | 左叉腰·起 | 进入该状态的过渡 |
| `dialog_virtual_state_akimboright_end` | 3.02s | 右叉腰·止 | 退出该状态的过渡 |
| `dialog_virtual_state_akimboright_start` | 1.38s | 右叉腰·起 | 进入该状态的过渡 |
| `dialog_virtual_state_earphone_end` | 3.43s | 戴耳机·止 | 退出该状态的过渡 |
| `dialog_virtual_state_earphone_start` | 1.42s | 戴耳机·起 | 进入该状态的过渡 |
| `dialog_virtual_state_introduction_end` | 1.77s | 自我介绍·止 | 退出该状态的过渡 |
| `dialog_virtual_state_introduction_start` | 1.37s | 自我介绍·起 | 进入该状态的过渡 |
| `dialog_virtual_state_scratchhead_end` | 2.27s | 挠头·止 | 退出该状态的过渡 |
| `dialog_virtual_state_scratchhead_start` | 2.07s | 挠头·起 | 进入该状态的过渡 |
| `dialog_virtual_state_think1_end` | 2.20s | 思考·止 | 退出该状态的过渡 |
| `dialog_virtual_state_think1_start` | 1.70s | 思考·起 | 进入该状态的过渡 |
| `gacha` | 11.42s | 抽卡演出 | 11.42s，跳跃/转身的登场演出 |
| `hair_yaw_m` | 0.17s | 头发偏转（叠加） | 0.17s，**叠加层**，不要当独立动作播 |
| `idle_to_relax` | 2.87s | 待机→放松 | 2.87s，进入 relax_loop 前的过渡 |
| `interact_rope_d_end` | 2.28s | 操作绳索·止2 | 2.28s |
| `interact_rope_end` | 2.75s | 操作绳索·止 | 2.75s |
| `interact_rope_start` | 5.28s | 操作绳索·起 | 5.28s |
| `interact_sit_end` | 4.00s | 起身 | 4.00s，播完回待机 |
| `interact_sit_start` | 3.75s | 坐下·起 | 3.75s，进入 interact_sit_loop 前用 |
| `lookat_body_m` | 0.17s | 身体朝向（叠加） | 0.17s，**叠加层**，不要当独立动作播 |
| `ui_overview_start_01` | 12.42s | 登场 | 12.42s，从侧后方转身入场，盒子小的场合慎用 |

## 5. 衍生动作（从剪辑里截一段，不用新资源）

| 动作名 | 来源 | 区间 | 播放方式 | 说明 |
|---|---|---|---|---|
| `swing` | `battle_attack_04` | 0.3–4.5s | pingpong（来回） | **荡秋千**：腾空侧摆那一段，腿在身侧划弧、裙摆甩开 |
| 任意 | 任意剪辑 | `play(name, {from, to})` | 自选 | 例如 `play('gacha', {from: 2, to: 5, loop: true})` |

```js
pet.play('swing');                                                       // 荡秋千（默认来回摆）
pet.play('battle_attack_04', { from: 0.3, to: 4.5, loop: 'pingpong' });  // 等价写法
pet.play('battle_attack_04', { from: 4.5, to: 6.4 });                     // 只看落地收招
```

> `loop` 支持 `true/false/'repeat'/'pingpong'`。片段是从现有 AnimationClip 里按时间切出来的
> （`_sliceClip`），时间轴重排到 0 起点，不需要重新导资源。
> 注：这版 three 的 `LoopPingPong` 常量没被 `_updateTime` 实现，来回摆是内核自己驱动 `action.time`。

### 道具（当前未使用）

站点 `deco/chr_0036_jsspsi` 导出 16 个道具：墨咬兽 / 卷轴 / **墨线涂鸦龙** / 毛笔 + 若干特效粒子，**没有秋千**。
曾经用 Canvas 笔触现画过一个墨线秋千（`poc/props.js`，效果见 `docs/shots/s2-12-ink-swing.png`），
但**已决定不启用**（main.js 不再引用）。以后要做道具，照这个模式：加载 `deco/*.glb`，
或复用 `props.js` 的笔触画法，按动作名淡入淡出。

## 6. 叠加片段（不要当独立动作播）

- `hair_yaw_m` 0.17s — 头发偏转（叠加）
- `lookat_body_m` 0.17s — 身体朝向（叠加）

## 6. 内核已经替你处理掉的坑

| 坑 | 内核的处理 |
|---|---|
| 剪辑带根位移（走路会走出画面、攻击会前冲 4 米） | `rootMotion:'center'` 把水平位移归零，竖直保留（坐下真的要矮下去） |
| 部分剪辑带对话镜头站位偏移（`uiteam_*` 偏 1.5 单位） | 同上，全部归位到原点 |
| `dialog_single_wave` 原剪辑 `loop:true` 导致永远挥手 | 元数据标 `oneshot`，内核强制单次 |
| 大姿态时脖子和视线打架 | 视线幅度自动 ×0.55 |
| 动作播完僵在末帧 | 1.5s 兜底回待机（外壳也可以自己 `reset()`） |

## 7. 高度偏移（盒子小的注意）

| 动作 | 根节点高度 | 说明 |
|---|---|---|
| 站立类 | y ≈ 0.92–1.07 | 基准 |
| `interact_sit_loop` / `interact_sit_start` | 0.64 | 坐在地上 |
| `dialog_state_sitread_loop` | 0.57 | 坐着阅读 |
| `dialog_state_sit2_loop` | **0.11** | 极低，接近趴伏 |
| `dialog_state_sit_loop` | **1.19** | 比站立还高，等于"坐在高台上" |
| `battle_air_start` | **5.12** | 腾空，盒子装不下 |
| `battle_skill_ult` | 1.37 | 起跳瞬间 |

## 8. 给 LLM 的动作清单（可直接塞 prompt）

只把下面这些交给 LLM，别把 103 条全给它 —— 它会乱选。
```text
可用动作（选一个，输出动作名即可）：
待机：ui_overview_loop_01
小动作：dialog_virtual_single_idle_nod（点头）、dialog_virtual_single_idle_shake（摇头）、
        dialog_single_wave（挥手）、dialog_virtual_single_idle_talkhands（说话手势）
状态（需要配合"回到待机"）：dialog_state_sit_loop（坐下）、relax_loop（放松）、
        dialog_state_holdarm_loop（抱臂）、dialog_state_point_loop（指）
组合：interact_sit_start + interact_sit_loop（坐下），interact_sit_end（起身）
```

---
*生成时间：2026-10-29 ／ 动作库版本：103 条（29 循环 + 74 单次）*
