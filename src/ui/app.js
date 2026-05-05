// SFF Curator — UI logic
// Bilingual (English default, 中文 toggle), settings persisted to localStorage,
// search hits /api/search, writeup hits /api/writeup, report hits /api/report.

// ---- i18n ----------------------------------------------------------------
const I18N = {
  en: {
    'title': 'SFF Curator',
    'nav.settings': '⚙ Settings',
    'settings.heading': 'Settings',
    'settings.provider.label': 'LLM provider',
    'settings.provider.anthropic': 'Anthropic Claude (recommended)',
    'settings.provider.openai': 'OpenAI / OpenAI-compatible (local llama.cpp, LM Studio, vLLM…)',
    'settings.provider.google': 'Google Gemini',
    'settings.provider.ollama': 'Ollama (local model)',
    'settings.provider.help':
      'Non-Claude models tend to leak mainland-Chinese phrasing. Watch for the yellow flags on writeups.',
    'settings.model.label': 'Model name',
    'settings.model.help':
      "Leave blank to use the provider default. Examples: claude-sonnet-4-5, gpt-4o, gemini-1.5-pro, llama3.",
    'settings.baseUrl.label': 'Base URL (optional — for local / self-hosted LLMs)',
    'settings.baseUrl.help':
      'Only used with the OpenAI provider. Point this at your local server to use llama-cpp-python, LM Studio, vLLM, or any OpenAI-compatible endpoint. Leave blank for the real OpenAI API. ' +
      'For llama-cpp-python: <code>python -m llama_cpp.server --model path/to/model.gguf</code> then enter <code>http://localhost:8000/v1</code>.',
    'settings.llmKey.label': 'LLM API key',
    'settings.llmKey.help':
      'Stored only in your browser. Sent directly to the LLM provider when generating writeups, never to anyone else. For local LLM servers a placeholder like <code>local</code> usually works.',
    'settings.tmdbKey.label': 'TMDB key (optional — for film & TV)',
    'settings.tmdbKey.help':
      'Free, sign up at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a>. ' +
      "Without it, books / anime / manga still work — you just won't get film or TV hits.",
    'settings.excludeAuthors.label': 'Exclude authors (one per line)',
    'settings.excludeAuthors.help':
      "Drop any work whose creator matches one of these names. Case-insensitive, matches across English / Chinese / original-language fields. Useful for authors you've already curated to death or want to avoid for a specific forum theme.",
    'settings.save': 'Save',
    'settings.close': 'Close',
    'settings.saved': 'Saved.',
    'search.label': 'Theme',
    'search.placeholder': 'e.g. steampunk · cyberpunk · cosmic horror · 蒸汽龐克',
    'search.button': 'Search',
    'welcome.line1': '<strong>Type a theme above</strong> to find candidate works.',
    'welcome.line2':
      'Search works without any keys. Add an LLM key in <a href="#" id="welcome-settings-link">Settings</a> to enable the zh-TW writeup step.',
    'footer': 'Runs locally on your PC. Nothing is uploaded to any server.',
    'status.searching': (theme) => `Searching for "${theme}"…`,
    'status.found': (n) => `Found ${n} result${n === 1 ? '' : 's'}.`,
    'status.foundWithErrors': (n, e) => `Found ${n} results (${e} source${e === 1 ? '' : 's'} failed).`,
    'status.error': (msg) => `Error: ${msg}`,
    'status.generatingAll': (i, n) => `Generating writeups… ${i} / ${n}`,
    'status.allDone': (n) => `Generated ${n} writeup${n === 1 ? '' : 's'}.`,
    'errors.heading': (n) => `Source errors (${n})`,
    'medium.book': 'book',
    'medium.film': 'film',
    'medium.tv': 'TV',
    'medium.anime': 'anime',
    'medium.manga': 'manga',
    'medium.comic': 'comic',
    'medium.game': 'game',
    'writeup.button': 'Generate zh-TW intro',
    'writeup.regenerate': 'Regenerate',
    'writeup.copy': 'Copy',
    'writeup.copied': 'Copied!',
    'writeup.generating': 'Generating…',
    'writeup.needKey': 'Add your LLM API key in Settings first.',
    'writeup.charCount': (n) => `${n} 字`,
    'writeup.flagged': (n) => `${n} mainland-CN phrase${n === 1 ? '' : 's'} flagged`,
    'actions.generateAll': 'Generate all writeups',
    'actions.saveReport': 'Save report (.md)',
    'actions.copyReport': 'Copy report',
    'actions.reportCopied': 'Report copied!',
    'flag.no_translation': '未中譯',
    'flag.tw_only': 'TW listing only',
    'flag.single_source': 'single source',
    'flag.low_confidence': 'low confidence',
  },
  zh: {
    'title': 'SFF 策展工具',
    'nav.settings': '⚙ 設定',
    'settings.heading': '設定',
    'settings.provider.label': 'LLM 服務商',
    'settings.provider.anthropic': 'Anthropic Claude（推薦）',
    'settings.provider.openai': 'OpenAI / 相容服務（本機 llama.cpp、LM Studio、vLLM…）',
    'settings.provider.google': 'Google Gemini',
    'settings.provider.ollama': 'Ollama（本機模型）',
    'settings.provider.help':
      '非 Claude 模型較容易混入大陸用語，生成介紹時請留意黃色標記。',
    'settings.model.label': '模型名稱',
    'settings.model.help':
      '留空則使用該服務商的預設模型。範例：claude-sonnet-4-5、gpt-4o、gemini-1.5-pro、llama3。',
    'settings.baseUrl.label': 'Base URL（選填，本機 / 自架 LLM 用）',
    'settings.baseUrl.help':
      '僅在選擇 OpenAI 服務商時使用。指向本機伺服器即可使用 llama-cpp-python、LM Studio、vLLM 或其他相容 OpenAI 的端點。留空則使用真正的 OpenAI API。' +
      'llama-cpp-python 範例：<code>python -m llama_cpp.server --model 路徑/model.gguf</code>，然後填入 <code>http://localhost:8000/v1</code>。',
    'settings.llmKey.label': 'LLM API 金鑰',
    'settings.llmKey.help':
      '只儲存在你的瀏覽器，生成介紹時直接傳給 LLM 服務商，不會傳給其他人。本機 LLM 伺服器填 <code>local</code> 之類的佔位字串即可。',
    'settings.tmdbKey.label': 'TMDB 金鑰（選填，用於電影與影集查詢）',
    'settings.tmdbKey.help':
      '免費註冊：<a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a>。' +
      '沒填也沒關係，書籍 / 動畫 / 漫畫的查詢仍然正常，只是不會出現電影或影集結果。',
    'settings.excludeAuthors.label': '排除作者（每行一位）',
    'settings.excludeAuthors.help':
      '名單中的作者，其作品會自動從結果中移除。不分大小寫，比對英文 / 中文 / 原文姓名。適合用來排除已經介紹過的作者，或避免某個主題不想出現的作者。',
    'settings.save': '儲存',
    'settings.close': '關閉',
    'settings.saved': '已儲存。',
    'search.label': '主題',
    'search.placeholder': '例如：steampunk · 蒸汽龐克 · cosmic horror · 賽博龐克',
    'search.button': '搜尋',
    'welcome.line1': '<strong>在上方輸入主題</strong>以查詢候選作品。',
    'welcome.line2':
      '不填金鑰也可以查詢。若想生成繁體中文介紹草稿，請到 <a href="#" id="welcome-settings-link">設定</a> 填入 LLM 金鑰。',
    'footer': '本機執行，資料不會上傳到任何伺服器。',
    'status.searching': (theme) => `搜尋中：「${theme}」…`,
    'status.found': (n) => `找到 ${n} 筆結果。`,
    'status.foundWithErrors': (n, e) => `找到 ${n} 筆結果（${e} 個來源失敗）。`,
    'status.error': (msg) => `錯誤：${msg}`,
    'status.generatingAll': (i, n) => `生成介紹中… ${i} / ${n}`,
    'status.allDone': (n) => `已生成 ${n} 篇介紹。`,
    'errors.heading': (n) => `來源錯誤（${n}）`,
    'medium.book': '書籍',
    'medium.film': '電影',
    'medium.tv': '影集',
    'medium.anime': '動畫',
    'medium.manga': '漫畫',
    'medium.comic': '漫畫',
    'medium.game': '遊戲',
    'writeup.button': '生成繁中介紹',
    'writeup.regenerate': '重新生成',
    'writeup.copy': '複製',
    'writeup.copied': '已複製！',
    'writeup.generating': '生成中…',
    'writeup.needKey': '請先到「設定」填入 LLM API 金鑰。',
    'writeup.charCount': (n) => `${n} 字`,
    'writeup.flagged': (n) => `偵測到 ${n} 個大陸用語`,
    'actions.generateAll': '全部生成介紹',
    'actions.saveReport': '匯出報告（.md）',
    'actions.copyReport': '複製報告',
    'actions.reportCopied': '報告已複製！',
    'flag.no_translation': '未中譯',
    'flag.tw_only': '僅 TW 上架',
    'flag.single_source': '單一來源',
    'flag.low_confidence': '低信心',
  },
};

