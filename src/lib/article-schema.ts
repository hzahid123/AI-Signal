import { z } from 'zod';

export const ARTICLE_CATEGORIES = [
  'AI Companies', 'AI Models & Research', 'AI Tools', 'AI Coding & Development',
  'AI Startups & Business', 'AI Automation', 'Robotics', 'AI Security', 'AI Industry News',
] as const;

export const ArticleCategorySchema = z.enum(ARTICLE_CATEGORIES);
export type ArticleCategory = z.infer<typeof ArticleCategorySchema>;
export const CATEGORY_DESCRIPTIONS: Record<ArticleCategory, string> = {
  'AI Companies': 'The organizations building and deploying AI.',
  'AI Models & Research': 'New models, papers, and scientific advances.',
  'AI Tools': 'Products and practical tools for people and teams.',
  'AI Coding & Development': 'AI systems changing how software gets made.',
  'AI Startups & Business': 'Funding, strategy, and the AI economy.',
  'AI Automation': 'Automated systems applied to work and services.',
  Robotics: 'Intelligent machines in the physical world.',
  'AI Security': 'Safety, security, and responsible deployment.',
  'AI Industry News': 'Important developments across the AI sector.',
};
export const ImportanceLevelSchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type ImportanceLevel = z.infer<typeof ImportanceLevelSchema>;
export const ArticleStatusSchema = z.enum(['PENDING', 'PUBLISHED', 'REJECTED']);
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

export const ArticleSourceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().url(),
  reliability: z.enum(['primary', 'peer-reviewed', 'reputable-secondary', 'other']).default('other'),
});

export const ImportanceFactorsSchema = z.object({
  affectedPeople: z.number().int().min(1).max(5),
  aiDevelopers: z.number().int().min(1).max(5),
  businesses: z.number().int().min(1).max(5),
  technicalSignificance: z.number().int().min(1).max(5),
  novelty: z.number().int().min(1).max(5),
  industryRelevance: z.number().int().min(1).max(5),
  sourceReliability: z.number().int().min(1).max(5),
});
export type ImportanceFactors = z.infer<typeof ImportanceFactorsSchema>;

export function scoreImportance(factors: ImportanceFactors): number {
  const values = Object.values(factors);
  return Math.max(1, Math.min(5, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)));
}

const slugSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must contain lowercase letters, numbers, and single hyphens.');

const ArticleFrontmatterBaseSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(8).max(140),
  introduction: z.string().trim().min(40).max(300),
  category: ArticleCategorySchema,
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  featuredImage: z.string().trim().optional().refine((value) => !value || value.startsWith('/') || z.string().url().safeParse(value).success, 'Featured image must be a site path or valid URL.'),
  eventAt: z.coerce.date(),
  publishedAt: z.coerce.date(),
  updatedAt: z.coerce.date().optional(),
  importanceLevel: ImportanceLevelSchema,
  importanceScore: z.number().int().min(1).max(5),
  importanceFactors: ImportanceFactorsSchema,
  importanceReason: z.string().trim().min(12).max(300),
  sources: z.array(ArticleSourceSchema).min(1),
  status: ArticleStatusSchema.default('PENDING'),
  isFeatured: z.boolean().default(false),
  seoTitle: z.string().trim().min(8).max(70).optional(),
  metaDescription: z.string().trim().min(40).max(180).optional(),
  eventKey: z.string().trim().min(1).max(180).optional(),
  author: z.string().trim().min(1).max(100).optional(),
});

function sourceReliabilityScore(sources: z.infer<typeof ArticleSourceSchema>[]): number {
  const scores = sources.map(({ reliability }) => ({
    primary: 5,
    'peer-reviewed': 5,
    'reputable-secondary': 3,
    other: 1,
  })[reliability]);
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function validateArticle(article: z.infer<typeof ArticleFrontmatterBaseSchema>, context: z.RefinementCtx): void {
  const expectedLevel = importanceLevelForScore(article.importanceScore);
  const expectedScore = scoreImportance(article.importanceFactors);
  const expectedReliability = sourceReliabilityScore(article.sources);
  if (article.importanceFactors.sourceReliability !== expectedReliability) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['importanceFactors', 'sourceReliability'], message: `Source reliability factor must match the linked sources (${expectedReliability}).` });
  }
  if (article.importanceScore !== expectedScore) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['importanceScore'], message: `Importance score must match the factor average (${expectedScore}).` });
  }
  if (article.importanceLevel !== expectedLevel) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['importanceLevel'], message: `Score ${article.importanceScore} must use ${expectedLevel}.` });
  }
  if (article.updatedAt && article.updatedAt < article.publishedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAt'], message: 'Updated date cannot be earlier than the original publication date.' });
  }
}

export const ArticleFrontmatterSchema = ArticleFrontmatterBaseSchema.superRefine(validateArticle);

export type ArticleFrontmatter = z.infer<typeof ArticleFrontmatterSchema>;
export const ArticleRecordSchema = ArticleFrontmatterBaseSchema.extend({ id: z.string().min(1), content: z.string() }).superRefine(validateArticle);
export type ArticleRecord = z.infer<typeof ArticleRecordSchema>;

export function importanceLevelForScore(score: number): ImportanceLevel {
  if (score === 5) return 'CRITICAL';
  if (score === 4) return 'HIGH';
  if (score === 3) return 'MEDIUM';
  return 'LOW';
}
