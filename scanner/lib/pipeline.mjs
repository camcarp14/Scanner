// Stages 4, 6 and 7 — Workflow Extractor, Skill Generator, Reviewer.
//
// Three separate model calls on purpose. Extraction is a reading task, writing
// a SKILL.md is a composition task, and reviewing is an adversarial task; asking
// one call to do all three produces a skill that reviews itself favourably.
//
// Every stage degrades: no API key means no skills, not a crashed run. The
// `--mock-llm` path exists so the whole pipeline (and the app that reads it) can
// be exercised without spending anything — everything it produces is flagged
// `mock: true` and is never published.

const MAX_WORKFLOWS_PER_REPO = 2;

/* --------------------------------- schemas --------------------------------- */

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The exact id from the input. Copy verbatim.' },
          is_ai_project: {
            type: 'boolean',
            description: 'True only if this project is really about AI/ML/agents.',
          },
          workflows: {
            type: 'array',
            description:
              'Reusable workflows the documentation actually teaches. Empty array if the docs only cover installation or API reference. Never invent one.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short imperative title.' },
                when_to_use: {
                  type: 'string',
                  description: 'The situation that should trigger this workflow.',
                },
                steps: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '3-8 concrete steps, each starting with a verb.',
                },
                prerequisites: { type: 'array', items: { type: 'string' } },
                tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Commands, libraries or APIs the workflow uses.',
                },
                evidence: {
                  type: 'string',
                  description: 'A short quote from the docs this was drawn from.',
                },
              },
              required: ['title', 'when_to_use', 'steps', 'prerequisites', 'tools', 'evidence'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'is_ai_project', 'workflows'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'kebab-case slug, 2-4 words, no project name unless essential.',
    },
    description: {
      type: 'string',
      description:
        'One sentence starting with "Use when". This is the routing sentence an agent matches against, so it must describe the triggering situation, not the implementation.',
    },
    body: {
      type: 'string',
      description:
        'The SKILL.md body in markdown, without frontmatter and without a top-level title.',
    },
  },
  required: ['name', 'description', 'body'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['approve', 'hold', 'reject'],
            description:
              'approve = publish as-is. hold = real but needs a human. reject = generic, ungrounded or wrong.',
          },
          grounded: {
            type: 'boolean',
            description: 'Is every claim traceable to the source documentation provided?',
          },
          quality: { type: 'integer', description: '0-100.' },
          reasons: {
            type: 'array',
            items: { type: 'string' },
            description: '1-3 short, specific reasons for the verdict.',
          },
        },
        required: ['id', 'verdict', 'grounded', 'quality', 'reasons'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
  additionalProperties: false,
};

/* --------------------------------- prompts --------------------------------- */

const EXTRACT_SYSTEM = `You read documentation for open-source AI projects and extract reusable workflows.

A reusable workflow is a repeatable procedure someone could follow to get a specific result — "evaluate a retrieval pipeline against a golden set", "stream tool calls through a sandbox", "quantize a model for edge inference". It is not: installing the package, the API reference, the changelog, or the project's pitch.

Most repositories do not document a reusable workflow. Returning an empty list is the correct and expected answer for them, and is much better than stretching an install guide into a procedure. Extract at most ${MAX_WORKFLOWS_PER_REPO} per repository, and only what the documentation actually teaches.

Every step must come from the documentation in front of you. Do not fill gaps from your own knowledge of the ecosystem.`;

const GENERATE_SYSTEM = `You write SKILL.md files: compact, reusable procedures an AI agent loads when it hits a matching task.

The description is the most important line you write. An agent decides whether to load the skill by matching that sentence against the task in front of it, so it must name the triggering situation concretely. "Use when evaluating a RAG pipeline's retrieval quality against a labelled set" routes correctly; "Use for RAG tasks" does not.

The body is instructions for an agent that is mid-task, not a tutorial for a person learning the field. Lead with what to do. Give the concrete commands, arguments, file shapes and gotchas. Skip the background, the motivation, and the "in this guide we will" framing.

Ground every claim in the source documentation you are given. If the docs don't say it, don't write it. Prefer a shorter skill that is entirely true to a longer one that guesses.`;

