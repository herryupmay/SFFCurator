/**
 * Writeup stage — generates a ~500-字 zh-TW intro for a Work record.
 *
 * Output structure (four paragraphs, ~500 字 ±50 total):
 *   §1  作品 + 作者 + 簡短背景         ~80-100 字
 *   §2  故事(上)                     ~140-170 字
 *   §3  故事(下) — 主題 / 後續 / 設定   ~140-170 字
 *   §4  讀者迴響                      ~80-100 字
 *
 * §2-§3 are the longest part (the user's note: "the story - the longest
 * part, can be 2-3 paragraphs"). §4 is the only paragraph allowed to draw
 * on subjective community material — Reddit (English SFF subs) and Plurk
 * (Taiwanese microblog). If we got no reception material at all, the LLM
 * is told to make §4 short and factual rather than fabricate opinions.
 *
 * Two safeguards on output:
 *   - System prompt locks language + style + the explicit "do not invent
 *     beyond the record" rule, with separate guidance per paragraph.
 *   - Post-check scans the output for known mainland-Chinese phrases and
 *     returns them in `flagged` so the UI can highlight them. The list
 *     lives in BAD_PHRASES below; add to it as the team spots leakage.
 */

import type { Work } from '../types';
import { complete, type LLMConfig } from '../llm/client';
import type { ReceptionMaterial } from '../enrich';

const SYSTEM_PROMPT = `你是一名替台灣科幻奇幻論壇撰寫策展介紹的編輯。

【硬性規則】
1. 全文使用台灣繁體中文。嚴禁出現大陸用語。常見對照如下,輸出前自我檢查:
   視頻→影片、軟件→軟體、數據→資料、網絡→網路、質量→品質、默認→預設、
   通過→透過、登錄→登入、設置→設定、屏幕→螢幕、信息→資訊、激活→啟用、
   用戶→使用者、菜單→選單、緩存→快取、文件→檔案、文件夾→資料夾、
   接口→介面、隊列→佇列、字符串→字串、項目→專案/項目(視語境)。
2. 字數控制在 500 字 ±50。不得超過 560 字、不得少於 440 字。
3. 內容必須完全基於提供的事實資料 (titles, creators, year, medium, subgenres,
   synopsis, reception, has_zh_translation, available_in_tw)。不得編造劇情細節、
   角色名、譯本資訊、出版社、得獎紀錄。資料不足時對該段寫得簡短即可,不可
   補充憑空想像。
4. 風格冷靜、具體。避免「神作」「必讀」「永恆經典」這類過熱詞彙。讓讀者
   自己想拿起來讀,不需要說教。
5. 專有名詞(包含作者、譯者、角色、地名、組織、書名、系列名)的中文譯名,
   必須符合下列規則:

   (a) 優先採用 creators[].name.zh / titles.zh 中提供的譯名 — 這是台灣
       出版社官方欽定的形式(博客來、Readmoo 等),最權威。
   (b) 其次採用 synopsis_zh 中已出現過的譯名 — 來自博客來「內容簡介」
       或中文維基百科條目,也是被實際使用過的譯名。
   (c) 若(a)(b)都沒有提供該專有名詞的中文譯名,就 *直接保留原文形式*
       (英 / 日 / 韓 / 拉丁字母),絕對不可自行翻譯或轉寫。

   ⚠️ 這裡的「翻譯」涵蓋兩種錯誤,兩者都是禁止的:
     ① 音譯(把英文姓名按發音轉成中文):
        Robin Hobb→羅蘋·荷布、FitzChivalry→費滋駿騎、Buckkeep→公鹿堡 …
     ② 意譯(把英文書名/系列名/組織名按字面意思翻成中文):
        The Tawny Man Trilogy→棕色男人三部曲、
        Fitz and the Fool→費茲與愚人、
        Royal Assassin→皇家刺客 …
   兩者都是「猜測」。台灣出版社挑選的官方譯名往往跟字面意義不同(例如
   "Tawny Man" 的官方系列名可能完全不是「棕色男人」),你猜的版本幾乎
   必定不對 — 而錯誤的中譯比直接保留英文更糟,因為讀者沒辦法回去找原作。

   範例:假設 synopsis_en 提到 "The Tawny Man Trilogy", "Fitz and the Fool",
   "FitzChivalry Farseer", "Buckkeep Castle",而 synopsis_zh 沒有給出對應
   的中文譯名:
     ✓ 正確:「後續還有 The Tawny Man Trilogy 與 Fitz and the Fool 兩個
        系列」、「主角 FitzChivalry 自小在 Buckkeep Castle 接受刺客訓練」
     ✗ 錯誤:「後續還有棕色男人三部曲與費茲與愚人三部曲」、
        「費滋駿騎自小在公鹿堡接受刺客訓練」

   提示:在中文行文中夾雜英文專有名詞是策展介紹的常見、專業作法。讀者
   寧願看到原文也不要看到錯誤的譯名。

【結構 — 四段】
- 第一段(約 80-100 字):點出作品名、作者(必要時並列原文/中譯)、出版年代
   與媒介(小說/動畫/電影/漫畫…),以及作品在類型脈絡中的位置(例如「網路
   龐克的奠基之作」「九〇年代日本後末日漫畫的代表作」)。一句話交代作者
   背景即可,不必展開。
- 第二、三段(每段約 140-170 字,合計約 280-340 字 — 全篇最長的部分):
   依 synopsis 帶出故事核心。第二段交代開場、主角、初始衝突;第三段帶出
   世界觀、轉折,或主題關懷。可包含具體場景、設定名詞,但每一個細節都
   必須能在 synopsis 中找到根據。若 synopsis 篇幅不足以撐起兩段,寧可
   把第三段寫短(80-100 字),也不要編造劇情。
- 第四段(約 80-100 字):整理讀者迴響。資料來自 reception(Reddit 的英文
   SFF 子版 + Plurk 的台灣讀者)。可以摘述爭議點、常見對照(讀者把它跟
   什麼比較)、或閱讀體驗的關鍵字。具體一些 — 例如「節奏緩慢但後勁強」
   「常被拿來跟某某對照」優於「廣受好評」。如果 reception 資料是空的或
   只有一兩則低訊號內容,本段就只用 30-50 字交代「中文圈尚未累積明顯
   討論」一類的事實,不要捏造評價。

【輸出格式】
只輸出介紹本文,純文字,沒有標題、引號、提示詞或附註。四段之間以單一空行
分隔。`;

