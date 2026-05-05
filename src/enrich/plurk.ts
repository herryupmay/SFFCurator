/**
 * Plurk synopsis enrichment.
 *
 * Plurk is Taiwan's longest-running microblogging platform; SFF reading
 * communities are active and the discussion is in zh-TW. We search by
 * EXACT TITLE (English or Chinese) - searching by theme keyword returns
 * far too much noise (most "學徒" plurks are not about books at all).
 *
 * Selectors (verified May 2026 against fixture tests/fixtures/plurk-real.html):
 *   - Each post wraps in <div class="plurk ... divplurk ..."
 *     data-pid="<plurkId>" data-respcount="<N>">. Filter on data-pid to
 *     ignore form_holder and other non-post divs that share the .plurk class.
 *   - The post text lives in <div class="content"><div class="text_holder">.
 *   - Permalink: <a href="https://www.plurk.com/p/<base36>"> inside .time.
 *   - Posted timestamp: <span class="posted" data-posted="ISO-8601">.
 *
 * No auth, no API key. Anonymous users have data-uid="99999" - we do not
 * try to identify posters; the post body itself is what we want.
 */

import * as cheerio from 'cheerio';
import { politeFetch } from '../sources/http';

const SEARCH_URL = (q: string) =>
  `https://www.plurk.com/search?q=${encodeURIComponent(q)}&category=plurks`;

interface PlurkEnrichment {
  lang: 'zh';
  /** Short opening line (first ~80 chars of the post body), used as a label. */
  title: string;
  /** Full post body. */
  text: string;
  /** Permanent URL to the plurk. */
  url: string;
  /** Plurk's permanent post id (data-pid). */
  pid: string;
  /** ISO-8601 posted timestamp, when available. */
  posted?: string;
  /** Response count, used as a "thread engagement" signal for sorting. */
  respCount: number;
}

export async function enrichFromPlurk(opts: {
  query: string;
  limit?: number;
}): Promise<PlurkEnrichment[]> {
  const query = opts.query.trim();
  const limit = opts.limit ?? 5;
  if (!query) return [];

  let html: string;
  try {
    const res = await politeFetch(SEARCH_URL(query), {
      hostDelayMs: 1500,
      headers: {
        // Plurk sometimes serves a stripped page to bare-UA clients;
        // mimic a regular browser politely.
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  return parsePlurkHtml(html, limit);
}

/** Exposed for fixture-based unit tests. */
export function parsePlurkHtml(html: string, limit = 5): PlurkEnrichment[] {
  const $ = cheerio.load(html);
  const out: PlurkEnrichment[] = [];

  // Try several candidate selectors so a partial Plurk redesign doesn't
  // take everything down at once.
  const itemSelectors = [
    'div.divplurk[data-pid]',
    'div.plurk[data-pid]',
    'div[data-pid][data-type="plurk"]',
  ];
  let $items = $();
  for (const sel of itemSelectors) {
    $items = $(sel);
    if ($items.length) break;
  }

  $items.each((_, el) => {
    if (out.length >= limit) return false;
    const $el = $(el);
    const pid = $el.attr('data-pid') || '';
    if (!pid || /^form_/.test(pid)) return;

    const $textHolder =
      $el.find('.content .text_holder').first().length
        ? $el.find('.content .text_holder').first()
        : $el.find('.content').first();
    const text = $textHolder.text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 20) return;

    const $permalink =
      $el.find('.time a[href*="plurk.com/p/"]').first().length
        ? $el.find('.time a[href*="plurk.com/p/"]').first()
        : $el.find('a[href*="plurk.com/p/"]').first();
    let url = $permalink.attr('href') || '';
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) url = 'https://www.plurk.com' + url;
    if (!url) url = `https://www.plurk.com/p/${pid}`;

    const posted = $el.find('.posted').first().attr('data-posted') || undefined;
    const respCountAttr = $el.attr('data-respcount');
    const respCount = respCountAttr ? parseInt(respCountAttr, 10) || 0 : 0;

    // Short label for citation: first ~80 chars of the body, single line.
    const title = text.slice(0, 80) + (text.length > 80 ? '…' : '');

    out.push({
      lang: 'zh',
      title,
      text,
      url,
      pid,
      posted,
      respCount,
    });
  });

  // Highest-engagement posts first; truncate to limit (already enforced).
  out.sort((a, b) => b.respCount - a.respCount);
  return out.slice(0, limit);
}

export type { PlurkEnrichment };
