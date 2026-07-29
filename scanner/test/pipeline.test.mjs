// node --test test/
//
// These cover the parts of the pipeline that have no network in them: doc
// ranking, the AI filter, skill scoring rules, SKILL.md rendering and the
// trending parser. They run offline, which matters because the stages they
// cover are exactly the ones you can't easily eyeball in a live run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTrending } from '../lib/trending.mjs';
import { aiRelevance } from '../lib/filter.mjs';
import { rankDocPaths } from '../lib/docs.mjs';
import { scoreSkill, distinctiveTerms } from '../lib/skillscore.mjs';
import {
  scoreRepo,
  shouldExclude,
  hasExcludedScript,
  stripExcludedScript,
} from '../lib/score.mjs';
import { renderSkillMd, slugify } from '../lib/skillfile.mjs';
import { readmeSummary, buildHook } from '../lib/summarize.mjs';
import { rateFor, orderWorkflows } from '../lib/pipeline.mjs';

/* --------------------------------- trending --------------------------------- */

test('parseTrending pulls owner/repo out of article headings', () => {
  const html = `
    <main>
      <article class="Box-row">
        <h2 class="h3 lh-condensed"><a href="/openai/whisper">openai / whisper</a></h2>
        <a href="/openai/whisper/stargazers">1,234</a>
      </article>
      <article class="Box-row">
        <h2 class="h3 lh-condensed"><a href="/ggerganov/llama.cpp">ggerganov / llama.cpp</a></h2>
      </article>
    </main>`;
  assert.deepEqual(parseTrending(html), ['openai/whisper', 'ggerganov/llama.cpp']);
});

test('parseTrending ignores non-repo links and duplicates', () => {
  const html = `
    <article><h2><a href="/explore">Explore</a></h2></article>
    <article><h2 class="h3"><a href="/a/b">a / b</a></h2></article>
    <article><h2 class="h3"><a href="/a/b">a / b</a></h2></article>`;
  assert.deepEqual(parseTrending(html), ['a/b']);
});

test('parseTrending returns nothing rather than throwing on junk', () => {
  assert.deepEqual(parseTrending('<html>rate limited</html>'), []);
});

/* ---------------------------------- filter ---------------------------------- */

const FILTER_CFG = {
  requireScore: 2,
  strongTopics: ['llm', 'rag'],
  strongKeywords: ['llm', 'ai agent'],
  weakKeywords: [' ai ', 'assistant', 'eval'],
};

test('filter keeps a repo on one strong signal', () => {
  const repo = { name: 'x', description: 'An LLM inference server', topics: [] };
  const result = aiRelevance(repo, '', FILTER_CFG);
  assert.equal(result.keep, true);
  assert.ok(result.score >= 2);
});

test('filter keeps a repo on two weak signals', () => {
  const repo = { name: 'x', description: 'An assistant for eval workflows', topics: [] };
  assert.equal(aiRelevance(repo, '', FILTER_CFG).keep, true);
});

test('filter drops an unrelated repo', () => {
  const repo = { name: 'fast-csv', description: 'A streaming CSV parser', topics: ['csv'] };
  assert.equal(aiRelevance(repo, '', FILTER_CFG).keep, false);
});

test('filter reads the docs when metadata is thin', () => {
  const repo = { name: 'zeta', description: '', topics: [] };
  assert.equal(aiRelevance(repo, '', FILTER_CFG).keep, false);
  assert.equal(aiRelevance(repo, 'Serve an LLM behind a queue.', FILTER_CFG).keep, true);
});

/* ----------------------------------- reader ----------------------------------- */

const READER_CFG = {
  preferredFiles: ['SKILL.md', 'AGENTS.md', 'docs/README.md'],
  docDirectories: ['docs', 'examples'],
};

test('rankDocPaths puts preferred files first, in configured order', () => {
  const paths = ['README.md', 'docs/README.md', 'AGENTS.md', 'src/main.ts', 'SKILL.md'];
  assert.deepEqual(rankDocPaths(paths, READER_CFG).slice(0, 3), [
    'SKILL.md',
    'AGENTS.md',
    'docs/README.md',
  ]);
});

test('rankDocPaths prefers shallow docs and ignores non-markdown and other trees', () => {
  const paths = [
    'docs/api/internals/v2/notes.md',
    'docs/guide.md',
    'src/lib.rs',
    'docs/logo.png',
    'vendor/docs/thing.md',
  ];
  const ranked = rankDocPaths(paths, READER_CFG);
  assert.equal(ranked[0], 'docs/guide.md');
  assert.ok(!ranked.includes('docs/logo.png'));
  assert.ok(!ranked.includes('vendor/docs/thing.md'));
});

