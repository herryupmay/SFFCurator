/**
 * Shared types across the pipeline.
 *
 * Each source adapter produces partial Work records (one per hit). The
 * matching stage merges them by ISBN / author+year / back-translated title
 * into a deduped list, where each final Work records the union of all
 * source URLs that contributed.
 */

export type Medium =
  | 'book'
  | 'film'
  | 'tv'
  | 'anime'
  | 'manga'
  | 'comic'
  | 'game';

export type CreatorRole =
  | 'author'
  | 'co-author'
  | 'director'
  | 'screenwriter'
  | 'illustrator'
  | 'translator'
  | 'studio';

export interface Creator {
  name: {
    en?: string;
    /** Traditional Chinese (zh-TW) preferred; falls back to zh-CN if that's all the source has. */
    zh?: string;
    /** Original-language form, e.g. Japanese for manga. */
    original?: string;
  };
  role: CreatorRole;
}

export interface Work {
  /**
   * URLs from each source that contributed to this record.
   * After merging, multiple keys means multiple sources confirmed the work.
   * Key examples: 'openlibrary', 'isfdb', 'anilist', 'tmdb', 'wikidata',
   * 'books_tw', 'readmoo'.
   */
  sources: Record<string, string>;

  titles: {
    en?: string;
    zh?: string;
    original?: string;
  };

  creators: Creator[];

  /** Year of original publication / release. */
  year?: number;

  /** ISBN-13 if known. Used as the highest-confidence merge key. */
  isbn13?: string;

  medium: Medium;

  /** Normalized subgenre tags (e.g. 'cyberpunk', 'space opera'). */
  subgenres?: string[];

  synopsis?: {
    en?: string;
    zh?: string;
  };

  /**
   * Per-source raw payloads, keyed by source name. Useful for debugging
   * scraper drift and for the matching stage's lower-confidence tiers.
   */
  raw: Record<string, unknown>;

  // ---- Populated by the verification stage ----

  confidence?: 'high' | 'medium' | 'low';

  /** True if any zh source has the work (translation exists). */
  hasZhTranslation?: boolean;

  /** True if 博客來 or Readmoo currently lists it (in-print in TW). */
  availableInTw?: boolean;

  /** Free-text flags surfaced in the UI, e.g. '未中譯', 'absent from ISFDB'. */
  flags?: string[];
}
