import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { ARTICLE_CATEGORIES, ArticleFrontmatterSchema } from '../src/lib/article-schema.ts';
import { freshnessLabel } from '../src/lib/article-rules.ts';
import { AutomationSettingsSchema, DEFAULT_AUTOMATION_SETTINGS } from '../automation/settings.ts';
// @ts-ignore Generated immediately before Wrangler bundles the Worker.
import { ADMIN_HTML } from './admin-page.ts';

interface Env {
  ACCESS_AUD: string;
  ADMIN_EMAIL: string;
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  DEFAULT_BRANCH: string;
  SITE_ORIGIN: string;
}
interface AccessIdentity { email?: string }
interface AccessContext {
  access?: { aud: string | string[]; getIdentity(): Promise<AccessIdentity> };
}

const ReliabilitySchema = z.enum(['primary', 'peer-reviewed', 'reputable-secondary', 'other']);
const SourceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  feedUrl: z.string().url().max(2048),
  category: z.enum(ARTICLE_CATEGORIES),
  enabled: z.boolean(),
  reliability: ReliabilitySchema,
  lastSuccessfulFetch: z.string().datetime().nullable().optional(),
  errorInformation: z.string().max(500).nullable().optional(),
}).strict();
const SettingsSchema = AutomationSettingsSchema;
type Settings = z.infer<typeof SettingsSchema>;
type GitFile = { content: string; sha: string };
type Article = z.infer<typeof ArticleFrontmatterSchema> & { id: string; content: string };

const defaultSettings: Settings = DEFAULT_AUTOMATION_SETTINGS;

const headersFor = (request: Request, env: Env): Headers => {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  const origin = request.headers.get('origin');
  if (origin === env.SITE_ORIGIN || origin === new URL(request.url).origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('vary', 'Origin');
  }
  return headers;
};

function json(request: Request, env: Env, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: headersFor(request, env) });
}

function sanitizeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  return message.replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/AIza[\w-]{20,}/g, '[redacted key]')
    .slice(0, 500);
}

function safeRepository(env: Env): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('Worker repository configuration is invalid');
  return env.GITHUB_REPOSITORY;
}

function encodedRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function githubRequest(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  const repository = safeRepository(env);
  try {
    return await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const method = (init.method ?? 'GET').toUpperCase();
    const endpoint = `/repos/${repository}/${path}`;
    const reason = error instanceof Error ? error.message : 'network request failed';
    throw new Error(`GitHub ${method} ${endpoint} could not be reached: ${reason}`);
  }
}

async function githubFailure(response: Response, path: string, env: Env, method = 'GET'): Promise<Error> {
  const endpoint = `/repos/${safeRepository(env)}/${path}`;
  let detail = '';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string') detail = `: ${body.message}`;
  } catch {
    // GitHub may return an empty or non-JSON error response.
  }
  const acceptedPermissions = response.headers.get('x-accepted-github-permissions');
  const sso = response.headers.get('x-github-sso');
  const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
  const rateLimitReset = response.headers.get('x-ratelimit-reset');
  const resetTimestamp = rateLimitReset ? Number(rateLimitReset) : NaN;
  const resetAt = Number.isFinite(resetTimestamp) ? new Date(resetTimestamp * 1000).toISOString() : '';
  const diagnostics = [
    acceptedPermissions ? `GitHub requires permissions: ${acceptedPermissions}` : '',
    sso ? `GitHub SSO status: ${sso}` : '',
    rateLimitRemaining === '0' ? `GitHub API rate limit is exhausted${resetAt ? `; reset at ${resetAt}` : ''}` : '',
  ].filter(Boolean);
  const diagnosticText = diagnostics.length ? ` (${diagnostics.join('; ')})` : '';
  return new Error(`GitHub ${method} ${endpoint} returned HTTP ${response.status}${detail}${diagnosticText}`);
}

