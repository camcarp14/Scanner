// Scoring: how interesting is this repo, biased toward *novel* over *popular*.
//
// Five components, each normalised to 0..1, then weighted by config.scoring.weights.
// The weights sum to 100 so the final score reads as a percentage.

const DAY = 86_400_000;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / DAY;

/** Stars per day since creation. The single most useful signal we have. */
export function starVelocity(repo) {
  const age = Math.max(daysSince(repo.created_at), 1);
  return repo.stargazers_count / age;
}

/**
 * Momentum: log-scaled star velocity.
 * 0.1 stars/day ≈ 0.15 · 1/day ≈ 0.4 · 10/day ≈ 0.7 · 100/day ≈ 1.0
 */
function momentumScore(repo) {
  const v = starVelocity(repo);
  return clamp01(Math.log10(v + 1) / 2);
}

/** Freshness: full marks under a week old, decaying to zero at a year. */
function freshnessScore(repo) {
  const age = daysSince(repo.created_at);
  if (age <= 7) return 1;
  return clamp01(1 - Math.log10(age / 7 + 1) / Math.log10(365 / 7 + 1));
}

/**
 * Novelty: keyword and shape heuristics. This is the lever that keeps
 * awesome-lists, boilerplate and tutorial repos out of the feed even when
 * their star counts are enormous.
 */
function noveltyScore(repo, readme, cfg) {
  const haystack = [
    repo.name,
    repo.description || '',
    (repo.topics || []).join(' '),
    readme.slice(0, 1500),
  ]
    .join(' \n ')
    .toLowerCase();

  let score = 0.5;

  for (const bad of cfg.penalizeKeywords) {
    if (haystack.includes(bad.toLowerCase())) score -= 0.18;
  }
  for (const good of cfg.rewardKeywords) {
    if (haystack.includes(good.toLowerCase())) score += 0.07;
  }

  if (cfg.unusualLanguages.includes(repo.language)) score += 0.12;

  // A specific description reads as a real project; a vague one rarely does.
  const desc = (repo.description || '').trim();
  if (desc.length >= 40) score += 0.08;
  if (!desc) score -= 0.25;

  // Repos that are mostly a name and a star count tend to be lists.
  const topicCount = (repo.topics || []).length;
  if (topicCount >= 3) score += 0.05;

  if (repo.fork) score -= 0.35;
  if (repo.archived) score -= 0.3;

  return clamp01(score);
}

/** Substance: is there actually something here to look at? */
function substanceScore(repo, readme) {
  let score = 0;
  if (readme.length > 400) score += 0.35;
  if (readme.length > 1500) score += 0.2;
  if (repo.description) score += 0.2;
  if ((repo.topics || []).length > 0) score += 0.1;
  if (repo.license) score += 0.05;
  if (repo.homepage) score += 0.1;
  return clamp01(score);
}

/**
 * Obscurity: a bell curve peaking at `obscurityIdealStars`.
 * 40k-star household names score near zero here; a 300-star repo scores ~1.
 */
function obscurityScore(repo, cfg) {
  const stars = Math.max(repo.stargazers_count, 1);
  const ideal = cfg.obscurityIdealStars;
  const distance = Math.log10(stars) - Math.log10(ideal);
  return clamp01(Math.exp(-(distance * distance) / 1.6));
}

/**
 * Returns { score, breakdown } — the breakdown is kept on each item so the UI
 * can explain *why* something surfaced instead of just asserting a number.
 *
 * `prior` is a previously stored breakdown. On refresh runs we don't re-fetch
 * READMEs, so the two README-dependent components (novelty, substance) are
 * carried over rather than recomputed against an empty string — otherwise a
 * repo's score would sag every time it was seen again.
 */
export function scoreRepo(repo, readme, cfg, prior = null) {
  const w = cfg.weights;
  const carryOver = !readme && prior;

  const parts = {
    momentum: momentumScore(repo),
    freshness: freshnessScore(repo),
    novelty: carryOver ? prior.novelty / 100 : noveltyScore(repo, readme, cfg),
    substance: carryOver ? prior.substance / 100 : substanceScore(repo, readme),
    obscurity: obscurityScore(repo, cfg),
  };

  const score = Object.entries(parts).reduce(
    (sum, [key, value]) => sum + value * (w[key] || 0),
    0,
  );

  return {
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100)]),
    ),
  };
}

export function shouldExclude(repo, cfg) {
  if (repo.stargazers_count > cfg.hardExcludeIfStarsAbove) return 'too well known';
  if (repo.fork) return 'fork';
  if (repo.archived) return 'archived';
  if (repo.disabled) return 'disabled';
  return null;
}

export { daysSince };
