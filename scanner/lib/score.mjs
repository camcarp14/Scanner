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
 * their star counts are enormous — and, since the config was reoriented, the
 * lever that prefers a tool somebody shipped over a demonstration of a
 * technique. Systems-internals vocabulary is penalised, not rewarded: a
 * hand-written JIT is an impressive thing and is not a thing you can use.
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

  // Capped, not unbounded. Each list used to apply its full weight per match
  // with no ceiling, so a repo matching six reward terms saturated the
  // component on vocabulary alone — and the lists have since roughly doubled,
  // which would have made a keyword-stuffed description outscore everything.
  const hits = (list) =>
    (list || []).filter((term) => haystack.includes(term.toLowerCase())).length;

  score -= Math.min(0.45, hits(cfg.penalizeKeywords) * 0.18);
  score += Math.min(0.28, hits(cfg.rewardKeywords) * 0.07);

  // The clearest available signal that this is a build rather than a writeup:
  // a line telling you how to run it. Searched across the whole README, since
  // install instructions rarely sit in the first 1500 characters.
  const full = readme.toLowerCase();
  if ((cfg.installSignals || []).some((term) => full.includes(term.toLowerCase()))) {
    score += 0.1;
  }

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

/*
 * Script filtering. A card written in a script you can't read is worse than no
 * card — it takes up a slot in a feed whose whole job is being scannable.
 *
 * `han` is the one that matters in practice: CJK ideographs cover Chinese, and
 * catch Japanese prose too, since kanji are drawn from the same block. The
 * others are here so widening this is a config edit rather than a code change.
 * Deliberately narrow ranges — CJK punctuation and the fullwidth forms block
 * also contain characters that turn up incidentally in otherwise-English text.
 */
const RANGES = {
  han: '㐀-䶿一-鿿豈-﫿',
  kana: '぀-ヿ',
  hangul: 'ᄀ-ᇿ가-힯',
  cyrillic: 'Ѐ-ӿ',
  arabic: '؀-ۿ',
  hebrew: '֐-׿',
  devanagari: 'ऀ-ॿ',
  thai: '฀-๿',
};

// Punctuation belonging to the stripped half of a bilingual line: CJK full
// stops and brackets, and the fullwidth forms. Removed alongside the script
// itself, never on its own -- some of these appear in otherwise-English text.
const CJK_PUNCT = '　-〿！-･￠-￦';

const classFor = (scripts) =>
  (scripts || [])
    .map((name) => RANGES[name])
    .filter(Boolean)
    .join('');

/** Does any of `text` fall in one of the configured excluded scripts? */
export function hasExcludedScript(text, scripts) {
  const cls = classFor(scripts);
  if (!text || !cls) return false;
  return new RegExp(`[${cls}]`).test(text);
}

/**
 * Remove the excluded-script portion of a string, leaving the rest intact.
 *
 * Dropping the whole repo is too blunt, because the most common shape by far
 * is BILINGUAL: an English sentence, a separator, then the same thing again in
 * Chinese. Eleven percent of the feed matched the plain test, and the first
 * three were real tools with perfectly readable English halves. So:
 *
 *   "Consider it done. The open-source AI agent · 想到，就能做到。"
 *
 * becomes "Consider it done. The open-source AI agent", and the repo stays.
 */
export function stripExcludedScript(text, scripts) {
  const cls = classFor(scripts);
  if (!text || !cls) return text || '';

  // A run of excluded-script characters together with the CJK punctuation and
  // spacing binding it, so a whole clause goes at once rather than leaving
  // punctuation confetti behind.
  const run = new RegExp(`[${cls}${CJK_PUNCT}]+(?:[\\s${CJK_PUNCT}]*[${cls}${CJK_PUNCT}]+)*`, 'g');
  const tidy = (s) =>
    s
      .replace(/\s*[·|｜/\\–—:;,-]+\s*$/, '')
      .replace(/^\s*[·|｜/\\–—:;,-]+\s*/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

  // Split on the separators that actually join the two halves of a bilingual
  // line BEFORE stripping, and judge each half on its own. Stripping the whole
  // string in one pass leaves the Latin fragments embedded in the Chinese half
  // stranded on the end -- "…out of the box · AI Agent".
  const segments = text.split(/\s*[·|｜]\s*|\n+/);
  const kept = [];

  for (const segment of segments) {
    if (!hasExcludedScript(segment, scripts)) {
      if (segment.trim()) kept.push(segment.trim());
      continue;
    }
    // What survives has to read as a sentence, not as the loose Latin words
    // (product names, framework names) sprinkled through the other language.
    const stripped = tidy(segment.replace(run, ' '));
    if (stripped.split(/\s+/).filter(Boolean).length >= 4) kept.push(stripped);
  }

  return tidy(kept.join(' · '));
}

// Below this, whatever survived the strip is a fragment, not a summary.
export const MIN_READABLE = 25;

/** Is there enough left of this text, after stripping, to render a card? */
export function readableAfterStrip(text, scripts) {
  if (!hasExcludedScript(text, scripts)) return true;
  return stripExcludedScript(text, scripts).length >= MIN_READABLE;
}

export function shouldExclude(repo, cfg) {
  if (repo.stargazers_count > cfg.hardExcludeIfStarsAbove) return 'too well known';
  if (repo.fork) return 'fork';
  if (repo.archived) return 'archived';
  if (repo.disabled) return 'disabled';

  const scripts = cfg.excludeScripts;

  // The name is the repo's identity and its URL -- it can't be rewritten, so a
  // name in another script is a drop rather than a strip.
  if (hasExcludedScript(repo.name || '', scripts)) return 'not in a script we read';

  // The description can be rewritten: keep the repo if a usable half survives.
  if (!readableAfterStrip(repo.description || '', scripts)) return 'not in a script we read';

  return null;
}

export { daysSince };
