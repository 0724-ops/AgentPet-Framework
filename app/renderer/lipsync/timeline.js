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
  const attack = Math.min(0.06, dur * 0.4);
  const release = Math.min(0.09, dur * 0.45);
  if (local < attack) return attack > 0 ? local / attack : 1;
  const remain = dur - local;
  if (remain < release) return release > 0 ? Math.max(0, remain / release) : 0;
  return 1;
}

function sampleFrames(targets, total) {
  const step = total > 90 ? 0.06 : FRAME_STEP;
  const frames = [];
  let prev = [0, 0, 0, 0, 0];
  const count = Math.min(Math.ceil(total / step) + 1, MAX_FRAMES);

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
    // 轻度时间平滑，避免逐帧跳变；内核只做插值，不再改总时长
    const smoothed = weights.map((x, i) => prev[i] * 0.35 + x * 0.65);
    prev = smoothed;
    frames.push({ t: round3(t), w: smoothed.map(round3) });
  }

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
      if (unit.close) {
        targets.push({ start: t, dur: 0.045 * factor, close: true });
        t += 0.045 * factor;
      }
      targets.push({ start: t, dur, v: unit.viseme, w: 1 });
      t += dur * 0.9; // 邻接音节重叠约 30ms
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
