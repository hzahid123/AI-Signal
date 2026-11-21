import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  ARTICLE_CATEGORIES,
  ArticleFrontmatterSchema,
  ArticleRecordSchema,
  importanceLevelForScore,
  scoreImportance,
  type ArticleCategory,
  type ArticleRecord,
  type ImportanceFactors,
} from '../src/lib/article-schema.ts';
import { findDuplicate, normalizeSourceUrl, normalizeTitle } from '../src/lib/article-rules.ts';
import { AutomationSettingsSchema, DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from './settings.ts';

const ReliabilitySchema = z.enum(['primary', 'peer-reviewed', 'reputable-secondary', 'other']);
const RegistryEntrySchema = z.object({
  name: z.string().min(1),
  feedUrl: z.string().url(),
  category: z.enum(ARTICLE_CATEGORIES),
  enabled: z.boolean(),
  reliability: ReliabilitySchema,
  lastSuccessfulFetch: z.string().datetime().nullable().optional(),
  errorInformation: z.string().nullable().optional(),
});
type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

type Candidate = {
  title: string;
  url: string;
  description: string;
  publishedAt: Date;
  feedName: string;
  category: ArticleCategory;
  reliability: z.infer<typeof ReliabilitySchema>;
};
type Citation = { title: string; url: string; reliability: z.infer<typeof ReliabilitySchema> };
type Research = { text: string; citations: Citation[]; queries: string[] };
type Draft = {
  title: string;
  introduction: string;
  eventAt: string;
  eventKey: string;
  category: ArticleCategory;
  tags: string[];
  importanceFactors: Omit<ImportanceFactors, 'sourceReliability'>;
  importanceReason: string;
  sections: Array<{ heading: string; body: string; sourceNumbers: number[] }>;
  uncertaintyNotes: string[];
  contradictingReports: boolean;
  sensitive: boolean;
};

const sourceFiles = path.resolve('automation/sources.json');
const articleDir = path.resolve('src/content/articles');
const stateFile = path.resolve('automation/source-status.json');
const now = new Date();
const errors: string[] = [];
const counters = { feedsChecked: 0, storiesDiscovered: 0, candidatesDeferred: 0, candidateProcessingErrors: 0, duplicatesRejected: 0, articlesGenerated: 0, articlesApproved: 0, articlesRejected: 0, articlesPublished: 0, heldForReview: 0 };
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, textNodeName: '#text', processEntities: true, trimValues: true });
const stateBranch = 'ai-pulse-automation-state';
type PersistedSourceStatus = { generatedAt?: string; summary?: Record<string, unknown>; sources?: Array<Record<string, any>> };

class GeminiQuotaExceededError extends Error {
  constructor(message: string) { super(message); this.name = 'GeminiQuotaExceededError'; }
}

async function githubApi(pathname: string, method = 'GET', body?: unknown): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error('GitHub token or repository context is missing');
  return fetch(`https://api.github.com/repos/${repository}/${pathname}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
}

async function loadPersistedStatus(): Promise<PersistedSourceStatus> {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return {};
  const response = await githubApi(`contents/automation/source-status.json?ref=${stateBranch}`);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Could not load prior source status (GitHub HTTP ${response.status})`);
  const file = await response.json() as { content?: string; encoding?: string };
  if (file.encoding !== 'base64' || !file.content) return {};
  try { return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as PersistedSourceStatus; }
  catch { return {}; }
}

