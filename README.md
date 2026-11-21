# AI Pulse


AI Pulse is a static Astro publication foundation for sourced AI and technology reporting. Articles live as Markdown in Git and are validated by an Astro Content Collection. The public site has no database or runtime API.

## Requirements

- Node.js 22.6 or later (Node 22 LTS or newer; tests use Node's built-in TypeScript stripping)
- npm

## Install and develop

```sh
npm install
npm run dev
```

Open the local URL printed by Astro. To check types and build the static site:

```sh
npm run check
npm run build
npm run preview
```

The build creates `dist/`, then Pagefind indexes the generated pages into `dist/pagefind/`. Cloudflare Pages can serve the `dist` directory as a static site; set the build command to `npm run build` and output directory to `dist`.

## Add an article

Create `src/content/articles/<file-name>.md` with valid frontmatter. The file name provides Astro's internal content id; `slug` provides its public `/news/<slug>/` route. Categories are centrally configured in `src/lib/article-schema.ts`. Replace every example value with verified reporting:

```md
---
slug: verified-ai-development
title: "A verified development in artificial intelligence"
introduction: "A concise, sourced introduction that explains the verified development and why it may matter to readers."
category: AI Models & Research
tags: [research]
eventAt: 2026-01-15T09:00:00Z
publishedAt: 2026-01-15T12:00:00Z
importanceLevel: MEDIUM
importanceScore: 3
importanceFactors:
  affectedPeople: 3
  aiDevelopers: 3
  businesses: 3
  technicalSignificance: 3
  novelty: 3
  industryRelevance: 3
  sourceReliability: 5
importanceReason: "Broad developer relevance with moderate technical novelty."
sources:
  - name: Official announcement
    url: https://example.org/announcement
    reliability: primary
status: PENDING
isFeatured: false
eventKey: organization-model-release-2026
---

Article body in Markdown with links to primary sources and clear attribution.
```

`PENDING` and `REJECTED` entries stay private. Set `status: PUBLISHED` only after source checks and editorial review. Keep `publishedAt` unchanged when updating an existing story, and change `updatedAt` for substantive updates. `eventAt` records when the reported event happened and drives freshness; importing or rewriting a story must not reset it. `isFeatured` is the manual homepage feature switch.

The importance score is validated against the mean of seven 1–5 factors: affected people, AI developers, businesses, technical significance, novelty, industry relevance, and source reliability. Source reliability is also checked against the listed source classes (`primary`/`peer-reviewed` = 5, `reputable-secondary` = 3, `other` = 1). The rounded mean maps to levels: 5 CRITICAL, 4 HIGH, 3 MEDIUM, and 1–2 LOW. `importanceReason` records the short editorial explanation. These factors provide a consistent rubric for an AI or human editor; the schema rejects mismatched values.

`eventKey` is a stable identity for a real-world announcement or event. The duplicate detector also compares normalized titles, title similarity, source URLs, category, tags, and event dates. Reuse the existing article for material updates where it remains the same story.

Freshness is computed from `eventAt` and the current time in TypeScript: under 6 hours BREAKING, 6–24 hours LATEST, 1–7 days RECENT, and older than 7 days OLDER. It is never stored in frontmatter. Latest News prominently shows articles published within 7 days; the archive retains all published articles, including items older than 30 days.

## Search, feeds, and SEO

- `@astrojs/sitemap` emits a sitemap from the canonical site URL in `astro.config.mjs`.
- `/rss.xml` exposes published articles; update `site` in Astro config and `public/robots.txt` when using a different domain.
- Pagefind indexes the static build and the search page queries that local index. Search only includes published generated pages.
- Canonical URLs, descriptions, page titles, language, and RSS discovery links are provided by the shared layout.
- Freshness and importance use separate fields and calculations. Breaking news is filtered at view time; no trending list is shown because visitor analytics are not configured.

## Editorial checks

```sh
npm test
npm run check
npm run build
```

## Automated news pipeline

The scheduled pipeline lives in `.github/workflows/news-pipeline.yml` and runs every two hours at minute 17 UTC, with a manual **Run workflow** option. GitHub scheduled runs use the latest commit on the repository's default branch and can be delayed during busy periods, so the interval is a target rather than a precise clock. The workflow is inactive until this file is pushed to the default branch and Actions is enabled.

Before enabling it, add `GEMINI_API_KEY` under **Repository Settings → Secrets and variables → Actions → New repository secret**. The workflow supplies GitHub's repository-scoped token for article commits and feed-status persistence. It requests `contents: write`; repository or organization policy must allow that permission. Optionally set the Actions variable `GEMINI_MODEL` to choose a model. The default is `gemini-3.8-flash` and can be changed without editing the workflow.

Edit `automation/sources.json` to enable/disable feeds, change their category, or set their reliability class. The included starter registry uses official OpenAI, Google DeepMind, and Hugging Face blogs plus arXiv AI and machine-learning feeds. RSS is treated as discovery metadata; the pipeline does not copy feed images or full article text. Gemini uses Google Search grounding for research, keeps citations, and drafts from the gathered evidence. The direct Gemini REST calls and Google Search grounding behavior are documented by [Google AI for Developers](https://ai.google.dev/gemini-api/docs/google-search).

There is no publication quota. The pipeline checks up to 20 newest relevant candidates per run by default to bound runtime and model usage; set `MAX_CANDIDATES_PER_RUN` to adjust that ceiling. `DISCOVERY_WINDOW_HOURS` defaults to 96. If Gemini reports exhausted quota, the run stops trying more candidates and reports how many were deferred, instead of retrying the same unavailable service for every story. A story is automatically marked `PUBLISHED` only if it passes schema and content checks, has at least two source links including a primary source, the links respond successfully to a conservative HEAD check, and the model reports no uncertainty, conflict, or sensitivity. The model's confidence is not used. Valid stories that do not satisfy every gate are stored as `PENDING`; malformed, undated, unsupported, or duplicate stories are rejected. Importance score and level are computed in TypeScript from the six model-suggested editorial factors plus source reliability.

The pipeline stores the latest feed status in the `ai-pulse-automation-state` branch, separate from the production branch, and attaches a 30-day JSON status artifact to each workflow run. This records each feed's last successful fetch and most recent error without triggering a Pages deployment for every feed check. Generated Markdown is committed to the default branch; if Cloudflare Pages is connected to that branch, the commit triggers the site build. Configure Pages to deploy the production branch only; the status branch is operational data.

The article file cap, retry limits, and conservative review gate control work per run, but do not guarantee costs. Gemini model and Google Search grounding usage are subject to Google's current pricing and quota terms; GitHub Actions and artifact usage are subject to the repository's plan. Check provider dashboards before relying on free-tier availability. Scheduled GitHub Actions run from the default branch and may be delayed during load; see [GitHub's workflow schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) and [token permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

## Environment and secrets

Copy `.env.example` to `.env` for local use. `SITE_URL`, `GEMINI_API_KEY`, and `GEMINI_MODEL` are typed in `src/env.d.ts`. Never expose keys with an Astro `PUBLIC_` prefix or commit `.env`. To run the automation locally, set `GEMINI_API_KEY`; `GITHUB_TOKEN` and `GITHUB_REPOSITORY` are only needed to persist the source-status file to the state branch. Local runs should avoid committing the generated `PENDING` content until an editor reviews it.

## Deployment and cost notes

The site remains static and database-free. Cloudflare Pages' free plan has usage/build limits that may change; consult Cloudflare's current plan documentation before relying on specific quotas. Static hosting avoids an always-on application server. The Cloudflare adapter dependency is available for a future Worker-backed feature, but is not required for this static Pages build. Private admin operations and Cloudflare Access are separate future phases.

Pagefind and the project dependencies are open source. Gemini API and Google Search grounding may incur charges depending on the selected model and current terms; monitor usage. GitHub Actions has plan-specific usage limits. No SQL database or paid service is required to build and host the static publication.

## Structure

```text
src/
  components/      Shared publication UI
  content/articles Markdown article source
  layouts/         Shared document shell
  lib/             Article sorting and formatting
  pages/           Static routes, news route, and RSS endpoint
  styles/          Global responsive styles
automation/        Feed registry and scheduled research pipeline
worker/            Reserved for private admin API
```

## Private owner dashboard

The static dashboard is at `/admin/`. Its API is a separate Cloudflare Worker routed to the same origin under `/admin-api/`; Cloudflare Access protects the dashboard and API together. The browser never receives GitHub or Gemini credentials. Article and settings changes are saved as GitHub commits; approving an article triggers the normal Pages deployment when Pages is connected to the repository.

### Cloudflare setup

1. Add `aipulse.news` to Cloudflare DNS/Pages and deploy the Pages project from this repository (`npm run build`, output `dist`). The domain must be active in the same Cloudflare account as the Worker.
2. In **Zero Trust → Access → Applications**, create a self-hosted application for `aipulse.news/admin*` and allow only the owner's email. This protects the static dashboard and `/admin-api/*` Worker route. Copy this application's **Application Audience (AUD) Tag**.
3. Set `GITHUB_REPOSITORY` in `worker/wrangler.toml` to the actual `owner/repository` value. Keep `DEFAULT_BRANCH` and `SITE_ORIGIN` correct.
4. From this repository, deploy the Worker: `npm run deploy:admin`. The Worker route is configured as `aipulse.news/admin-api/*` in `worker/wrangler.toml`.
5. Add Worker secrets from the repository root (replace the prompts with the actual values when Wrangler asks):

   ```sh
   npx wrangler secret put ACCESS_AUD --config worker/wrangler.toml
   npx wrangler secret put ADMIN_EMAIL --config worker/wrangler.toml
   npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.toml
   ```

   `GITHUB_TOKEN` should be a fine-grained token limited to this repository, with **Contents: Read and write**, **Actions: Read and write**, and **Commit statuses: Read-only** permissions. The Worker uses it to edit article/settings/source files, inspect Actions runs and deployment status, and dispatch the workflow. Do not put it in `.env`, source code, or the browser.
6. Keep `GEMINI_API_KEY` only in the GitHub repository's **Settings → Secrets and variables → Actions → New repository secret**. The automation workflow reads settings from `automation/settings.json`; no key is stored there.
7. Visit `https://aipulse.news/admin/`, complete Cloudflare Access sign-in, and verify the dashboard shows repository and recent Action data. If API requests show an audience error, check that `ACCESS_AUD` is the audience tag from the dashboard Access application.

The Access policies are essential: the Worker also checks the Access identity and exact configured audience before handling any API request. The source URL validator accepts public HTTPS feeds only, checks redirect targets, and limits the response size. Essential duplicate detection, source checks, and review rules cannot be disabled from AI Settings. Settings and the source registry are versioned in GitHub, so edits create auditable commits and can be reverted there.

Cloudflare Access free-tier user limits, Workers request limits, Pages build limits, and GitHub Actions minutes depend on the current account plan. Check the account's Cloudflare and GitHub usage pages before increasing automation frequency; the two-hour schedule uses 12 workflow runs daily. No SQL database is used.