async function githubJson<T>(path: string, env: Env, init: RequestInit = {}): Promise<T> {
  const response = await githubRequest(path, env, init);
  if (!response.ok) throw await githubFailure(response, path, env, (init.method ?? 'GET').toUpperCase());
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function readGitFile(filePath: string, env: Env, branch = env.DEFAULT_BRANCH): Promise<GitFile | null> {
  const query = new URLSearchParams({ ref: branch });
  const path = `contents/${encodedRepoPath(filePath)}?${query}`;
  const response = await githubRequest(path, env);
  if (response.status === 404) return null;
  if (!response.ok) throw await githubFailure(response, path, env);
  const result = await response.json() as { content?: string; encoding?: string; sha?: string };
  if (!result.content || result.encoding !== 'base64' || !result.sha) throw new Error(`GitHub returned an unreadable file for ${filePath}`);
  const binary = atob(result.content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return { content: new TextDecoder().decode(bytes), sha: result.sha };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function writeGitFile(filePath: string, content: string, message: string, env: Env): Promise<void> {
  const existing = await readGitFile(filePath, env);
  const result = await githubRequest(`contents/${encodedRepoPath(filePath)}`, env, {
    method: 'PUT',
    body: JSON.stringify({ message, content: toBase64(content), branch: env.DEFAULT_BRANCH, ...(existing ? { sha: existing.sha } : {}) }),
  });
  if (!result.ok) throw await githubFailure(result, `contents/${encodedRepoPath(filePath)}`, env, 'PUT');
}

async function deleteGitFile(filePath: string, message: string, env: Env): Promise<void> {
  const existing = await readGitFile(filePath, env);
  if (!existing) throw new Error('That file no longer exists. Reload the dashboard.');
  const response = await githubRequest(`contents/${encodedRepoPath(filePath)}`, env, {
    method: 'DELETE', body: JSON.stringify({ message, sha: existing.sha, branch: env.DEFAULT_BRANCH }),
  });
  if (!response.ok) throw await githubFailure(response, `contents/${encodedRepoPath(filePath)}`, env, 'DELETE');
}

function parseArticle(fileName: string, raw: string): Article {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`Article ${fileName} has invalid frontmatter`);
  const frontmatter = ArticleFrontmatterSchema.parse(parseYaml(match[1]!));
  return { ...frontmatter, id: fileName.replace(/\.md$/, ''), content: match[2] ?? '' };
}

async function listArticles(env: Env): Promise<Article[]> {
  const rows = await githubJson<Array<{ name: string; path: string; type: string }>>(`contents/src/content/articles?ref=${encodeURIComponent(env.DEFAULT_BRANCH)}`, env);
  const files = rows.filter((row) => row.type === 'file' && row.name.endsWith('.md'));
  const records = await Promise.all(files.map(async (file) => {
    const raw = await readGitFile(file.path, env);
    return raw ? parseArticle(file.name, raw.content) : null;
  }));
  return records.filter((record): record is Article => record !== null);
}

async function listWorkflowRuns(env: Env, perPage = 10): Promise<Array<Record<string, any>>> {
  const response = await githubJson<{ workflow_runs?: Array<Record<string, any>> }>(`actions/workflows/news-pipeline.yml/runs?per_page=${perPage}`, env);
  return response.workflow_runs ?? [];
}

async function sourceStatus(env: Env): Promise<Record<string, any> | null> {
  try {
    const file = await readGitFile('automation/source-status.json', env, 'ai-pulse-automation-state');
    return file ? JSON.parse(file.content) as Record<string, any> : null;
  } catch { return null; }
}

async function latestDeploymentStatus(env: Env): Promise<Array<Record<string, unknown>>> {
  try {
    const commits = await githubJson<Array<Record<string, any>>>(`commits?path=src/content/articles&per_page=1`, env);
    const sha = commits[0]?.sha;
    if (typeof sha !== 'string') return [];
    const statuses = await githubJson<Array<Record<string, any>>>(`commits/${encodeURIComponent(sha)}/statuses`, env);
    return statuses.map((status) => ({ context: String(status.context ?? 'Deployment'), state: String(status.state ?? 'unknown'), description: String(status.description ?? ''), updatedAt: status.updated_at ?? null, url: status.target_url ?? null }));
  } catch { return []; }
}

function mondayUtc(date: Date): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - ((day + 6) % 7));
  return start;
}