async function persistStatusBranch(status: PersistedSourceStatus): Promise<void> {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const encodedPath = 'contents/automation/source-status.json';
  let priorResponse = await githubApi(`${encodedPath}?ref=${stateBranch}`);
  let priorSha: string | undefined;
  if (priorResponse.status === 404) {
    const baseSha = process.env.GITHUB_SHA;
    if (!baseSha) throw new Error('GITHUB_SHA is missing; cannot initialize the feed-status branch');
    const createResponse = await githubApi('git/refs', 'POST', { ref: `refs/heads/${stateBranch}`, sha: baseSha });
    if (!createResponse.ok && createResponse.status !== 422) throw new Error(`Could not create status branch (GitHub HTTP ${createResponse.status})`);
    priorResponse = await githubApi(`${encodedPath}?ref=${stateBranch}`);
  }
  if (priorResponse.ok) priorSha = (await priorResponse.json() as { sha?: string }).sha;
  else if (priorResponse.status !== 404) throw new Error(`Could not read status file (GitHub HTTP ${priorResponse.status})`);
  const update = await githubApi(encodedPath, 'PUT', {
    message: 'chore(automation): update feed status',
    content: Buffer.from(`${JSON.stringify(status, null, 2)}\n`).toString('base64'),
    branch: stateBranch,
    ...(priorSha ? { sha: priorSha } : {}),
  });
  if (!update.ok) throw new Error(`Could not save source status (GitHub HTTP ${update.status})`);
}

function cleanText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return cleanText(object['#text'] ?? object.text ?? '');
  }
  return '';
}

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parsedItem(item: Record<string, unknown>, source: RegistryEntry): Candidate | null {
  const title = cleanText(item.title);
  const linkValue = item.link;
  const link = typeof linkValue === 'string'
    ? linkValue
    : (Array.isArray(linkValue)
      ? String((linkValue.find((entry) => typeof entry === 'object' && entry !== null && (!('@_rel' in entry) || (entry as Record<string, unknown>)['@_rel'] === 'alternate')) as Record<string, unknown> | undefined)?.['@_href'] ?? '')
      : (linkValue && typeof linkValue === 'object' ? String((linkValue as Record<string, unknown>)['@_href'] ?? '') : ''));
  const dateValue = item.pubDate ?? item.published ?? item.updated ?? item.date ?? item['dc:date'];
  const publishedAt = new Date(cleanText(dateValue));
  if (!title || !Number.isFinite(publishedAt.getTime())) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { title: title.slice(0, 300), url: url.href, description: cleanText(item.description ?? item.summary ?? item.content).slice(0, 1400), publishedAt, feedName: source.name, category: source.category, reliability: source.reliability };
  } catch {
    return null;
  }
}