const REVIEW_SYSTEM = `You are the last check before a generated SKILL.md is published, and your job is to find the reason it should not be.

Reject anything that is: generic advice that would be true of any project in the category; a restated installation guide; a workflow whose steps do not appear in the source documentation; or a description too vague to route on.

Hold anything real but incomplete, ambiguous, or that a person should look at before it ships.

Approve only skills you would be happy to see loaded automatically into an agent's context on a real task. Being strict is the point — a wrong skill is worse than a missing one. Most generated skills should not be approved.`;

/* ------------------------------- model plumbing ------------------------------- */

export function enrichmentAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function createClient() {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic();
  } catch (err) {
    console.warn(`  @anthropic-ai/sdk unavailable (${err.message})`);
    return null;
  }
}

function parseResponse(response) {
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `model declined (${response.stop_details?.category || 'unknown category'})`,
    );
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text.trim()) throw new Error('empty response');
  return JSON.parse(text);
}

/**
 * One model call with a JSON schema. Tries the server-side fallback path first
 * so a safety-classifier decline on one odd repo doesn't cost the whole batch,
 * then retries once on the plain endpoint.
 */
async function callModel(client, { system, prompt, schema, cfg, maxTokens = 8000 }) {
  const request = {
    model: cfg.model,
    max_tokens: maxTokens,
    system,
    output_config: {
      effort: cfg.effort,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: prompt }],
  };

  try {
    return parseResponse(
      await client.beta.messages.create({
        ...request,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }),
    );
  } catch (err) {
    console.warn(`    retrying without server-side fallbacks: ${err.message}`);
    return parseResponse(await client.messages.create(request));
  }
}

/* ------------------------------- stage 4: extract ------------------------------- */

