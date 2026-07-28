// Stage 2 — Filter: keep AI projects.
//
// Deliberately rule-based rather than a model call. It runs on every repo the
// scout finds (hundreds per run), so it has to be free, and "is this an AI
// project" is a question keywords answer well.
//
// Scoring: a strong topic or keyword is worth 2, a weak keyword 1. The default
// threshold of 2 means one strong signal is enough, or two weak ones.

const contains = (haystack, needle) => haystack.includes(needle.toLowerCase());

/**
 * @returns {{ keep: boolean, score: number, signals: string[] }}
 */
export function aiRelevance(repo, docs, cfg) {
  const topics = (repo.topics || []).map((t) => t.toLowerCase());
  const haystack = [
    repo.name,
    repo.description || '',
    topics.join(' '),
    (docs || '').slice(0, 2500),
  ]
    .join(' \n ')
    .toLowerCase();

  const signals = [];
  let score = 0;

  for (const topic of cfg.strongTopics) {
    if (topics.includes(topic)) {
      score += 2;
      signals.push(`topic:${topic}`);
      break; // one topic hit is the signal; more doesn't make it more AI
    }
  }

  for (const keyword of cfg.strongKeywords) {
    if (contains(haystack, keyword)) {
      score += 2;
      signals.push(keyword.trim());
      break;
    }
  }

  for (const keyword of cfg.weakKeywords) {
    if (contains(haystack, keyword)) {
      score += 1;
      signals.push(keyword.trim());
      if (signals.length >= 4) break;
    }
  }

  return {
    keep: score >= cfg.requireScore,
    score,
    signals: [...new Set(signals)].slice(0, 4),
  };
}
