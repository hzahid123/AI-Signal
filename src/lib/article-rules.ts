import type { ArticleRecord } from './article-schema';

export type FreshnessLabel = 'BREAKING' | 'LATEST' | 'RECENT' | 'OLDER';
export type ArchiveBucket = 'LATEST' | 'ARCHIVE' | 'HISTORICAL';

export function freshnessLabel(eventAt: Date, now: Date = new Date()): FreshnessLabel {
  const ageHours = Math.max(0, now.getTime() - eventAt.getTime()) / 3_600_000;
  if (ageHours < 6) return 'BREAKING';
  if (ageHours < 24) return 'LATEST';
  if (ageHours <= 24 * 7) return 'RECENT';
  return 'OLDER';
}

export function sortLatest<T extends Pick<ArticleRecord, 'publishedAt'>>(articles: readonly T[]): T[] {
  return [...articles].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

export function sortMostImportant<T extends Pick<ArticleRecord, 'importanceScore' | 'publishedAt'>>(articles: readonly T[]): T[] {
  return [...articles].sort((a, b) => b.importanceScore - a.importanceScore || b.publishedAt.getTime() - a.publishedAt.getTime());
}

export function sortBreaking<T extends Pick<ArticleRecord, 'eventAt'>>(articles: readonly T[], now: Date = new Date()): T[] {
  return articles.filter((article) => freshnessLabel(article.eventAt, now) === 'BREAKING');
}

export function sortFeatured<T extends Pick<ArticleRecord, 'isFeatured' | 'publishedAt'>>(articles: readonly T[]): T[] {
  return [...articles].filter((article) => article.isFeatured).sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

export function archiveBucket(publishedAt: Date, now: Date = new Date()): ArchiveBucket {
  const ageDays = Math.max(0, now.getTime() - publishedAt.getTime()) / 86_400_000;
  if (ageDays < 7) return 'LATEST';
  if (ageDays <= 30) return 'ARCHIVE';
  return 'HISTORICAL';
}

export function normalizeTitle(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function normalizeSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.host}${pathname}${url.search}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function tokenSimilarity(left: string, right: string): number {
  const stop = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'the', 'to', 'with']);
  const a = new Set(normalizeTitle(left).split(' ').filter((token) => token && !stop.has(token)));
  const b = new Set(normalizeTitle(right).split(' ').filter((token) => token && !stop.has(token)));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / (a.size + b.size - overlap);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

export type DuplicateReason = 'event-key' | 'source-url' | 'normalized-title' | 'similar-title-and-metadata';
export interface DuplicateMatch<T> { article: T; reason: DuplicateReason; similarity: number }

export function findDuplicate<T extends Pick<ArticleRecord, 'title' | 'category' | 'tags' | 'eventAt' | 'eventKey' | 'sources'>>(
  incoming: T,
  existing: readonly T[],
): DuplicateMatch<T> | null {
  const title = normalizeTitle(incoming.title);
  const incomingSources = new Set(incoming.sources.map(({ url }) => normalizeSourceUrl(url)));
  for (const candidate of existing) {
    if (incoming.eventKey && candidate.eventKey && incoming.eventKey.toLowerCase() === candidate.eventKey.toLowerCase()) {
      return { article: candidate, reason: 'event-key', similarity: 1 };
    }
    if (candidate.sources.some(({ url }) => incomingSources.has(normalizeSourceUrl(url)))) {
      return { article: candidate, reason: 'source-url', similarity: 1 };
    }
    const candidateTitle = normalizeTitle(candidate.title);
    const similarity = tokenSimilarity(title, candidateTitle);
    if (title && title === candidateTitle && daysBetween(incoming.eventAt, candidate.eventAt) <= 30) {
      return { article: candidate, reason: 'normalized-title', similarity: 1 };
    }
    const sharedTags = incoming.tags.map((tag) => tag.toLowerCase()).filter((tag) => candidate.tags.some((other) => other.toLowerCase() === tag));
    const sameMetadata = incoming.category === candidate.category && daysBetween(incoming.eventAt, candidate.eventAt) <= 3;
    if ((similarity >= 0.78 && daysBetween(incoming.eventAt, candidate.eventAt) <= 30)
      || (similarity >= 0.62 && sameMetadata && sharedTags.length > 0)) {
      return { article: candidate, reason: 'similar-title-and-metadata', similarity };
    }
  }
  return null;
}
