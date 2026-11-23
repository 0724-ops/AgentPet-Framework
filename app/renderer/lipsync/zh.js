// 中文读音 → 口型：词级拼音（pinyin-pro，懒加载）→ 韵母 → 五元音
// pinyin-pro 的浏览器构建由 tools 复制到 renderer/vendor，运行时按需加载。

const FINAL_VISEME = {
  // a 组（张口最大）
  a: 'a', ia: 'a', ua: 'a', ai: 'a', uai: 'a', ao: 'a', iao: 'a', an: 'a',
  uan: 'a', ang: 'a', iang: 'a', uang: 'a', van: 'a',
  // o 组（圆唇）
  o: 'o', uo: 'o', ou: 'o', ong: 'o', iong: 'o', iu: 'o', iou: 'o',
  // e 组（扁唇）
  e: 'e', ei: 'e', ie: 'e', ve: 'e', er: 'e', en: 'e', eng: 'e', ue: 'e',
  // i 组（展唇）
  i: 'i', in: 'i', ing: 'i', ian: 'i',
  // u 组（撮口）
  u: 'u', v: 'u', un: 'u', vn: 'u', ui: 'u',
};

// 复韵母的第二个口型：单给一个主元音会「一下到位」，补上收尾/介音的滑动更像说话
const FINAL_GLIDE = {
  ai: 'i', ei: 'i', ui: 'i',
  ao: 'o', ou: 'u', iu: 'u', iou: 'u', iao: 'o',
  ia: 'a', ie: 'e', ian: 'e', ua: 'a', uo: 'o', uai: 'i', ue: 'e', ve: 'e',
};

