// 嘴型时钟：流式（文本到达时间）/ 语音同步（音频时间或本地计时）
// 两种模式复用同一份时间轴构建器，只有时钟不同，避免两套逻辑漂移。

import { probeLipSync, createLipSyncSender } from './contract.js';
import { buildTimeline } from './timeline.js';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

const ZERO = [0, 0, 0, 0, 0];

// 流式「最新优先」：积压超过 CATCHUP_LAG 就跳读，只保留 CATCHUP_KEEP 的前瞻缓冲
const CATCHUP_LAG = 0.8;
const CATCHUP_KEEP = 0.2;
const CATCHUP_MIN_GAP = 0.45; // 两次跳读的最小间隔（秒），避免抖动

function sampleAt(frames, t) {
  if (!frames || !frames.length) return ZERO;
  if (t <= frames[0].t) return frames[0].w;
  let lo = 0;
  let hi = frames.length - 1;
  if (t >= frames[hi].t) return frames[hi].w;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const span = b.t - a.t;
  const k = span > 0 ? (t - a.t) / span : 0;
  return a.w.map((v, i) => v + ((b.w[i] || 0) - v) * k);
}

// 流式切分：以句读为界；没有标点时按空白或长度兜底，留下未完成的词
function takeReady(buf) {
  let cut = -1;
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    if (/[，。！？；：、,.!?;:\n]/.test(buf[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut < 0 && buf.length > 30) {
    const space = buf.lastIndexOf(' ');
    cut = space > 0 ? space + 1 : buf.length - 1;
  }
  if (cut <= 0) return { text: '', rest: buf };
  return { text: buf.slice(0, cut), rest: buf.slice(cut) };
}

export function createLipSyncEngine(deps = {}) {
  const getPet = deps.getPet || (() => null);
  const getSettings = deps.getSettings || (() => ({}));
  const isVoiceAvailable = typeof deps.isVoiceAvailable === 'function' ? deps.isVoiceAvailable : () => true;
  const onState = typeof deps.onState === 'function' ? deps.onState : () => {};

  const state = {
    caps: probeLipSync(null),
    sender: null,
    reply: { active: false, closed: true, mode: 'off', id: '' },
    stream: { buf: '', cursor: 0, startAt: 0, started: false, queue: Promise.resolve(), frames: [], timer: null, monitor: null, lastJumpAt: -1 },
    voice: null,
  };

  function settings() {
    return getSettings() || {};
  }

  function currentMode() {
    const mode = settings().lipSyncMode;
    return mode === 'stream' || mode === 'voice' ? mode : 'off';
  }

  function intensity() {
    return clamp(Number(settings().lipSyncIntensity) || 0.9, 0.2, 1.2);
  }

  function delaySec() {
    return clamp(Number(settings().lipSyncDelay) || 0, -100, 100) / 1000;
  }

  function speed() {
    return clamp(Number(settings().ttsSpeed) || 1, 0.6, 1.6);
  }

  function emitState() {
    onState({
      supported: state.caps.supported,
      mode: state.caps.mode,
      visemes: state.caps.visemes.slice(),
      declared: state.caps.declared,
      version: state.caps.version,
    });
  }

  function attach(pet) {
    state.caps = probeLipSync(pet);
    state.sender = createLipSyncSender(pet, state.caps);
    if (pet && typeof pet.on === 'function') {
      try {
        pet.on('lipsync_end', (e) => {
          if (state.voice && e && e.id === state.voice.id) state.voice.playing = false;
        });
      } catch (_) {
        /* 老内核没有事件系统 */
      }
    }
    emitState();
    return state.caps;
  }

  // ---------------------------------------------------------------- 流式
  function clearStreamTimer() {
    if (state.stream.timer) {
      clearInterval(state.stream.timer);
      state.stream.timer = null;
    }
    if (state.stream.monitor) {
      clearInterval(state.stream.monitor);
      state.stream.monitor = null;
    }
  }

  function catchUpEnabled() {
    return settings().lipSyncCatchUp !== false;
  }

  // 流式「最新优先」：嘴不再逐字念完，而是追内容前沿
  function tickCatchUp() {
    const s = state.stream;
    if (!s.started || !state.reply.active) {
      clearStreamTimer();
      return;
    }
    const playT = (now() - s.startAt) / 1000;
    const lag = s.cursor - playT;
    if (!catchUpEnabled() || lag < CATCHUP_LAG) return;
    if (s.lastJumpAt >= 0 && playT - s.lastJumpAt < CATCHUP_MIN_GAP) return;
    s.lastJumpAt = playT;
    if (!state.sender) return;

    if (state.sender.mode === 'frames') {
      // 内核按绝对时间播放：跳到已排内容的末端附近，中间那段直接跳过
      if (!state.caps.seekable) return;
      state.sender.seek(state.reply.id, Math.max(0, s.cursor - CATCHUP_KEEP));
      return;
    }

    // 单通道降级：把缓冲重新对时，丢弃已被跳过的旧口型
    const target = playT + CATCHUP_KEEP;
    const shift = s.cursor - target;
    if (shift <= 0) return;
    s.frames = s.frames
      .filter((f) => f.t - shift >= playT - 0.05)
      .map((f) => ({ t: round3(f.t - shift), w: f.w }));
    s.cursor = target;
  }

  function startStreamMonitor() {
    if (state.stream.monitor || typeof setInterval !== 'function') return;
    state.stream.monitor = setInterval(tickCatchUp, 100);
  }

  function beginReply() {
    stop();
    const mode = currentMode();
    const effective = mode === 'voice' && !isVoiceAvailable() ? 'stream' : mode;
    state.reply = {
      active: effective !== 'off' && state.caps.supported,
      closed: false,
      mode: effective,
      id: `ls-${Date.now().toString(36)}`,
    };
    state.stream = { buf: '', cursor: 0, startAt: 0, started: false, queue: Promise.resolve(), frames: [], timer: null, monitor: null, lastJumpAt: -1 };
  }

  function feedText(chunk) {
    if (!state.reply.active || state.reply.closed || state.reply.mode !== 'stream') return;
    const text = String(chunk || '');
    if (!text) return;
    state.stream.buf += text;
    const ready = takeReady(state.stream.buf);
    state.stream.buf = ready.rest;
    if (ready.text) {
      state.stream.queue = state.stream.queue
        .then(() => emitStream(ready.text))
        .catch(() => {});
    }
  }

  async function emitStream(text) {
    if (!state.reply.active) return;
    if (!state.stream.started) {
      state.stream.started = true;
      state.stream.startAt = now();
      if (state.sender) {
        state.sender.begin(state.reply.id, intensity());
        state.sender.play(state.reply.id);
      }
      if (state.sender && state.sender.mode === 'mouth') startStreamMouth();
      startStreamMonitor();
    }
    const arrival = Math.max(0, (now() - state.stream.startAt) / 1000);
    // 文本比嘴快、积压超过 250ms：本段最多 1.6 倍速追平
    const lag = state.stream.cursor - arrival;
    const boost = lag > 0.25 ? Math.min(1.6, 1 + (lag - 0.25) * 1.6) : 1;
    const timeline = await buildTimeline(text, { speed: speed() * boost });
    if (!state.reply.active || !timeline.frames.length) return;
    const offset = Math.max(arrival, state.stream.cursor);
    const frames = timeline.frames.map((f) => ({ t: round3(f.t + offset), w: f.w }));
    state.stream.cursor = offset + timeline.duration;
    if (state.sender) {
      if (state.sender.mode === 'mouth') state.stream.frames.push(...frames);
      state.sender.push(state.reply.id, frames);
    }
  }

  function startStreamMouth() {
    clearStreamTimer();
    if (typeof setInterval !== 'function') return;
    state.stream.timer = setInterval(() => {
      if (!state.stream.started) return;
      const t = (now() - state.stream.startAt) / 1000;
      if (t > state.stream.cursor + 0.3) {
        clearStreamTimer();
        state.sender.mouth(ZERO, intensity());
        return;
      }
      state.sender.mouth(sampleAt(state.stream.frames, t), intensity());
    }, 33);
  }

  function endReply() {
    if (!state.reply.active) return;
    const id = state.reply.id;
    if (state.reply.mode === 'stream') {
      state.reply.closed = true;
      state.stream.queue = state.stream.queue
        .then(async () => {
          const rest = state.stream.buf.trim();
          state.stream.buf = '';
          if (rest) await emitStream(rest);
          if (state.sender) state.sender.end(id);
        })
        .catch(() => {})
        .then(() => {
          state.reply.active = false;
        });
      return;
    }
    // 语音同步模式由 TTS 播放进度驱动，这里不主动收尾
    state.reply.closed = true;
  }

  // ---------------------------------------------------------------- 语音同步
  function clearVoiceTimers() {
    const voice = state.voice;
    if (!voice) return;
    if (voice.mouthTimer) clearInterval(voice.mouthTimer);
    if (voice.clockTimer) clearInterval(voice.clockTimer);
    voice.mouthTimer = null;
    voice.clockTimer = null;
  }

  function voiceElapsed(voice) {
    if (!voice || !voice.startedAt) return 0;
    const paused = voice.pausedAt ? now() - voice.pausedAt : 0;
    return Math.max(0, (now() - voice.startedAt - paused) / 1000 - voice.pausedTotal);
  }

  function startVoiceMouth(voice) {
    if (typeof setInterval !== 'function') return;
    voice.mouthTimer = setInterval(() => {
      const t = voiceElapsed(voice) + delaySec();
      if (t > voice.duration + 0.2) {
        clearInterval(voice.mouthTimer);
        voice.mouthTimer = null;
        state.sender.mouth(ZERO, intensity());
        return;
      }
      state.sender.mouth(sampleAt(voice.frames, t), intensity());
    }, 33);
  }

  // 预装时间轴：音频还没开始播，先不 Play
  async function beginVoice(text, opts = {}) {
    if (!state.caps.supported || currentMode() !== 'voice') return false;
    const content = String(text || '').trim();
    if (!content) return false;
    stop();
    const timeline = await buildTimeline(content, { speed: speed() });
    if (!timeline.frames.length) return false;
    const id = opts.id || `lv-${Date.now().toString(36)}`;
    state.voice = {
      id,
      frames: timeline.frames,
      duration: timeline.duration,
      startedAt: 0,
      pausedAt: 0,
      pausedTotal: 0,
      playing: false,
      mouthTimer: null,
      clockTimer: null,
    };
    state.reply = { active: true, closed: true, mode: 'voice', id };
    if (state.sender) {
      state.sender.begin(id, intensity());
      state.sender.push(id, timeline.frames);
    }
    return true;
  }

  function voicePlay(clock = 'web') {
    const voice = state.voice;
    if (!voice) return;
    voice.startedAt = now();
    voice.pausedAt = 0;
    voice.pausedTotal = 0;
    voice.playing = true;
    if (state.sender) state.sender.play(voice.id);
    if (state.sender && state.sender.mode === 'mouth' && clock !== 'audio') startVoiceMouth(voice);
  }

  function voiceSeek(t) {
    const voice = state.voice;
    if (!voice || !state.sender) return;
    const clamped = clamp(Number(t) || 0, 0, voice.duration);
    if (state.sender.mode === 'frames') {
      state.sender.seek(voice.id, clamped);
    } else {
      state.sender.mouth(sampleAt(voice.frames, clamped + delaySec()), intensity());
    }
  }

  function voiceBoundary(charIndex, totalChars) {
    const voice = state.voice;
    if (!voice || !voice.playing) return;
    const total = Math.max(1, Number(totalChars) || 1);
    const frac = clamp((Number(charIndex) || 0) / total, 0, 1);
    const target = voice.duration * frac;
    const current = voiceElapsed(voice);
    if (Math.abs(target - current) <= 0.12) return;
    if (state.sender) {
      if (state.sender.mode === 'frames') state.sender.seek(voice.id, clamp(target + delaySec(), 0, voice.duration));
      else state.sender.mouth(sampleAt(voice.frames, target + delaySec()), intensity());
    }
    // 让内部计时靠拢校准点
    voice.startedAt = now() - target * 1000;
    voice.pausedAt = 0;
    voice.pausedTotal = 0;
  }

  function voicePause() {
    const voice = state.voice;
    if (!voice || !voice.playing) return;
    voice.pausedAt = now();
    if (voice.mouthTimer) {
      clearInterval(voice.mouthTimer);
      voice.mouthTimer = null;
    }
    if (state.sender) state.sender.pause(voice.id);
  }

  function voiceResume() {
    const voice = state.voice;
    if (!voice) return;
    if (voice.pausedAt) {
      voice.pausedTotal += (now() - voice.pausedAt) / 1000;
      voice.pausedAt = 0;
    }
    if (state.sender) state.sender.resume(voice.id);
    if (state.sender && state.sender.mode === 'mouth' && !voice.mouthTimer) startVoiceMouth(voice);
  }

  function voiceStop(fade = 0.12) {
    const voice = state.voice;
    // 没有语音轨道时不动内核：避免把流式模式正在播的口型一起关掉
    if (!voice) return null;
    clearVoiceTimers();
    if (state.sender) {
      state.sender.stop(fade);
      if (state.sender.mode === 'mouth') state.sender.mouth(ZERO, intensity());
    }
    state.voice = null;
    if (state.reply.mode === 'voice') {
      state.reply.active = false;
      state.reply.closed = true;
    }
    return voice;
  }

  // ---------------------------------------------------------------- 统一停止
  function stop(fade = 0.12) {
    clearStreamTimer();
    clearVoiceTimers();
    if (state.sender) {
      state.sender.stop(fade);
      if (state.sender.mode === 'mouth') state.sender.mouth(ZERO, intensity());
    }
    state.voice = null;
    state.reply = { active: false, closed: true, mode: 'off', id: '' };
    state.stream = { buf: '', cursor: 0, startAt: 0, started: false, queue: Promise.resolve(), frames: [], timer: null, monitor: null, lastJumpAt: -1 };
  }

  return {
    attach,
    emitState,
    getCaps: () => state.caps,
    getState: () => ({
      supported: state.caps.supported,
      mode: state.caps.mode,
      visemes: state.caps.visemes.slice(),
      replyMode: state.reply.mode,
      replyActive: state.reply.active,
    }),
    currentMode,
    beginReply,
    feedText,
    endReply,
    beginVoice,
    voicePlay,
    voiceSeek,
    voiceBoundary,
    voicePause,
    voiceResume,
    voiceStop,
    stop,
  };
}
