/**
 * Writeup stage — generates a 200-word zh-TW intro for a Work record.
 *
 * Two safeguards:
 *   - System prompt locks language + style + the explicit "do not invent
 *     beyond the record" rule.
 *   - Post-check scans the output for known mainland-Chinese phrases and
 *     returns them in `flagged` so the UI can highlight them. The list
 *     lives in BAD_PHRASES below; add to it as the team spots leakage.
 */

import type { Work } from '../types';
import { complete, type LLMConfig } from '../llm/client';

const SYSTEM_PROMPT = `你是一名替台灣科幻奇幻論壇撰寫策展介紹的編輯。

【硬性規則】
1. 全文使用台灣繁體中文。嚴禁出現大陸用語。常見對照如下,輸出前自我檢查:
   視頻→影片、軟件→軟體、數據→資料、網絡→網路、質量→品質、默認→預設、
   通過→透過、登錄→登入、設置→設定、屏幕→螢幕、信息→資訊、激活→啟用、
   用戶→使用者、菜單→選單、緩存→快取、文件→檔案、文件夾→資料夾、
   接口→介面、隊列→佇列、字符串→字串、項目→專案/項目(視語境)。
2. 字數控制在 200 字 ±20。不得超過 220 字。
3. 內容必須完全基於提供的事實資料 (titles, creators, year, medium, subgenres,
   synopsis, has_zh_translation, available_in_tw)。不得編造劇情細節、角色名、
   譯本資訊、出版社、得獎紀錄。資料不足時寫得簡短即可,不可補充憑空想像。
4. 風格冷靜、具體。避免「神作」「必讀」「永恆經典」這類過熱詞彙。讓讀者
   自己想拿起來讀,不需要說教。

【結構】
- 第一段(約 70 字):點出作品的時代背景、媒介(小說/動畫/電影...)、核心
   主題或子類型。
- 第二段(約 100 字):基於 synopsis 帶出情節核心或主要設定。如果資料中沒
   有 synopsis,就描述其在策展主題下的位置即可,不可硬編劇情。
- 第三段(可選,約 30 字):一句話交代為何值得放進本期主題。

【輸出格式】
只輸出介紹本文,純文字,沒有標題、引號、提示詞或附註。三段之間以單一空行
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

export async function writeup(work: Work, config: LLMConfig): Promise<WriteupResult> {
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
    has_zh_translation: work.hasZhTranslation ?? false,
    available_in_tw: work.availableInTw ?? false,
    sources: Object.keys(work.sources),
  };

  const userMsg =
    `請依下列事實資料,寫一段 200 字 ±20 的台灣繁體中文介紹:\n\n` +
    '```json\n' + JSON.stringify(userPayload, null, 2) + '\n```';

  const text = await complete(config, {
    system: SYSTEM_PROMPT,
    user: userMsg,
    maxTokens: 600,
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
