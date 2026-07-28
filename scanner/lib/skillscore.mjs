// Stage 5 — Skill Score: score with rules.
//
// This runs *before* the model reviews anything, and it exists to catch the
// failure mode that matters most here: a fluent, confident SKILL.md that isn't
// actually grounded in the source project. Rules can check that cheaply and
// without the model marking its own homework.

const clamp01 = (n) => Math.max(0, Math.min(1, n));

const IMPERATIVE =
  /^(run|call|open|create|write|read|set|add|install|configure|check|verify|parse|fetch|build|generate|pass|use|define|register|start|stop|apply|export|import|copy|move|deploy|query|inspect|measure|split|merge|wrap|mount|declare)\b/i;

const TRIGGER =
  /\b(when|whenever|if you|use this|for tasks|before|after|any time|anytime)\b/i;

/** Distinctive tokens: code identifiers, flags, dotted names, CamelCase. */
function distinctiveTerms(text) {
  const terms = new Set();
  const patterns = [
    /`([^`\n]{2,40})`/g, // backticked code
    /\b([a-z]+[-_][a-z0-9-_]{2,})\b/gi, // kebab / snake identifiers
    /\b([a-z]+\.[a-z][a-z0-9_.]{2,})\b/gi, // dotted paths
    /\b([A-Z][a-z]+[A-Z][A-Za-z]+)\b/g, // CamelCase
    /(--[a-z][a-z0-9-]+)/g, // CLI flags
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const term = match[1].toLowerCase().trim();
      if (term.length >= 4 && term.length <= 40) terms.add(term);
    }
  }
  return [...terms];
}

function specificityScore(skill, cfg) {
  const text = `${skill.description} ${skill.body}`.toLowerCase();
  let score = 0.55;

  for (const phrase of cfg.genericPhrases) {
    if (text.includes(phrase)) score -= 0.14;
  }

  const terms = distinctiveTerms(`${skill.description}\n${skill.body}`);
  score += clamp01(terms.length / 14) * 0.4;

  const words = skill.description.trim().split(/\s+/).length;
  if (words >= 12 && words <= 45) score += 0.1;
  if (words < 8) score -= 0.2;

  return clamp01(score);
}

function actionabilityScore(skill, cfg) {
  const steps = skill.steps || [];
  let score = 0;

  if (steps.length >= cfg.minSteps) score += 0.4;
  else score += (steps.length / cfg.minSteps) * 0.4;

  const imperative = steps.filter((s) => IMPERATIVE.test(String(s).trim())).length;
  score += clamp01(imperative / Math.max(steps.length, 1)) * 0.3;

  if ((skill.prerequisites || []).length > 0) score += 0.15;
  if ((skill.tools || []).length > 0) score += 0.15;

  return clamp01(score);
}

/**
 * Grounding: how much of the skill's distinctive vocabulary actually appears in
 * the source documentation. A skill full of terms the docs never mention was
 * written from the model's priors, not from the project.
 */
function groundingScore(skill, docsRaw) {
  if (!docsRaw) return 0.4;
  const terms = distinctiveTerms(`${skill.description}\n${skill.body}`);
  if (terms.length === 0) return 0.25;
  const found = terms.filter((term) => docsRaw.includes(term)).length;
  return clamp01(found / terms.length);
}

function reusabilityScore(skill) {
  let score = 0.3;
  const description = skill.description || '';

  if (TRIGGER.test(description)) score += 0.35;
  if ((skill.when_to_use || '').length > 20) score += 0.2;

  const body = skill.body || '';
  // A workflow that only makes sense inside one checkout isn't reusable.
  if (/\b(this repo|this repository|our codebase|in this project)\b/i.test(body)) {
    score -= 0.2;
  }
  if (body.length > 600) score += 0.15;
  if (body.length < 250) score -= 0.25;

  return clamp01(score);
}

function sourceQualityScore(repo, docs) {
  let score = 0;
  if (repo.stargazers_count >= 50) score += 0.3;
  if (repo.stargazers_count >= 500) score += 0.2;
  if ((docs?.files || []).length >= 2) score += 0.3;
  if ((docs?.text || '').length > 3000) score += 0.2;
  return clamp01(score);
}

export function scoreSkill(skill, repo, docs, cfg) {
  const w = cfg.weights;
  const parts = {
    specificity: specificityScore(skill, cfg),
    actionability: actionabilityScore(skill, cfg),
    grounding: groundingScore(skill, docs?.raw || ''),
    reusability: reusabilityScore(skill),
    sourceQuality: sourceQualityScore(repo, docs),
  };

  const score = Object.entries(parts).reduce(
    (sum, [key, value]) => sum + value * (w[key] || 0),
    0,
  );

  return {
    skill_score: Math.round(score * 10) / 10,
    skill_breakdown: Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100)]),
    ),
  };
}

export { distinctiveTerms };
