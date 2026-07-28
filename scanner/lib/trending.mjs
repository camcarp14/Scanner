// Stage 1a — GitHub Trending.
//
// Trending has no API, so this parses the HTML page. That makes it the most
// fragile part of the pipeline, which is why it is also the most defensive:
// any failure returns an empty list and the search lanes carry the run.
//
// The page only gives us `owner/repo`; the caller re-fetches each one through
// the REST API so trending repos end up with exactly the same shape as
// search results.

const TRENDING = 'https://github.com/trending';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0 Safari/537.36';

/**
 * Extract `owner/repo` pairs from a trending page.
 * The markup we key off is `<h2 class="h3 lh-condensed"><a href="/owner/repo">`,
 * which has been stable for years, but we validate every match anyway.
 */
export function parseTrending(html) {
  const names = [];
  const seen = new Set();

  // Article headings link to the repo; everything else on the page links to
  // users, stars, topics and so on.
  const headingBlocks = html.split('<article').slice(1);

  for (const block of headingBlocks) {
    const match = block.match(/<h2[^>]*>\s*<a[^>]*href="\/([^"#?]+)"/);
    if (!match) continue;
    const fullName = match[1].replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) continue;
    if (seen.has(fullName.toLowerCase())) continue;
    seen.add(fullName.toLowerCase());
    names.push(fullName);
  }

  return names;
}

async function fetchTrendingPage(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch trending repo names across the configured windows and languages.
 * Returns { names, ok } — `ok: false` means the caller should lean on search.
 */
export async function fetchTrending({ since = ['daily'], languages = [''] } = {}) {
  const names = new Set();
  let attempted = 0;
  let succeeded = 0;

  for (const window of since) {
    for (const language of languages) {
      attempted++;
      const url =
        `${TRENDING}${language ? `/${encodeURIComponent(language)}` : ''}` +
        `?since=${encodeURIComponent(window)}`;
      try {
        const html = await fetchTrendingPage(url);
        const parsed = parseTrending(html);
        parsed.forEach((n) => names.add(n));
        succeeded++;
        console.log(
          `  trending ${window}${language ? `/${language}` : ''} → ${parsed.length} repos`,
        );
      } catch (err) {
        console.warn(
          `  trending ${window}${language ? `/${language}` : ''} unavailable: ${err.message}`,
        );
      }
    }
  }

  return { names: [...names], ok: succeeded > 0, attempted, succeeded };
}
