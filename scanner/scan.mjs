#!/usr/bin/env node
// ideafeed — the skill-mining pipeline.
//
//   scout ─▶ filter ─▶ reader ─▶ extract ─▶ score ─▶ generate ─▶ review ─▶ publish
//
//   node scan.mjs              full run
//   node scan.mjs --dry        run everything, write nothing
//   node scan.mjs --no-llm     scout/filter/read only; no skills generated
//   node scan.mjs --mock-llm   run every stage against deterministic stand-ins
//
// Designed to run unattended on a cron. Every network call is retried, every
// model stage degrades to "no skills this run" rather than failing the run, and
// the feed is only written after a full pass has succeeded.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  searchRepos,
  fetchReadme,
  getRepo,
  mapLimit,
  isAuthenticated,
  coreQuotaExhausted,
  forbiddenRequests,
} from './lib/github.mjs';
import { fetchTrending } from './lib/trending.mjs';
import { aiRelevance } from './lib/filter.mjs';
import { readDocs } from './lib/docs.mjs';
import { scoreRepo, shouldExclude, starVelocity, daysSince } from './lib/score.mjs';
import { scoreSkill } from './lib/skillscore.mjs';
import { buildHook, cleanDescription } from './lib/summarize.mjs';
import {
  createClient,
  enrichmentAvailable,
  extractWorkflows,
  generateSkill,
  reviewSkills,
  mock,
} from './lib/pipeline.mjs';
import { writeSkill } from './lib/skillfile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry');
const NO_LLM = args.has('--no-llm');
const MOCK_LLM = args.has('--mock-llm');

const DAY = 86_400_000;
const MAX_BODY_CHARS = 6000;

// IDEAFEED_CONFIG points at an alternate config file — handy for trying a
// different set of lanes without touching the one the cron job uses.
async function loadConfig() {
  const path = process.env.IDEAFEED_CONFIG
    ? resolve(process.cwd(), process.env.IDEAFEED_CONFIG)
    : resolve(HERE, 'config.json');
  const raw = await readFile(path, 'utf8');
  return { ...JSON.parse(raw), __dir: dirname(path) };
}

async function loadFeed(path) {
  if (!existsSync(path)) return { items: [] };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { ...parsed, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    console.warn(`existing feed unreadable (${err.message}); starting fresh`);
    return { items: [] };
  }
}

/** `created:>{{days:21}}` -> `created:>2026-07-07` */
function expandQuery(query) {
  return query.replace(/\{\{days:(\d+)\}\}/g, (_, n) =>
    new Date(Date.now() - Number(n) * DAY).toISOString().slice(0, 10),
  );
}

/* ------------------------------ stage 1: scout ------------------------------ */

async function scout(config) {
  /** @type {Map<string, {repo: any, lanes: Set<string>}>} */
  const found = new Map();

  const add = (repo, laneId) => {
    const key = String(repo.id);
    if (!found.has(key)) found.set(key, { repo, lanes: new Set() });
    found.get(key).lanes.add(laneId);
  };

  console.log('\n[1] scout — search lanes');
  for (const lane of config.scout.lanes) {
    const query = expandQuery(lane.query);
    console.log(`  ${lane.id.padEnd(14)} ${query}`);
    const repos = await searchRepos(query, { sort: lane.sort, perPage: config.limits.perQuery });
    repos.forEach((repo) => add(repo, lane.id));
    console.log(`  ${' '.repeat(14)} → ${repos.length} repos`);
  }

  if (config.scout.trending?.enabled) {
    console.log('\n[1] scout — github trending');
    const { names, ok } = await fetchTrending(config.scout.trending);
    if (!ok) {
      console.warn(
        '  trending unavailable this run (it has no API, so this happens);\n' +
          '  the search lanes above already cover most of the same ground.',
      );
    }
    // Trending only gives owner/repo, so hydrate through the REST API to get
    // the same shape as search results.
    const hydrated = await mapLimit(names, 5, (name) => getRepo(name));
    let added = 0;
    for (const repo of hydrated) {
      if (!repo?.id) continue;
      add(repo, 'trending');
      added++;
    }
    if (names.length) console.log(`  hydrated ${added}/${names.length} trending repos`);
  }

  return found;
}

/* --------------------------------- helpers --------------------------------- */

function laneChips(config) {
  const chips = new Map();
  chips.set('Trending', { id: 'Trending', label: 'Trending', blurb: 'From GitHub Trending.' });
  for (const lane of config.scout.lanes) {
    if (!chips.has(lane.label)) {
      chips.set(lane.label, { id: lane.label, label: lane.label, blurb: lane.blurb });
    }
  }
  return [...chips.values()];
}

