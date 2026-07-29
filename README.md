# ideafeed

A self-running pipeline that mines GitHub for reusable agent skills, and a feed
for reviewing what it finds.

Once a day it sweeps GitHub for new AI projects, reads their
documentation, extracts the reusable workflows buried in there, writes each one
up as a `SKILL.md`, scores it, reviews it, and opens a pull request for the ones
that survive. The web app is where you skim the output, read the generated
skills, and save the ones worth coming back to.

```
                  ┌── GitHub Trending (daily + weekly)
    1. Scout   ───┤
                  └── GitHub Search (configurable lanes)
                              │
    2. Filter  ── keep AI projects (rules, not a model call)
                              │
    3. Reader  ── read the docs first: SKILL.md, AGENTS.md, docs/, examples/
                              │
    4. Extract ── pull out reusable workflows the docs actually teach
                              │
    5. Score   ── rules: specificity, actionability, grounding, reusability
                              │
    6. Generate ─ write the SKILL.md
                              │
    7. Review  ── adversarial pass: approve / hold / reject
                              │
    8. Publish ── approved skills → skills/ → pull request
                              │
                        feed.json → web app
```

There is no server. The pipeline is a cron job, the feed is a static file, the
app is static, and your saves live in your browser. Each run is also mirrored
into Postgres if credentials are present — optional, and additive: the site
never reads from it.

---

## Layout

| Path | What it is |
| --- | --- |
| `scanner/scan.mjs` | The pipeline, stage by stage |
| `scanner/config.json` | Everything tunable: lanes, filter, scoring, limits |
| `scanner/lib/trending.mjs` | Stage 1 — GitHub Trending (no API, so it parses HTML) |
| `scanner/lib/filter.mjs` | Stage 2 — the AI-project filter |
| `scanner/lib/docs.mjs` | Stage 3 — finds and reads the documentation |
| `scanner/lib/pipeline.mjs` | Stages 4, 6, 7 — extract, generate, review |
| `scanner/lib/skillscore.mjs` | Stage 5 — the rule-based skill score |
| `scanner/lib/skillfile.mjs` | Stage 8 — renders and writes `SKILL.md` |
| `scanner/lib/supabase.mjs` | Optional mirror of each run into Postgres |
| `scanner/test/` | Offline tests for every stage that has no network in it |
| `skills/` | Published skills. Written by the pipeline, merged by you |
| `web/` | Vite + React + TypeScript app |
| `web/public/feed.json` | The feed. Written by the pipeline, read by the app |

---

## Running it

```bash
cd scanner
npm install
npm test                        # 18 offline tests, no network, no key

# A GitHub token is optional but strongly recommended: it raises the API limit
# from 60/hour to 5000/hour, and stage 3 reads several files per repository.
GITHUB_TOKEN=ghp_… ANTHROPIC_API_KEY=sk-ant-… node scan.mjs

cd ../web && npm install && npm run dev
```

| Flag | What it does |
| --- | --- |
| `--dry` | Runs every stage, writes nothing |
| `--no-llm` | Stages 1–3 only: collect candidates, generate no skills |
| `--mock-llm` | Runs all eight stages against deterministic stand-ins |
| `--no-db` | Skip the Postgres mirror |
| `IDEAFEED_CONFIG=./other.json` | Use a different config |

**`--mock-llm` is worth knowing about.** It exercises the whole pipeline —
extraction, generation, scoring, review, the publish gate and the app that reads
the result — without an API key and without spending anything. Everything it
produces is tagged `mock`, is refused by the publish gate, and is labelled as
such in the UI. Use it to check wiring, never to judge output quality.

---

## The stages

**1. Scout.** Two sources. GitHub Trending covers daily and weekly windows across
several languages; the search lanes in `config.json` cover the rest — brand-new
repos with traction, young repos under 250 stars, and topic lanes for agents,
RAG, MCP, devtools. Trending has no API, so that half parses HTML and is the
most fragile thing here; when it fails the run says so and the search lanes carry
it.

**2. Filter.** Keeps AI projects, using rules rather than a model call — it runs
on several hundred repos per run, so it has to be free. One strong signal (an
`llm` topic, "agentic" in the description) or two weak ones is enough.

**3. Reader.** The README says what a project is; the docs say how people use it,
which is where workflows live. This stage walks the file tree once and reads the
best few markdown files it finds, preferring any `SKILL.md`, `AGENTS.md` or
`CLAUDE.md` the repo already ships, then shallow files under `docs/`,
`guides/` and `examples/`.

**4. Extract.** Pulls out reusable workflows — repeatable procedures with a
trigger and steps. The prompt is explicit that most repositories don't have one
and that an empty result is the correct answer, because the failure mode here is
stretching an install guide into a "workflow".

