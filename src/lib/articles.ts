import type { CollectionEntry } from 'astro:content';
import type { ArticleRecord } from './article-schema';
import { ArticleRecordSchema } from './article-schema';
import { findDuplicate } from './article-rules';

export type Article = CollectionEntry<'articles'>;

export function assertNoDuplicatePublishedArticles(articles: Article[]): void {
  const published = articles.filter(({ data }) => data.status === 'PUBLISHED')
    .map((article) => ArticleRecordSchema.parse({ id: article.id, content: article.body, ...article.data }));
  for (let index = 0; index < published.length; index += 1) {
    const current = published[index];
    if (!current) continue;
    const duplicate = findDuplicate(current, published.slice(0, index));
    if (duplicate) {
      throw new Error(`Published article "${current.slug}" duplicates "${duplicate.article.slug}" (${duplicate.reason}, similarity ${duplicate.similarity.toFixed(2)}). Update the existing story or correct the metadata before publishing.`);
    }
  }
}

export function publicArticles(articles: Article[]): Article[] {
  assertNoDuplicatePublishedArticles(articles);
  return articles.filter(({ data }) => data.status === 'PUBLISHED')
    .sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());
}

export function toArticleRecord(article: Article): ArticleRecord {
  return ArticleRecordSchema.parse({ id: article.id, content: article.body, ...article.data });
}

export function readingTime(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

export function categorySlug(category: string): string {
  return category.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
