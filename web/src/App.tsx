import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feed, FeedItem, SortKey, View } from './types';
import { isCandidate, isSkill } from './types';
import { Card } from './components/Card';
import { SkillCard } from './components/SkillCard';
import {
  CommandK,
  Num,
  SkFeed,
  useWindowed,
  ToastProvider,
  useToast,
  type Command,
} from './components/primitives';
import { downloadJson, readTheme, store, writeTheme, type StoreState, type Theme } from './lib/store';
import { relative } from './lib/format';

const FEED_URL = `${import.meta.env.BASE_URL}feed.json`;

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'score', label: 'Highest scoring' },
  { key: 'newest', label: 'Newest' },
  { key: 'momentum', label: 'Fastest moving' },
  { key: 'stars', label: 'Most stars' },
];

const VIEWS: { key: View; label: string }[] = [
  { key: 'skills', label: 'Skills' },
  { key: 'candidates', label: 'Candidates' },
  { key: 'saved', label: 'Saved' },
  { key: 'archive', label: 'Archive' },
];

/** Sort keys that only mean something for repos. */
const REPO_ONLY_SORTS: SortKey[] = ['momentum', 'stars'];

function App() {
  const toast = useToast();

  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState<StoreState | null>(null);
  /** The visit timestamp from *before* this session — drives the "new" pills. */
  const previousVisit = useRef<string | null>(null);

  const [view, setView] = useState<View>('skills');
  const [sort, setSort] = useState<SortKey>('score');
  const [lane, setLane] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');

  const searchRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);

  /* ------------------------------- data ------------------------------- */

  const loadFeed = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`feed.json returned ${res.status}`);
      const data: Feed = await res.json();
      if (!Array.isArray(data.items)) throw new Error('feed.json has no items');
      setFeed(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    setTheme(readTheme());
    void store.load().then((loaded) => {
      previousVisit.current = loaded.lastVisit;
      setState({ ...loaded, lastVisit: new Date().toISOString() });
    });
  }, []);

  useEffect(() => {
    if (!state) return;
    void store.save(state);
  }, [state]);

  useEffect(() => {
    writeTheme(theme);
  }, [theme]);

  /* ------------------------------ derived ------------------------------ */

  const bookmarks = useMemo(() => new Set(state?.bookmarks ?? []), [state]);
  const archived = useMemo(() => new Set(state?.dismissed ?? []), [state]);
  const opened = useMemo(() => new Set(state?.opened ?? []), [state]);

  const isNew = useCallback(
    (item: FeedItem) =>
      Boolean(previousVisit.current) &&
      new Date(item.first_seen).getTime() > new Date(previousVisit.current!).getTime(),
    [],
  );

  const lanes = feed?.lanes ?? [];

  const visible = useMemo(() => {
    const all = feed?.items ?? [];
    const needle = query.trim().toLowerCase();

    let list = all.filter((item) => {
      if (view === 'saved') return bookmarks.has(item.id);
      if (view === 'archive') return archived.has(item.id);
      if (archived.has(item.id)) return false;
      return view === 'skills' ? isSkill(item) : isCandidate(item);
    });

    if (lane !== 'all') {
      list = list.filter((item) => isCandidate(item) && item.lanes.includes(lane));
    }

    if (needle) {
      list = list.filter((item) => {
        const haystack = isSkill(item)
          ? [
              item.name,
              item.description,
              item.body,
              item.source.full_name,
              item.source.language ?? '',
              (item.tools ?? []).join(' '),
            ]
          : [
              item.full_name,
              item.hook,
              item.language ?? '',
              item.tags.join(' '),
              item.topics.join(' '),
            ];
        return haystack.join(' ').toLowerCase().includes(needle);
      });
    }

    const scoreOf = (item: FeedItem) => (isSkill(item) ? item.skill_score : item.score);
    const starsOf = (item: FeedItem) => (isSkill(item) ? item.source.stars : item.stars);
    const velocityOf = (item: FeedItem) => (isSkill(item) ? 0 : item.star_velocity);

    return [...list].sort((a, b) => {
      switch (sort) {
        case 'newest':
          return new Date(b.first_seen).getTime() - new Date(a.first_seen).getTime();
        case 'momentum':
          return velocityOf(b) - velocityOf(a);
        case 'stars':
          return starsOf(b) - starsOf(a);
        default:
          return scoreOf(b) - scoreOf(a);
      }
    });
  }, [feed, view, lane, query, sort, bookmarks, archived]);

  const { shown, sentinel, hasMore } = useWindowed(visible, `${view}|${lane}|${sort}|${query}`);

  const newCount = useMemo(
    () =>
      (feed?.items ?? []).filter(
        (item) => isSkill(item) && isNew(item) && !archived.has(item.id),
      ).length,
    [feed, isNew, archived],
  );

  useEffect(() => {
    setSelected(0);
  }, [view, lane, sort, query]);

  // Lanes and repo-only sorts don't apply to the skills view.
  const showLanes = view === 'candidates' || view === 'saved' || view === 'archive';
  const sortOptions = useMemo(
    () => (view === 'skills' ? SORTS.filter((s) => !REPO_ONLY_SORTS.includes(s.key)) : SORTS),
    [view],
  );
  useEffect(() => {
    if (view === 'skills' && REPO_ONLY_SORTS.includes(sort)) setSort('score');
    if (view === 'skills' && lane !== 'all') setLane('all');
  }, [view, sort, lane]);

  /* ------------------------------ actions ------------------------------ */

  const toggleIn = (key: 'bookmarks' | 'dismissed' | 'opened', id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const list = prev[key];
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      return { ...prev, [key]: next };
    });
  };

  const labelOf = (item: FeedItem) => (isSkill(item) ? item.slug ?? item.name : item.name);

  const toggleBookmark = (item: FeedItem) => {
    toggleIn('bookmarks', item.id);
    toast(bookmarks.has(item.id) ? 'Removed from saved' : `Saved ${labelOf(item)}`);
  };

  const toggleArchive = (item: FeedItem) => {
    toggleIn('dismissed', item.id);
    toast(archived.has(item.id) ? `Restored ${labelOf(item)}` : `Archived ${labelOf(item)}`);
  };

  const markOpened = (item: FeedItem) => {
    setState((prev) =>
      prev && !prev.opened.includes(item.id)
        ? { ...prev, opened: [...prev.opened, item.id] }
        : prev,
    );
  };

  const openSelected = () => {
    const item = shown[selected];
    if (!item) return;
    markOpened(item);
    window.open(isSkill(item) ? item.source.url : item.url, '_blank', 'noopener,noreferrer');
  };

  const exportSaved = () => {
    const saved = (feed?.items ?? []).filter((item) => bookmarks.has(item.id));
    if (!saved.length) {
      toast('Nothing saved yet', { err: true });
      return;
    }
    downloadJson(`ideafeed-saved-${new Date().toISOString().slice(0, 10)}.json`, saved);
    toast(`Exported ${saved.length} saved ${saved.length === 1 ? 'item' : 'items'}`);
  };

  /* ----------------------------- keyboard ----------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }

      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (typing) {
        if (e.key === 'Escape') (target as HTMLInputElement).blur();
        return;
      }
      if (paletteOpen || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'j':
          e.preventDefault();
          setSelected((i) => Math.min(i + 1, shown.length - 1));
          break;
        case 'k':
          e.preventDefault();
          setSelected((i) => Math.max(i - 1, 0));
          break;
        case 'o':
        case 'Enter':
          e.preventDefault();
          openSelected();
          break;
        case 'b':
          e.preventDefault();
          if (shown[selected]) toggleBookmark(shown[selected]);
          break;
        case 'x':
          e.preventDefault();
          if (shown[selected]) toggleArchive(shown[selected]);
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case '1':
          setView('skills');
          break;
        case '2':
          setView('candidates');
          break;
        case '3':
          setView('saved');
          break;
        case '4':
          setView('archive');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    cardRefs.current[selected]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  /* ---------------------------- command palette ---------------------------- */

  const commands: Command[] = useMemo(() => {
    return [
      ...VIEWS.map((v) => ({
        id: `view-${v.key}`,
        label: `Go to ${v.label}`,
        keywords: [v.key],
        run: () => setView(v.key),
      })),
      ...SORTS.map((s) => ({
        id: `sort-${s.key}`,
        label: `Sort by ${s.label.toLowerCase()}`,
        keywords: ['sort', s.key],
        run: () => setSort(s.key),
      })),
      {
        id: 'lane-all',
        label: 'Show all lanes',
        keywords: ['filter', 'lane', 'reset'],
        run: () => {
          setView('candidates');
          setLane('all');
        },
      },
      ...lanes.map((l) => ({
        id: `lane-${l.id}`,
        label: `Filter candidates to ${l.label}`,
        keywords: ['lane', 'filter', l.label.toLowerCase()],
        run: () => {
          setView('candidates');
          setLane(l.id);
        },
      })),
      {
        id: 'refresh',
        label: 'Refresh feed',
        keywords: ['reload', 'fetch'],
        run: () => void loadFeed({ silent: true }).then(() => toast('Feed refreshed')),
      },
      {
        id: 'export',
        label: 'Export saved items as JSON',
        keywords: ['download', 'backup', 'bookmarks'],
        run: exportSaved,
      },
      {
        id: 'theme',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        keywords: ['theme', 'dark', 'light', 'appearance'],
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, theme, feed, bookmarks]);

  /* ------------------------------- render ------------------------------- */

  cardRefs.current = [];

  // The counts tween up rather than appearing, so the header reads as an
  // instrument settling on a value instead of text swapping in.
  const subtitle = feed ? (
    <>
      <Num v={feed.stats.skills} /> skills · <Num v={feed.stats.published} /> published ·{' '}
      <Num v={feed.stats.candidates} /> candidates · {relative(feed.generated_at)}
    </>
  ) : (
    'Mining GitHub for reusable agent skills'
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <BrandMark />
            <div>
              <h1>ideafeed</h1>
              <p className="sub">{subtitle}</p>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="search">
              <SearchIcon />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Search the feed"
              />
              {query && (
                <button className="clear" onClick={() => setQuery('')} aria-label="Clear search">
                  ×
                </button>
              )}
            </div>
            <button
              className="btn ghost icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              <ThemeIcon theme={theme} />
            </button>
            <button className="btn ghost kbd-hint" onClick={() => setPaletteOpen(true)}>
              <kbd>⌘K</kbd>
            </button>
          </div>
        </div>

        <div className="controls">
          <div className="seg" role="tablist" aria-label="View">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                aria-selected={view === v.key}
                className={view === v.key ? 'on' : ''}
                onClick={() => setView(v.key)}
              >
                {v.label}
                {v.key === 'saved' && bookmarks.size > 0 && (
                  <span className="count">{bookmarks.size}</span>
                )}
              </button>
            ))}
          </div>

          <div className="spacer" />

          <label className="sort">
            <span className="sr-only">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {sortOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {showLanes && lanes.length > 0 && (
          <div className="lanes" role="group" aria-label="Filter by lane">
            <button className={`chip${lane === 'all' ? ' on' : ''}`} onClick={() => setLane('all')}>
              All
            </button>
            {lanes.map((l) => (
              <button
                key={l.id}
                className={`chip${lane === l.id ? ' on' : ''}`}
                onClick={() => setLane(lane === l.id ? 'all' : l.id)}
                title={l.blurb}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="main">
        {feed?.mode === 'mock' && (
          <div className="banner warn pagefade">
            <span className="banner-dot" />
            <span>
              This feed was generated in mock mode — skills here are placeholders, not
              real output. Run the scanner with an <code>ANTHROPIC_API_KEY</code> for real
              ones.
            </span>
          </div>
        )}

        {feed?.mode === 'unavailable' && (
          <div className="banner warn pagefade">
            <span className="banner-dot" />
            <span>
              No <code>ANTHROPIC_API_KEY</code> was set on the last run, so no skills were
              generated. Candidates are still being collected.
            </span>
          </div>
        )}

        {newCount > 0 && view === 'skills' && (
          <div className="banner pagefade">
            <span className="banner-dot" />
            {newCount} new skill{newCount === 1 ? '' : 's'} since your last visit
            <button className="btn ghost tiny" onClick={() => setSort('newest')}>
              Show newest first
            </button>
          </div>
        )}

        {!loading && !error && feed && (view === 'skills' || view === 'candidates') && (
          <Funnel feed={feed} />
        )}

        {loading && <SkFeed />}

        {!loading && error && (
          <div className="state pagefade">
            <h2>The feed didn’t load</h2>
            <p>{error}</p>
            <p className="dim">
              If this is a fresh checkout, the scanner hasn’t written{' '}
              <code>public/feed.json</code> yet.
            </p>
            <button className="btn primary" onClick={() => void loadFeed()}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && visible.length === 0 && (
          <EmptyState
            view={view}
            query={query}
            lane={lane}
            feed={feed}
            onReset={() => {
              setQuery('');
              setLane('all');
            }}
            onGoCandidates={() => setView('candidates')}
            onGoSkills={() => setView('skills')}
          />
        )}

        {!loading && !error && visible.length > 0 && (
          <div className="pagefade" key={`${view}-${lane}-${sort}`}>
            <div className="feed stagger">
              {shown.map((item, i) =>
                isSkill(item) ? (
                  <SkillCard
                    key={item.id}
                    item={item}
                    isNew={isNew(item)}
                    bookmarked={bookmarks.has(item.id)}
                    archived={archived.has(item.id)}
                    selected={i === selected}
                    onBookmark={() => toggleBookmark(item)}
                    onArchive={() => toggleArchive(item)}
                    cardRef={(el) => {
                      cardRefs.current[i] = el;
                    }}
                  />
                ) : (
                  <Card
                    key={item.id}
                    item={item}
                    isNew={isNew(item)}
                    bookmarked={bookmarks.has(item.id)}
                    archived={archived.has(item.id)}
                    opened={opened.has(item.id)}
                    selected={i === selected}
                    onBookmark={() => toggleBookmark(item)}
                    onArchive={() => toggleArchive(item)}
                    onOpen={() => markOpened(item)}
                    cardRef={(el) => {
                      cardRefs.current[i] = el;
                    }}
                  />
                ),
              )}
            </div>

            {/* Grows the window when it scrolls into view. */}
            <div ref={sentinel} aria-hidden="true" />

            <p className="footnote">
              {hasMore
                ? `${shown.length} of ${visible.length} — scroll for more`
                : `${visible.length} shown`}
              {' · '}
              <button className="linklike" onClick={exportSaved}>
                export saved
              </button>
            </p>
          </div>
        )}
      </main>

      <div className="keyhints" aria-hidden="true">
        <kbd>j</kbd>
        <kbd>k</kbd> move · <kbd>o</kbd> source · <kbd>b</kbd> save · <kbd>x</kbd> archive ·{' '}
        <kbd>/</kbd> search
      </div>

      <CommandK commands={commands} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/**
 * The same mark as the app icon — solid centre, closed ring, and a sweep broken
 * at the top-right. The sweep turns once every nine seconds, which is the only
 * ambient motion in the app: it says the thing is scanning, which it is.
 */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
      <g transform="translate(256 256)">
        <path
          className="brand-sweep"
          d="M 0 -150 A 150 150 0 1 0 106 106"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.4"
          strokeWidth="30"
          strokeLinecap="round"
        />
        <circle r="86" fill="none" stroke="currentColor" strokeOpacity="0.7" strokeWidth="32" />
        <circle r="38" fill="currentColor" />
      </g>
    </svg>
  );
}

/**
 * The last run, as a funnel. This is the most informative thing the app can
 * show and it was missing entirely: the pipeline's defining behaviour is how
 * much it throws away, and a bare "8 skills" hides that 425 repos went in.
 */
function Funnel({ feed }: { feed: Feed }) {
  const s = feed.stats;
  const steps = [
    { label: 'Scanned', value: s.scanned, hint: 'Repos found by search + trending' },
    { label: 'AI projects', value: s.kept_by_filter, hint: 'Kept by the filter' },
    { label: 'Docs read', value: s.docs_read, hint: 'New repos whose documentation was read' },
    { label: 'Skills', value: s.new_skills_this_run, hint: 'Generated from extracted workflows' },
    { label: 'Published', value: s.published_this_run, hint: 'Cleared the reviewer and the score' },
  ];
  const max = Math.max(...steps.map((x) => x.value || 0), 1);

  return (
    <section className="funnel" aria-label="Last pipeline run">
      <div className="funnel-head">
        <span className="eyebrow">Last run</span>
        <span className="funnel-when mono">{relative(feed.generated_at)}</span>
      </div>
      <ol className="funnel-steps">
        {steps.map((step) => (
          <li key={step.label} title={step.hint}>
            <span className="funnel-value mono">{(step.value ?? 0).toLocaleString()}</span>
            <span className="funnel-label">{step.label}</span>
            <span className="funnel-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(((step.value || 0) / max) * 100, 1.5)}%` }} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  // Shows what you'll get, not what you have.
  if (theme === 'dark') {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="8" cy="8" r="3.1" fill="currentColor" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <line
            key={deg}
            x1="8"
            y1="1.4"
            x2="8"
            y2="3.1"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            transform={`rotate(${deg} 8 8)`}
          />
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M13.2 10.1A5.6 5.6 0 0 1 6 2.8a5.7 5.7 0 1 0 7.2 7.3Z" fill="currentColor" />
    </svg>
  );
}

function EmptyState({
  view,
  query,
  lane,
  feed,
  onReset,
  onGoCandidates,
  onGoSkills,
}: {
  view: View;
  query: string;
  lane: string;
  feed: Feed | null;
  onReset: () => void;
  onGoCandidates: () => void;
  onGoSkills: () => void;
}) {
  if (query || lane !== 'all') {
    return (
      <div className="state pagefade">
        <h2>Nothing matches that</h2>
        <p>
          No results{query ? ` for “${query}”` : ''}
          {lane !== 'all' ? ` in ${lane}` : ''}.
        </p>
        <button className="btn primary" onClick={onReset}>
          Clear filters
        </button>
      </div>
    );
  }

  if (view === 'saved') {
    return (
      <div className="state pagefade">
        <h2>Nothing saved yet</h2>
        <p>
          Press <kbd>b</kbd> on any skill or candidate to keep it here for later.
        </p>
        <button className="btn primary" onClick={onGoSkills}>
          Back to skills
        </button>
      </div>
    );
  }

  if (view === 'archive') {
    return (
      <div className="state pagefade">
        <h2>Archive is empty</h2>
        <p>
          Press <kbd>x</kbd> on anything you don’t want to see again. It lands here, not in
          the bin.
        </p>
        <button className="btn primary" onClick={onGoSkills}>
          Back to skills
        </button>
      </div>
    );
  }

  if (view === 'candidates') {
    return (
      <div className="state pagefade">
        <h2>No candidates yet</h2>
        <p>
          The scanner hasn’t run, or nothing survived the AI filter. Run{' '}
          <code>npm run scan</code> in <code>ideafeed/scanner</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="state pagefade">
      <h2>No skills yet</h2>
      <p>
        {feed && feed.stats.candidates > 0
          ? `${feed.stats.candidates} candidate repositories are waiting. Skills appear once the extractor finds a reusable workflow in one of their docs — most repos don't have one, which is the point.`
          : 'Nothing has been through the pipeline yet.'}
      </p>
      {feed && feed.stats.candidates > 0 && (
        <button className="btn primary" onClick={onGoCandidates}>
          See the candidates
        </button>
      )}
    </div>
  );
}

export default function Root() {
  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}