**5. Score.** Five rules, weighted to sum to 100. The one doing the real work is
**grounding**: it pulls the distinctive vocabulary out of the generated skill —
code identifiers, CLI flags, dotted paths — and checks how much of it actually
appears in the source docs. A skill full of terms the documentation never
mentions was written from the model's priors, not from the project, and this
catches that without asking a model to mark its own homework.

**6. Generate.** Writes the `SKILL.md`. The `description` line gets the most
attention because it's what an agent matches against when deciding whether to
load the skill at all.

**7. Review.** A separate adversarial pass whose job is to find the reason the
skill *shouldn't* ship. Extraction, writing and reviewing are three different
tasks; folding them into one call produces a skill that reviews itself well.

**8. Publish.** A skill is written to `skills/` only if the reviewer approved it
*and* it cleared the rule threshold. Those go out as a pull request, never
straight onto the branch — the model decides what's worth proposing, you decide
what's worth keeping.

---

## The app

- **Skills** — the pipeline's output. Each card shows the routing description,
  the source repo, the reviewer's verdict, and expands into the full rendered
  `SKILL.md` with a copy button.
- **Candidates** — repos that passed scout and filter but haven't produced a
  skill. Most never will, which is the point.
- **Saved / Archive** — save keeps something for later; archive hides it without
  deleting it.
- **Score breakdown** — the number on every card expands into its components, so
  you can see *why* something scored the way it did.
- **Appearance** — 20 colour schemes on one axis, light/dark on the other, so
  every scheme has both. Generated: `npm run themes` rewrites `design/themes.css`,
  `design/palettes.ts` and the pre-paint block in `index.html` from the single
  table in `scripts/gen-themes.mjs`, and refuses to emit a palette that fails
  WCAG AA. Add a theme by adding a row.
- **Refresh** — the feed is a static file rebuilt by cron, so this re-fetches it.
  Mostly for the installed app, which will otherwise sit on a cached copy.
- **Keyboard** — `j`/`k` move, `o` opens the source, `b` saves, `x` archives,
  `/` searches, `r` refreshes, `t` opens appearance, `1`–`3` switch views,
  `⌘K` for the command palette.
- **Export** — saved items come back out as JSON.

Saves live in `localStorage` under `ideafeed.state.v1`. If you ever want them
synced across devices, `web/src/lib/store.ts` defines an `IdeaStore` interface
with a local implementation; a Supabase version is a drop-in replacement and no
component changes.

---

## Deploying

**Netlify**: import the repo and accept the defaults. The root `netlify.toml`
declares `base = "web"` along with the build command, caching and SPA routing,
so there is nothing to fill in by hand. Leave the UI's build fields empty — if
the base directory isn't set anywhere, Netlify publishes the repository as-is
and you get the unbuilt Vite entry rather than the app.

**GitHub Pages**: Settings → Pages → Source "GitHub Actions". Creating the Pages
site needs repo-admin, so no workflow can do it for you; once it exists, every
push that touches `web/` redeploys.

Either way the scan workflow keeps committing `feed.json`, and each commit
triggers a rebuild, so the live site stays current on its own.

---

## Secrets

| Secret | Needed? | Without it |
| --- | --- | --- |
| `GITHUB_TOKEN` | Provided automatically in Actions | 60 requests/hour, so stage 3 reads almost nothing |
| `ANTHROPIC_API_KEY` | Optional | Stages 4–8 are skipped; candidates are still collected |
| `SUPABASE_URL` | Optional | No database mirror; `feed.json` is unaffected |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional | As above |

## What it costs

Each run reports its own spend, computed from the token usage the API returns
rather than estimated from prompt sizes, and stores it in `ideafeed_runs`:

```
api spend
  claude-haiku-4-5    2 calls ·  23,912 in /  4,602 out · $0.047
  claude-sonnet-5     2 calls ·  11,788 in /  2,378 out · $0.071
  claude-opus-5       1 calls ·   6,149 in /    703 out · $0.048
  total               5 calls · $0.166 this run · ~$4.99/month daily
```

That block is a real run, not an illustration. A model that isn't in
`enrichment.pricing` is marked `(no rate configured)` rather than quietly
costing nothing — the rate lookup tolerates the dated model IDs the API
answers with (`claude-haiku-4-5-20251001`), because an exact-key match priced
that stage at zero.

**One model per stage, matched to what the stage does.** Extraction is bulk
reading — it carries most of the input tokens and the least judgement, so it
runs on the cheapest model. Generation is a writing task. Review is the gate
that has to catch a fluent lie, and it's the cheapest stage by volume, so it
keeps the best model.

