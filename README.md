# ideafeed

A self-running pipeline that mines GitHub for reusable agent skills, and a feed
for reviewing what it finds.

Every couple of hours it sweeps GitHub for new AI projects, reads their
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

There is no server and no database. The pipeline is a cron job, the feed is a
static file, the app is static, and your saves live in your browser.

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
- **Keyboard** — `j`/`k` move, `o` opens the source, `b` saves, `x` archives,
  `/` searches, `1`–`4` switch views, `⌘K` for the command palette.
- **Export** — saved items come back out as JSON.

Saves live in `localStorage` under `ideafeed.state.v1`. If you ever want them
synced across devices, `web/src/lib/store.ts` defines an `IdeaStore` interface
with a local implementation; a Supabase version is a drop-in replacement and no
component changes.

---

## Deploying

**Netlify**: import the repo, set the base directory to `web`.
`web/netlify.toml` handles build, caching and SPA routing.

**GitHub Pages**: Settings → Pages → Source "GitHub Actions", then run the
*ideafeed deploy* workflow. It's manual on purpose — publishing to Pages replaces
whatever else the repository serves there.

Either way the scan workflow keeps committing `feed.json`, and each commit
triggers a rebuild, so the live site stays current on its own.

---

## Secrets

| Secret | Needed? | Without it |
| --- | --- | --- |
| `GITHUB_TOKEN` | Provided automatically in Actions | 60 requests/hour, so stage 3 reads almost nothing |
| `ANTHROPIC_API_KEY` | Optional | Stages 4–8 are skipped; candidates are still collected |

Cost is bounded by `limits.maxSkillsPerRun` (8 per run) and
`limits.maxCandidatesPerRun` (40 repos read per run). Extraction and review are
batched; generation is one call per skill.

---

## Tuning it

Everything worth changing is in `scanner/config.json`:

- **Different interests?** `scout.lanes` — any GitHub search query works.
- **Wrong things getting through the filter?** `filter.strongKeywords` /
  `weakKeywords`, or raise `requireScore`.
- **Skills too generic?** Raise `skillScoring.publishThreshold`, or add the
  offending phrasing to `genericPhrases`.
- **Not finding docs?** `reader.preferredFiles` and `docDirectories`.
- **Too expensive?** Lower `maxSkillsPerRun`, or set `enrichment.enabled: false`.
- **Different cadence?** The cron expression in `scan.yml`.
