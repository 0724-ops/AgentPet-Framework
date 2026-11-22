// 嘴型同步单测：node --test "AgentPet Framework/app/renderer/lipsync.test.mjs"
// 覆盖：中文数字 / 日期 / 单位 / 百分比 / 英文序数 / 分段 / 韵母归类 / G2P / 时间轴 / 契约降级 / 时钟
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  intToZh,
  numToZh,
  intToEn,
  ordinalEn,
  expandNumbers,
  splitSegments,
  normalizeForLipsync,
} from './lipsync/normalize.js';
import { finalToViseme, zhSyllables } from './lipsync/zh.js';
import { g2p, enPhonemes, phonemeSteps, setEnDictionary } from './lipsync/en.js';
import { buildTimeline, scheduleUnits } from './lipsync/timeline.js';
import { probeLipSync, createVisemeAdapter } from './lipsync/contract.js';
import { createLipSyncEngine } from './lipsync/clock.js';

const DICT = {
  hello: 'HH AH0 L OW1',
  world: 'W ER1 L D',
  make: 'M EY1 K',
  story: 'S T AO1 R IY0',
};

test('中文整数读法', () => {
  assert.equal(intToZh(123), '一百二十三');
  assert.equal(intToZh(200), '两百');
  assert.equal(intToZh(1005), '一千零五');
  assert.equal(intToZh(10), '十');
  assert.equal(intToZh(22), '二十二');
  assert.equal(intToZh(100000001), '一亿零一');
  assert.equal(intToZh(100010000), '一亿零一万');
});

test('中文小数读法', () => {
  assert.equal(numToZh('3.14'), '三点一四');
  assert.equal(numToZh('0.5'), '零点五');
});

test('英文数字与序数', () => {
  assert.equal(intToEn(123), 'one hundred twenty three');
  assert.equal(intToEn(1005), 'one thousand five');
  assert.equal(ordinalEn(1), 'first');
  assert.equal(ordinalEn(12), 'twelfth');
  assert.equal(ordinalEn(21), 'twenty first');
  assert.equal(ordinalEn(40), 'fortieth');
});

test('数字 / 日期 / 时间 / 单位 / 百分比转写', () => {
  assert.match(expandNumbers('现在是2026年11月22日。'), /二零二六年十一月二十二日/);
  assert.match(expandNumbers('2026-11-22'), /二零二六年十一月二十二日/);
  assert.match(expandNumbers('进度45%'), /百分之四十五/);
  assert.match(expandNumbers('跑了3km'), /三公里/);
  assert.match(expandNumbers('温度30℃'), /三十摄氏度/);
  assert.match(expandNumbers('电话13800138000'), /一三八零零一三八零零零/);
  assert.match(expandNumbers('meet at 14:30'), /fourteen thirty/);
  assert.match(expandNumbers('the 21st'), /twenty first/);
  assert.match(expandNumbers('价格￥12.5'), /十二点五元/);
});

test('Markdown 清洗与分段', () => {
  const text = normalizeForLipsync('## 标题\n\n**你好**，`code` [链接](https://x.com) 😀');
  assert.ok(!text.includes('#'));
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes('https'));
  const segs = splitSegments('你好，world！');
  assert.deepEqual(segs.map((s) => s.kind), ['zh', 'pause', 'en', 'pause']);
});

test('韵母 → 五元音', () => {
  assert.equal(finalToViseme('a'), 'a');
  assert.equal(finalToViseme('iang'), 'a');
  assert.equal(finalToViseme('uo'), 'o');
  assert.equal(finalToViseme('iu'), 'o');
  assert.equal(finalToViseme('ie'), 'e');
  assert.equal(finalToViseme('ing'), 'i');
  assert.equal(finalToViseme('ian'), 'i');
  assert.equal(finalToViseme('ün'), 'u');
  assert.equal(finalToViseme('ui'), 'u');
});

test('无拼音库时中文兜底不崩', async () => {
  const syls = await zhSyllables('你好');
  assert.equal(syls.length, 2);
  assert.ok(['a', 'i', 'u', 'e', 'o'].includes(syls[0].viseme));
});

test('英文 G2P 与词典命中', () => {
  setEnDictionary(DICT);
  assert.deepEqual(enPhonemes('hello'), ['HH', 'AH', 'L', 'OW']);
  assert.ok(g2p('stories').length > 0);
  assert.equal(g2p('stories').slice(-2).join(' '), 'IY Z');
  assert.ok(g2p('wanted').slice(-2).join(' ') === 'IH D');
  assert.deepEqual(phonemeSteps('OW')[0].v, 'o');
  assert.equal(phonemeSteps('B')[0].close, true);
});

