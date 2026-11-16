// 情绪化上下文：纯计算，不读写磁盘、不碰 DOM，方便单测。
// 设计见 情感系统设计.md §11：
//   注入总量 = 上限 × 情绪权重（0.8~1.0）
//   连续段   = 总量的 ceil(65%)
//   补齐段   = 从更早的对话里按「情绪相近 × 时间衰减 × 强度」挑

// 补齐段占注入总量的比例（35%）
export const CONTEXT_FILL_RATIO = 0.35;

// 少于这么多轮时不做拆分：轮次本来就少，拆了反而把有限语境切碎
export const MIN_CONTEXT_TURNS = 25;

// limit：historyWindow（轮）；weight：情绪权重（0.8~1.0）；
// available：当前可注入的总轮数（不传视为无限）
// 返回 { total: 注入总轮数, keep: 连续段轮数, fill: 补齐段轮数 }
export function planContextWindow(limit, weight, fillRatio = CONTEXT_FILL_RATIO, available = Infinity) {
  const turns = Math.max(0, Math.floor(Number(limit) || 0));
  if (!turns) return { total: 0, keep: 0, fill: 0 };
  const w = Math.min(1, Math.max(0.1, Number(weight) || 1));
  const pool = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : Infinity;
  if (pool <= 0) return { total: 0, keep: 0, fill: 0 };
  const total = Math.max(1, Math.min(turns, Math.round(turns * w), pool));
  const ratio = Math.min(0.9, Math.max(0, Number(fillRatio) || 0));
  // 连续段至少留 1 轮，避免「全是补齐、没有当前语境」
  const fill = Math.max(0, Math.min(total - 1, Math.floor(total * ratio)));
  return { total, keep: total - fill, fill };
}

// turns: [{ seq, msgs }]，msgs 里可能带 mood: { valence, intensity }
// 返回按 seq 升序挑出的轮（保持时间顺序）
export function pickTurnsByMood(turns, count, nowValence, nowMs, opts = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n || !Array.isArray(turns) || !turns.length) return [];
  const decayDays = Number(opts.decayDays) > 0 ? Number(opts.decayDays) : 14;
  const now = Number(nowMs) || Date.now();
  const target = Number.isFinite(Number(nowValence)) ? Number(nowValence) : 50;
  const scored = turns.map((t, i) => {
    let sim = 0.5;      // 没有情绪标签的老消息给中性分
    let salience = 0.6;
    (t.msgs || []).forEach((m) => {
      if (!m || m.role !== 'ai' || !m.mood) return;
      const v = Number(m.mood.valence);
      if (Number.isFinite(v)) sim = Math.max(sim, 1 - Math.abs(v - target) / 100);
      const k = Math.min(1, Math.max(0, Number(m.mood.intensity) || 0));
      salience = Math.max(salience, 0.6 + 0.8 * k);
    });
    const at = Number((t.msgs && t.msgs[0] && t.msgs[0].ts) || 0);
    const days = at > 0 ? Math.max(0, (now - at) / 86400000) : decayDays;
    const decay = Math.pow(0.5, days / decayDays);
    return { t, i, score: sim * decay * salience };
  });
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  return scored.slice(0, n).map((x) => x.t).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
}