function laneLabels(config) {
  const byId = new Map([['trending', 'Trending']]);
  for (const lane of config.scout.lanes) byId.set(lane.id, lane.label);
  return byId;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const config = await loadConfig();
  const outPath = resolve(config.__dir, config.output);
  const skillsDir = resolve(config.__dir, config.skillsDir);
  const previous = await loadFeed(outPath);
  const previousById = new Map(previous.items.map((item) => [String(item.id), item]));
  const knownRepoIds = new Set(
    previous.items.filter((i) => i.type === 'candidate').map((i) => String(i.id)),
  );

  console.log(
    `ideafeed pipeline — ${previous.items.length} items in feed · ` +
      `github auth: ${isAuthenticated() ? 'yes' : 'no (rate limits will be tight)'}`,
  );

  const candidatesFound = await scout(config);
  console.log(`\n${candidatesFound.size} unique repos found`);

  /* ---------------------------- stage 2: filter ---------------------------- */

  console.log('\n[2] filter — keep AI projects');
  const passed = [];
  let excluded = 0;
  let notAi = 0;

  for (const { repo, lanes } of candidatesFound.values()) {
    if (shouldExclude(repo, config.scoring)) {
      excluded++;
      continue;
    }
    const relevance = aiRelevance(repo, '', config.filter);
    if (!relevance.keep) {
      notAi++;
      continue;
    }
    passed.push({ repo, lanes: [...lanes], relevance });
  }

  console.log(
    `  ${passed.length} kept · ${notAi} not AI projects · ${excluded} excluded (forks, archived, too well known)`,
  );

  /* ---------------------------- stage 3: reader ---------------------------- */

  // Only new repos need reading; ones already in the feed keep their summary.
  const fresh = passed.filter(({ repo }) => !knownRepoIds.has(String(repo.id)));
  const known = passed.filter(({ repo }) => knownRepoIds.has(String(repo.id)));

  const ranked = fresh
    .map((entry) => ({
      ...entry,
      preScore: scoreRepo(entry.repo, '', config.scoring).score,
    }))
    .sort((a, b) => b.preScore - a.preScore);

  const toRead = ranked.slice(0, config.limits.maxCandidatesPerRun);
  const notRead = ranked.slice(config.limits.maxCandidatesPerRun);

  console.log(
    `\n[3] reader — reading docs for the top ${toRead.length} of ${fresh.length} new repos`,
  );

  await mapLimit(toRead, 4, async (entry) => {
    const readme = await fetchReadme(entry.repo.full_name, config.limits.docBytes);
    entry.readme = readme;
    entry.docs = await readDocs(entry.repo, readme, config.reader, config.limits);
    // Re-run the filter now that we've actually read the documentation.
    entry.relevance = aiRelevance(entry.repo, entry.docs.text, config.filter);
    return entry;
  });

  const docStats = toRead.reduce(
    (acc, e) => {
      acc.files += e.docs?.files.length || 0;
      acc.withDocs += (e.docs?.files.length || 0) > 1 ? 1 : 0;
      return acc;
    },
    { files: 0, withDocs: 0 },
  );
  console.log(
    `  read ${docStats.files} files · ${docStats.withDocs} repos had docs beyond the README`,
  );
  if (coreQuotaExhausted()) {
    console.warn(
      '  GitHub core quota exhausted — set GITHUB_TOKEN to raise it from 60/hr to 5000/hr.',
    );
  }
  if (forbiddenRequests() > 0) {
    console.warn(
      `  ${forbiddenRequests()} requests were refused by GitHub with 403 and no rate-limit\n` +
        '  headers. That is a permissions or egress-policy block, not throttling —\n' +
        '  check that the token can read public repositories other than this one.',
    );
  }

  /* --------------------------- build candidate items --------------------------- */

  const labels = laneLabels(config);
  const nowIso = new Date().toISOString();

  const buildCandidate = (entry, prior) => {
    const { repo, lanes, docs, readme, relevance } = entry;
    const { score, breakdown } = scoreRepo(
      repo,
      readme || '',
      config.scoring,
      prior?.breakdown || null,
    );
    const laneLabelSet = [...new Set(lanes.map((id) => labels.get(id) || id))];

    return {
      type: 'candidate',
      id: String(repo.id),
      full_name: repo.full_name,
      owner: repo.owner?.login || repo.full_name.split('/')[0],
      name: repo.name,
      url: repo.html_url,
      description: cleanDescription(repo.description || ''),
      hook: prior?.hook || buildHook(repo, readme || ''),
      tags: (repo.topics || []).slice(0, 4),
      language: repo.language || null,
      stars: repo.stargazers_count,
      topics: repo.topics || [],
      created_at: repo.created_at,
      pushed_at: repo.pushed_at,
      age_days: Math.round(daysSince(repo.created_at)),
      star_velocity: Math.round(starVelocity(repo) * 100) / 100,
      score,
      breakdown,
      lanes: prior ? [...new Set([...(prior.lanes || []), ...laneLabelSet])] : laneLabelSet,
      ai_signals: relevance.signals,
      doc_files: docs?.files || prior?.doc_files || [],
      skills_extracted: prior?.skills_extracted || 0,
      first_seen: prior?.first_seen || nowIso,
      last_seen: nowIso,
      stars_at_first_seen: prior?.stars_at_first_seen ?? repo.stargazers_count,
    };
  };

  const candidateItems = [
    ...toRead.map((entry) => buildCandidate(entry, null)),
    ...notRead.map((entry) => buildCandidate(entry, null)),
    ...known.map((entry) => buildCandidate(entry, previousById.get(String(entry.repo.id)))),
  ];

  /* ------------------- stages 4-7: extract, generate, review ------------------- */

  const newSkills = [];
  const runMode = MOCK_LLM ? 'mock' : NO_LLM ? 'off' : enrichmentAvailable() ? 'live' : 'unavailable';

  if (runMode === 'off') {
    console.log('\n[4-7] skill pipeline skipped (--no-llm)');
  } else if (runMode === 'unavailable') {
    console.log(
      '\n[4-7] skill pipeline skipped — no ANTHROPIC_API_KEY.\n' +
        '      Candidates are still collected; set a key to generate skills.',
    );
  } else {
    const client = runMode === 'live' ? await createClient() : null;

    if (runMode === 'live' && !client) {
      console.warn('  could not create the Anthropic client; skipping the skill pipeline');
    } else {
      // Mock mode exists to exercise wiring, so it accepts thin input and falls
      // back to the repo description — otherwise it can't run at all in an
      // environment where fetching other repos' files is blocked.
      const readable = toRead.filter((e) =>
        runMode === 'mock'
          ? e.relevance.keep
          : e.relevance.keep && (e.docs?.text || '').length > 400,
      );
      if (runMode === 'mock') {
        for (const entry of readable) {
          if ((entry.docs?.text || '').length > 400) continue;
          entry.docs = {
            files: entry.docs?.files || [],
            raw: (entry.repo.description || '').toLowerCase(),
            text: `${entry.repo.description || ''}\n${(entry.repo.topics || []).join(', ')}`,
          };
        }
      }
      console.log(
        `\n[4] extract — ${readable.length} repos with enough documentation to read` +
          `${runMode === 'mock' ? ' (mock)' : ''}`,
      );

      const extractInput = readable.map((entry) => ({
        id: String(entry.repo.id),
        full_name: entry.repo.full_name,
        name: entry.repo.name,
        stars: entry.repo.stargazers_count,
        language: entry.repo.language,
        topics: entry.repo.topics,
        description: entry.repo.description,
        docs: entry.docs,
      }));

      const extracted =
        runMode === 'mock'
          ? mock.extractWorkflows(extractInput)
          : await extractWorkflows(client, extractInput, config.enrichment, config.limits.extractBatchSize);

      // Flatten to individual workflows, best repos first, then cap.
      const workflowQueue = [];
      for (const entry of readable) {
        const result = extracted.get(String(entry.repo.id));
        if (!result?.is_ai_project) continue;
        for (const workflow of result.workflows || []) {
          workflowQueue.push({ entry, workflow });
        }
      }
      workflowQueue.sort((a, b) => b.entry.preScore - a.entry.preScore);
      const selected = workflowQueue.slice(0, config.limits.maxSkillsPerRun);

      console.log(
        `  ${workflowQueue.length} workflows extracted · generating ${selected.length}` +
          `${workflowQueue.length > selected.length ? ` (capped by maxSkillsPerRun; ${workflowQueue.length - selected.length} dropped)` : ''}`,
      );

      console.log(`\n[5-6] score + generate`);
      for (const [i, { entry, workflow }] of selected.entries()) {
        const source = {
          full_name: entry.repo.full_name,
          owner: entry.repo.owner?.login || entry.repo.full_name.split('/')[0],
          url: entry.repo.html_url,
          language: entry.repo.language || null,
          stars: entry.repo.stargazers_count,
          doc_files: entry.docs?.files || [],
          repo_id: String(entry.repo.id),
        };

        let generated;
        try {
          generated =
            runMode === 'mock'
              ? mock.generateSkill({ repo: entry.repo, workflow })
              : await generateSkill(client, { repo: { ...entry.repo, stars: entry.repo.stargazers_count }, docs: entry.docs, workflow }, config.enrichment);
        } catch (err) {
          console.warn(`  generation failed for ${entry.repo.full_name}: ${err.message}`);
          continue;
        }

        const skillDraft = {
          name: generated.name,
          description: generated.description,
          body: String(generated.body || '').slice(0, MAX_BODY_CHARS),
          when_to_use: workflow.when_to_use,
          steps: workflow.steps || [],
          prerequisites: workflow.prerequisites || [],
          tools: workflow.tools || [],
        };

        const { skill_score, skill_breakdown } = scoreSkill(
          skillDraft,
          entry.repo,
          entry.docs,
          config.skillScoring,
        );

        newSkills.push({
          type: 'skill',
          id: `skill:${entry.repo.id}:${i}`,
          ...skillDraft,
          workflow,
          source,
          skill_score,
          skill_breakdown,
          docs_excerpt: entry.docs?.text || '',
          mock: runMode === 'mock',
          review: null,
          published: false,
          slug: null,
          first_seen: nowIso,
          last_seen: nowIso,
        });

        console.log(
          `  ${String(skill_score).padStart(5)}  ${generated.name}  ← ${entry.repo.full_name}`,
        );
      }

      /* ----------------------------- stage 7: review ----------------------------- */

      if (newSkills.length) {
        console.log(`\n[7] review${runMode === 'mock' ? ' (mock)' : ''}`);
        const reviews =
          runMode === 'mock'
            ? mock.reviewSkills(newSkills)
            : await reviewSkills(client, newSkills, config.enrichment, config.limits.reviewBatchSize);

        for (const skill of newSkills) {
          skill.review = reviews.get(skill.id) || {
            verdict: 'hold',
            grounded: false,
            quality: 0,
            reasons: ['No review returned; held for a human.'],
          };
        }

        const counts = newSkills.reduce((acc, s) => {
          acc[s.review.verdict] = (acc[s.review.verdict] || 0) + 1;
          return acc;
        }, {});
        console.log(
          `  approve ${counts.approve || 0} · hold ${counts.hold || 0} · reject ${counts.reject || 0}`,
        );
      }
    }
  }

  /* --------------------------- stage 8: publish --------------------------- */

  const published = [];
  for (const skill of newSkills) {
    const passes =
      !skill.mock &&
      skill.review?.verdict === 'approve' &&
      skill.skill_score >= config.skillScoring.publishThreshold;
    if (!passes) continue;

    if (DRY_RUN) {
      published.push(skill.name);
      skill.published = true;
      skill.slug = skill.name;
      continue;
    }

    try {
      const slug = await writeSkill(skillsDir, skill);
      skill.published = true;
      skill.slug = slug;
      skill.skill_path = `${config.skillsRepoPath}/${slug}/SKILL.md`;
      published.push(slug);
    } catch (err) {
      console.warn(`  could not write ${skill.name}: ${err.message}`);
    }
  }

  if (newSkills.length) {
    console.log(
      `\n[8] publish — ${published.length} written to ${config.skillsRepoPath}` +
        `${published.length ? `: ${published.join(', ')}` : ''}`,
    );
  }

  /* ----------------------------- merge and write ----------------------------- */

  const merged = new Map(previousById);
  for (const item of candidateItems) {
    const prior = previousById.get(item.id);
    merged.set(item.id, {
      ...item,
      skills_extracted:
        (prior?.skills_extracted || 0) +
        newSkills.filter((s) => s.source.repo_id === item.id).length,
    });
  }
  for (const skill of newSkills) {
    // docs_excerpt is prompt context, not feed content — don't ship it.
    const { docs_excerpt, ...rest } = skill;
    merged.set(skill.id, rest);
  }

  const cutoff = Date.now() - config.limits.keepUnseenDays * DAY;
  const items = [...merged.values()]
    .map((item) =>
      item.type === 'skill'
        ? item
        : {
            ...item,
            stars_gained: Math.max(0, item.stars - (item.stars_at_first_seen ?? item.stars)),
          },
    )
    // Skills are the output of the pipeline and are kept indefinitely;
    // candidates age out once they stop showing up.
    .filter((item) => item.type === 'skill' || new Date(item.last_seen).getTime() >= cutoff)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'skill' ? -1 : 1;
      return a.type === 'skill'
        ? b.skill_score - a.skill_score
        : b.score - a.score;
    })
    .slice(0, config.limits.maxItemsInFeed);

  const skills = items.filter((i) => i.type === 'skill');

  const feed = {
    version: 2,
    generated_at: nowIso,
    mode: runMode,
    lanes: laneChips(config),
    stats: {
      total: items.length,
      skills: skills.length,
      published: skills.filter((s) => s.published).length,
      candidates: items.length - skills.length,
      scanned: candidatesFound.size,
      kept_by_filter: passed.length,
      docs_read: toRead.length,
      new_skills_this_run: newSkills.length,
      published_this_run: published.length,
    },
    items,
  };

  console.log(
    `\n${items.length} items in feed · ${skills.length} skills ` +
      `(${feed.stats.published} published) · ${feed.stats.candidates} candidates`,
  );

  if (DRY_RUN) {
    console.log('\n--dry: nothing written');
    return;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(`\npipeline failed: ${err.stack || err.message}`);
  process.exit(1);
});
