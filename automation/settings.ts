import { z } from 'zod';
import { ARTICLE_CATEGORIES } from '../src/lib/article-schema.ts';

export const AutomationSettingsSchema = z.object({
  model: z.string().regex(/^gemini-[A-Za-z0-9.-]{1,80}$/),
  maximumCandidatesPerRun: z.number().int().min(1).max(50),
  minimumImportanceScore: z.number().int().min(1).max(5),
  enabledCategories: z.array(z.enum(ARTICLE_CATEGORIES)).min(1).max(ARTICLE_CATEGORIES.length),
  researchRequirements: z.object({ minimumSources: z.number().int().min(2).max(8), requirePrimarySource: z.literal(true) }).strict(),
  qualityThresholds: z.object({ minimumWords: z.number().int().min(250).max(1000), maximumWords: z.number().int().min(500).max(1500) }).strict(),
  automaticPublishingEnabled: z.boolean(),
  manualReview: z.object({ highImpactScore: z.literal(4), sensitiveTopics: z.literal(true), conflictingReports: z.literal(true) }).strict(),
}).strict().superRefine((settings, context) => {
  if (settings.qualityThresholds.minimumWords >= settings.qualityThresholds.maximumWords) context.addIssue({ code: z.ZodIssueCode.custom, path: ['qualityThresholds'], message: 'Minimum article length must be below maximum article length.' });
  if (new Set(settings.enabledCategories).size !== settings.enabledCategories.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['enabledCategories'], message: 'Categories cannot be duplicated.' });
});

export type AutomationSettings = z.infer<typeof AutomationSettingsSchema>;
export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  model: 'gemini-3.8-flash', maximumCandidatesPerRun: 20, minimumImportanceScore: 3,
  enabledCategories: [...ARTICLE_CATEGORIES],
  researchRequirements: { minimumSources: 2, requirePrimarySource: true },
  qualityThresholds: { minimumWords: 250, maximumWords: 1500 }, automaticPublishingEnabled: true,
  manualReview: { highImpactScore: 4, sensitiveTopics: true, conflictingReports: true },
};
