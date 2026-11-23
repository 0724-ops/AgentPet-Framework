// 壳层 ↔ 内核契约：能力探测、缺项合并、调用包装
// 只出现口型基元（a/i/u/e/o/close/open），绝不出现骨骼 / morph / ctrl 名字。

const VISEMES = ['a', 'i', 'u', 'e', 'o'];

// 缺项合并：缺失的基元向最近邻靠拢（与计划书 4.6 一致）
const MERGE = { a: 'o', o: 'u', u: 'o', e: 'i', i: 'e' };

const EMPTY_CAPS = {
  supported: false,
  mode: 'none',
  visemes: [],
  version: 0,
  maxIntensity: 1.2,
  latencyMs: 0,
  declared: false,
  seekable: false,
};

export function probeLipSync(pet) {
  if (!pet) return { ...EMPTY_CAPS };
  let info = null;
  if (typeof pet.getLipSyncInfo === 'function') {
    try {
      info = pet.getLipSyncInfo();
    } catch (_) {
      info = null;
    }
  }
  if (info && info.supported === false) return { ...EMPTY_CAPS, version: Number(info.version) || 0 };

  const hasFrames =
    typeof pet.lipSyncBegin === 'function' &&
    typeof pet.lipSyncPush === 'function' &&
    typeof pet.lipSyncPlay === 'function';
  const hasMouth = typeof pet.setMouth === 'function';
  const mode = hasFrames ? 'frames' : hasMouth ? 'mouth' : 'none';
  if (mode === 'none') return { ...EMPTY_CAPS };

  let visemes;
  if (info && Array.isArray(info.visemes) && info.visemes.length) {
    visemes = info.visemes.map(String);
  } else if (info || hasFrames) {
    // 声明了帧接口但没给集合：按全量五元音处理
    visemes = VISEMES.slice();
  } else {
    // 老内核只有 setMouth：退化为单通道开合
    visemes = ['open'];
  }

  return {
    supported: true,
    mode,
    visemes,
    version: Number(info && info.version) || 1,
    maxIntensity: Number(info && info.maxIntensity) || 1.2,
    latencyMs: Number(info && info.latencyMs) || 0,
    declared: !!info,
    // 支持 seek 才能做流式「跳读追赶」；没有就只能按原速播放
    seekable: hasFrames && typeof pet.lipSyncSeek === 'function',
  };
}

// 根据内核声明的集合，生成「五元音 → 内核可表现形状」的映射器
export function createVisemeAdapter(caps) {
  if (!caps || !caps.supported) return null;
  const set = new Set(caps.visemes || []);
  const hasAnyVowel = VISEMES.some((v) => set.has(v));

  if (set.has('open') && !hasAnyVowel) {
    return {
      open: true,
      map(weights) {
        const sum = (weights || []).reduce((a, b) => a + (Number(b) || 0), 0);
        return { open: Math.min(1, sum) };
      },
    };
  }

  const fallback = VISEMES.find((v) => set.has(v)) || (set.has('close') ? null : null);
  const target = {};
  for (const viseme of VISEMES) {
    let cur = viseme;
    const seen = new Set();
    while (!set.has(cur) && MERGE[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = MERGE[cur];
    }
    target[viseme] = set.has(cur) ? cur : fallback;
  }

  const mappedTargets = [...new Set(Object.values(target).filter(Boolean))];

  return {
    open: false,
    map(weights) {
      const out = {};
      // 先把所有可写通道显式归零，避免内核残留上一帧的权重
      for (const key of mappedTargets) out[key] = 0;
      for (let i = 0; i < VISEMES.length; i += 1) {
        const dst = target[VISEMES[i]];
        if (!dst) continue;
        const value = Number(weights && weights[i]) || 0;
        if (value > 0) out[dst] = Math.min(1, (out[dst] || 0) + value);
      }
      return out;
    },
  };
}

// 调用包装：任何内核侧异常都只告警一次，不影响对话与动作系统
export function createLipSyncSender(pet, caps) {
  const adapter = createVisemeAdapter(caps);
  if (!caps || !caps.supported || !adapter) return null;

  let warned = false;
  const guard = (fn) => {
    try {
      fn();
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[lipsync] kernel call failed', err);
      }
    }
  };
  const can = (name) => typeof pet[name] === 'function';
  const isFrames = caps.mode === 'frames';

  return {
    mode: caps.mode,
    adapter,
    begin(id, intensity) {
      if (isFrames && can('lipSyncBegin')) guard(() => pet.lipSyncBegin({ id, intensity, attack: 0.06, release: 0.1 }));
    },
    push(id, frames) {
      if (isFrames && can('lipSyncPush')) guard(() => pet.lipSyncPush({ id, frames }));
    },
    play(id) {
      if (isFrames && can('lipSyncPlay')) guard(() => pet.lipSyncPlay({ id }));
    },
    pause(id) {
      if (isFrames && can('lipSyncPause')) guard(() => pet.lipSyncPause({ id }));
    },
    resume(id) {
      if (isFrames && can('lipSyncResume')) guard(() => pet.lipSyncResume({ id }));
    },
    seek(id, t) {
      if (isFrames && can('lipSyncSeek')) guard(() => pet.lipSyncSeek({ id, t }));
    },
    end(id) {
      if (isFrames && can('lipSyncEnd')) guard(() => pet.lipSyncEnd({ id }));
    },
    stop(fade = 0.12) {
      if (isFrames && can('lipSyncStop')) guard(() => pet.lipSyncStop({ fade }));
    },
    // 降级通道：内核只实现 setMouth 时，壳层按固定频率推权重
    mouth(weights, intensity) {
      if (!can('setMouth')) return;
      const obj = adapter.map(weights);
      guard(() => pet.setMouth(obj, intensity));
    },
  };
}
