// 文本 → 口型时间轴：单一管线、单一时间轴、单一语速来源
// 规范化 → 分段 → 读音 → 口型 → 时长 / 停顿 / 协同发音 → frames[]
// frames 里的权重是 0~1 的基元幅度，强度（intensity）由契约层统一传递。

import { normalizeForLipsync, splitSegments } from './normalize.js';
import { zhSyllables } from './zh.js';
import { enPhonemes, phonemesToSteps, loadEnDictionary } from './en.js';

export const VISEMES = ['a', 'i', 'u', 'e', 'o'];

const FRAME_STEP = 0.04; // 40ms 一帧，落在计划书建议的 40~60ms 区间
const ZH_SYLLABLE = 0.2; // 中文单音节基础时长
const MAX_FRAMES = 3000;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

// 把文本拆成「发音单元」：中文音节 / 英文音素步进 / 停顿
export async function analyzeText(text, opts = {}) {
  const normalized = normalizeForLipsync(text);
  const segments = splitSegments(normalized);
  const units = [];
  let dict = opts.enDict || null;

  for (const seg of segments) {
    if (seg.kind === 'pause') {
      units.push({ type: 'pause', ms: seg.pause });
      continue;
    }
    if (seg.kind === 'zh') {
      const syllables = await zhSyllables(seg.text);
      for (const syl of syllables) units.push({ type: 'zh', ...syl });
      continue;
    }
    if (seg.kind === 'en') {
      if (!dict) dict = await loadEnDictionary();
      const words = String(seg.text)
        .split(/[^a-z']+/i)
        .filter(Boolean);
      words.forEach((word, idx) => {
        const phones = enPhonemes(word, dict);
        units.push({ type: 'en', word, steps: phonemesToSteps(phones) });
        if (idx < words.length - 1) units.push({ type: 'pause', ms: 60 });
      });
    }
  }
  return { normalized, units };
}

function envelope(local, dur) {
  const attack = Math.min(0.055, dur * 0.35);
  const release = Math.min(0.085, dur * 0.45);
  const smooth = (x) => {
    const t = clamp(x, 0, 1);
    return t * t * (3 - 2 * t);
  };
  if (local < attack) return attack > 0 ? smooth(local / attack) : 1;
  const remain = dur - local;
  if (remain < release) return release > 0 ? smooth(Math.max(0, remain / release)) : 0;
  return 1;
}

// 零相位双向平滑：正向 + 反向各低通一次，既没有单向滤波的滞后，
// 又让权重曲线的一阶/二阶导连续，嘴形加减速不再一段一段地硬拐。
function smoothTrack(raw, step, tau = 0.04) {
  const n = raw.length;
  if (!n) return raw;
  const a = 1 - Math.exp(-step / tau);
  const fwd = new Array(n);
  let prev = raw[0].slice();
  for (let i = 0; i < n; i += 1) {
    prev = prev.map((v, k) => v + a * (raw[i][k] - v));
    fwd[i] = prev.slice();
  }
  const out = new Array(n);
  let next = fwd[n - 1].slice();
  for (let i = n - 1; i >= 0; i -= 1) {
    next = next.map((v, k) => v + a * (fwd[i][k] - v));
    out[i] = next.map((v) => (v < 0.012 ? 0 : Math.min(1, v)));
  }
  return out;
}

function sampleFrames(targets, total) {
  const step = total > 90 ? 0.06 : FRAME_STEP;
  const count = Math.min(Math.ceil(total / step) + 1, MAX_FRAMES);
  const raw = [];

  for (let n = 0; n < count; n += 1) {
    const t = n * step;
    const weights = [0, 0, 0, 0, 0];
    let closing = false;
    for (const target of targets) {
      if (t < target.start - 0.02 || t > target.start + target.dur + 0.02) continue;
      if (target.close) {
        closing = true;
        continue;
      }
      const env = envelope(Math.max(0, t - target.start), target.dur);
      const idx = VISEMES.indexOf(target.v);
      if (idx >= 0) weights[idx] = Math.max(weights[idx], (target.w || 1) * env);
    }
    if (closing) weights.fill(0);
    raw.push(weights);
  }

  // 平滑放在采样之后统一做：同帧多基元（协同发音）先叠加，再一起过渡
  const smoothed = smoothTrack(raw, step);
  const frames = smoothed.map((w, n) => ({ t: round3(n * step), w: w.map(round3) }));

  // 收尾：删掉末尾连续闭嘴的空帧，保留一小段自然闭合
  while (frames.length > 1) {
    const last = frames[frames.length - 1];
    if (last.w.some((v) => v > 0.02)) break;
    frames.pop();
  }
  if (frames.length) {
    const last = frames[frames.length - 1];
    frames.push({ t: round3(last.t + step), w: [0, 0, 0, 0, 0] });
  }
  return frames;
}

// 发音单元 → 时间轴帧；speed 是唯一语速来源（settings.ttsSpeed）
export function scheduleUnits(units, opts = {}) {
  const rate = clamp(Number(opts.speed) || 1, 0.6, 1.6);
  const factor = 1 / rate;
  const targets = [];
  let t = 0;

  for (const unit of units) {
    if (unit.type === 'pause') {
      t += (Math.min(Number(unit.ms) || 0, 600) / 1000) * factor;
      continue;
    }
    if (unit.type === 'zh') {
      const dur = ZH_SYLLABLE * factor;
      const onset = unit.close ? 0.04 * factor : 0;
      if (onset) targets.push({ start: t, dur: onset, close: true });
      // 开唇略早于闭唇结束，避免「闭死 → 弹开」的硬切
      const vStart = t + onset * 0.6;
      const glide = unit.glide && unit.glide !== unit.viseme ? unit.glide : '';
      if (glide) {
        // 复韵母拆成「主元音 → 收尾」两段，后段与前段重叠，形成自然滑动
        targets.push({ start: vStart, dur: dur * 0.62, v: unit.viseme, w: 1 });
        targets.push({ start: vStart + dur * 0.4, dur: dur * 0.64, v: glide, w: 0.9 });
      } else {
        targets.push({ start: vStart, dur, v: unit.viseme, w: 1 });
      }
      // 与下一音节留约 15% 重叠：相邻音素同时有权重，嘴形互相带一下
      t = vStart + dur * 0.86;
      continue;
    }
    if (unit.type === 'en') {
      for (const step of unit.steps || []) {
        const dur = (step.dur || 0.06) * factor;
        targets.push({ start: t, dur, v: step.v, w: step.w, close: !!step.close });
        t += dur * 0.85;
      }
    }
  }

  const total = t > 0 ? t + 0.12 : 0;
  return {
    frames: total ? sampleFrames(targets, total) : [],
    duration: total,
    units,
    speed: rate,
  };
}

export async function buildTimeline(text, opts = {}) {
  const { units } = await analyzeText(text, opts);
  return scheduleUnits(units, opts);
}