const FLAG_LABEL = {
  '未中譯': 'flag.no_translation',
  'tw-listing-only': 'flag.tw_only',
  'single-source': 'flag.single_source',
  'low-confidence': 'flag.low_confidence',
};

const LANG_KEY = 'sff-curator-lang';
let currentLang = localStorage.getItem(LANG_KEY) || 'en';

function t(key, ...args) {
  const v = (I18N[currentLang] && I18N[currentLang][key]) ?? I18N.en[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

function applyLang() {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-TW' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.innerHTML = t(key);
  });
  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.getAttribute('data-i18n-attr').split(';').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  document.getElementById('lang-toggle').textContent =
    currentLang === 'en' ? '中文' : 'English';

  const wsl = document.getElementById('welcome-settings-link');
  if (wsl) wsl.addEventListener('click', e => {
    e.preventDefault();
    settingsPanel.classList.add('open');
    settingsPanel.scrollIntoView({ behavior: 'smooth' });
  });

  if (lastWorks.length) renderResults(lastWorks, lastErrors);
}

document.getElementById('lang-toggle').addEventListener('click', () => {
  currentLang = currentLang === 'en' ? 'zh' : 'en';
  localStorage.setItem(LANG_KEY, currentLang);
  applyLang();
});

// ---- Settings ------------------------------------------------------------
const SETTINGS_KEY = 'sff-curator-settings';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const settingsPanel = document.getElementById('settings-panel');
const settingsLink = document.getElementById('settings-link');
const settingsSave = document.getElementById('settings-save');
const settingsClose = document.getElementById('settings-close');