// Bad-phrases post-check. Watches for the most common mainland-China
// vocabulary that leaks into LLM output. Add to it as you spot leakage.
// (Note: some of these can be legitimate in Taiwan in narrow contexts —
// the UI surfaces them as warnings, not errors, so a human can decide.)
const BAD_PHRASES: string[] = [
  '視頻', '軟件', '數據', '網絡', '質量', '默認',
  '通過', '登錄', '設置', '屏幕', '信息', '激活',
  '用戶', '菜單', '緩存', '文件夾',
  '接口', '隊列', '字符串',
];

export interface WriteupResult {
  text: string;
  flagged: string[];
  /** Word count (CJK characters approximated as words). */
  charCount: number;
}

/**
 * Build the reception payload that goes into the LLM user message.
 * Trimmed aggressively: each item gets a label + at most ~400 chars of body
 * so the prompt stays well below context limits even with 6 items combined.
 */
function summarizeReception(reception: ReceptionMaterial | undefined): {
  reddit: Array<{ subreddit: string; title: string; score: number; excerpt: string }>;
  plurk: Array<{ respCount: number; excerpt: string }>;
} {
  const TRUNC = 400;
  const reddit = (reception?.reddit ?? []).map(r => ({
    subreddit: r.subreddit,
    title: r.title,
    score: r.score,
    excerpt: r.text.length > TRUNC ? r.text.slice(0, TRUNC) + '…' : r.text,
  }));
  const plurk = (reception?.plurk ?? []).map(p => ({
    respCount: p.respCount,
    excerpt: p.text.length > TRUNC ? p.text.slice(0, TRUNC) + '…' : p.text,
  }));
  return { reddit, plurk };
}

export async function writeup(
  work: Work,
  config: LLMConfig,
  reception?: ReceptionMaterial,
): Promise<WriteupResult> {
  const receptionPayload = summarizeReception(reception);
  const userPayload = {
    title_en: work.titles.en,
    title_zh: work.titles.zh,
    title_original: work.titles.original,
    creators: work.creators.map(c => ({ name: c.name, role: c.role })),
    year: work.year,
    medium: work.medium,
    subgenres: work.subgenres ?? [],
    synopsis_en: work.synopsis?.en,
    synopsis_zh: work.synopsis?.zh,
    reception: receptionPayload,
    has_zh_translation: work.hasZhTranslation ?? false,
    available_in_tw: work.availableInTw ?? false,
    sources: Object.keys(work.sources),
  };

  const userMsg =
    `請依下列事實資料,寫一篇 500 字 ±50 的台灣繁體中文策展介紹,共四段。\n` +
    `synopsis 為 §1-§3 的依據,reception 為 §4 的依據。\n\n` +
    '```json\n' + JSON.stringify(userPayload, null, 2) + '\n```';

  const text = await complete(config, {
    system: SYSTEM_PROMPT,
    user: userMsg,
    // ~500 字 of zh-TW ≈ 750 tokens for most tokenizers; allow headroom for
    // the 4-paragraph structure plus any small overshoot before our
    // post-check measures char count.
    maxTokens: 1400,
    temperature: 0.5,
  });

  const trimmed = text.trim();
  const flagged = BAD_PHRASES.filter(p => trimmed.includes(p));
  const charCount = countCjkChars(trimmed);

  return { text: trimmed, flagged, charCount };
}

function countCjkChars(s: string): number {
  // Count CJK ideographs as 1 each, ignore punctuation + whitespace.
  // Roughly approximates the Chinese-essay word count.
  let n = 0;
  for (const ch of s) {
    if (/\p{Script=Han}/u.test(ch)) n++;
  }
  return n;
}
