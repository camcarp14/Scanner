// Heuristic README cleanup. This runs for every item and is what the feed shows
// when LLM enrichment is unavailable, so it has to be decent on its own.
//
// READMEs are mostly badges, logos, headings and install instructions. We strip
// all of that and keep the first sentence that actually says what the thing is.

export function stripMarkdown(text) {
  let out = text;
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links -> label
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/^[>\s]*[-*+]\s+/gm, ''); // bullets
  out = out.replace(/^#{1,6}\s+/gm, ''); // headings
  out = out.replace(/[*_~]{1,3}/g, ''); // emphasis
  out = out.replace(/\|/g, ' '); // tables
  out = out.replace(/[ \t]+/g, ' ');
  return out;
}

const BOILERPLATE_LINE =
  /^(installation|install|usage|getting started|quick ?start|license|contributing|table of contents|contents|features|documentation|docs|requirements|prerequisites|build|roadmap|changelog|acknowledg|sponsor|star history|contributors|download|issues|website|demo|discord|twitter|blog|report a bug|request a feature)\b/i;

/**
 * Badge rows and nav strips survive markdown stripping as things like
 * "example.com · Download · Issues". They look like sentences to a naive
 * filter, so reject them explicitly.
 */
function looksLikeNavRow(line) {
  const separators = (line.match(/[·•|→›]/g) || []).length;
  if (separators >= 2) return true;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 5) return true;
  // No sentence punctuation and mostly Capitalised Words: a heading or nav row.
  const capitalised = words.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  if (!/[.!?,;:]/.test(line) && capitalised / words.length > 0.6) return true;
  return false;
}

/**
 * Pull the first line that reads like a description of the project.
 * Returns '' if nothing usable is found — callers fall back to repo.description.
 */
export function readmeSummary(readme, repoName = '') {
  if (!readme) return '';

  const lines = stripMarkdown(readme)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 25 || line.length > 400) continue;
    if (BOILERPLATE_LINE.test(line)) continue;
    if (/^https?:\/\//.test(line)) continue;
    if (looksLikeNavRow(line)) continue;
    // A line that is just the repo name restated isn't a description.
    if (repoName && line.toLowerCase().replace(/[^a-z0-9]/g, '') ===
        repoName.toLowerCase().replace(/[^a-z0-9]/g, '')) continue;
    if (/^\d+\.\s/.test(line) && line.length < 60) continue; // numbered step

    return firstSentences(line, 2);
  }
  return '';
}

function firstSentences(text, count = 2) {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.slice(0, count).join(' ').trim();
}

/** Tidy a GitHub description: drop trailing emoji noise, collapse whitespace. */
export function cleanDescription(desc = '') {
  return desc
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, '')
    .trim();
}

/**
 * The one-liner the feed shows. Prefers the GitHub description when it's
 * substantial, otherwise falls back to the README's first real sentence.
 */
export function buildHook(repo, readme) {
  const desc = cleanDescription(repo.description || '');
  if (desc.length >= 45) return firstSentences(desc, 2);

  const fromReadme = readmeSummary(readme, repo.name);
  if (fromReadme) return fromReadme;

  return desc || `${repo.name} — no description provided.`;
}

/** A short excerpt used as context for the enrichment pass. */
export function readmeContext(readme, limit = 1400) {
  return stripMarkdown(readme)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 20)
    .join('\n')
    .slice(0, limit);
}
