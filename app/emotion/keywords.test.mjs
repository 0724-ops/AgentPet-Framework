// 关键词直通单测：node --test app/emotion/keywords.test.mjs
// app/emotion 下是 ES module，但目录里没有 package.json；
// 这里用 data URL 导入，和 app/renderer/*.test.mjs 保持一致。
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('./classify.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { matchKeywords } = mod;

const table = JSON.parse(fs.readFileSync(new URL('./keywords.json', import.meta.url), 'utf8'));

test('同一类里取命中的最长词', () => {
  const hits = matchKeywords({ praise: ['开心', '好开心'] }, '今天好开心');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, '好开心');
});

test('一句话可以命中多类，但不超过 maxHits', () => {
  const hits = matchKeywords(table, '有点烦，但还是想抱抱', 2);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['cold', 'hug']);
});

test('maxHits 缺省或非法时至少返回 1 条', () => {
  assert.equal(matchKeywords(table, '有点烦，想抱抱', 0).length, 1);
  assert.equal(matchKeywords(table, '有点烦，想抱抱', 'x').length, 1);
  assert.equal(matchKeywords(table, '有点烦，想抱抱').length, 2);
});

test('没有命中返回空数组', () => {
  assert.deepEqual(matchKeywords(table, '今天天气不错'), []);
  assert.deepEqual(matchKeywords(table, ''), []);
});

test('下划线开头的说明字段不参与匹配', () => {
  const hits = matchKeywords({ _note: '嘴硬', tease: ['嘴硬'] }, '嘴硬');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'tease');
});

test('表结构非法时不抛错', () => {
  assert.deepEqual(matchKeywords(null, '嘴硬'), []);
  assert.deepEqual(matchKeywords({ _note: 'x' }, '嘴硬'), []);
  assert.deepEqual(matchKeywords({ tease: null, praise: '开心' }, '嘴硬'), []);
});

test('关键词强度固定：sim 0.88，intensity 0.94', () => {
  const hits = matchKeywords({ tease: ['嘴硬'] }, '嘴硬');
  assert.equal(hits[0].sim, 0.88);
  assert.equal(hits[0].intensity, 0.94);
});

test('真实词表：嘴硬归到傲娇类，显示命中词', () => {
  const hits = matchKeywords(table, '嘴硬，想陪着你');
  assert.equal(hits[0].kind, 'tease');
  assert.equal(hits[0].text, '嘴硬');
});

test('真实词表：期待归到想念类', () => {
  const hits = matchKeywords(table, '有点期待见到你');
  assert.equal(hits[0].kind, 'miss');
  assert.equal(hits[0].text, '期待');
});

test('真实词表：想笑归到开心类（不再被认成傲娇）', () => {
  const hits = matchKeywords(table, '好奇，忍不住想笑');
  assert.equal(hits[0].kind, 'praise');
  assert.equal(hits[0].text, '想笑');
});