// 没有拼音库时的兜底：常用字韵母归类，保证功能不会整段失效
const FALLBACK_FINAL = {
  的: 'e', 一: 'i', 是: 'i', 不: 'u', 了: 'e', 在: 'a', 人: 'e', 有: 'o',
  我: 'o', 他: 'a', 这: 'e', 个: 'e', 们: 'e', 中: 'o', 来: 'a', 上: 'a',
  大: 'a', 为: 'e', 和: 'e', 国: 'o', 地: 'i', 到: 'a', 以: 'i', 说: 'o',
  时: 'i', 要: 'a', 就: 'o', 出: 'u', 会: 'u', 可: 'e', 也: 'e', 你: 'i',
  对: 'u', 生: 'e', 能: 'e', 而: 'e', 子: 'i', 那: 'a', 得: 'e', 于: 'u',
  着: 'e', 下: 'a', 自: 'i', 之: 'i', 年: 'i', 过: 'o', 发: 'a', 后: 'o',
  作: 'o', 里: 'i', 用: 'o', 道: 'a', 行: 'i', 所: 'o', 然: 'a', 家: 'a',
  种: 'o', 事: 'i', 成: 'e', 方: 'a', 多: 'o', 经: 'i', 么: 'e', 去: 'u',
  法: 'a', 学: 'e', 如: 'u', 都: 'o', 同: 'o', 现: 'i', 当: 'a', 没: 'e',
  动: 'o', 面: 'i', 起: 'i', 看: 'a', 定: 'i', 天: 'i', 分: 'e', 还: 'a',
  进: 'i', 好: 'a', 小: 'a', 部: 'u', 其: 'i', 些: 'e', 主: 'u', 样: 'a',
  理: 'i', 心: 'i', 她: 'a', 本: 'e', 前: 'i', 开: 'a', 但: 'a', 因: 'i',
  只: 'i', 从: 'o', 想: 'a', 实: 'i', 日: 'i', 军: 'u', 者: 'e', 意: 'i',
  无: 'u', 力: 'i', 它: 'a', 与: 'u', 长: 'a', 把: 'a', 机: 'i', 十: 'i',
  民: 'i', 第: 'i', 公: 'o', 此: 'i', 已: 'i', 工: 'o', 使: 'i', 情: 'i',
  明: 'i', 性: 'i', 知: 'i', 全: 'a', 三: 'a', 又: 'o', 关: 'a', 点: 'i',
  正: 'e', 业: 'e', 外: 'a', 将: 'a', 两: 'a', 高: 'a', 间: 'i', 由: 'o',
  问: 'e', 很: 'e', 最: 'u', 重: 'o', 并: 'i', 物: 'u', 手: 'o', 应: 'i',
  向: 'a', 头: 'o', 文: 'e', 体: 'i', 政: 'e', 美: 'e', 相: 'a', 见: 'i',
  被: 'e', 利: 'i', 什: 'e', 二: 'e', 等: 'e', 产: 'a', 或: 'o', 新: 'i',
  己: 'i', 制: 'i', 身: 'e', 果: 'o', 加: 'a', 西: 'i', 斯: 'i', 月: 'e',
  话: 'a', 合: 'e', 回: 'u', 特: 'e', 代: 'a', 内: 'e', 信: 'i', 表: 'a',
  化: 'a', 老: 'a', 给: 'i', 世: 'i', 位: 'e', 次: 'i', 度: 'u', 门: 'e',
  任: 'e', 常: 'a', 先: 'i', 海: 'a', 通: 'o', 教: 'a', 儿: 'e', 原: 'a',
  东: 'o', 声: 'e', 提: 'i', 立: 'i', 及: 'i', 比: 'i', 员: 'a', 解: 'e',
  水: 'u', 名: 'i', 真: 'e', 论: 'u', 处: 'u', 走: 'o', 义: 'i', 各: 'e',
  入: 'u', 几: 'i', 口: 'o', 认: 'e', 条: 'a', 平: 'i', 系: 'i', 气: 'i',
  题: 'i', 活: 'o', 尔: 'e', 更: 'e', 别: 'e', 打: 'a', 女: 'u', 变: 'i',
  四: 'i', 神: 'e', 总: 'o', 何: 'e', 电: 'i', 数: 'u', 安: 'a', 少: 'a',
  报: 'a', 才: 'a', 结: 'e', 反: 'a', 受: 'o', 目: 'u', 太: 'a', 量: 'a',
  再: 'a', 感: 'a', 建: 'i', 务: 'u', 做: 'o', 接: 'e', 必: 'i', 场: 'a',
  件: 'i', 计: 'i', 管: 'a', 期: 'i', 市: 'i', 直: 'i', 德: 'e', 资: 'i',
  命: 'i', 山: 'a', 金: 'i', 指: 'i', 克: 'e', 许: 'u', 统: 'o', 区: 'u',
  保: 'a', 至: 'i', 队: 'u', 形: 'i', 社: 'e', 便: 'i', 空: 'o', 决: 'e',
  治: 'i', 展: 'a', 马: 'a', 科: 'e', 司: 'i', 五: 'u', 基: 'i', 眼: 'i',
  书: 'u', 非: 'e', 则: 'e', 听: 'i', 白: 'a', 却: 'e', 界: 'e', 达: 'a',
  光: 'a', 放: 'a', 强: 'a', 即: 'i', 像: 'a', 难: 'a', 且: 'e', 权: 'a',
  思: 'i', 王: 'a', 象: 'a', 完: 'a', 设: 'e', 式: 'i', 色: 'e', 路: 'u',
  记: 'i', 南: 'a', 品: 'i', 住: 'u', 告: 'a', 类: 'e', 求: 'o', 据: 'u',
  程: 'e', 北: 'e', 边: 'i', 死: 'i', 张: 'a', 该: 'a', 交: 'a', 规: 'u',
  万: 'a', 取: 'u', 拉: 'a', 格: 'e', 望: 'a', 觉: 'e', 领: 'i', 共: 'o',
  确: 'e', 传: 'a', 师: 'i', 观: 'a', 清: 'i', 今: 'i', 切: 'e', 院: 'a',
  让: 'a', 识: 'i', 候: 'o', 带: 'a', 导: 'a', 争: 'e', 运: 'u', 笑: 'a',
  飞: 'e', 风: 'e', 步: 'u', 改: 'a', 收: 'o', 根: 'e', 干: 'a', 造: 'a',
  言: 'i', 联: 'i', 持: 'i', 组: 'u', 每: 'e', 济: 'i', 车: 'e', 亲: 'i',
  极: 'i', 林: 'i', 服: 'u', 快: 'a', 办: 'a', 议: 'i', 往: 'a', 元: 'a',
  英: 'i', 士: 'i', 证: 'e', 近: 'i', 失: 'i', 转: 'a', 夫: 'u', 令: 'i',
  准: 'u', 布: 'u', 始: 'i', 怎: 'e', 呢: 'e', 存: 'u', 未: 'e', 远: 'a',
  叫: 'a', 台: 'a', 单: 'a', 影: 'i', 具: 'u', 罗: 'o', 字: 'i', 爱: 'a',
  击: 'i', 流: 'o', 备: 'e', 兵: 'i', 连: 'i', 调: 'a', 深: 'e', 商: 'a',
  算: 'a', 质: 'i', 团: 'a', 集: 'i', 百: 'a', 需: 'u', 价: 'a', 花: 'a',
  党: 'a', 华: 'a', 城: 'e', 石: 'i', 级: 'i', 整: 'e', 府: 'u', 离: 'i',
  况: 'a', 亚: 'a', 请: 'i', 技: 'i', 际: 'i', 约: 'e', 示: 'i', 复: 'u',
  病: 'i', 息: 'i', 究: 'o', 线: 'i', 似: 'i', 官: 'a', 火: 'o', 断: 'a',
  精: 'i', 满: 'a', 支: 'i', 视: 'i', 消: 'a', 越: 'e', 器: 'i', 容: 'o',
  照: 'a', 须: 'u', 九: 'o', 增: 'e', 研: 'a', 写: 'e', 称: 'e', 企: 'i',
  八: 'a', 功: 'o', 吗: 'a', 包: 'a', 片: 'i', 史: 'i', 委: 'e', 乎: 'u',
  查: 'a', 轻: 'i', 易: 'i', 早: 'a', 曾: 'e', 除: 'u', 农: 'o', 找: 'a',
  装: 'a', 广: 'a', 昨: 'o', 谢: 'e', 睡: 'u', 觉: 'e', 吃: 'i', 饭: 'a',
  喝: 'e', 茶: 'a', 好: 'a', 累: 'e', 忙: 'a', 闲: 'i', 开: 'a', 心: 'i',
  高: 'a', 兴: 'i', 难: 'a', 过: 'o', 没: 'e', 事: 'i', 别: 'e', 担: 'a',
  心: 'i', 一: 'i', 定: 'i', 会: 'u', 加: 'a', 油: 'o', 晚: 'a', 安: 'a',
  再: 'a', 见: 'i', 明: 'i', 天: 'i', 见: 'i', 拜: 'a', 拜: 'a',
};

