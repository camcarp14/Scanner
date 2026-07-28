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
import { renderSkillMd, slugify } from '../lib/skillfile.mjs';
import { readmeSummary, buildHook } from '../lib/summarize.mjs';

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