/* -------------------------------- skill scoring -------------------------------- */

const SKILL_CFG = {
  weights: {
    specificity: 26,
    actionability: 24,
    grounding: 24,
    reusability: 16,
    sourceQuality: 10,
  },
  minSteps: 3,
  genericPhrases: ['best practices', 'getting started'],
  publishThreshold: 62,
};

const REPO = { stargazers_count: 900 };

const GOOD_SKILL = {
  description:
    'Use when you need to evaluate a retrieval pipeline against a labelled set and report recall@k.',
  when_to_use: 'Before shipping a change to the retriever or the chunking strategy.',
  steps: [
    'Build a golden set with `make-golden --out golden.jsonl`',
    'Run the retriever with `retrieve-eval --k 10`',
    'Compare against the baseline with `eval-compare`',
    'Write the report to reports/recall.md',
  ],
  prerequisites: ['A labelled golden set'],
  tools: ['retrieve-eval', 'eval-compare'],
  body: `Run \`retrieve-eval --k 10 --golden golden.jsonl\` against the index.
The command writes recall@k and mrr to stdout as JSON. Compare with
\`eval-compare --baseline baseline.json\`, which exits non-zero when recall@k
regresses by more than the --tolerance flag. Chunk size is set in config.yaml
under retriever.chunk_size; changing it invalidates the cached index, so pass
--rebuild on the next run. Keep the golden set under version control.`.repeat(2),
};

const GENERIC_SKILL = {
  description: 'A guide to best practices.',
  when_to_use: '',
  steps: ['Read the docs'],
  prerequisites: [],
  tools: [],
  body: 'Getting started with best practices. Read the documentation to learn more.',
};

const DOCS = {
  files: ['README.md', 'docs/eval.md'],
  text: 'x'.repeat(4000),
  raw: `run retrieve-eval --k 10 --golden golden.jsonl. compare with eval-compare
    --baseline baseline.json. chunk_size lives in config.yaml under retriever.
    pass --rebuild to invalidate. make-golden --out golden.jsonl builds the set.
    recall@k and mrr are reported. --tolerance controls the regression gate.`,
};

test('a grounded, specific skill scores well above the publish threshold', () => {
  const { skill_score, skill_breakdown } = scoreSkill(GOOD_SKILL, REPO, DOCS, SKILL_CFG);
  assert.ok(
    skill_score >= SKILL_CFG.publishThreshold,
    `expected >= ${SKILL_CFG.publishThreshold}, got ${skill_score}`,
  );
  assert.ok(skill_breakdown.actionability >= 80);
});

test('a generic skill scores far below the publish threshold', () => {
  const { skill_score } = scoreSkill(GENERIC_SKILL, REPO, DOCS, SKILL_CFG);
  assert.ok(
    skill_score < SKILL_CFG.publishThreshold,
    `expected < ${SKILL_CFG.publishThreshold}, got ${skill_score}`,
  );
});

test('grounding collapses when the skill cites things the docs never mention', () => {
  const grounded = scoreSkill(GOOD_SKILL, REPO, DOCS, SKILL_CFG);
  const ungrounded = scoreSkill(
    GOOD_SKILL,
    REPO,
    { ...DOCS, raw: 'this project is a web framework for building websites.' },
    SKILL_CFG,
  );
  assert.ok(
    ungrounded.skill_breakdown.grounding < grounded.skill_breakdown.grounding - 30,
    `grounding should drop sharply: ${grounded.skill_breakdown.grounding} -> ${ungrounded.skill_breakdown.grounding}`,
  );
  assert.ok(ungrounded.skill_score < grounded.skill_score);
});

test('distinctiveTerms picks up code identifiers and flags', () => {
  const terms = distinctiveTerms('Run `eval-compare` with --tolerance and retriever.chunk_size');
  assert.ok(terms.includes('eval-compare'));
  assert.ok(terms.includes('--tolerance'));
  assert.ok(terms.some((t) => t.startsWith('retriever.chunk')));
});

test('distinctiveTerms captures the numbers hallucinations hide in', () => {
  const terms = distinctiveTerms('Serve on port 4104, covering 19 of 103 entries, requires v2.1.0');
  assert.ok(terms.includes('4104'), 'port');
  assert.ok(terms.includes('103'), 'count');
  assert.ok(terms.includes('v2.1.0'), 'version');
});