const fields = {
  llmProvider: document.getElementById('llm-provider'),
  llmModel: document.getElementById('llm-model'),
  llmBaseUrl: document.getElementById('llm-base-url'),
  llmKey: document.getElementById('llm-key'),
  tmdbKey: document.getElementById('tmdb-key'),
  excludeAuthors: document.getElementById('exclude-authors'),
};

function applySettingsToForm() {
  const s = loadSettings();
  fields.llmProvider.value = s.llmProvider || 'anthropic';
  fields.llmModel.value = s.llmModel || '';
  fields.llmBaseUrl.value = s.llmBaseUrl || '';
  fields.llmKey.value = s.llmKey || '';
  fields.tmdbKey.value = s.tmdbKey || '';
  // excludeAuthors is stored as an array; the textarea shows one per line.
  const ex = Array.isArray(s.excludeAuthors) ? s.excludeAuthors : [];
  fields.excludeAuthors.value = ex.join('\n');
}
applySettingsToForm();

settingsLink.addEventListener('click', e => {
  e.preventDefault();
  settingsPanel.classList.toggle('open');
});
settingsClose.addEventListener('click', () => settingsPanel.classList.remove('open'));
settingsSave.addEventListener('click', () => {
  // Parse the textarea into a clean string[]: split on any newline,
  // trim, drop empties, dedupe (case-insensitive on the trimmed form
  // — server normalizes harder).
  const seen = new Set();
  const excludeAuthors = [];
  for (const line of fields.excludeAuthors.value.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    excludeAuthors.push(t);
  }
  saveSettings({
    llmProvider: fields.llmProvider.value,
    llmModel: fields.llmModel.value.trim(),
    llmBaseUrl: fields.llmBaseUrl.value.trim(),
    llmKey: fields.llmKey.value.trim(),
    tmdbKey: fields.tmdbKey.value.trim(),
    excludeAuthors,
  });
  status(t('settings.saved'), false);
  settingsPanel.classList.remove('open');
});

