// Stage 3 — Reader: read the documentation first.
//
// The README tells you what a project is. The docs tell you how people actually
// use it, and that's where reusable workflows live — so this stage goes looking
// for guides, cookbooks, examples and any SKILL.md / AGENTS.md the repo already
// ships, and hands the extractor a single readable bundle.

import { fetchFile, listTree } from './github.mjs';
import { stripMarkdown } from './summarize.mjs';

const MARKDOWN = /\.mdx?$/i;

/**
 * Rank the file tree for documentation value. Preferred files first (in the
 * order configured), then markdown inside doc directories, shallowest first —
 * `docs/guide.md` beats `docs/api/internals/v2/notes.md`.
 */
export function rankDocPaths(paths, cfg) {
  const lower = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const picked = [];
  const seen = new Set();

  const take = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    picked.push(path);
  };

  for (const preferred of cfg.preferredFiles) {
    take(lower.get(preferred.toLowerCase()));
  }

  const inDocDirs = paths
    .filter((p) => MARKDOWN.test(p))
    .filter((p) => {
      const top = p.split('/')[0].toLowerCase();
      return cfg.docDirectories.includes(top);
    })
    .sort((a, b) => {
      const depth = a.split('/').length - b.split('/').length;
      if (depth !== 0) return depth;
      return a.localeCompare(b);
    });

  inDocDirs.forEach(take);
  return picked;
}

/**
 * Gather documentation for one repo.
 * Returns { text, files } — `text` is stripped markdown ready for a prompt.
 */
export async function readDocs(repo, readme, cfg, limits) {
  const parts = [];
  const files = [];

  if (readme) {
    parts.push(`# README\n${readme}`);
    files.push('README.md');
  }

  let tree = [];
  try {
    tree = await listTree(repo.full_name, repo.default_branch || 'HEAD');
  } catch {
    tree = [];
  }

  const candidates = rankDocPaths(tree, cfg).slice(0, limits.maxDocFiles);

  for (const path of candidates) {
    const text = await fetchFile(repo.full_name, path, limits.docBytes);
    if (!text || text.length < 200) continue;
    parts.push(`# ${path}\n${text}`);
    files.push(path);
  }

  const bundle = parts.join('\n\n---\n\n');

  return {
    files,
    text: stripMarkdown(bundle)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, limits.docBytes * 2),
    /** Kept raw and lowercased for the grounding check in skill scoring. */
    raw: bundle.toLowerCase(),
  };
}