function extractPrompt(batch) {
  return batch
    .map((item) =>
      [
        `id: ${item.id}`,
        `repo: ${item.full_name}`,
        `stars: ${item.stars}`,
        `language: ${item.language || 'unknown'}`,
        `topics: ${(item.topics || []).join(', ') || 'none'}`,
        `description: ${item.description || '(none)'}`,
        `documentation files read: ${(item.docs?.files || []).join(', ') || 'README only'}`,
        `documentation:\n${item.docs?.text || '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n=====\n\n');
}

export async function extractWorkflows(client, candidates, cfg, batchSize) {
  const out = new Map();

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const label = `${i + 1}-${Math.min(i + batchSize, candidates.length)}/${candidates.length}`;
    try {
      const result = await callModel(client, {
        system: EXTRACT_SYSTEM,
        prompt: `Extract reusable workflows from these ${batch.length} repositories.\n\n${extractPrompt(batch)}`,
        schema: EXTRACT_SCHEMA,
        cfg,
        maxTokens: 12000,
      });
      for (const entry of result.results || []) {
        if (!entry?.id) continue;
        out.set(String(entry.id), {
          is_ai_project: Boolean(entry.is_ai_project),
          workflows: (entry.workflows || []).slice(0, MAX_WORKFLOWS_PER_REPO),
        });
      }
      const found = (result.results || []).reduce(
        (n, r) => n + (r.workflows?.length || 0),
        0,
      );
      console.log(`  extracted ${label} → ${found} workflows`);
    } catch (err) {
      console.warn(`  extraction failed for ${label}: ${err.message}`);
    }
  }

  return out;
}

/* ------------------------------ stage 6: generate ------------------------------ */

export async function generateSkill(client, { repo, docs, workflow }, cfg) {
  const prompt = [
    `Write a SKILL.md for this workflow.`,
    ``,
    `Source project: ${repo.full_name} (${repo.language || 'unknown'}, ${repo.stars} stars)`,
    `Project description: ${repo.description || '(none)'}`,
    ``,
    `Workflow title: ${workflow.title}`,
    `When to use: ${workflow.when_to_use}`,
    `Steps identified: ${(workflow.steps || []).map((s, i) => `\n  ${i + 1}. ${s}`).join('')}`,
    `Prerequisites: ${(workflow.prerequisites || []).join(', ') || 'none stated'}`,
    `Tools: ${(workflow.tools || []).join(', ') || 'none stated'}`,
    `Evidence from the docs: ${workflow.evidence || '(none)'}`,
    ``,
    `Source documentation:`,
    docs?.text || '(none)',
  ].join('\n');

  return callModel(client, {
    system: GENERATE_SYSTEM,
    prompt,
    schema: GENERATE_SCHEMA,
    cfg,
    maxTokens: 8000,
  });
}

/* ------------------------------- stage 7: review ------------------------------- */

export async function reviewSkills(client, skills, cfg, batchSize) {
  const out = new Map();

  for (let i = 0; i < skills.length; i += batchSize) {
    const batch = skills.slice(i, i + batchSize);
    const label = `${i + 1}-${Math.min(i + batchSize, skills.length)}/${skills.length}`;

    const prompt = batch
      .map((skill) =>
        [
          `id: ${skill.id}`,
          `source repo: ${skill.source.full_name}`,
          `skill name: ${skill.name}`,
          `description: ${skill.description}`,
          `rule-based score: ${skill.skill_score} (grounding ${skill.skill_breakdown.grounding}, specificity ${skill.skill_breakdown.specificity})`,
          ``,
          `SKILL.md body:`,
          skill.body,
          ``,
          `Source documentation it should be grounded in:`,
          (skill.docs_excerpt || '').slice(0, 4000),
        ].join('\n'),
      )
      .join('\n\n=====\n\n');

    try {
      const result = await callModel(client, {
        system: REVIEW_SYSTEM,
        prompt: `Review these ${batch.length} generated skills.\n\n${prompt}`,
        schema: REVIEW_SCHEMA,
        cfg,
        maxTokens: 6000,
      });
      for (const review of result.reviews || []) {
        if (!review?.id) continue;
        out.set(String(review.id), {
          verdict: review.verdict,
          grounded: Boolean(review.grounded),
          quality: Math.max(0, Math.min(100, Math.round(Number(review.quality) || 0))),
          reasons: (review.reasons || []).map(String).slice(0, 3),
        });
      }
      console.log(`  reviewed ${label}`);
    } catch (err) {
      console.warn(`  review failed for ${label}: ${err.message}`);
    }
  }

  return out;
}

/* --------------------------------- mock mode --------------------------------- */

// Deterministic stand-ins so the pipeline and the app can be exercised without
// an API key. Everything produced here is marked `mock: true`, is never
// published, and is obvious on sight — it is a wiring test, not sample content.

export const mock = {
  extractWorkflows(candidates) {
    const out = new Map();
    for (const item of candidates) {
      const lines = (item.docs?.text || '')
        .split('\n')
        .filter((l) => l.length > 40)
        .slice(0, 4);
      out.set(item.id, {
        is_ai_project: true,
        workflows: lines.length
          ? [
              {
                title: `Work with ${item.name}`,
                when_to_use: `MOCK — placeholder trigger for ${item.full_name}.`,
                steps: lines.map((l) => `Review: ${l.slice(0, 90)}`),
                prerequisites: [`${item.language || 'unknown'} toolchain`],
                tools: [item.name],
                evidence: lines[0]?.slice(0, 120) || '',
              },
            ]
          : [],
      });
    }
    return out;
  },

  generateSkill({ repo, workflow }) {
    return {
      name: `mock-${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 40),
      description: `MOCK SKILL — generated without a model to test the pipeline. Source: ${repo.full_name}.`,
      body: [
        '> This is mock output. Run the scanner with an ANTHROPIC_API_KEY to',
        '> generate real skills.',
        '',
        '## Steps',
        ...(workflow.steps || []).map((s, i) => `${i + 1}. ${s}`),
      ].join('\n'),
    };
  },

  reviewSkills(skills) {
    const out = new Map();
    for (const skill of skills) {
      out.set(skill.id, {
        verdict: 'reject',
        grounded: false,
        quality: 0,
        reasons: ['Mock output is never published.'],
      });
    }
    return out;
  },
};
