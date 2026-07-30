// Optional mirror of each run into Postgres (the `the-pentagon` project).
//
// feed.json stays the source of truth for the website — it's a static file, it
// costs nothing to serve, and the app works with no database at all. This is
// additive: it gives the data a queryable home alongside the other agents, and
// it keeps run history, which a snapshot file can't.
//
// Everything here is best-effort. If the credentials are missing the sync is
// skipped; if a request fails the run still succeeds and still writes the feed.
// Losing the mirror must never cost us a scan.
//
// PostgREST over fetch rather than @supabase/supabase-js: two endpoints and no
// dependency to keep current in a job that otherwise installs nothing.

const CHUNK = 200;

export function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function client() {
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return async function request(table, rows, { onConflict, schema } = {}) {
    const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    const res = await fetch(`${url}/rest/v1/${table}${qs}`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // Everything ideafeed writes lives in `public`, which is PostgREST's
        // default, so no profile header is needed today. Kept as an option
        // because the same client is the obvious place to write elsewhere.
        ...(schema ? { 'content-profile': schema } : {}),
        // merge-duplicates makes this an upsert; minimal skips the echo.
        prefer: onConflict
          ? 'resolution=merge-duplicates,return=minimal'
          : 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${table}: ${body.slice(0, 240)}`);
    }
  };
}

const iso = (value) => {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

const candidateRow = (item) => ({
  id: item.id,
  full_name: item.full_name,
  owner: item.owner,
  name: item.name,
  url: item.url,
  description: item.description || null,
  hook: item.hook || null,
  language: item.language,
  topics: item.topics || [],
  tags: item.tags || [],
  stars: item.stars ?? 0,
  star_velocity: item.star_velocity ?? null,
  age_days: item.age_days ?? null,
  repo_created_at: iso(item.created_at),
  pushed_at: iso(item.pushed_at),
  score: item.score ?? null,
  breakdown: item.breakdown || {},
  lanes: item.lanes || [],
  ai_signals: item.ai_signals || [],
  doc_files: item.doc_files || [],
  skills_extracted: item.skills_extracted ?? 0,
  stars_at_first_seen: item.stars_at_first_seen ?? null,
  first_seen: iso(item.first_seen),
  last_seen: iso(item.last_seen),
});

const skillRow = (item) => ({
  id: item.id,
  name: item.name,
  slug: item.slug,
  description: item.description || null,
  body: item.body || null,
  when_to_use: item.when_to_use || null,
  steps: item.steps || [],
  prerequisites: item.prerequisites || [],
  tools: item.tools || [],
  workflow: item.workflow || {},
  source_repo_id: item.source?.repo_id ?? null,
  source: item.source || {},
  skill_score: item.skill_score ?? null,
  skill_breakdown: item.skill_breakdown || {},
  verdict: item.review?.verdict ?? null,
  review: item.review ?? null,
  published: Boolean(item.published),
  skill_path: item.skill_path || null,
  mock: Boolean(item.mock),
  first_seen: iso(item.first_seen),
  last_seen: iso(item.last_seen),
});

/**
 * Mirror a completed run. Returns a short status string for the log.
 *
 * Candidates are upserted before skills because a skill references its source
 * repo; inserting a skill whose candidate isn't there yet would trip the
 * foreign key. Skills whose candidate has since been pruned from the feed still
 * insert fine — the column is ON DELETE SET NULL, not NOT NULL.
 */
export async function syncRun({ items, stats, mode, spend }) {
  const request = client();

  const candidates = items.filter((i) => i.type === 'candidate').map(candidateRow);
  const skills = items.filter((i) => i.type === 'skill').map(skillRow);

  // A skill can outlive its candidate's 45-day retention. Drop the dangling
  // reference rather than the row.
  const known = new Set(candidates.map((c) => c.id));
  for (const skill of skills) {
    if (skill.source_repo_id && !known.has(skill.source_repo_id)) {
      skill.source_repo_id = null;
    }
  }

  for (let i = 0; i < candidates.length; i += CHUNK) {
    await request('ideafeed_candidates', candidates.slice(i, i + CHUNK), { onConflict: 'id' });
  }
  for (let i = 0; i < skills.length; i += CHUNK) {
    await request('ideafeed_skills', skills.slice(i, i + CHUNK), { onConflict: 'id' });
  }

  await request('ideafeed_runs', [
    {
      mode,
      scanned: stats.scanned ?? null,
      kept_by_filter: stats.kept_by_filter ?? null,
      docs_read: stats.docs_read ?? null,
      skills_generated: stats.new_skills_this_run ?? null,
      published: stats.published_this_run ?? null,
      api_calls: stats.api_calls ?? null,
      input_tokens: stats.input_tokens ?? null,
      output_tokens: stats.output_tokens ?? null,
      cost_usd: stats.cost_usd ?? null,
      stats,
      by_stage: spend?.byStage ?? null,
    },
  ]);

  return `${candidates.length} candidates, ${skills.length} skills, 1 run`;
}

