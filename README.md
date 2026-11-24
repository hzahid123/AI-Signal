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

The scheduled pipeline lives in `.github/workflows/news-pipeline.yml` and runs daily at 10:17 UTC, with a manual **Run workflow** option. Each run evaluates up to three candidates and stops after one article passes automatic publication checks. This reduces Gemini usage; it does not guarantee an article if quota is unavailable or no story passes validation. GitHub scheduled runs use the latest commit on the repository's default branch and can be delayed during busy periods, so the time is a target rather than a guarantee. The workflow is inactive until this file is pushed to the default branch and Actions is enabled.

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

The owner dashboard can be served privately from the Worker at its `workers.dev` URL. `npm run build:admin` generates the static site and embeds the dashboard page into the Worker; the Worker serves `/admin/` and its same-origin `/admin-api/` endpoints. This avoids needing to own a custom domain. The public publication continues to deploy separately to Cloudflare Pages. The browser never receives GitHub or Gemini credentials.

### Cloudflare setup

1. In Cloudflare, open **Workers & Pages** and enable your account's `workers.dev` subdomain if it is not enabled. Cloudflare creates a Worker URL like `https://ai-signal.<your-account-subdomain>.workers.dev`.
2. In the AI Signal Worker project's build settings, leave **Build command** blank (the deploy script builds the admin bundle itself), set **Deploy command** to `npm run deploy:admin`, and set **Preview command** to `npm run preview:admin` if the form requires one. Keep preview deployments disabled unless you separately configure local preview secrets.
3. Enable **Protect with Cloudflare Access** for **All traffic**, and set its policy to allow only the owner's exact email. Copy the Access application's **Application Audience (AUD) Tag**. The Worker directly checks the authenticated Access identity and audience on API requests.
4. Set `GITHUB_REPOSITORY` in `worker/wrangler.toml` to the actual `owner/repository` value. Keep `DEFAULT_BRANCH` and `SITE_ORIGIN` correct. The Worker uses `workers_dev = true` and does not require a custom domain or zone route.
5. From this repository, deploy the Worker with `npm run deploy:admin` after the changes are pushed.
6. Add Worker secrets from the Cloudflare Worker settings or with Wrangler from the repository root (replace the prompts with the actual values when Wrangler asks):

   ```sh
   npx wrangler secret put ACCESS_AUD --config worker/wrangler.toml
   npx wrangler secret put ADMIN_EMAIL --config worker/wrangler.toml
   npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.toml
   ```

   `GITHUB_TOKEN` should be a fine-grained token limited to this repository, with **Contents: Read and write**, **Actions: Read and write**, and **Commit statuses: Read-only** permissions. The Worker uses it to edit article/settings/source files, inspect Actions runs and deployment status, and dispatch the workflow. Do not put it in `.env`, source code, or the browser.
7. Keep `GEMINI_API_KEY` only in the GitHub repository's **Settings → Secrets and variables → Actions → New repository secret**. The automation workflow reads settings from `automation/settings.json`; no key is stored there.
8. Open the Worker URL Cloudflare shows for `ai-signal`, then visit its `/admin/` path, sign in through Cloudflare Access, and verify the dashboard shows repository and recent Actions data. If API requests show an audience error, check that `ACCESS_AUD` matches the Access application audience.

The Access policy protects the Worker dashboard and API. If the separate public Pages site includes `/admin/`, protect that Pages path with its own Access application too; the Worker-hosted dashboard is the private working copy. The source URL validator accepts public HTTPS feeds only, checks redirect targets, and limits the response size. Essential duplicate detection, source checks, and review rules cannot be disabled from AI Settings. Settings and the source registry are versioned in GitHub, so edits create auditable commits and can be reverted there.

Cloudflare Access free-tier user limits, Workers request limits, Pages build limits, and GitHub Actions minutes depend on the current account plan. Check the account's Cloudflare and GitHub usage pages before increasing automation frequency. The daily schedule uses one workflow run per day by default. No SQL database is used.