// ---- Search --------------------------------------------------------------
const form = document.getElementById('search-form');
const themeInput = document.getElementById('theme');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

let lastTheme = '';
let lastWorks = [];
let lastErrors = {};
let lastStats = {};
let writeupCache = {}; // idx -> { text, flagged, charCount }

function status(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const theme = themeInput.value.trim();
  if (!theme) return;

  searchBtn.disabled = true;
  resultsEl.innerHTML = '';
  writeupCache = {};
  status(t('status.searching', theme));

  const settings = loadSettings();
  const keys = {};
  if (settings.tmdbKey) keys.tmdb = settings.tmdbKey;

  // Send the LLM config so the server can do bilingual keyword expansion
  // (translating Chinese themes to English search terms in parallel) when
  // the user has CJK in the query AND has an LLM configured.
  const reqBody = { theme, limit: 15, keys };
  if (hasLlmCreds(settings)) {
    reqBody.llmConfig = llmConfigFromSettings(settings);
  }
  // Author exclude list — server filters merged works after verify, before
  // the LLM rerank, so we don't waste rerank tokens on dropped works.
  if (Array.isArray(settings.excludeAuthors) && settings.excludeAuthors.length) {
    reqBody.excludeAuthors = settings.excludeAuthors;
  }

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    lastTheme = data.theme || theme;
    lastWorks = data.works || [];
    lastErrors = data.errors || {};
    lastStats = data.stats || {};
    const errCount = Object.keys(lastErrors).length;

    status(errCount
      ? t('status.foundWithErrors', lastWorks.length, errCount)
      : t('status.found', lastWorks.length));

    renderResults(lastWorks, lastErrors);
  } catch (err) {
    status(t('status.error', err.message), true);
  } finally {
    searchBtn.disabled = false;
  }
});

function renderResults(works, errors) {
  if (!works.length) {
    resultsEl.innerHTML = renderErrors(errors);
    return;
  }
  const actions = `
    <div class="action-bar">
      <button class="secondary" id="generate-all-btn">${escapeHtml(t('actions.generateAll'))}</button>
      <button class="secondary" id="save-report-btn">${escapeHtml(t('actions.saveReport'))}</button>
      <button class="secondary" id="copy-report-btn">${escapeHtml(t('actions.copyReport'))}</button>
    </div>
  `;
  resultsEl.innerHTML = actions
    + renderDiagnostics(works, errors, lastStats)
    + works.map((w, i) => renderWork(w, i)).join('')
    + renderErrors(errors);

  // Wire buttons
  document.getElementById('generate-all-btn').addEventListener('click', generateAll);
  document.getElementById('save-report-btn').addEventListener('click', saveReport);
  document.getElementById('copy-report-btn').addEventListener('click', copyReport);

  resultsEl.querySelectorAll('[data-writeup-idx]').forEach(btn => {
    btn.addEventListener('click', () => onWriteupClick(parseInt(btn.dataset.writeupIdx, 10)));
  });
  resultsEl.querySelectorAll('[data-copy-idx]').forEach(btn => {
    btn.addEventListener('click', () => onCopyClick(parseInt(btn.dataset.copyIdx, 10), btn));
  });

  // Re-render any cached writeups (after a language switch)
  for (const [idx, result] of Object.entries(writeupCache)) {
    const out = document.getElementById('writeup-' + idx);
    if (out) {
      out.innerHTML = renderWriteup(result, parseInt(idx, 10));
      const cb = out.querySelector('[data-copy-idx]');
      if (cb) cb.addEventListener('click', () => onCopyClick(parseInt(idx, 10), cb));
      const btn = document.querySelector(`[data-writeup-idx="${idx}"]`);
      if (btn) btn.textContent = t('writeup.regenerate');
    }
  }
}

