# 祀 · 可用动作（ACTIONS）

> 由当前动作库生成（2026-11-15，共 102 条）。
> 这份文件就是系统提示里 ACTIONS 区块的原文，可在设置页编辑后保存回 si/app/preset-actions.md。
> 只有下面 si:common 里列出的动作会进系统提示，其余算「高阶动作」，模型用 list_advanced_actions 取。

<!-- si:common
ui_overview_loop_01
dialog_state_idle_loop
relax_loop
battle_loop
walk_loop_sp_01
interact_sit_loop
dialog_state_holdarm_loop
dialog_state_angry02_loop
dialog_state_muse_loop
dialog_state_surprise_loop
dialog_state_cough_loop
dialog_state_play02_loop
dialog_single_wave
dialog_virtual_single_idle_nod
dialog_virtual_single_idle_shake
dialog_virtual_single_idle_talkhands
dialog_virtual_single_idle_talklefthand1
dialog_virtual_single_idle_talkrighthand1
-->

## 一、怎么用动作

1. 一次只给一个动作名，写进 play_action 的 action 参数，队列按顺序播放。
2. 循环动作（loop）会一直保持；后面的动作会排队等它，换姿态要先排它的 _end 或回到待机。
3. 大姿态走三段式：xxx_start → xxx_loop → xxx_end；过渡剪辑不要单独当动作。
4. hair_yaw_m / lookat_body_m 是叠加层，不能播。
5. 拿不准时用最轻的反馈：点头、摇头、挥手。

## 二、循环动作（会一直保持）

| 动作名 | 中文 | 时长 |
|---|---|---|
| `battle_loop` | 战斗待机 | 2.00s |
| `dialog_state_adjust_loop` | 整理 | 6.93s |
| `dialog_state_angry02_loop` | 生气 | 2.67s |
| `dialog_state_censure_loop` | 责备 | 3.33s |
| `dialog_state_chesthugging1_loop` | 抱胸 | 4.85s |
| `dialog_state_cough_loop` | 咳嗽 | 3.60s |
| `dialog_state_dignified_loop` | 端庄 | 3.33s |
| `dialog_state_halfraise_loop` | 半举手 | 2.42s |
| `dialog_state_holdarm_loop` | 抱臂 | 2.17s |
| `dialog_state_idle_loop` | 对话待机 | 2.00s |
| `dialog_state_muse_loop` | 沉思 | 2.67s |
| `dialog_state_play02_loop` | 玩闹 | 2.52s |
| `dialog_state_point_loop` | 指 | 2.37s |
| `dialog_state_sit_loop` | 坐下（高台） | 18.17s |
| `dialog_state_sit2_loop` | 坐下（低姿） | 2.00s |
| `dialog_state_sitread_loop` | 坐着看书 | 5.17s |
| `dialog_state_spell_loop` | 施法 | 8.53s |
| `dialog_state_surprise_loop` | 惊讶 | 2.70s |
| `dialog_state_walkandtalk_loop` | 边走边说 | 5.67s |
| `interact_sit_loop` | 坐在地上 | 3.83s |
| `relax_loop` | 放松 | 3.00s |
| `ui_overview_loop_01` | 总览待机 | 2.50s |
| `ui_relax_loop` | 放松（UI） | 3.00s |
| `uiteam_idle_01` | 队伍站位 1 | 2.48s |
| `uiteam_idle_02` | 队伍站位 2 | 2.50s |
| `uiteam_idle_03` | 队伍站位 3 | 2.50s |
| `uiteam_idle_04` | 队伍站位 4 | 2.50s |
| `walk_loop_sp_01` | 走路 | 7.72s |

## 三、一次性动作

| 动作名 | 中文 | 时长 |
|---|---|---|
| `battle_attack_01` | 攻击 1 | 5.65s |
| `battle_attack_02` | 攻击 2 | 6.83s |
| `battle_attack_03` | 攻击 3 | 5.33s |
| `battle_attack_04` | 攻击 4 | 8.97s |
| `battle_attack_05` | 攻击 5 | 6.32s |
| `battle_dead` | 倒下 | 3.93s |
| `battle_hit_heavy` | 受重击 | 2.43s |
| `battle_normal_skill_1` | 普攻技能 | 5.58s |
| `battle_skill_ult` | 终极技 | 7.12s |
| `battle_to_idle` | 战斗→待机 | 4.08s |
| `dialog_single_wave` | 挥手 | 4.17s |
| `dialog_virtual_single_idle_nod` | 点头 | 1.33s |
| `dialog_virtual_single_idle_shake` | 摇头 | 2.33s |
| `dialog_virtual_single_idle_talkhands` | 双手比划 | 4.58s |
| `dialog_virtual_single_idle_talklefthand1` | 左手比划 | 2.83s |
| `dialog_virtual_single_idle_talkrighthand1` | 右手比划 | 2.83s |
| `gacha` | 抽卡演出 | 11.42s |
| `idle_to_relax` | 待机→放松 | 2.87s |
| `ui_overview_start_01` | 登场 | 12.42s |