function nextScheduledRun(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 17));
  if (next <= now || next.getUTCHours() % 2 !== 0) {
    next.setUTCHours(next.getUTCHours() + (next.getUTCHours() % 2 === 0 ? 2 : 1));
    if (next.getUTCHours() >= 24) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

async function getOverview(env: Env): Promise<Record<string, unknown>> {
  const [articles, runs, status] = await Promise.all([listArticles(env), listWorkflowRuns(env, 10), sourceStatus(env)]);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = mondayUtc(now).getTime();
  const published = articles.filter((article) => article.status === 'PUBLISHED');
  const latestRun = runs[0] ?? null;
  let activity: Array<Record<string, unknown>> = [];
  try {
    activity = await githubJson<Array<Record<string, any>>>(`commits?path=src/content/articles&per_page=8`, env)
      .then((commits) => commits.map((commit) => ({ message: String(commit.commit?.message ?? '').split('\n')[0], author: String(commit.commit?.author?.name ?? 'Unknown'), at: commit.commit?.author?.date ?? null, url: commit.html_url })));
  } catch { /* Overview remains useful if activity history is unavailable. */ }
  return {
    counts: {
      published: published.length,
      pending: articles.filter((article) => article.status === 'PENDING').length,
      rejected: articles.filter((article) => article.status === 'REJECTED').length,
      today: published.filter((article) => article.publishedAt.getTime() >= today).length,
      thisWeek: published.filter((article) => article.publishedAt.getTime() >= monday).length,
    },
    latestRun: latestRun ? publicRun(latestRun) : null,
    nextScheduledRun: nextScheduledRun(now),
    runSummary: status?.summary ?? null,
    sourceStatuses: status?.sources ?? [],
    recentActivity: activity,
  };
}

function publicRun(run: Record<string, any>): Record<string, unknown> {
  return { id: run.id, name: run.name ?? 'AI Pulse news pipeline', status: run.status, conclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url, runNumber: run.run_number };
}

function safeUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Enter a valid feed URL.'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipLiteral = host.includes(':') || /^\d+(?:\.\d+){0,3}$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || ipLiteral || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Feed URLs must use public HTTPS addresses.');
  }
  return url;
}