// The regression this exists for: on the first live run the rule scored 94-97
// on skills the reviewer then proved were invented, because only the *numbers*
// were fabricated — every identifier around them was real.
test('grounding falls when only the numbers are invented', () => {
  const docs = {
    files: ['README.md'],
    text: 'x'.repeat(4000),
    raw: 'toolport gateway. run `toolport serve` and set toolport_discovery. the /mcp endpoint is streamable-http.',
  };
  const shared = {
    when_to_use: 'Setting up the gateway.',
    steps: ['Run `toolport serve`', 'Set toolport_discovery', 'Call the /mcp endpoint'],
    prerequisites: ['cargo'],
    tools: ['toolport'],
    description: 'Use when configuring the toolport gateway and its /mcp endpoint.',
  };
  const truthful = {
    ...shared,
    body: 'Run `toolport serve`, set toolport_discovery, then call the /mcp endpoint over streamable-http. '.repeat(6),
  };
  const invented = {
    ...shared,
    body: 'Run `toolport serve` on port 4104, set toolport_discovery across 103 servers, then call the /mcp endpoint over streamable-http. Ports 4105 and 4106 are reserved and 8721 entries cached. '.repeat(6),
  };

  const a = scoreSkill(truthful, REPO, docs, SKILL_CFG).skill_breakdown.grounding;
  const b = scoreSkill(invented, REPO, docs, SKILL_CFG).skill_breakdown.grounding;
  assert.ok(b < a, `invented numbers should lower grounding: ${a} -> ${b}`);
});

/* ------------------------------- skill rendering ------------------------------- */

test('slugify produces safe directory names', () => {
  assert.equal(slugify('Evaluate RAG Recall@K!'), 'evaluate-rag-recall-k');
  assert.equal(slugify('   '), 'skill');
  assert.ok(slugify('a'.repeat(80)).length <= 48);
});

test('renderSkillMd emits valid frontmatter and keeps provenance', () => {
  const md = renderSkillMd({
    name: 'evaluate-retrieval',
    description: 'Use when you need to check recall@k after a "retriever" change.',
    body: '## Steps\n\n1. Run the eval.',
    source: {
      full_name: 'acme/rag',
      url: 'https://github.com/acme/rag',
      language: 'Python',
      stars: 1234,
      doc_files: ['README.md', 'docs/eval.md'],
    },
    workflow: { evidence: 'Run retrieve-eval --k 10.' },
    skill_score: 71.5,
    review: { verdict: 'approve', quality: 84 },
  });

  const lines = md.split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], 'name: evaluate-retrieval');
  assert.equal(lines[3], '---');
  // Double quotes in a description would break the YAML block.
  assert.ok(!lines[2].slice('description: "'.length, -1).includes('"'));
  assert.match(md, /acme\/rag/);
  assert.match(md, /docs\/eval\.md/);
  assert.match(md, /rule score 71\.5/);
  assert.match(md, /reviewer approve \(84\)/);
});

/* --------------------------------- summariser --------------------------------- */

test('readmeSummary skips badges, nav rows and headings', () => {
  const readme = `# thing

[![build](https://img.shields.io/x)](https://ci.example.com)

<p align="center">
  <img src="logo.png" />
</p>

example.com · Download · Issues

Thing is a deterministic scheduler for GPU inference that batches requests by shape.

## Installation`;
  assert.match(readmeSummary(readme, 'thing'), /^Thing is a deterministic scheduler/);
});

test('buildHook prefers a substantial description over the README', () => {
  const repo = {
    name: 'thing',
    description: 'A deterministic scheduler for GPU inference that batches by tensor shape.',
  };
  assert.match(buildHook(repo, '# thing\n\nSomething else entirely here.'), /deterministic/);
});

test('buildHook falls back to the README when the description is thin', () => {
  const repo = { name: 'thing', description: 'wip' };
  const readme = '# thing\n\nThing is a deterministic scheduler for GPU inference workloads.';
  assert.match(buildHook(repo, readme), /^Thing is a deterministic scheduler/);
});

/* --------------------------------- pricing --------------------------------- */

const PRICING = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

test('rateFor matches a model ID the API returned with a release date on it', () => {
  // The live run asked for claude-haiku-4-5 and the response said
  // claude-haiku-4-5-20251001, so the exact-key lookup found nothing and the
  // whole extract stage was reported as free.
  assert.deepEqual(rateFor(PRICING, 'claude-haiku-4-5-20251001'), PRICING['claude-haiku-4-5']);
  assert.deepEqual(rateFor(PRICING, 'claude-opus-5'), PRICING['claude-opus-5']);
});

test('rateFor still returns nothing for a model that is genuinely unpriced', () => {
  assert.equal(rateFor(PRICING, 'claude-sonnet-5'), undefined);
  assert.equal(rateFor(undefined, 'claude-opus-5'), undefined);
});