## 四、过渡剪辑（必须拼在状态前后）

| 动作名 | 中文 | 时长 |
|---|---|---|
| `battle_air_end` | 腾空·落 | 5.82s |
| `battle_air_start` | 腾空·起 | 1.07s |
| `battle_attack_04_start` | 攻击4·前摇 | 2.42s |
| `battle_blown_end` | 被击飞·落 | 2.97s |
| `battle_blown_start` | 被击飞·起 | 0.87s |
| `battle_stun_end` | 眩晕·结束 | 1.00s |
| `dialog_state_angry02_end` | 生气·止 | 2.17s |
| `dialog_state_angry02_start` | 生气·起 | 1.42s |
| `dialog_state_censure_end` | 责备·止 | 2.92s |
| `dialog_state_censure_start` | 责备·起 | 13.33s |
| `dialog_state_chesthugging1_end` | 抱胸·止 | 2.17s |
| `dialog_state_chesthugging1_start` | 抱胸·起 | 1.90s |
| `dialog_state_chesthugging3_derived_tail_end` | 抱胸(变体尾段)·止 | 1.95s |
| `dialog_state_chesthugging3_derived_tail_start` | 抱胸(变体尾段)·起 | 1.42s |
| `dialog_state_chesthugging3_end` | 抱胸(变体)·止 | 1.95s |
| `dialog_state_chesthugging3_start` | 抱胸(变体)·起 | 1.42s |
| `dialog_state_cough_end` | 咳嗽·止 | 2.00s |
| `dialog_state_cough_start` | 咳嗽·起 | 2.20s |
| `dialog_state_dignified_end` | 端庄·止 | 2.67s |
| `dialog_state_dignified_start` | 端庄·起 | 3.33s |
| `dialog_state_halfraise_end` | 半举手·止 | 2.83s |
| `dialog_state_halfraise_start` | 半举手·起 | 2.00s |
| `dialog_state_holdarm_end` | 抱臂·止 | 4.13s |
| `dialog_state_holdarm_start` | 抱臂·起 | 2.10s |
| `dialog_state_muse_end` | 沉思·止 | 4.57s |
| `dialog_state_muse_start` | 沉思·起 | 3.77s |
| `dialog_state_point_end` | 指·止 | 2.83s |
| `dialog_state_point_start` | 指·起 | 3.13s |
| `dialog_state_sit2_end` | 坐(低姿)·止 | 5.25s |
| `dialog_state_sit2_start` | 坐(低姿)·起 | 5.12s |
| `dialog_state_spell_start` | 施法·起 | 2.17s |
| `dialog_state_surprise_end` | 惊讶·止 | 1.80s |
| `dialog_state_surprise_start` | 惊讶·起 | 1.60s |
| `dialog_state_walkandtalk_end` | 边走边说·止 | 16.67s |
| `dialog_state_walkandtalk_start` | 边走边说·起 | 9.50s |
| `dialog_virtual_state_akimbo1_end` | 叉腰·止 | 2.08s |
| `dialog_virtual_state_akimbo1_start` | 叉腰·起 | 1.33s |
| `dialog_virtual_state_akimboleft_end` | 左叉腰·止 | 3.15s |
| `dialog_virtual_state_akimboleft_start` | 左叉腰·起 | 1.93s |
| `dialog_virtual_state_akimboright_end` | 右叉腰·止 | 3.02s |
| `dialog_virtual_state_akimboright_start` | 右叉腰·起 | 1.38s |
| `dialog_virtual_state_earphone_end` | 戴耳机·止 | 3.43s |
| `dialog_virtual_state_earphone_start` | 戴耳机·起 | 1.42s |
| `dialog_virtual_state_introduction_end` | 自我介绍·止 | 1.77s |
| `dialog_virtual_state_introduction_start` | 自我介绍·起 | 1.37s |
| `dialog_virtual_state_scratchhead_end` | 挠头·止 | 2.27s |
| `dialog_virtual_state_scratchhead_start` | 挠头·起 | 2.07s |
| `dialog_virtual_state_think1_end` | 思考·止 | 2.20s |
| `dialog_virtual_state_think1_start` | 思考·起 | 1.70s |
| `interact_rope_d_end` | 操作绳索·止2 | 2.28s |
| `interact_rope_end` | 操作绳索·止 | 2.75s |
| `interact_rope_start` | 操作绳索·起 | 5.28s |
| `interact_sit_end` | 起身 | 4.00s |
| `interact_sit_start` | 坐下·起 | 3.75s |

## 五、衍生动作

| 动作名 | 中文 | 说明 |
|---|---|---|
| `swing` | 荡秋千 | 内核从剪辑截取生成 |