### Scouting is free

Worth being precise about, because it's the natural place to start cutting and
it saves nothing. That run swept 426 repos across 8 search lanes and 8 trending
pages, and none of it cost a cent — the GitHub API is free, and Actions minutes
are free on a public repo. Widening or narrowing the lanes changes how many
ideas you see, not what you pay.

Two things drive the bill:

| Driver | Rate | Notes |
| --- | --- | --- |
| New repos with docs | ~$0.005 each (extract) | Self-limiting. 302 repos passed the filter, but 289 were already in the feed, so only 13 were read |
| `maxSkillsPerRun` | ~$0.04 each (generate + review) | A cap you set. At 4 it was 72% of the run |

So `maxSkillsPerRun` is the lever. It's set to **2**, which is as much about
output as cost: the runs at 4 and 8 approved zero skills each, and paying to
write up four candidates the reviewer then rejects is the expensive way to get
nothing. The levers in order:

| Lever | Where | Effect |
| --- | --- | --- |
| Cadence | the cron in `.github/workflows/scan.yml` | Linear, and by far the biggest |
| `maxSkillsPerRun` | `limits` | ~$0.04 per skill, both stages |
| Stage models | `enrichment.stages` | See above |
| `docBytes` / `maxDocFiles` | `limits` | Small, and it cuts into grounding — the reader is what the score checks claims against, so starving it makes the reviewer reject more |
| `perQuery`, `maxCandidatesPerRun`, lanes | `limits`, `scout` | **No effect on cost** |

Don't cut the review model to save money — it's the smallest line item and the
only thing standing between a hallucinated `SKILL.md` and your skills
directory.

One consequence of a tight `maxSkillsPerRun`: which workflows get written up
starts to matter. A single repo often yields two, so `orderWorkflows` takes
every repo's best one before anyone's second — otherwise a two-skill run spends
its whole budget on one project.

---

## The database mirror (optional)

`feed.json` is the source of truth. It's a static file, it costs nothing to
serve, and the app works with no database at all — so the mirror is strictly
additive, and a failure in it is logged rather than allowed to fail a scan that
already produced its output.

What it buys you is the two things a snapshot file can't: **history**, and
**queryability from outside the app**.

Three tables, in the existing `the-pentagon` project rather than a new one:

| Table | One row per |
| --- | --- |
| `ideafeed_candidates` | Repo the scout has ever kept |
| `ideafeed_skills` | Generated SKILL.md, including the held and rejected ones |
| `ideafeed_runs` | Pipeline run, with the funnel counts |

Rejected skills are kept on purpose: they're the record of what the pipeline
decided *not* to ship, which is what you tune the thresholds against.

All three are RLS-enabled with a read-only policy for `anon`. The scanner writes
with the service role, which bypasses RLS — so no policy grants insert anywhere,
and a leaked publishable key cannot write.

```sql
-- what's growing fastest since we found it
select full_name, stars - stars_at_first_seen as gained, score
from ideafeed_candidates order by gained desc limit 20;

-- is the extractor getting stricter or looser over time?
select ran_at::date, scanned, kept_by_filter, docs_read, skills_generated, published
from ideafeed_runs order by ran_at desc;

-- everything the reviewer held, worst grounding first
select name, skill_score, skill_breakdown->>'grounding' as grounding, review->>'reasons'
from ideafeed_skills where verdict = 'hold' order by skill_score;
```

---

## Tuning it

Everything worth changing is in `scanner/config.json`:

- **Different interests?** `scout.lanes` — any GitHub search query works.
- **Wrong things getting through the filter?** `filter.strongKeywords` /
  `weakKeywords`, or raise `requireScore`.
- **Too many feats of engineering, not enough tools?** `scoring.rewardKeywords`
  is the vocabulary of something shipped, `penalizeKeywords` covers both
  non-projects (lists, tutorials) and technique demonstrations (compilers,
  allocators, hand-written kernels). `installSignals` is the strongest single
  signal that a repo is a build rather than a writeup.
- **Cards you can't read?** `scoring.excludeScripts` — `han` by default.
  Bilingual repos keep their English half; only the ones with nothing readable
  left are dropped. `kana`, `hangul`, `cyrillic`, `arabic`, `hebrew`,
  `devanagari` and `thai` are available.
- **Skills too generic?** Raise `skillScoring.publishThreshold`, or add the
  offending phrasing to `genericPhrases`.
- **Not finding docs?** `reader.preferredFiles` and `docDirectories`.
- **Too expensive?** Lower `maxSkillsPerRun`, or set `enrichment.enabled: false`.
- **Different cadence?** The cron expression in `scan.yml`.