/* ---------------------------- workflow selection ---------------------------- */

const repoEntry = (id, preScore) => ({ repo: { id }, preScore });

test('orderWorkflows spreads a tight budget across repos instead of draining one', () => {
  // The live run generated 4 skills from exactly 2 repos, because sorting by
  // repo score put both of a repo's workflows above everyone else's first one.
  // At maxSkillsPerRun 2 that would have covered a single project per day.
  const readable = [repoEntry('a', 90), repoEntry('b', 80), repoEntry('c', 70)];
  const extracted = new Map([
    ['a', { is_ai_project: true, workflows: ['a1', 'a2'] }],
    ['b', { is_ai_project: true, workflows: ['b1'] }],
    ['c', { is_ai_project: true, workflows: ['c1', 'c2'] }],
  ]);

  const { queue, repos } = orderWorkflows(readable, extracted);
  assert.equal(repos, 3);
  assert.deepEqual(
    queue.map((q) => q.workflow),
    ['a1', 'b1', 'c1', 'a2', 'c2'],
  );
  // The two the budget actually pays for come from two different projects.
  assert.deepEqual(queue.slice(0, 2).map((q) => q.entry.repo.id), ['a', 'b']);
});

test('orderWorkflows drops repos the extractor rejected or found nothing in', () => {
  const readable = [repoEntry('a', 90), repoEntry('b', 80), repoEntry('c', 70)];
  const extracted = new Map([
    ['a', { is_ai_project: false, workflows: ['a1'] }],
    ['b', { is_ai_project: true, workflows: [] }],
    ['c', { is_ai_project: true, workflows: ['c1'] }],
  ]);

  const { queue, repos } = orderWorkflows(readable, extracted);
  assert.equal(repos, 1);
  assert.deepEqual(queue.map((q) => q.workflow), ['c1']);
});

test('orderWorkflows handles an empty extraction without throwing', () => {
  assert.deepEqual(orderWorkflows([], new Map()), { queue: [], repos: 0 });
});

/* ------------------------------ script filter ------------------------------ */

test('hasExcludedScript catches Chinese but leaves English and accents alone', () => {
  assert.equal(hasExcludedScript('一个基于大模型的智能体框架', ['han']), true);
  assert.equal(hasExcludedScript('AgentKit — 中文文档', ['han']), true);
  assert.equal(hasExcludedScript('An agent framework for LLM apps', ['han']), false);
  // Accented Latin, em dashes, arrows and emoji all turn up in real English
  // descriptions and must not trip the filter.
  assert.equal(hasExcludedScript('Café → naïve résumé parser ✨ (v2)', ['han']), false);
  // Japanese written with kanji trips `han` on purpose — the two share the
  // ideograph blocks, and the rule is "can I read this card", not "which
  // language is it". Pure katakana doesn't, until kana is switched on.
  assert.equal(hasExcludedScript('日本語のドキュメント', ['han']), true);
  assert.equal(hasExcludedScript('ドキュメント', ['han']), false);
  assert.equal(hasExcludedScript('ドキュメント', ['han', 'kana']), true);
  assert.equal(hasExcludedScript('anything at all', []), false);
});

test('shouldExclude drops the unreadable repos and keeps the bilingual ones', () => {
  const cfg = { hardExcludeIfStarsAbove: 90000, excludeScripts: ['han'] };
  const base = { stargazers_count: 100, name: 'agentkit', topics: [] };

  assert.equal(shouldExclude({ ...base, description: 'An agent toolkit for LLM apps' }, cfg), null);

  // Nothing readable left once the Chinese is gone.
  assert.equal(
    shouldExclude({ ...base, description: '一个智能体工具包' }, cfg),
    'not in a script we read',
  );

  // Bilingual: the English half stands on its own, so the repo stays. This is
  // the common case by a wide margin — dropping these lost real tools.
  assert.equal(
    shouldExclude(
      { ...base, description: 'The open-source AI agent that works out of the box · 想到，就能做到。' },
      cfg,
    ),
    null,
  );

  // The name is the repo's URL and can't be rewritten, so it's a hard drop.
  assert.equal(
    shouldExclude({ ...base, name: '智能体', description: 'An agent toolkit for LLM apps' }, cfg),
    'not in a script we read',
  );

  // Topics are card-visible but disposable — filtered at render, not fatal.
  assert.equal(
    shouldExclude({ ...base, description: 'An agent toolkit for LLM apps', topics: ['中文', 'llm'] }, cfg),
    null,
  );
});

