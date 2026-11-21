import assert from 'node:assert/strict';
import test from 'node:test';
import { ArticleFrontmatterSchema, ArticleRecordSchema, importanceLevelForScore, scoreImportance } from '../src/lib/article-schema.ts';
import { archiveBucket, findDuplicate, freshnessLabel, normalizeTitle, normalizeSourceUrl, sortBreaking, sortLatest, sortMostImportant } from '../src/lib/article-rules.ts';

const now = new Date('2026-01-10T12:00:00.000Z');
const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000);
const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000);
const source = { name: 'Official announcement', url: 'https://example.org/news', reliability: 'primary' };
const factors = { affectedPeople: 3, aiDevelopers: 3, businesses: 3, technicalSignificance: 3, novelty: 3, industryRelevance: 3, sourceReliability: 5 };

function article(overrides = {}) {
  return {
    slug: 'example-development',
    title: 'A significant artificial intelligence development',
    introduction: 'A sourced and concise introduction that explains the important development for readers.',
    category: 'AI Industry News',
    tags: ['industry', 'models'],
    eventAt: new Date('2026-01-10T10:00:00.000Z'),
    publishedAt: new Date('2026-01-10T11:00:00.000Z'),
    importanceLevel: 'MEDIUM',
    importanceScore: 3,
    importanceFactors: factors,
    importanceReason: 'Broad developer relevance with moderate technical novelty.',
    sources: [source],
    status: 'PENDING',
    isFeatured: false,
    ...overrides,
  };
}

test('freshness uses event time and exact age boundaries', () => {
  assert.equal(freshnessLabel(hoursAgo(5.99), now), 'BREAKING');
  assert.equal(freshnessLabel(hoursAgo(6), now), 'LATEST');
  assert.equal(freshnessLabel(hoursAgo(23.99), now), 'LATEST');
  assert.equal(freshnessLabel(hoursAgo(24), now), 'RECENT');
  assert.equal(freshnessLabel(daysAgo(7), now), 'RECENT');
  assert.equal(freshnessLabel(daysAgo(7.01), now), 'OLDER');
});

test('freshness clamps future event timestamps to current rather than old', () => {
  assert.equal(freshnessLabel(new Date(now.getTime() + 2 * 3_600_000), now), 'BREAKING');
});

test('latest sorting is newest publication first and does not mutate input', () => {
  const input = [{ id: 'old', publishedAt: daysAgo(2) }, { id: 'new', publishedAt: daysAgo(0) }];
  assert.deepEqual(sortLatest(input).map(({ id }) => id), ['new', 'old']);
  assert.equal(input[0]?.id, 'old');
});

test('importance sorting uses score then publication date', () => {
  const input = [
    { id: 'new-medium', importanceScore: 3, publishedAt: daysAgo(0) },
    { id: 'old-high', importanceScore: 4, publishedAt: daysAgo(5) },
    { id: 'old-medium', importanceScore: 3, publishedAt: daysAgo(2) },
  ];
  assert.deepEqual(sortMostImportant(input).map(({ id }) => id), ['old-high', 'new-medium', 'old-medium']);
});

test('breaking sorting includes only event freshness under six hours', () => {
  const input = [{ eventAt: hoursAgo(2) }, { eventAt: hoursAgo(6) }];
  assert.equal(sortBreaking(input, now).length, 1);
});

test('archive windows retain stories indefinitely in three date bands', () => {
  assert.equal(archiveBucket(daysAgo(6.99), now), 'LATEST');
  assert.equal(archiveBucket(daysAgo(7), now), 'ARCHIVE');
  assert.equal(archiveBucket(daysAgo(30), now), 'ARCHIVE');
  assert.equal(archiveBucket(daysAgo(30.01), now), 'HISTORICAL');
});

test('importance score maps to the required importance levels', () => {
  assert.equal(importanceLevelForScore(5), 'CRITICAL');
  assert.equal(importanceLevelForScore(4), 'HIGH');
  assert.equal(importanceLevelForScore(3), 'MEDIUM');
  assert.equal(importanceLevelForScore(2), 'LOW');
  assert.equal(importanceLevelForScore(1), 'LOW');
});

test('importance factor average is the score used for validation', () => {
  assert.equal(scoreImportance(factors), 3);
  assert.equal(ArticleFrontmatterSchema.safeParse(article()).success, true);
  assert.equal(ArticleFrontmatterSchema.safeParse(article({ importanceScore: 4, importanceLevel: 'HIGH' })).success, false);
});

test('article validation rejects invalid status, slugs, and missing sources', () => {
  assert.equal(ArticleFrontmatterSchema.safeParse(article({ status: 'LIVE' })).success, false);
  assert.equal(ArticleFrontmatterSchema.safeParse(article({ slug: 'Bad Slug' })).success, false);
  assert.equal(ArticleFrontmatterSchema.safeParse(article({ sources: [] })).success, false);
});

test('article record validates explicit id and markdown body', () => {
  assert.equal(ArticleRecordSchema.safeParse({ ...article(), id: 'example', content: '# Verified report' }).success, true);
  assert.equal(ArticleRecordSchema.safeParse({ ...article(), content: '# Missing id' }).success, false);
});

test('duplicate matching normalizes titles and strips tracking parameters from URLs', () => {
  assert.equal(normalizeTitle('  Acmé: New AI Model! '), 'acme new ai model');
  assert.equal(normalizeSourceUrl('https://www.example.org/news/?utm_source=feed#top'), 'example.org/news');
  const original = article({ eventKey: 'company-model-release-2026', sources: [source] });
  const sameEvent = article({ eventKey: 'COMPANY-MODEL-RELEASE-2026', sources: [{ ...source, url: 'https://other.example/story' }] });
  assert.equal(findDuplicate(sameEvent, [original])?.reason, 'event-key');
});

test('duplicate detection catches matching source URLs and highly similar story titles', () => {
  const original = article({ title: 'OpenAI releases a new image model for developers' });
  const sameSource = article({ title: 'A different title about the same report', sources: [{ ...source, url: 'https://www.example.org/news/?utm_campaign=launch' }] });
  assert.equal(findDuplicate(sameSource, [original])?.reason, 'source-url');
  const similar = article({ title: 'OpenAI releases a new image model for developers today', sources: [{ ...source, url: 'https://different.example/release' }] });
  assert.equal(findDuplicate(similar, [original])?.reason, 'similar-title-and-metadata');
  const unrelated = article({ title: 'Robotics company expands warehouse automation', sources: [{ ...source, url: 'https://robotics.example/release' }] });
  assert.equal(findDuplicate(unrelated, [original]), null);
  const annual = article({ title: original.title, eventAt: new Date('2024-01-10T10:00:00.000Z'), sources: [{ ...source, url: 'https://example.org/annual-report' }] });
  assert.equal(findDuplicate(annual, [original]), null);
});
