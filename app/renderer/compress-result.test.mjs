// 压缩 JSON 解析测试：node --test app/renderer/compress-result.test.mjs
// app/renderer 下是 ES module，但 app/package.json 没写 type=module；
// 这里用 data URL 导入，和 pseudo-tools.test.mjs 保持一致。
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('./compress-result.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { parseCompressResult } = mod;

test('标准 JSON：summary + facts 原样返回', () => {
  const r = parseCompressResult(
    '{"summary":"博士想喝冰咖啡。","facts":[{"subject":"user","relation":"preference","object":"咖啡","fact":"喜欢冰美式","polarity":"positive","truth":1,"source":"我喜欢喝冰美式"}]}'
  );
  assert.equal(r.summary, '博士想喝冰咖啡。');
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].fact, '喜欢冰美式');
});

test('Markdown 代码块 + 前后说明也能解析', () => {
  const r = parseCompressResult(
    '好的，整理如下：\n```json\n{"summary":"剧情推进","facts":[]}\n```\n以上。'
  );
  assert.equal(r.summary, '剧情推进');
  assert.deepEqual(r.facts, []);
});

test('JSON 前后有多余文字时截取第一个完整对象', () => {
  const r = parseCompressResult('（说明文字）{"summary":"异步写入","facts":[{"fact":"x"}]} 谢谢');
  assert.equal(r.summary, '异步写入');
  assert.equal(r.facts.length, 1);
});

test('skip=true 与纯文本 SKIP 都表示无需压缩', () => {
  assert.deepEqual(parseCompressResult('{"skip":true}'), { skip: true });
  assert.deepEqual(parseCompressResult('SKIP'), { skip: true });
  assert.deepEqual(parseCompressResult('skip\n原因：全是寒暄'), { skip: true });
});

test('facts 不是数组时回退为空数组', () => {
  const r = parseCompressResult('{"summary":"只有摘要","facts":null}');
  assert.deepEqual(r.facts, []);
});

test('没有 summary 时返回空字符串（由调用方决定是否中止）', () => {
  const r = parseCompressResult('{"facts":[]}');
  assert.equal(r.summary, '');
});

test('空响应 / 没有 JSON / 坏 JSON 都抛出可读错误', () => {
  assert.throws(() => parseCompressResult('   '), /没有返回内容/);
  assert.throws(() => parseCompressResult('我不知道该怎么压缩'), /没有 JSON 对象/);
  assert.throws(() => parseCompressResult('{"summary": "缺右括号"'), /没有 JSON 对象/);
  assert.throws(() => parseCompressResult('{"summary": 坏}'), /JSON 解析失败/);
});
