// ============================================================================
//  压缩结果解析（Step 2）
//
//  压缩模型被要求只输出一个 JSON 对象：
//    {"summary":"...","facts":[{subject,relation,object,fact,polarity,truth,source}]}
//  但实际服务端经常裹 Markdown 代码块、带前后说明，这里做容错。
//  {"skip":true} 或纯文本 SKIP 都表示「这段对话无需压缩」。
// ============================================================================

export function parseCompressResult(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) throw new Error('压缩没有返回内容');
  if (/^SKIP\b/i.test(raw)) return { skip: true };

  const body = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('压缩结果里没有 JSON 对象');

  let data;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new Error(`压缩 JSON 解析失败：${err && err.message ? err.message : err}`);
  }
  if (data && data.skip) return { skip: true };
  return {
    summary: String((data && data.summary) || '').trim(),
    facts: Array.isArray(data && data.facts) ? data.facts : [],
    // 可选：给情感系统做低置信度兜底，缺失时为空串
    emotion: String((data && data.emotion) || '').trim(),
  };
}