function renderWork(w, idx) {
  const titleEn = w.titles?.en || '';
  const titleZh = w.titles?.zh || '';
  const titleOriginal = w.titles?.original || '';
  const primary = currentLang === 'zh'
    ? (titleZh || titleEn || titleOriginal)
    : (titleEn || titleOriginal || titleZh);
  const secondary = [titleEn, titleZh, titleOriginal]
    .filter(t => t && t !== primary)
    .join(' / ');

  const creators = (w.creators || [])
    .map(c => {
      const n = c.name || {};
      return currentLang === 'zh'
        ? (n.zh || n.en || n.original)
        : (n.en || n.original || n.zh);
    })
    .filter(Boolean)
    .join(currentLang === 'zh' ? '、' : ', ');

  const year = w.year ? String(w.year) : '?';
  const medium = t('medium.' + w.medium) || w.medium || '?';

  const tags = (w.subgenres || [])
    .map(s => `<span class="tag">${escapeHtml(s)}</span>`)
    .join('');

  const flagTags = (w.flags || [])
    .map(f => {
      const i18nKey = FLAG_LABEL[f];
      const label = i18nKey ? t(i18nKey) : f;
      return `<span class="tag flag">${escapeHtml(label)}</span>`;
    })
    .join('');

  // Strip the `_N` collision suffix (books_tw_2 -> books_tw) added by
  // collapseSeries when multiple volumes share the same source. The URL
  // remains volume-specific; only the visible label is cleaned.
  const sources = Object.entries(w.sources || {})
    .map(([k, v]) => `<a href="${escapeHtml(safeUrl(v))}" target="_blank" rel="noopener noreferrer">${escapeHtml(k.replace(/_\d+$/, ''))}</a>`)
    .join('');

  const confBadge = w.confidence
    ? `<span class="conf conf-${w.confidence}">${'★'.repeat({high:3,medium:2,low:1}[w.confidence] || 1)}</span>`
    : '';

  return `
    <div class="work" id="work-${idx}">
      <h3>
        ${escapeHtml(primary || '?')}${secondary ? ` <span class="alt">— ${escapeHtml(secondary)}</span>` : ''}
        ${confBadge}
      </h3>
      <div class="meta">${escapeHtml(medium)} · ${year}${creators ? ` · ${escapeHtml(creators)}` : ''}</div>
      ${tags || flagTags ? `<div class="tags">${flagTags}${tags}</div>` : ''}
      <div class="sources">${sources}</div>
      <div class="writeup-row">
        <button class="secondary writeup-btn" data-writeup-idx="${idx}">${escapeHtml(t('writeup.button'))}</button>
      </div>
      <div class="writeup-output" id="writeup-${idx}"></div>
    </div>
  `;
}

function renderErrors(errors) {
  const entries = Object.entries(errors);
  if (!entries.length) return '';
  return `
    <details style="margin-top:1.5rem;">
      <summary>${escapeHtml(t('errors.heading', entries.length))}</summary>
      <pre>${escapeHtml(entries.map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>
    </details>
  `;
}

/**
 * Search-time diagnostics panel — collapsed by default. Surfaces all the
 * stuff that was previously DevTools-only: per-source result counts,
 * per-source error counts, the actual query strings each adapter saw, the
 * brainstorm expansions per keyword group, the LLM rerank verdict tally,
 * and how many entries got collapsed/excluded. Ugly but unmissable when
 * you need it.
 */