async function fetchFeed(source: RegistryEntry, prior?: Record<string, any>): Promise<{ source: RegistryEntry; candidates: Candidate[]; status: Record<string, unknown> }> {
  const status: Record<string, unknown> = { name: source.name, feedUrl: source.feedUrl, enabled: source.enabled, lastSuccessfulFetch: source.lastSuccessfulFetch ?? prior?.lastSuccessfulFetch ?? null, errorInformation: null, storiesFound: 0 };
  if (!source.enabled) return { source, candidates: [], status: { ...status, skipped: true } };
  try {
    const response = await fetch(source.feedUrl, { headers: { 'user-agent': 'AI-Pulse-NewsResearch/1.0 (+https://ai-pulse.example; RSS discovery only)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    if (xml.length > 8_000_000) throw new Error('Feed exceeded the 8 MB safety limit');
    const parsed = parser.parse(xml) as Record<string, any>;
    const items = list<Record<string, unknown>>(parsed.rss?.channel?.item ?? parsed.feed?.entry ?? parsed.RDF?.item);
    const candidates = items.map((item) => parsedItem(item, source)).filter((item): item is Candidate => item !== null);
    status.lastSuccessfulFetch = new Date().toISOString();
    status.storiesFound = candidates.length;
    return { source, candidates, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.errorInformation = message;
    status.lastSuccessfulFetch = source.lastSuccessfulFetch ?? prior?.lastSuccessfulFetch ?? null;
    errors.push(`Feed ${source.name}: ${message}`);
    return { source, candidates: [], status };
  }
}

function isRelevant(candidate: Candidate): boolean {
  const text = `${candidate.title} ${candidate.description}`.toLowerCase();
  return /\b(ai|artificial intelligence|machine learning|deep learning|generative|large language model|llm|neural network|robot|autonomous agent|computer vision|foundation model|inference|openai|anthropic|deepmind|hugging face|nvidia|transformer)\b/.test(text);
}

function importanceReliability(sources: Citation[]): number {
  const ranks = sources.map((source) => source.reliability === 'primary' || source.reliability === 'peer-reviewed' ? 5 : source.reliability === 'reputable-secondary' ? 3 : 1);
  return Math.round(ranks.reduce((sum, rank) => sum + rank, 0) / Math.max(1, ranks.length));
}

function parseModelJson<T>(text: string): T {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean) as T;
}

async function requestJson(url: string, body: unknown, apiKey: string): Promise<Record<string, any>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 900);
        if (response.status === 429 && /exceeded your current quota|resource_exhausted|quota.{0,30}(exceed|exhaust)/i.test(detail)) {
          throw new GeminiQuotaExceededError(`Gemini quota exhausted: ${detail}`);
        }
        if (response.status < 500 && response.status !== 429) throw new Error(`Gemini HTTP ${response.status}: ${detail}`);
        throw new Error(`Gemini HTTP ${response.status}: ${detail}`);
      }
      return await response.json() as Record<string, any>;
    } catch (error) {
      lastError = error;
      if (error instanceof GeminiQuotaExceededError) throw error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function modelOutput(interaction: Record<string, any>): { text: string; annotations: Array<Record<string, any>>; queries: string[] } {
  const steps = list<Record<string, any>>(interaction.steps);
  const blocks = steps.filter((step) => step.type === 'model_output').flatMap((step) => list<Record<string, any>>(step.content));
  const textBlocks = blocks.filter((block) => typeof block.text === 'string');
  return {
    text: textBlocks.map((block) => block.text).join('\n'),
    annotations: textBlocks.flatMap((block) => list<Record<string, any>>(block.annotations)),
    queries: steps.filter((step) => step.type === 'google_search_call').flatMap((step) => list<string>(step.arguments?.queries)),
  };
}

async function researchStory(candidate: Candidate, apiKey: string, model: string): Promise<Research> {
  const input = [
    'Research this AI news candidate using web search and report only verifiable facts.',
    'Identify the actual event and the date it happened, separately from the publication date. Check the official announcement or research paper where possible, and compare another independent credible source.',
    'Note uncertainty or material disagreement. Do not repeat long text from any source, do not invent claims, and do not treat an RSS summary as confirmation.',
    `Candidate title: ${candidate.title}`,
    `Discovery source: ${candidate.feedName} (${candidate.url})`,
    `Feed publication time: ${candidate.publishedAt.toISOString()}`,
    `Feed description (discovery context only): ${candidate.description || '(none)'}`,
  ].join('\n');
  const response = await requestJson('https://generativelanguage.googleapis.com/v1beta/interactions', { model, input, tools: [{ type: 'google_search' }] }, apiKey);
  const output = modelOutput(response);
  const citations = output.annotations.filter((annotation) => annotation.type === 'url_citation' && typeof annotation.url === 'string')
    .map((annotation): Citation => ({ title: String(annotation.title ?? new URL(annotation.url).hostname).slice(0, 120), url: String(annotation.url), reliability: 'reputable-secondary' }));
  const unique = new Map<string, Citation>();
  for (const citation of citations) {
    try {
      const url = new URL(citation.url);
      if (url.protocol === 'https:' && !/vertexaisearch|grounding-api-redirect/i.test(url.hostname)) unique.set(url.href, { ...citation, url: url.href });
    } catch { /* malformed model citation is not a source */ }
  }
  return { text: output.text, citations: [...unique.values()], queries: output.queries };
}

const DraftSchema = z.object({
  title: z.string().min(8).max(140),
  introduction: z.string().min(40).max(300),
  eventAt: z.string(),
  eventKey: z.string().min(4).max(180),
  category: z.enum(ARTICLE_CATEGORIES),
  tags: z.array(z.string().min(1).max(40)).max(12),
  importanceFactors: z.object({ affectedPeople: z.number().int().min(1).max(5), aiDevelopers: z.number().int().min(1).max(5), businesses: z.number().int().min(1).max(5), technicalSignificance: z.number().int().min(1).max(5), novelty: z.number().int().min(1).max(5), industryRelevance: z.number().int().min(1).max(5) }),
  importanceReason: z.string().min(12).max(300),
  sections: z.array(z.object({ heading: z.string(), body: z.string().min(60), sourceNumbers: z.array(z.number().int().min(1)) })).min(3).max(7),
  uncertaintyNotes: z.array(z.string()),
  contradictingReports: z.boolean(),
  sensitive: z.boolean(),
});

async function draftStory(candidate: Candidate, research: Research, citations: Citation[], apiKey: string, model: string): Promise<Draft> {
  const sourceBrief = citations.map((source, index) => `${index + 1}. ${source.title} — ${source.url} (${source.reliability})`).join('\n');
  const input = `Write an original, concise news article from the verified research below. The sources are the only evidence. Do not invent or extrapolate facts, quotations, statistics, dates, capabilities, or company statements. Do not copy source wording. Avoid a generic AI introduction and avoid repeating the same fact. Clearly separate confirmed facts from uncertainty. Use a neutral international English editorial voice.\n\nReturn only one JSON object with: title, introduction, eventAt (ISO date/time for the event itself, not discovery/publication), eventKey (stable identity for the real-world event), category (one exact category below), tags (array), importanceFactors (six integer ratings 1-5 for affectedPeople, aiDevelopers, businesses, technicalSignificance, novelty, industryRelevance), importanceReason (short explanation), sections (3-7 objects with heading, body, sourceNumbers array). Also include uncertaintyNotes (array), contradictingReports (boolean), sensitive (boolean). Each factual section must cite source numbers that support it. Use natural headings from: What Happened?, Key Highlights, Why Is This Important?, Who Will Be Affected?, Real-World Impact, What's Next? Omit headings that add no value. Do not include an Original Sources section in body.\n\nCategories: ${ARTICLE_CATEGORIES.join(' | ')}\n\nDiscovery title: ${candidate.title}\nCandidate publication date: ${candidate.publishedAt.toISOString()}\nResearch: ${research.text}\n\nVerified citation list:\n${sourceBrief}`;
  const result = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    contents: [{ parts: [{ text: input }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  }, apiKey);
  const text = list<Record<string, any>>(result.candidates)[0]?.content?.parts?.map((part: Record<string, unknown>) => part.text ?? '').join('');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Gemini returned an empty article draft');
  return DraftSchema.parse(parseModelJson<Draft>(text));
}

function slugify(title: string): string {
  return normalizeTitle(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || `ai-news-${now.getTime()}`;
}

function safeMarkdown(value: string): string {
  return value.trim().replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
}

function formatMarkdownBody(draft: Draft, citations: Citation[]): string {
  return draft.sections.map((section) => {
    const refs = [...new Set(section.sourceNumbers)].filter((number) => number <= citations.length);
    if (!refs.length) throw new Error(`Section “${section.heading}” has no valid supporting source number`);
    const links = refs.map((number) => `[${number}](${citations[number - 1]!.url})`).join(' ');
    return `## ${section.heading}\n\n${safeMarkdown(section.body)}\n\nSources: ${links}`;
  }).join('\n\n');
}

function validateBody(content: string, discoveryText: string, thresholds: AutomationSettings['qualityThresholds']): string[] {
  const issues: string[] = [];
  const words = content.replace(/\[[^\]]+\]\([^)]+\)/g, '').split(/\s+/).filter(Boolean);
  if (words.length < thresholds.minimumWords) issues.push(`Article body is too short (${words.length} words; minimum ${thresholds.minimumWords})`);
  if (words.length > thresholds.maximumWords) issues.push(`Article body is too long (${words.length} words; maximum ${thresholds.maximumWords})`);
  const paragraphs = content.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/, '').trim().toLowerCase()).filter((part) => part.length >= 80);
  if (new Set(paragraphs).size !== paragraphs.length) issues.push('Repeated paragraph detected');
  if (/as an ai language model|in today's rapidly evolving|in a rapidly evolving landscape|the world of ai is changing rapidly/i.test(content)) issues.push('Generic or suspicious boilerplate detected');
  const sourceWords = discoveryText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  const articleWords = ` ${content.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (sourceWords.length >= 12) {
    for (let index = 0; index <= sourceWords.length - 12; index += 1) {
      const phrase = ` ${sourceWords.slice(index, index + 12).join(' ')} `;
      if (articleWords.includes(phrase)) { issues.push('A long exact phrase overlaps the RSS discovery text'); break; }
    }
  }
  return issues;
}

function markdownFile(frontmatter: Record<string, unknown>, content: string): string {
  return `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${content.trim()}\n`;
}

async function readExistingArticles(): Promise<ArticleRecord[]> {
  await mkdir(articleDir, { recursive: true });
  const files = await readdir(articleDir);
  const records: ArticleRecord[] = [];
  for (const file of files.filter((entry) => entry.endsWith('.md'))) {
    try {
      const raw = await readFile(path.join(articleDir, file), 'utf8');
      const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
      if (!match) { errors.push(`Existing article ${file} has malformed frontmatter; excluded from duplicate scan`); continue; }
      const frontmatter = parseYaml(match[1]!) as Record<string, unknown>;
      const checked = ArticleFrontmatterSchema.safeParse(frontmatter);
      if (!checked.success) { errors.push(`Existing article ${file} failed schema validation; excluded from duplicate scan`); continue; }
      const article = ArticleRecordSchema.safeParse({ ...checked.data, id: file.replace(/\.md$/, ''), content: match[2] ?? '' });
      if (article.success) records.push(article.data);
    } catch (error) {
      errors.push(`Could not read existing article ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

async function validUrl(urlText: string): Promise<boolean> {
  try {
    const url = new URL(urlText);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) return false;
    let response = await fetch(url.href, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'AI-Pulse-NewsResearch/1.0' } });
    if (response.status === 405) response = await fetch(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { range: 'bytes=0-0', 'user-agent': 'AI-Pulse-NewsResearch/1.0' } });
    return response.status >= 200 && response.status < 400;
  } catch { return false; }
}