async function readResponseLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('Feed is larger than the 1 MB validation limit.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw new Error('Feed is larger than the 1 MB validation limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function validateFeed(rawUrl: string): Promise<Record<string, unknown>> {
  let url = safeUrl(rawUrl);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Feed returned a redirect without a destination.');
      url = safeUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}.`);
    const text = await readResponseLimited(response, 1_000_000);
    if (!/<(?:rss|feed|rdf:rdf)\b/i.test(text.slice(0, 12_000))) throw new Error('The URL responded, but it does not look like an RSS or Atom feed.');
    return { valid: true, finalUrl: url.href, message: 'Feed is reachable and contains RSS or Atom XML.' };
  }
  throw new Error('Feed redirected too many times.');
}

async function readSettings(env: Env): Promise<Settings> {
  const file = await readGitFile('automation/settings.json', env);
  return file ? SettingsSchema.parse(JSON.parse(file.content)) : defaultSettings;
}

async function handleApi(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/admin-api/, '').replace(/\/+$/, '') || '/admin';
  if (pathname === '/admin/overview' && request.method === 'GET') return json(request, env, { ...(await getOverview(env)), adminEmail: identity.email });
  if (pathname === '/admin/articles' && request.method === 'GET') {
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const importance = url.searchParams.get('importance');
    const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const articles = await listArticles(env);
    const filtered = articles.filter((article) => (!status || article.status === status) && (!category || article.category === category)
      && (!importance || article.importanceLevel === importance) && (!search || `${article.title} ${article.introduction}`.toLowerCase().includes(search)))
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    return json(request, env, filtered.map(({ content: _content, ...article }) => ({ ...article, freshness: freshnessLabel(article.eventAt) })));
  }
  const articleMatch = pathname.match(/^\/admin\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (articleMatch) {
    const slug = articleMatch[1]!;
    const filePath = `src/content/articles/${slug}.md`;
    if (request.method === 'GET') {
      const file = await readGitFile(filePath, env);
      if (!file) return json(request, env, { error: 'Article not found.' }, 404);
      return json(request, env, { article: parseArticle(`${slug}.md`, file.content) });
    }
    if (request.method === 'PUT') {
      const payload = await readBody(request);
      const checked = ArticleFrontmatterSchema.safeParse(payload.frontmatter);
      if (!checked.success) return json(request, env, { error: 'Article metadata failed validation.', details: checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }, 422);
      if (checked.data.slug !== slug) return json(request, env, { error: 'Article slug cannot be changed here.' }, 422);
      if (typeof payload.content !== 'string' || payload.content.trim().split(/\s+/).length < 40 || payload.content.length > 100_000) return json(request, env, { error: 'Markdown must contain at least 40 words and be under 100 KB.' }, 422);
      const current = await readGitFile(filePath, env);
      if (!current) return json(request, env, { error: 'Article not found. Reload the table.' }, 404);
      await writeGitFile(filePath, `---\n${stringifyYaml(checked.data).trim()}\n---\n\n${payload.content.trim()}\n`, `admin: edit article ${slug}`, env);
      return json(request, env, { message: 'Article saved.' });
    }
    if (request.method === 'POST' && (url.pathname.endsWith('/approve') || url.pathname.endsWith('/reject'))) {
      return json(request, env, { error: 'Use /approve or /reject article action route.' }, 404);
    }
    if (request.method === 'DELETE') {
      const payload = await readBody(request);
      const file = await readGitFile(filePath, env);
      if (!file) return json(request, env, { error: 'Article not found.' }, 404);
      const article = parseArticle(`${slug}.md`, file.content);
      if (payload.confirmTitle !== article.title) return json(request, env, { error: 'Confirmation title does not match the article.' }, 400);
      await deleteGitFile(filePath, `admin: delete article ${slug}`, env);
      return json(request, env, { message: 'Article deleted.' });
    }
  }
  const statusAction = pathname.match(/^\/admin\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(approve|reject)$/);
  if (statusAction && request.method === 'POST') {
    const slug = statusAction[1]!;
    const nextStatus = statusAction[2] === 'approve' ? 'PUBLISHED' : 'REJECTED';
    const filePath = `src/content/articles/${slug}.md`;
    const file = await readGitFile(filePath, env);
    if (!file) return json(request, env, { error: 'Article not found.' }, 404);
    const article = parseArticle(`${slug}.md`, file.content);
    if (article.status !== 'PENDING') return json(request, env, { error: 'Only pending articles can be approved or rejected.' }, 409);
    const { content, id: _id, ...frontmatter } = article;
    const next = ArticleFrontmatterSchema.parse({ ...frontmatter, status: nextStatus });
    await writeGitFile(filePath, `---\n${stringifyYaml(next).trim()}\n---\n\n${content.trim()}\n`, `admin: ${nextStatus === 'PUBLISHED' ? 'approve' : 'reject'} article ${slug}`, env);
    return json(request, env, { message: nextStatus === 'PUBLISHED' ? 'Article published.' : 'Article rejected.' });
  }
  if (pathname === '/admin/sources' && request.method === 'GET') {
    const file = await readGitFile('automation/sources.json', env);
    const sources = z.array(SourceSchema).parse(file ? JSON.parse(file.content) : []);
    const status = await sourceStatus(env);
    const byName = new Map((status?.sources ?? []).map((entry: Record<string, any>) => [String(entry.name), entry]));
    return json(request, env, sources.map((source) => ({ ...source, ...(byName.get(source.name) ?? {}) })));
  }
  if (pathname === '/admin/sources' && request.method === 'PUT') {
    const payload = await readBody(request);
    const checked = z.array(SourceSchema).min(1).max(100).parse(payload.sources);
    const names = new Set<string>();
    const urls = new Set<string>();
    for (const source of checked) {
      const url = safeUrl(source.feedUrl);
      if (names.has(source.name.toLowerCase()) || urls.has(url.href)) throw new Error('Source names and URLs must be unique.');
      names.add(source.name.toLowerCase()); urls.add(url.href);
    }
    const existingFile = await readGitFile('automation/sources.json', env);
    const existing = existingFile ? z.array(SourceSchema).parse(JSON.parse(existingFile.content)) : [];
    const prior = new Map(existing.map((source) => [source.name, source]));
    const output = checked.map((source) => {
      const old = prior.get(source.name);
      return { ...source, lastSuccessfulFetch: old?.lastSuccessfulFetch ?? null, errorInformation: old?.errorInformation ?? null };
    });
    await writeGitFile('automation/sources.json', `${JSON.stringify(output, null, 2)}\n`, 'admin: update news source registry', env);
    return json(request, env, { message: 'News sources saved.' });
  }
  if (pathname === '/admin/sources/validate' && request.method === 'POST') {
    const payload = await readBody(request);
    if (typeof payload.url !== 'string') return json(request, env, { error: 'Feed URL is required.' }, 400);
    return json(request, env, await validateFeed(payload.url));
  }
  if (pathname === '/admin/settings' && request.method === 'GET') return json(request, env, await readSettings(env));
  if (pathname === '/admin/settings' && request.method === 'PUT') {
    const payload = await readBody(request);
    const checked = SettingsSchema.safeParse(payload);
    if (!checked.success) return json(request, env, { error: 'Settings failed validation.', details: checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }, 422);
    await writeGitFile('automation/settings.json', `${JSON.stringify(checked.data, null, 2)}\n`, 'admin: update automation settings', env);
    return json(request, env, { message: 'AI settings saved.' });
  }
  if (pathname === '/admin/automation' && request.method === 'GET') {
    const [runs, status] = await Promise.all([listWorkflowRuns(env, 10), sourceStatus(env)]);
    return json(request, env, { runs: runs.map(publicRun), summary: status?.summary ?? null, sources: status?.sources ?? [] });
  }
  if (pathname === '/admin/automation/run' && request.method === 'POST') {
    const payload = await readBody(request);
    if (payload.confirm !== true) return json(request, env, { error: 'Confirm before starting automation.' }, 400);
    const body = { ref: env.DEFAULT_BRANCH };
    const path = 'actions/workflows/news-pipeline.yml/dispatches';
    const response = await githubRequest(path, env, { method: 'POST', body: JSON.stringify(body) });
    if (response.status !== 204) throw await githubFailure(response, path, env, 'POST');
    return json(request, env, { message: 'Automation started. This page will update as the run progresses.' }, 202);
  }
  if (pathname === '/admin/logs' && request.method === 'GET') {
    const [runs, status, deployments] = await Promise.all([listWorkflowRuns(env, 20), sourceStatus(env), latestDeploymentStatus(env)]);
    return json(request, env, { runs: runs.map(publicRun), summary: status?.summary ?? null, sources: status?.sources ?? [], deployments });
  }
  if (pathname === '/admin/settings/security' && request.method === 'GET') return json(request, env, { accessEmail: identity.email, repository: safeRepository(env), branch: env.DEFAULT_BRANCH });
  return json(request, env, { error: 'Admin endpoint not found.' }, 404);
}

async function readBody(request: Request): Promise<Record<string, any>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('Send request data as JSON.');
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 1_000_000) throw new Error('Request body is too large.');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 1_000_000) throw new Error('Request body is too large.');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be a JSON object.');
  return parsed as Record<string, any>;
}

export default {
  async fetch(request: Request, env: Env, ctx: AccessContext): Promise<Response> {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') {
      if (origin !== env.SITE_ORIGIN && origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
      const headers = headersFor(request, env);
      headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('access-control-allow-headers', 'content-type');
      headers.set('access-control-max-age', '600');
      return new Response(null, { status: 204, headers });
    }
    if (origin && origin !== env.SITE_ORIGIN && origin !== new URL(request.url).origin) return json(request, env, { error: 'Request origin is not allowed.' }, 403);
    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname === '/admin/')) {
      return new Response(ADMIN_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
    }
    if (!pathname.startsWith('/admin-api/')) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    if (!env.ACCESS_AUD || !env.ADMIN_EMAIL || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !env.DEFAULT_BRANCH || !env.SITE_ORIGIN) {
      return json(request, env, { error: 'Admin API is not configured yet.' }, 503);
    }
    if (!ctx.access) return json(request, env, { error: 'Cloudflare Access sign-in is required.' }, 401);
    const audiences = Array.isArray(ctx.access.aud) ? ctx.access.aud : [ctx.access.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return json(request, env, { error: 'Cloudflare Access audience did not match.' }, 403);
    const identity = await ctx.access.getIdentity();
    if (!identity.email || identity.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return json(request, env, { error: 'This dashboard is restricted to its owner.' }, 403);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return json(request, env, { error: 'Method not allowed.' }, 405);
    try { return await handleApi(request, env, identity); }
    catch (error) {
      const message = sanitizeMessage(error);
      const status = error instanceof z.ZodError ? 422 : message.includes('does not exist') || message.includes('not found') ? 404 : 400;
      console.error('AI Pulse admin operation failed', { method: request.method, path: new URL(request.url).pathname, message });
      return json(request, env, { error: message }, status);
    }
  },
};
