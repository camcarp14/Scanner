// Thin GitHub REST client. No dependencies — Node 18+ has global fetch.
//
// Auth is optional but strongly recommended: unauthenticated search is capped at
// 10 requests/minute, authenticated at 30. GitHub Actions injects GITHUB_TOKEN
// for free, so in CI this is always authenticated.

const API = 'https://api.github.com';

let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function headers(accept = 'application/vnd.github+json') {
  const h = {
    accept,
    'user-agent': 'ideafeed-scanner',
    'x-github-api-version': '2022-11-28',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Search and the rest of the REST API have separate quotas. Unauthenticated,
// the core quota is only 60/hour — once it's gone there is no point queueing
// hundreds of README fetches behind it, so we note the reset time and skip.
let coreBlockedUntil = 0;

// A 403 with no rate-limit headers is not a quota problem — it's the request
// being refused outright (a policy, a proxy, an org restriction). Those are
// counted separately so the run reports the real reason it read nothing.
let forbiddenCount = 0;

export const coreQuotaExhausted = () => Date.now() < coreBlockedUntil;
export const forbiddenRequests = () => forbiddenCount;

/**
 * GET with retry on rate limit / transient failure.
 * Returns null on 404 (missing README, deleted repo) rather than throwing —
 * a single missing resource should never take down a whole scan.
 *
 * `waitOnRateLimit: false` makes the call give up immediately when the quota is
 * spent, instead of sleeping until it resets.
 */
async function get(url, { accept, attempts = 4, waitOnRateLimit = true } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: headers(accept) });
    } catch (err) {
      if (attempt === attempts) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (res.ok) return res;
    if (res.status === 404) return null;

    // A stale or wrongly-scoped token shouldn't kill the run — everything the
    // scanner reads is public, so drop the credential and continue anonymously.
    if (res.status === 401 && token) {
      console.warn('  GitHub rejected the token; continuing unauthenticated');
      token = '';
      continue;
    }

    const remaining = res.headers.get('x-ratelimit-remaining');
    const isRateLimited =
      res.status === 429 || (res.status === 403 && remaining === '0');

    // Refused, not throttled: private repo, org policy, or an egress proxy that
    // only allows some paths. Retrying won't help and it isn't fatal.
    if (res.status === 403 && !isRateLimited) {
      forbiddenCount++;
      return null;
    }

    if (isRateLimited) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      if (!waitOnRateLimit) {
        coreBlockedUntil = reset || Date.now() + 60_000;
        return null;
      }
      if (attempt < attempts) {
        const waitMs = reset ? Math.max(reset - Date.now(), 0) + 1500 : 20_000;
        console.log(`  rate limited, waiting ${Math.round(waitMs / 1000)}s…`);
        await sleep(Math.min(waitMs, 90_000));
        continue;
      }
    }

    if (res.status >= 500 && attempt < attempts) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} on ${url}: ${body.slice(0, 300)}`);
  }
  throw new Error(`GitHub request failed after ${attempts} attempts: ${url}`);
}

/** Search repositories. `sort` is one of stars | updated | forks | help-wanted-issues. */
export async function searchRepos(query, { sort = 'stars', perPage = 50 } = {}) {
  const url =
    `${API}/search/repositories?q=${encodeURIComponent(query)}` +
    `&sort=${sort}&order=desc&per_page=${Math.min(perPage, 100)}`;
  const res = await get(url);
  if (!res) return [];
  const json = await res.json();
  return json.items || [];
}

/**
 * Raw README text, truncated. Returns '' when the repo has no README, and also
 * when the core quota is spent — the heuristic summariser falls back to the
 * repo description, which is worse but not broken.
 */
export async function fetchReadme(fullName, maxBytes = 6000) {
  if (coreQuotaExhausted()) return '';
  const res = await get(`${API}/repos/${fullName}/readme`, {
    accept: 'application/vnd.github.raw',
    attempts: 2,
    waitOnRateLimit: false,
  });
  if (!res) return '';
  const text = await res.text();
  return text.slice(0, maxBytes);
}

/** Full repo object by `owner/name`. Used to hydrate trending results. */
export async function getRepo(fullName) {
  const res = await get(`${API}/repos/${fullName}`, { waitOnRateLimit: false });
  if (!res) return null;
  const repo = await res.json();
  // The repos endpoint omits `topics` unless asked for it via the preview
  // accept header; the search endpoint includes them. Normalise.
  return { ...repo, topics: repo.topics || [] };
}

/** A single file's raw contents, or '' when it doesn't exist. */
export async function fetchFile(fullName, path, maxBytes = 9000) {
  if (coreQuotaExhausted()) return '';
  const res = await get(
    `${API}/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    { accept: 'application/vnd.github.raw', attempts: 2, waitOnRateLimit: false },
  );
  if (!res) return '';
  const text = await res.text();
  return text.slice(0, maxBytes);
}

/**
 * Every file path in the default branch, via the git trees API — one request
 * instead of one per directory. Returns [] if the tree is too large or missing.
 */
export async function listTree(fullName, defaultBranch = 'HEAD') {
  if (coreQuotaExhausted()) return [];
  const res = await get(
    `${API}/repos/${fullName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    { attempts: 2, waitOnRateLimit: false },
  );
  if (!res) return [];
  const json = await res.json();
  if (!Array.isArray(json.tree)) return [];
  return json.tree.filter((node) => node.type === 'blob').map((node) => node.path);
}

export const isAuthenticated = () => Boolean(token);

/** Small concurrency-limited map — keeps us well under the secondary rate limit. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        console.warn(`  skipped ${items[i]?.full_name || i}: ${err.message}`);
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
