// ============================================================================
//  伪工具标记解析器（流式）
//
//  模型输出里允许出现两种伪工具标记：
//    <<<SPEAK 台词>>>                 —— 台词：进聊天 + TTS
//    <<<MEM_MARK wrong=M1,M2>>>       —— 记忆反馈：只结算，不给用户看/念
//
//  规则：
//    1. 标记本身永远不会进入聊天正文，也不会进 TTS；
//    2. SPEAK 里的文字按原顺序留在正文里，MEM_MARK 整段丢弃；
//    3. 结束标记是连续 2 个及以上的 '>'：模型经常把 >>> 写成 >>，两种都认；
//    4. 流式解析：标记被任意 chunk 切碎也要能拼回来；末尾未闭合的标记按
//       SPEAK 保留文字、MEM_MARK 丢弃、未知标记原样输出；
//    5. 未知的 <<<FOO ...>>> 不当伪工具，原样当正文；但 `<<<台词>>>` 这种被
//       模型漏掉 SPEAK 的写法按 SPEAK 处理，避免标记漏进聊天。
// ============================================================================

const OPEN = '<<<';
const CLOSE_CHARS = '>';

// 宽松解析 wrong= 后面的记忆编号：wrong=M1,M2 / wrong: M1、M2 / wrong = [M1 M2]
export function parseMemMarks(body) {
  const src = String(body || '');
  const at = src.search(/wrong/i);
  if (at < 0) return [];
  const seg = src.slice(at).replace(/^wrong\s*[=:：]?/i, '');
  const out = [];
  const seen = new Set();
  const re = /M\d+/gi;
  let m;
  while ((m = re.exec(seg))) {
    const id = m[0].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function isMarkerName(name) {
  return name === 'SPEAK' || name === 'MEM_MARK';
}

// 把标记头拆成 { name, body }：body 保留原文，SPEAK 只去掉一个分隔空格。
// 模型偶尔会把台词写成 `<<<台词>>>`（漏掉 SPEAK），这种没有 ASCII 标记名的
// 直接按 SPEAK 处理，否则开头 `<<<` 会整段漏进聊天正文。
function splitInner(inner) {
  const m = /^\s*([A-Za-z_]+)([\s\S]*)$/.exec(inner);
  if (!m) return { name: 'SPEAK', body: inner };
  return { name: m[1].toUpperCase(), body: m[2] };
}

// 找结束标记：连续 2 个及以上的 '>'（>>> 和 >> 都认）。
// 返回 { start, end }；没找到返回 null。流未结束时如果末尾只有单个 '>'，
// 可能只是被 chunk 切开的 '>>' 前半，先等下一块。
// 另外，模型偶尔会整段漏写结束标记：如果先遇到下一个 `<<<`，就把上一个标记
// 在 `<<<` 处隐式收尾（台词里不会再嵌套 `<<<`，这样能避免后续开口泄漏）。
function findClose(src, from, final) {
  for (let i = from; i < src.length; i += 1) {
    if (src.startsWith(OPEN, i)) return { start: i, end: i, implicit: true };
    if (src[i] !== CLOSE_CHARS) continue;
    let j = i;
    while (j < src.length && src[j] === CLOSE_CHARS) j += 1;
    const count = j - i;
    // 流还没结束时，末尾刚好两个 '>' 可能是 '>>>' 的前半，等下一块再判断
    if (j >= src.length && !final && count === 2) return null;
    if (count >= 2) return { start: i, end: j };
    if (j >= src.length && !final) return null;
    i = j - 1;
  }
  return null;
}

export function createPseudoToolParser({ onText, onSpeak, onMemMark } = {}) {
  let buf = '';
  let text = '';
  let speech = '';
  let swallowNewline = false;
  const marks = [];
  const markers = [];

  function emit(chunk, kind) {
    if (!chunk) return;
    text += chunk;
    if (kind === 'speak') speech += chunk;
    if (onText) onText(chunk, kind);
    if (kind === 'speak' && onSpeak) onSpeak(chunk);
  }

  function handle(name, body, raw) {
    if (name === 'SPEAK') {
      // `<<<SPEAK 你好>>>` 去掉标记后面的一个分隔空格，其余原样保留
      const line = body.replace(/^[ \t]/, '');
      markers.push({ name, text: line, raw });
      emit(line, 'speak');
      return;
    }
    if (name === 'MEM_MARK') {
      const wrong = parseMemMarks(body);
      marks.push(...wrong);
      markers.push({ name, wrong, raw });
      // MEM_MARK 后面通常跟一个换行，剥掉，免得聊天框开头多一条空行
      swallowNewline = true;
      if (onMemMark) onMemMark(wrong, body);
    }
  }

  // final=false：尽量吐字，但把可能是半个标记的尾巴留在 buf 里
  // final=true ：流结束，剩余内容一次性处理完
  function pump(final) {
    for (;;) {
      if (swallowNewline) {
        if (!buf.length) {
          if (!final) return;
          swallowNewline = false;
        } else if (buf === '\r' && !final) {
          return; // 等下一个 chunk 的 \n，别把 \r\n 拆成两半
        } else if (buf.startsWith('\r\n')) {
          buf = buf.slice(2);
          swallowNewline = false;
        } else if (buf[0] === '\n') {
          buf = buf.slice(1);
          swallowNewline = false;
        } else {
          swallowNewline = false;
        }
      }
      const open = buf.indexOf(OPEN);
      if (open < 0) {
        if (final) {
          emit(buf, 'plain');
          buf = '';
          return;
        }
        let keep = 0;
        for (let n = Math.min(OPEN.length - 1, buf.length); n > 0; n -= 1) {
          if (OPEN.startsWith(buf.slice(-n))) {
            keep = n;
            break;
          }
        }
        const head = keep ? buf.slice(0, buf.length - keep) : buf;
        emit(head, 'plain');
        buf = keep ? buf.slice(-keep) : '';
        return;
      }
      if (open > 0) {
        emit(buf.slice(0, open), 'plain');
        buf = buf.slice(open);
        continue;
      }

      const close = findClose(buf, OPEN.length, final);
      if (!close) {
        if (!final) return;
        // 流结束时还没闭合：SPEAK 保留台词，MEM_MARK 丢弃，未知标记原样
        const rest = buf;
        const { name, body } = splitInner(rest.slice(OPEN.length));
        if (name === 'SPEAK') {
          const line = body.replace(/^[ \t]/, '');
          handle('SPEAK', line, rest);
        } else if (name === 'MEM_MARK') {
          handle('MEM_MARK', body, rest);
        } else {
          emit(rest, 'plain');
        }
        buf = '';
        return;
      }

      const raw = buf.slice(0, close.end);
      const inner = buf.slice(OPEN.length, close.start).replace(/[ \t]+$/, '');
      const { name, body } = splitInner(inner);
      if (isMarkerName(name)) handle(name, body, raw);
      else emit(raw, 'plain'); // 未知标记：别吞，原样输出
      buf = buf.slice(close.end);
    }
  }

  return {
    feed(chunk) {
      if (chunk == null) return;
      buf += String(chunk);
      pump(false);
    },
    flush() {
      pump(true);
      return { text, speech, marks: [...marks], markers: [...markers] };
    },
    get text() {
      return text;
    },
    get speechText() {
      return speech;
    },
    get marks() {
      return [...marks];
    },
  };
}

// 非流式清洗：把一段已经存在的文本（例如旧版本存下来的聊天记录）按同样规则
// 过一遍，返回 { text, speech, marks }。用于载入历史消息时补做剥离。
// 旧版剥离器只认 >>>，所以历史文本里还可能出现「开口已被吞掉、只剩行尾 >>」
// 的残片；这里顺手把行尾连续的 > 清掉（只用于历史清洗，不影响流式输出）。
export function sanitizePseudoText(source) {
  const p = createPseudoToolParser();
  p.feed(String(source == null ? '' : source));
  const out = p.flush();
  const clean = (s) =>
    String(s || '')
      .replace(/[ \t]*>{2,}(?=\r?\n|$)/g, '')
      .replace(/\s+$/, '');
  return { ...out, text: clean(out.text), speech: clean(out.speech) };
}