function renderDiagnostics(works, errors, stats) {
  if (!stats || typeof stats !== 'object') return '';

  // Source counts: walk every Work and tally by stripped source key
  // (books_tw, books_tw_2, ... all collapse to "books_tw" for the count).
  const counts = Object.create(null);
  for (const w of works) {
    for (const k of Object.keys(w.sources || {})) {
      const base = k.replace(/_\d+$/, '');
      counts[base] = (counts[base] || 0) + 1;
    }
  }
  const allSources = ['openlibrary', 'anilist', 'tmdb', 'isfdb', 'wikidata', 'books_tw', 'readmoo'];
  const sourceLine = allSources.map(s => {
    const n = counts[s] || 0;
    const err = errors && errors[s] ? ' ⚠️' : '';
    const cls = n === 0 ? 'color:#999' : (n > 0 ? 'color:#1a1a1a' : '');
    return `<span style="${cls}">${s} ${n}${err}</span>`;
  }).join(' · ');

  const variants = Array.isArray(stats.queryVariants) ? stats.queryVariants : [];
  const variantList = variants.length
    ? variants.map(v => `<code style="background:#f4f1ea;padding:0.05rem 0.35rem;border-radius:2px;margin-right:0.4rem;">${escapeHtml(v)}</code>`).join('')
    : '<em style="color:#999;">(none)</em>';

  // bilingualGroups is parallel to the original keywords; render one row per.
  const groups = Array.isArray(stats.bilingualGroups) ? stats.bilingualGroups : [];
  const keywords = Array.isArray(stats.keywords) ? stats.keywords : [];
  const groupRows = groups.length
    ? groups.map((g, i) => {
        const head = keywords[i] || `group ${i}`;
        return `<tr><td style="padding:0.2rem 0.6rem 0.2rem 0;color:#6b6b6b;vertical-align:top;"><code>${escapeHtml(head)}</code></td><td style="padding:0.2rem 0;">${
          g.map(t => `<span style="background:#f4f1ea;padding:0.05rem 0.3rem;border-radius:2px;margin:0 0.2rem 0.2rem 0;display:inline-block;">${escapeHtml(t)}</span>`).join('')
        }</td></tr>`;
      }).join('')
    : '';
  const groupBlock = groupRows
    ? `<table style="border-collapse:collapse;font-size:0.85rem;">${groupRows}</table>`
    : '<em style="color:#999;">(no LLM expansion ran)</em>';

  // Pipeline funnel: raw → merged → kept; series collapsed; excluded; rerank.
  const lines = [];
  if (typeof stats.raw === 'number') lines.push(`raw: ${stats.raw} → merged: ${stats.merged} → kept: ${stats.kept}`);
  if (stats.collapsedSeries) lines.push(`series collapsed: ${stats.collapsedSeries}`);
  if (stats.excluded) lines.push(`excluded by author filter: ${stats.excluded}`);
  if (stats.rerank) {
    const r = stats.rerank;
    lines.push(`AI rerank: ${r.yes ?? 0} yes / ${r.maybe ?? 0} maybe / ${r.no ?? 0} no`);
  }
  const funnelLine = lines.length
    ? `<div style="font-size:0.85rem;color:#6b6b6b;margin-top:0.4rem;">${lines.join(' · ')}</div>`
    : '';

  return `
    <details style="margin:0 0 1rem 0;background:#fafaf7;border:1px solid #d8d6d0;border-radius:3px;padding:0.6rem 0.9rem;">
      <summary style="cursor:pointer;font-size:0.9rem;color:#6b6b6b;">Search diagnostics</summary>
      <div style="margin-top:0.7rem;">
        <div style="font-size:0.85rem;"><strong>Sources:</strong> ${sourceLine}</div>
        <div style="font-size:0.85rem;margin-top:0.5rem;"><strong>Queries sent:</strong> ${variantList}</div>
        <div style="font-size:0.85rem;margin-top:0.6rem;"><strong>LLM brainstorm:</strong></div>
        <div style="margin-top:0.3rem;">${groupBlock}</div>
        ${funnelLine}
      </div>
    </details>
  `;
}

// ---- Writeup -------------------------------------------------------------
function llmConfigFromSettings(s) {
  return {
    provider: s.llmProvider || 'anthropic',
    model: s.llmModel || '',
    apiKey: s.llmKey || '',
    baseUrl: s.llmBaseUrl || '',
  };
}

function hasLlmCreds(s) {
  return Boolean(s.llmKey) ||
    s.llmProvider === 'ollama' ||
    (s.llmProvider === 'openai' && s.llmBaseUrl);
}