test('时间轴：帧单调递增且权重在 0~1', async () => {
  const tl = await buildTimeline('你好，world。', { enDict: DICT, speed: 1 });
  assert.ok(tl.frames.length > 4);
  let last = -1;
  for (const f of tl.frames) {
    assert.ok(f.t >= last);
    last = f.t;
    for (const w of f.w) {
      assert.ok(w >= 0 && w <= 1.0001);
    }
  }
  assert.ok(tl.duration > 0.3);
});

test('语速越快时间轴越短', () => {
  const units = [
    { type: 'zh', viseme: 'a', close: false },
    { type: 'zh', viseme: 'i', close: false },
  ];
  const slow = scheduleUnits(units, { speed: 0.6 });
  const fast = scheduleUnits(units, { speed: 1.6 });
  assert.ok(fast.duration < slow.duration);
});

test('契约：老内核 / 全量 / 子集 / 仅开合 / 不支持', () => {
  assert.equal(probeLipSync(null).supported, false);
  assert.equal(probeLipSync({}).supported, false);

  const full = {
    getLipSyncInfo: () => ({ supported: true, version: 1, visemes: ['a', 'i', 'u', 'e', 'o', 'close'] }),
    lipSyncBegin() {},
    lipSyncPush() {},
    lipSyncPlay() {},
  };
  const caps = probeLipSync(full);
  assert.equal(caps.supported, true);
  assert.equal(caps.mode, 'frames');

  const subset = probeLipSync({
    getLipSyncInfo: () => ({ supported: true, visemes: ['i', 'o'] }),
    lipSyncBegin() {},
    lipSyncPush() {},
    lipSyncPlay() {},
  });
  const adapter = createVisemeAdapter(subset);
  const mapped = adapter.map([1, 0, 0, 0, 0]);
  assert.equal(mapped.o, 1);
  assert.equal(mapped.i, 0);

  const openOnly = probeLipSync({ getLipSyncInfo: () => ({ supported: true, visemes: ['open'] }), setMouth() {} });
  assert.equal(openOnly.mode, 'mouth');
  assert.deepEqual(createVisemeAdapter(openOnly).map([0.2, 0.3, 0, 0, 0]), { open: 0.5 });
});

test('时钟：流式模式推帧并收尾', async () => {
  const calls = [];
  const fakePet = {
    getLipSyncInfo: () => ({ supported: true, version: 1, visemes: ['a', 'i', 'u', 'e', 'o'] }),
    lipSyncBegin: (p) => calls.push(['begin', p.id]),
    lipSyncPush: (p) => calls.push(['push', p.frames.length]),
    lipSyncPlay: () => calls.push(['play']),
    lipSyncEnd: () => calls.push(['end']),
    lipSyncStop: () => calls.push(['stop']),
  };
  const engine = createLipSyncEngine({
    getPet: () => fakePet,
    getSettings: () => ({ lipSyncMode: 'stream', lipSyncIntensity: 0.9, ttsSpeed: 1 }),
  });
  engine.attach(fakePet);
  engine.beginReply();
  engine.feedText('你好。');
  engine.endReply();
  await new Promise((r) => setTimeout(r, 30));
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('begin'));
  assert.ok(names.includes('play'));
  assert.ok(names.includes('push'));
  assert.ok(names.includes('end'));
});

test('时钟：语音模式预装、播放、校准、停止', async () => {
  const calls = [];
  const fakePet = {
    getLipSyncInfo: () => ({ supported: true, version: 1, visemes: ['a', 'i', 'u', 'e', 'o'] }),
    lipSyncBegin: () => calls.push('begin'),
    lipSyncPush: () => calls.push('push'),
    lipSyncPlay: () => calls.push('play'),
    lipSyncSeek: () => calls.push('seek'),
    lipSyncPause: () => calls.push('pause'),
    lipSyncResume: () => calls.push('resume'),
    lipSyncStop: () => calls.push('stop'),
  };
  const engine = createLipSyncEngine({
    getPet: () => fakePet,
    getSettings: () => ({ lipSyncMode: 'voice', lipSyncIntensity: 0.9, ttsSpeed: 1 }),
  });
  engine.attach(fakePet);
  assert.equal(await engine.beginVoice('你好。'), true);
  engine.voicePlay('web');
  engine.voiceBoundary(3, 4);
  engine.voicePause();
  engine.voiceResume();
  engine.voiceStop();
  assert.ok(calls.includes('begin'));
  assert.ok(calls.includes('play'));
  assert.ok(calls.includes('pause'));
  assert.ok(calls.includes('resume'));
  assert.ok(calls.includes('stop'));
});

test('时钟：内核不支持时完全静默', async () => {
  const engine = createLipSyncEngine({
    getPet: () => ({}),
    getSettings: () => ({ lipSyncMode: 'stream' }),
  });
  engine.attach({});
  engine.beginReply();
  engine.feedText('你好。');
  await engine.beginVoice('你好。');
  engine.endReply();
  engine.stop();
  assert.equal(engine.getState().supported, false);
});