async function processCandidate(candidate: Candidate, existing: ArticleRecord[], apiKey: string, model: string, settings: AutomationSettings): Promise<'published' | 'pending' | 'rejected' | 'duplicate'> {
  const seed: ArticleRecord = {
    id: slugify(candidate.title), slug: slugify(candidate.title), title: candidate.title.slice(0, 140),
    introduction: (candidate.description || candidate.title).padEnd(40, ' ').slice(0, 300), category: candidate.category,
    tags: [], eventAt: candidate.publishedAt, publishedAt: now, importanceLevel: 'LOW', importanceScore: 1,
    importanceFactors: { affectedPeople: 1, aiDevelopers: 1, businesses: 1, technicalSignificance: 1, novelty: 1, industryRelevance: 1, sourceReliability: candidate.reliability === 'primary' || candidate.reliability === 'peer-reviewed' ? 5 : candidate.reliability === 'reputable-secondary' ? 3 : 1 },
    importanceReason: 'Discovery record used for duplicate checking.', sources: [{ name: candidate.feedName, url: candidate.url, reliability: candidate.reliability }], status: 'PENDING', isFeatured: false, content: '',
  };
  if (findDuplicate(seed, existing)) { counters.duplicatesRejected += 1; return 'duplicate'; }
  let research: Research;
  try { research = await researchStory(candidate, apiKey, model); }
  catch (error) {
    const message = `Research failed for “${candidate.title}”: ${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof GeminiQuotaExceededError) throw new GeminiQuotaExceededError(message);
    throw new Error(message);
  }
  if (!research.text || !research.citations.length) { counters.articlesRejected += 1; return 'rejected'; }
  const citationsByUrl = new Map<string, Citation>();
  const discoveryCitation: Citation = { title: candidate.feedName, url: candidate.url, reliability: candidate.reliability };
  citationsByUrl.set(normalizeSourceUrl(candidate.url), discoveryCitation);
  const reliabilityRank: Record<Citation['reliability'], number> = { primary: 5, 'peer-reviewed': 5, 'reputable-secondary': 3, other: 1 };
  for (const citation of research.citations) {
    const key = normalizeSourceUrl(citation.url);
    const current = citationsByUrl.get(key);
    if (!current || reliabilityRank[citation.reliability] > reliabilityRank[current.reliability]) citationsByUrl.set(key, citation);
  }
  const citations = [...citationsByUrl.values()].slice(0, 8);
  const draft = await draftStory(candidate, research, citations, apiKey, model);
  counters.articlesGenerated += 1;
  const eventAt = new Date(draft.eventAt);
  if (!Number.isFinite(eventAt.getTime()) || eventAt.getTime() > now.getTime() + 60_000) { counters.articlesRejected += 1; return 'rejected'; }
  const sources = citations.map(({ title, url, reliability }) => ({ name: title, url, reliability }));
  const sourceReliability = importanceReliability(citations);
  const importanceFactors: ImportanceFactors = { ...draft.importanceFactors, sourceReliability };
  const importanceScore = scoreImportance(importanceFactors);
  const content = formatMarkdownBody(draft, citations);
  const bodyIssues = validateBody(content, candidate.description, settings.qualityThresholds);
  const allUrlsValid = await Promise.all(sources.map((source) => validUrl(source.url)));
  const linkIssues = allUrlsValid.some((isValid) => !isValid);
  const articleStatus = settings.automaticPublishingEnabled && importanceScore >= settings.minimumImportanceScore && !bodyIssues.length && !linkIssues && sources.length >= settings.researchRequirements.minimumSources && sources.some(({ reliability }) => reliability === 'primary' || reliability === 'peer-reviewed') && !draft.uncertaintyNotes.length && !draft.contradictingReports && !draft.sensitive && importanceScore < settings.manualReview.highImpactScore ? 'PUBLISHED' : 'PENDING';
  const titleSlug = slugify(draft.title);
  const articleFrontmatter = {
    slug: titleSlug,
    title: draft.title,
    introduction: draft.introduction,
    category: draft.category,
    tags: [...new Set(draft.tags)].slice(0, 12),
    eventAt,
    publishedAt: now,
    importanceLevel: importanceLevelForScore(importanceScore),
    importanceScore,
    importanceFactors,
    importanceReason: draft.importanceReason,
    sources,
    status: articleStatus,
    isFeatured: false,
    eventKey: draft.eventKey.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 180),
  };
  const checked = ArticleFrontmatterSchema.safeParse(articleFrontmatter);
  if (!checked.success) { counters.articlesRejected += 1; return 'rejected'; }
  const finalRecord = ArticleRecordSchema.safeParse({ ...checked.data, id: titleSlug, content });
  if (!finalRecord.success) { counters.articlesRejected += 1; return 'rejected'; }
  if (findDuplicate(finalRecord.data, existing)) { counters.duplicatesRejected += 1; return 'duplicate'; }
  const outputPath = path.join(articleDir, `${titleSlug}.md`);
  try { await readFile(outputPath); counters.duplicatesRejected += 1; return 'duplicate'; }
  catch { /* new file path */ }
  await writeFile(outputPath, markdownFile(checked.data as unknown as Record<string, unknown>, content), 'utf8');
  existing.push(finalRecord.data);
  if (articleStatus === 'PUBLISHED') { counters.articlesApproved += 1; counters.articlesPublished += 1; return 'published'; }
  counters.heldForReview += 1;
  if (bodyIssues.length) errors.push(`Held “${draft.title}” for review: ${bodyIssues.join('; ')}`);
  if (linkIssues) errors.push(`Held “${draft.title}” for review: one or more source links could not be checked successfully`);
  return 'pending';
}

function markdownSummary(feedStatuses: Array<Record<string, unknown>>): string {
  const feedLines = feedStatuses.map((status) => `| ${status.name} | ${status.enabled ? (status.errorInformation ? 'Error' : 'OK') : 'Disabled'} | ${status.storiesFound ?? 0} | ${status.lastSuccessfulFetch ?? 'never'} | ${String(status.errorInformation ?? '').replaceAll('|', '\\|') || '—'} |`);
  return [
    '# AI Pulse automation summary', '',
    `- Feeds checked: ${counters.feedsChecked}`,
    `- Stories discovered: ${counters.storiesDiscovered}`,
    `- Candidates deferred after quota/rate limit: ${counters.candidatesDeferred}`,
    `- Candidate processing errors: ${counters.candidateProcessingErrors}`,
    `- Duplicate stories rejected: ${counters.duplicatesRejected}`,
    `- Articles generated: ${counters.articlesGenerated}`,
    `- Articles approved for automatic publication: ${counters.articlesApproved}`,
    `- Articles held for manual review: ${counters.heldForReview}`,
    `- Articles rejected: ${counters.articlesRejected}`,
    `- Articles published: ${counters.articlesPublished}`,
    `- Errors encountered: ${errors.length}`,
    '', '| Feed | Status | Stories | Last successful fetch | Error |', '| --- | --- | ---: | --- | --- |', ...feedLines,
    '', '## Errors', '', ...(errors.length ? errors.map((error) => `- ${error}`) : ['- None']), '',
  ].join('\n');
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required. Configure it as a GitHub Actions secret before running the pipeline.');
  let settings: AutomationSettings;
  try { settings = AutomationSettingsSchema.parse(JSON.parse(await readFile('automation/settings.json', 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') settings = DEFAULT_AUTOMATION_SETTINGS;
    else throw new Error(`Automation settings are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const model = settings.model || process.env.GEMINI_MODEL || DEFAULT_AUTOMATION_SETTINGS.model;
  const registry = z.array(RegistryEntrySchema).parse(JSON.parse(await readFile(sourceFiles, 'utf8')))
    .filter((source) => settings.enabledCategories.includes(source.category));
  let previousStatus: PersistedSourceStatus = {};
  try { previousStatus = await loadPersistedStatus(); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const previousByName = new Map((previousStatus.sources ?? []).map((source) => [String(source.name), source]));
  const enabledSources = registry.filter((source) => source.enabled);
  counters.feedsChecked = enabledSources.length;
  const results = await Promise.all(registry.map((source) => fetchFeed(source, previousByName.get(source.name))));
  const feedStatuses = results.map(({ status }) => status);
  let candidates = results.flatMap(({ candidates }) => candidates).filter(isRelevant);
  const windowHours = Number(process.env.DISCOVERY_WINDOW_HOURS || 96);
  candidates = candidates.filter(({ publishedAt }) => publishedAt.getTime() <= now.getTime() + 60_000 && (now.getTime() - publishedAt.getTime()) / 3_600_000 <= windowHours);
  candidates.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  const seenUrls = new Set<string>();
  candidates = candidates.filter((candidate) => {
    const url = new URL(candidate.url); url.hash = ''; url.searchParams.delete('utm_source');
    if (seenUrls.has(url.href)) return false;
    seenUrls.add(url.href); return true;
  });
  counters.storiesDiscovered = candidates.length;
  const maxCandidates = settings.maximumCandidatesPerRun;
  candidates = candidates.slice(0, maxCandidates);
  const existing = await readExistingArticles();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    try { await processCandidate(candidate, existing, apiKey, model, settings); }
    catch (error) {
      counters.candidateProcessingErrors += 1;
      errors.push(error instanceof Error ? error.message : String(error));
      if (error instanceof GeminiQuotaExceededError) {
        counters.candidatesDeferred += candidates.length - index - 1;
        break;
      }
    }
  }
  const runSummary = { ...counters, errors: [...errors], startedAt: now.toISOString(), completedAt: new Date().toISOString(), status: errors.length ? 'completed_with_errors' : 'success' };
  await writeFile(stateFile, `${JSON.stringify({ generatedAt: now.toISOString(), summary: runSummary, sources: feedStatuses }, null, 2)}\n`, 'utf8');
  try { await persistStatusBranch({ generatedAt: now.toISOString(), summary: runSummary, sources: feedStatuses }); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const summary = markdownSummary(feedStatuses);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  if (errors.length > 0 && counters.feedsChecked > 0 && feedStatuses.every((status) => Boolean(status.errorInformation))) {
    throw new Error('All enabled RSS feeds failed; inspect the automation summary.');
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  process.stderr.write(`AI Pulse pipeline failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `\n## Fatal pipeline error\n\n${message}\n`, { flag: 'a' }).catch(() => undefined);
  process.exitCode = 1;
});