let pinyinLib = null;
let pinyinLoading = null;

// 懒加载 pinyin-pro：只在第一次需要中文口型时拉一次 325KB 的浏览器构建
export function loadPinyin() {
  if (pinyinLib) return Promise.resolve(pinyinLib);
  if (pinyinLoading) return pinyinLoading;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(null);
  }
  if (window.pinyinPro && typeof window.pinyinPro.pinyin === 'function') {
    pinyinLib = window.pinyinPro;
    return Promise.resolve(pinyinLib);
  }
  pinyinLoading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/pinyin-pro/index.js', import.meta.url).href;
    script.onload = () => {
      pinyinLib = window.pinyinPro && typeof window.pinyinPro.pinyin === 'function' ? window.pinyinPro : null;
      pinyinLoading = null;
      resolve(pinyinLib);
    };
    script.onerror = () => {
      pinyinLoading = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return pinyinLoading;
}

// 韵母 → 口型；ü 统一写成 v 再查表
export function finalToViseme(final) {
  let f = String(final || '')
    .toLowerCase()
    .replace(/ü/g, 'v')
    .replace(/[1-5]/g, '')
    .trim();
  if (!f) return 'close';
  if (FINAL_VISEME[f]) return FINAL_VISEME[f];
  if (/^(a|ia|ua|ai|uai|ao|iao|an|uan|ang|iang|uang|van)/.test(f)) return 'a';
  if (/^(o|uo|ou|ong|iong|iu)/.test(f)) return 'o';
  if (/^(e|ei|ie|ve|er|en|eng|ue)/.test(f)) return 'e';
  if (/^(i|in|ing|ian)/.test(f)) return 'i';
  if (/^(u|v|un|vn|ui)/.test(f)) return 'u';
  return 'a';
}

// 韵母的收尾口型（无滑动时返回空串）
export function finalGlide(final) {
  const f = String(final || '')
    .toLowerCase()
    .replace(/ü/g, 'v')
    .replace(/[1-5]/g, '')
    .trim();
  return FINAL_GLIDE[f] || '';
}

// 中文段 → 音节列表：[{ char, initial, final, viseme, glide, close }]
export async function zhSyllables(text) {
  const chars = Array.from(String(text || ''));
  const lib = await loadPinyin();
  if (!lib || typeof lib.pinyin !== 'function') {
    return chars
      .filter((ch) => /[\u3400-\u9fff]/.test(ch))
      .map((ch) => {
        const f = FALLBACK_FINAL[ch] || 'a';
        return { char: ch, initial: '', final: f, viseme: finalToViseme(f), glide: finalGlide(f), close: false };
      });
  }
  let finals = [];
  let initials = [];
  try {
    finals = lib.pinyin(text, { pattern: 'final', toneType: 'none', type: 'array', nonZh: 'consecutive' });
    initials = lib.pinyin(text, { pattern: 'initial', toneType: 'none', type: 'array', nonZh: 'consecutive' });
  } catch (_) {
    finals = [];
    initials = [];
  }
  const out = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (!/[\u3400-\u9fff]/.test(ch)) continue;
    const final = finals[i] || FALLBACK_FINAL[ch] || 'a';
    const initial = initials[i] || '';
    out.push({
      char: ch,
      initial,
      final,
      viseme: finalToViseme(final),
      glide: finalGlide(final),
      // b / p / m 起音先闭一下唇，口型更有「说话感」
      close: /^[bpm]$/i.test(initial),
    });
  }
  return out;
}
