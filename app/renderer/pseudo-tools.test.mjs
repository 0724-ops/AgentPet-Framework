// 伪工具剥离器测试：node --test app/renderer/pseudo-tools.test.mjs
// app/renderer 下是 ES module，但 app/package.json 没写 type=module；
// 这里用 data URL 导入，避免为了测试去改 Electron 的模块类型。
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('./pseudo-tools.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { createPseudoToolParser, parseMemMarks, sanitizePseudoText } = mod;

function parseAll(chunks) {
  const out = { text: '', speech: '', marks: [], seen: [] };
  const p = createPseudoToolParser({
    onText: (t, kind) => out.seen.push([kind, t]),
    onMemMark: (wrong) => out.marks.push(...wrong),
  });
  chunks.forEach((c) => p.feed(c));
  const done = p.flush();
  out.text = done.text;
  out.speech = done.speech;
  return out;
}

test('SPEAK 标记只留台词', () => {
  const r = parseAll(['<<<SPEAK 博士你好>>>']);
  assert.equal(r.text, '博士你好');
  assert.equal(r.speech, '博士你好');
});

test('模型漏掉 SPEAK、直接写 <<<台词>>> 也能剥离', () => {
  const r = parseAll(['<<<中午好。 >>>\n<<<都这个点了，饭吃了没？ >>>']);
  assert.equal(r.text, '中午好。\n都这个点了，饭吃了没？');
  assert.equal(r.speech, '中午好。都这个点了，饭吃了没？');
});

test('漏掉 SPEAK 的台词被任意位置切开也能拼回', () => {
  const raw = '<<<土豆丝炒肉可以换成清淡点的，土豆烧肉留下。 >>>';
  const expect = parseAll([raw]);
  for (let i = 0; i <= raw.length; i += 1) {
    const r = parseAll([raw.slice(0, i), raw.slice(i)]);
    assert.equal(r.text, expect.text, `split at ${i}`);
    assert.equal(r.speech, expect.speech, `split at ${i}`);
  }
});

test('模型连续多段 SPEAK 都漏写结束标记时，不泄漏标记', () => {
  const raw =
    '<<<SPEAK 记得。土豆烧肉是你的偏爱，土豆丝炒肉和辣椒炒肉那两样我没动，还挂着没定。\n' +
    '<<<SPEAK 早餐一直是煎饼果子，配的一直空着，这点也没变。\n' +
    '<<<SPEAK 不过我猜你问的不是这些——是想说记忆那事儿？';
  const r = parseAll([raw]);
  assert.ok(!r.text.includes('<<<'), '正文里不能出现漏出的标记');
  assert.equal(
    r.text,
    '记得。土豆烧肉是你的偏爱，土豆丝炒肉和辣椒炒肉那两样我没动，还挂着没定。\n' +
      '早餐一直是煎饼果子，配的一直空着，这点也没变。\n' +
      '不过我猜你问的不是这些——是想说记忆那事儿？',
  );
  const perChar = parseAll([...raw]);
  assert.equal(perChar.text, r.text);
  assert.ok(!perChar.text.includes('<<<'));
});

test('前一个标记漏写结尾时，遇到下一个 <<< 自动收尾', () => {
  const r = parseAll(['<<<MEM_MARK wrong=M1\n<<<SPEAK 我在。>>>']);
  assert.deepEqual(r.marks, ['M1']);
  assert.equal(r.text, '我在。');
});

test('MEM_MARK 整段丢弃，不进入正文/朗读', () => {
  const r = parseAll(['<<<MEM_MARK wrong=M1,M2>>>\n<<<SPEAK 我在。>>>']);
  assert.equal(r.text, '我在。');
  assert.equal(r.speech, '我在。');
  assert.deepEqual(r.marks, ['M1', 'M2']);
});

test('多段台词按顺序保留，标记外的旁白也保留', () => {
  const r = parseAll(['（点头）\n<<<SPEAK 早上好>>>\n<<<SPEAK 今天做什么>>>']);
  assert.equal(r.text, '（点头）\n早上好\n今天做什么');
  assert.equal(r.speech, '早上好今天做什么');
});

test('任意位置切 chunk 都能拼回同样的结果', () => {
  const raw = '<<<MEM_MARK wrong=M3>>>好的，<<<SPEAK 博士，咖啡要冰的吗？>>>\n<<<SPEAK 我记得你喜欢冰美式。>>>';
  const expect = parseAll([raw]);
  for (let i = 0; i <= raw.length; i += 1) {
    const r = parseAll([raw.slice(0, i), raw.slice(i)]);
    assert.equal(r.text, expect.text, `split at ${i}`);
    assert.equal(r.speech, expect.speech, `split at ${i}`);
    assert.deepEqual(r.marks, expect.marks, `split at ${i}`);
  }
  const perChar = parseAll([...raw]);
  assert.equal(perChar.text, expect.text);
  assert.equal(perChar.speech, expect.speech);
  assert.deepEqual(perChar.marks, expect.marks);
});

test('流式过程中不会把半个标记漏进正文', () => {
  const seen = [];
  const q = createPseudoToolParser({ onText: (t) => seen.push(t) });
  ['Hi', '<<<SP', 'EAK 你', '好>>>', '再见'].forEach((c) => q.feed(c));
  q.flush();
  assert.equal(seen.join(''), 'Hi你好再见');
});

test('未闭合的 SPEAK 保留文字，未闭合的 MEM_MARK 丢弃', () => {
  const speak = parseAll(['<<<SPEAK 还没说完']);
  assert.equal(speak.text, '还没说完');
  const mark = parseAll(['<<<MEM_MARK wrong=M9']);
  assert.equal(mark.text, '');
  assert.deepEqual(mark.marks, ['M9']);
});

test('未知标记原样保留，不吞正文', () => {
  const r = parseAll(['<<<FOO 123>>>正常文字']);
  assert.equal(r.text, '<<<FOO 123>>>正常文字');
  assert.equal(r.speech, '');
});

test('模型把 >>> 写成 >> 也能剥离（多段台词）', () => {
  const raw =
    '<<<SPEAK 咦？不吃了？ >>\n' +
    '<<<SPEAK 我还以为煎饼果子是你雷打不动的那一份呢。 >>\n' +
    '<<<SPEAK 那明天想换什么？ >>';
  const r = parseAll([raw]);
  assert.equal(r.text, '咦？不吃了？\n我还以为煎饼果子是你雷打不动的那一份呢。\n那明天想换什么？');
  assert.equal(r.speech, '咦？不吃了？我还以为煎饼果子是你雷打不动的那一份呢。那明天想换什么？');
});

test('结束标记 >> 被任意位置切开也能拼回', () => {
  const raw = '<<<MEM_MARK wrong=M1>>\n<<<SPEAK 我在。>>\n<<<SPEAK 你好>>';
  const expect = parseAll([raw]);
  assert.equal(expect.text, '我在。\n你好');
  assert.deepEqual(expect.marks, ['M1']);
  for (let i = 0; i <= raw.length; i += 1) {
    const r = parseAll([raw.slice(0, i), raw.slice(i)]);
    assert.equal(r.text, expect.text, `split at ${i}`);
    assert.deepEqual(r.marks, expect.marks, `split at ${i}`);
  }
});

test('台词里的单个 > 不会提前闭合', () => {
  const r = parseAll(['<<<SPEAK 1 > 0，所以你是对的 >>']);
  assert.equal(r.text, '1 > 0，所以你是对的');
  assert.equal(r.speech, '1 > 0，所以你是对的');
});

test('sanitizePseudoText 可清洗旧聊天记录', () => {
  const old = '嗯…… >>\n<<<SPEAK 明天换口味，我记下了。 >>\n<<<MEM_MARK wrong=M2>>';
  const r = sanitizePseudoText(old);
  assert.equal(r.text, '嗯……\n明天换口味，我记下了。');
  assert.equal(r.speech, '明天换口味，我记下了。');
  assert.deepEqual(r.marks, ['M2']);
});

test('sanitizePseudoText 能清掉旧记录里漏掉 SPEAK 的标记', () => {
  const r = sanitizePseudoText('<<<中午好。 >>>\n<<<都这个点了，饭吃了没？ >>>');
  assert.equal(r.text, '中午好。\n都这个点了，饭吃了没？');
  assert.equal(r.speech, '中午好。都这个点了，饭吃了没？');
});

test('parseMemMarks 宽松格式', () => {
  assert.deepEqual(parseMemMarks(' wrong=M1,M2 '), ['M1', 'M2']);
  assert.deepEqual(parseMemMarks(' wrong: m3、M4 '), ['M3', 'M4']);
  assert.deepEqual(parseMemMarks('wrong = [M5 M6]'), ['M5', 'M6']);
  assert.deepEqual(parseMemMarks(''), []);
});