test('stripExcludedScript keeps the English half of a bilingual description', () => {
  const han = ['han'];

  // Cleanly split by a separator.
  assert.equal(
    stripExcludedScript(
      'Consider it done. The open-source AI agent that works out of the box · 想到，就能做到。开源、开箱即用的 AI Agent。',
      han,
    ),
    'Consider it done. The open-source AI agent that works out of the box',
  );

  // Split by nothing at all — the two languages just abut.
  assert.equal(
    stripExcludedScript(
      'A practical, open-source guide to mastering WorkBuddy through real-world workflows.开源的 WorkBuddy 实战蓝皮书。',
      han,
    ),
    'A practical, open-source guide to mastering WorkBuddy through real-world workflows.',
  );

  // Interleaved. Cutting on punctuation left the debris from the mixed half
  // welded onto the good sentence: "…from scratch. Claude Code 50 ~5000
  // TypeScript / Python 11 coding agent". Cutting on the script transition,
  // then requiring each surviving run to read as prose, is what fixes it.
  assert.equal(
    stripExcludedScript(
      'Build your own Claude Code from scratch. 从零开始构建 Claude Code，50 节课 ~5000 行 TypeScript / Python，11 个 coding agent',
      han,
    ),
    'Build your own Claude Code from scratch.',
  );

  // A residue of product names is not a description.
  assert.equal(stripExcludedScript('企业数据分析、统计分析｜Analysis Lab、FastAPI、Next.js', han), '');
  assert.equal(stripExcludedScript('面向 AI 创作的开源无限画布工作台', han), '');

  // Untouched when there is nothing to strip.
  const plain = 'A perfectly ordinary English description';
  assert.equal(stripExcludedScript(plain, han), plain);
  assert.equal(stripExcludedScript(plain, []), plain);
});

test('emoji are not mistaken for Chinese', () => {
  // Astral-plane characters are surrogate pairs, and a character class tested
  // without the `u` flag can match the halves. A naive
  // /[一-鿿豈-﫿]/ does exactly that and reports every
  // rocket-ship README as Chinese — which is how this was nearly missed.
  const emoji = 'The agentic HTML editor 🚀 75 Skills 🛡️ Sandboxed preview 📤 1-click 🔑 Zero API key';

  assert.equal(hasExcludedScript(emoji, ['han']), false);
  assert.equal(stripExcludedScript(emoji, ['han']), emoji);
  for (const ch of ['🚀', '🔍', '🐙', '📤', '🔑', '✨', '→', 'é', '·']) {
    assert.equal(hasExcludedScript(ch, ['han']), false, `${ch} should not read as Chinese`);
  }
  assert.equal(hasExcludedScript('一', ['han']), true);
});

/* --------------------------- tool-build weighting --------------------------- */

const SCORING = {
  weights: { momentum: 34, freshness: 22, novelty: 24, substance: 10, obscurity: 10 },
  penalizeKeywords: ['from scratch', 'compiler', 'simd', 'tutorial'],
  rewardKeywords: ['cli', 'self-hosted', 'lets you', 'browser extension'],
  installSignals: ['npm install', 'brew install'],
  obscurityIdealStars: 400,
  hardExcludeIfStarsAbove: 90000,
  excludeScripts: [],
};

const repoOf = (description) => ({
  name: 'thing',
  description,
  topics: ['ai', 'llm'],
  language: 'TypeScript',
  stargazers_count: 300,
  created_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
  license: {},
});

test('a shipped tool outscores a from-scratch demonstration', () => {
  const tool = scoreRepo(
    repoOf('A CLI that lets you run evals against your own prompts, self-hosted.'),
    'Install with `npm install -g thing`. '.padEnd(2000, 'x'),
    SCORING,
  );
  const trick = scoreRepo(
    repoOf('A transformer compiler written from scratch with SIMD kernels.'),
    'A walkthrough of the approach. '.padEnd(2000, 'x'),
    SCORING,
  );

  assert.ok(
    tool.breakdown.novelty > trick.breakdown.novelty + 20,
    `expected the tool to lead clearly, got ${tool.breakdown.novelty} vs ${trick.breakdown.novelty}`,
  );
});

test('keyword stuffing cannot saturate the novelty component', () => {
  // Every reward term at once. Before the cap this alone cleared 1.0 and the
  // component stopped discriminating between anything.
  const stuffed = scoreRepo(
    repoOf('cli self-hosted lets you browser extension ' + 'cli self-hosted lets you'),
    'no install line here. '.padEnd(2000, 'x'),
    SCORING,
  );
  assert.ok(
    stuffed.breakdown.novelty < 100,
    `expected the cap to bite, got ${stuffed.breakdown.novelty}`,
  );
});