async function onWriteupClick(idx) {
  const work = lastWorks[idx];
  if (!work) return;
  const settings = loadSettings();

  const out = document.getElementById('writeup-' + idx);
  const btn = document.querySelector(`[data-writeup-idx="${idx}"]`);
  if (!hasLlmCreds(settings)) {
    out.innerHTML = `<div class="writeup-warning">${escapeHtml(t('writeup.needKey'))}</div>`;
    return;
  }

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = t('writeup.generating');
  out.innerHTML = `<div class="writeup-loading">${escapeHtml(t('writeup.generating'))}</div>`;

  try {
    const res = await fetch('/api/writeup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work, config: llmConfigFromSettings(settings) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    writeupCache[idx] = data;
    out.innerHTML = renderWriteup(data, idx);
    btn.textContent = t('writeup.regenerate');
  } catch (err) {
    out.innerHTML = `<div class="writeup-warning">${escapeHtml(t('status.error', err.message))}</div>`;
    btn.textContent = prevLabel;
  } finally {
    btn.disabled = false;
    const copyBtn = out.querySelector(`[data-copy-idx="${idx}"]`);
    if (copyBtn) copyBtn.addEventListener('click', () => onCopyClick(idx, copyBtn));
  }
}

async function generateAll() {
  const settings = loadSettings();
  if (!hasLlmCreds(settings)) {
    status(t('writeup.needKey'), true);
    return;
  }
  const total = lastWorks.length;
  // Skip ones already in cache.
  const todo = lastWorks
    .map((_, i) => i)
    .filter(i => !writeupCache[i]);

  for (let n = 0; n < todo.length; n++) {
    const idx = todo[n];
    status(t('status.generatingAll', n + 1, todo.length));
    await onWriteupClick(idx);
  }
  status(t('status.allDone', Object.keys(writeupCache).length));
  void total;
}

function renderWriteup(result, idx) {
  let html = escapeHtml(result.text);
  for (const phrase of result.flagged || []) {
    const safe = escapeHtml(phrase);
    const re = new RegExp(safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    html = html.replace(re, `<mark class="bad-phrase">${safe}</mark>`);
  }

  const flaggedNote = (result.flagged || []).length
    ? `<span class="writeup-flagged">${escapeHtml(t('writeup.flagged', result.flagged.length))}</span>`
    : '';

  const paras = html
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `
    <div class="writeup-text">${paras}</div>
    <div class="writeup-meta">
      <span>${escapeHtml(t('writeup.charCount', result.charCount))}</span>
      ${flaggedNote}
      <button class="secondary tiny" data-copy-idx="${idx}">${escapeHtml(t('writeup.copy'))}</button>
    </div>
  `;
}

async function onCopyClick(idx, btn) {
  const out = document.getElementById('writeup-' + idx);
  if (!out) return;
  const text = out.querySelector('.writeup-text')?.innerText || '';
  await copyText(text, btn, t('writeup.copy'), t('writeup.copied'));
}

async function copyText(text, btn, restoreLabel, successLabel) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = successLabel;
    setTimeout(() => { btn.textContent = restoreLabel || orig; }, 1500);
  }
}

// ---- Report --------------------------------------------------------------
async function fetchReport() {
  // Server-side composition keeps the markdown format canonical.
  const writeupsForServer = {};
  for (const [idx, r] of Object.entries(writeupCache)) writeupsForServer[idx] = r.text;
  const res = await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: lastTheme, works: lastWorks, writeups: writeupsForServer }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return await res.text();
}

async function saveReport() {
  try {
    const md = await fetchReport();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `curate_${slugify(lastTheme)}_${ymd()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    status(t('status.error', err.message), true);
  }
}

async function copyReport() {
  try {
    const md = await fetchReport();
    const btn = document.getElementById('copy-report-btn');
    await copyText(md, btn, t('actions.copyReport'), t('actions.reportCopied'));
  } catch (err) {
    status(t('status.error', err.message), true);
  }
}

function slugify(s) {
  return (s || 'theme').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}\-_]/gu, '').slice(0, 60) || 'theme';
}
function ymd() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}


function safeUrl(u) {
  // Source URLs come from scraped HTML; anything that isn't http(s) is dropped.
  // Stops things like javascript:, data:, file: from ever ending up in an
  // href attribute.
  if (typeof u !== 'string') return '#';
  return /^https?:\/\//i.test(u) ? u : '#';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
  );
}

// ---- init ---------------------------------------------------------------
applyLang();
