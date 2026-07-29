import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feed, FeedItem, Range, SortKey, View } from './types';
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
import {
  downloadJson,
  readPalette,
  readTheme,
  store,
  writePalette,
  writeTheme,
  type StoreState,
  type Theme,
} from './lib/store';
import { Appearance } from './components/Appearance';
import { relative } from './lib/format';

const FEED_URL = `${import.meta.env.BASE_URL}feed.json`;

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'popping', label: 'Popping now' },
  { key: 'gained', label: 'Biggest gain' },
  { key: 'newest', label: 'Newest' },
  { key: 'stars', label: 'Most stars' },
  { key: 'score', label: 'Top scored' },
];

const VIEWS: { key: View; label: string }[] = [
  { key: 'ideas', label: 'Ideas' },
  { key: 'saved', label: 'Saved' },
  { key: 'skills', label: 'Skills' },
];

/** Look-back windows, by how long ago the repo itself was created. */
const RANGES: { key: Range; label: string }[] = [
  { key: 7, label: '7d' },
  { key: 30, label: '30d' },
  { key: 90, label: '90d' },
  { key: 0, label: 'All' },
];

/** Sort keys that only mean something for repos, not generated skills. */
const REPO_ONLY_SORTS: SortKey[] = ['popping', 'gained', 'stars'];

function App() {
  const toast = useToast();

  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState<StoreState | null>(null);
  /** The visit timestamp from *before* this session — drives the "new" pills. */
  const previousVisit = useRef<string | null>(null);

  // Opens on Ideas: the point of the app is what people are building, and the
  // generated skills are a by-product you go looking for.
  const [view, setView] = useState<View>('ideas');
  const [sort, setSort] = useState<SortKey>('popping');
  const [lane, setLane] = useState<string>('all');
  const [range, setRange] = useState<Range>(30);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');
  const [palette, setPalette] = useState<string>('ink');
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
    setPalette(readPalette());
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

  useEffect(() => {
    writePalette(palette);
  }, [palette]);

  // The feed is a static file rebuilt by the cron job, so "refresh" means
  // re-fetch it — worth a button because an installed PWA can sit on a cached
  // copy for a long time, and because the pull happens on a schedule you
  // didn't choose. The minimum spin is deliberate: an instant 304 otherwise
  // looks like the button did nothing.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const started = Date.now();
    await loadFeed({ silent: true });
    const elapsed = Date.now() - started;
    window.setTimeout(() => setRefreshing(false), Math.max(0, 420 - elapsed));
  }, [loadFeed]);

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
      if (showArchived) return archived.has(item.id);
      if (archived.has(item.id)) return false;
      if (view === 'saved') return bookmarks.has(item.id);
      return view === 'skills' ? isSkill(item) : isCandidate(item);
    });

    // Look-back: how recently the project itself was created, which is the
    // question "what have people built lately" actually asks.
    if (range > 0) {
      list = list.filter((item) => (isCandidate(item) ? item.age_days <= range : true));
    }

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
    const gainedOf = (item: FeedItem) => (isSkill(item) ? 0 : item.stars_gained);
    // "Newest" means the project is new, not that we happened to notice it.
    const createdOf = (item: FeedItem) =>
      isCandidate(item) ? new Date(item.created_at).getTime() : new Date(item.first_seen).getTime();

    return [...list].sort((a, b) => {
      switch (sort) {
        case 'newest':
          return createdOf(b) - createdOf(a);
        case 'popping':
          return velocityOf(b) - velocityOf(a);
        case 'gained':
          return gainedOf(b) - gainedOf(a);
        case 'stars':
          return starsOf(b) - starsOf(a);
        default:
          return scoreOf(b) - scoreOf(a);
      }
    });
  }, [feed, view, lane, query, sort, range, showArchived, bookmarks, archived]);

  const { shown, sentinel, hasMore } = useWindowed(
    visible,
    `${view}|${lane}|${sort}|${query}|${range}|${showArchived}`,
  );

  const newCount = useMemo(
    () =>
      (feed?.items ?? []).filter(
        (item) => isSkill(item) && isNew(item) && !archived.has(item.id),
      ).length,
    [feed, isNew, archived],
  );

  useEffect(() => {
    setSelected(0);
  }, [view, lane, sort, query, range, showArchived]);

  // Lanes and repo-only sorts don't apply to the skills view.
  const showFilters = view !== 'skills';
  const sortOptions = useMemo(
    () => (view === 'skills' ? SORTS.filter((s) => !REPO_ONLY_SORTS.includes(s.key)) : SORTS),
    [view],
  );
  useEffect(() => {
    if (view === 'skills' && REPO_ONLY_SORTS.includes(sort)) setSort('score');
    if (view === 'skills' && lane !== 'all') setLane('all');
  }, [view, sort, lane]);

  // Newly-found skills count as "new" on the Skills tab; on Ideas it's repos.
  const newBadge = useMemo(
    () =>
      (feed?.items ?? []).filter(
        (item) => isCandidate(item) && isNew(item) && !archived.has(item.id),
      ).length,
    [feed, isNew, archived],
  );

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
      if (paletteOpen || appearanceOpen || e.metaKey || e.ctrlKey || e.altKey) return;

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
        case 'r':
          e.preventDefault();
          void refresh();
          break;
        case 't':
          e.preventDefault();
          setAppearanceOpen(true);
          break;
        case '1':
          setView('ideas');
          break;
        case '2':
          setView('saved');
          break;
        case '3':
          setView('skills');
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
      ...RANGES.map((r) => ({
        id: `range-${r.key}`,
        label: r.key === 0 ? 'Look back: all time' : `Look back: last ${r.label}`,
        keywords: ['range', 'date', 'window', 'look back'],
        run: () => {
          setView('ideas');
          setRange(r.key);
        },
      })),
      {
        id: 'archived',
        label: 'Toggle archived',
        keywords: ['archive', 'hidden'],
        run: () => setShowArchived((v) => !v),
      },
      ...lanes.map((l) => ({
        id: `lane-${l.id}`,
        label: `Filter candidates to ${l.label}`,
        keywords: ['lane', 'filter', l.label.toLowerCase()],
        run: () => {
          setView('ideas');
          setLane(l.id);
        },
      })),
      {
        id: 'refresh',
        label: 'Refresh feed',
        keywords: ['reload', 'fetch'],
        run: () => void refresh().then(() => toast('Feed refreshed')),
      },
      {
        id: 'export',
        label: 'Export saved items as JSON',
        keywords: ['download', 'backup', 'bookmarks'],
        run: exportSaved,
      },
      {
        id: 'theme',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
        keywords: ['theme', 'dark', 'light', 'mode'],
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'appearance',
        label: 'Change the colour scheme',
        keywords: ['theme', 'colour', 'color', 'palette', 'appearance'],
        run: () => setAppearanceOpen(true),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, theme, feed, bookmarks, refresh]);

  /* ------------------------------- render ------------------------------- */

  cardRefs.current = [];

  const subtitle = feed ? (
    <>
      <Num v={feed.stats.candidates} /> ideas · scanned daily
    </>
  ) : (
    'Scanning GitHub for what people are building'
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
              className={`btn ghost icon${refreshing ? ' spinning' : ''}`}
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Check for new items (r)"
              aria-label="Refresh the feed"
            >
              <RefreshIcon />
            </button>
            <button
              className="btn ghost icon"
              onClick={() => setAppearanceOpen(true)}
              title="Appearance"
              aria-label="Appearance"
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
                {v.key === 'ideas' && newBadge > 0 && <span className="count">{newBadge}</span>}
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

        {showFilters && (
          <>
            <div className="filterbar">
              <div className="rangeset" role="group" aria-label="How recently the project was created">
                <span className="filter-label">Built</span>
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    className={`chip${range === r.key ? ' on' : ''}`}
                    onClick={() => setRange(r.key)}
                    title={
                      r.key === 0
                        ? 'Every project in the feed'
                        : `Projects created in the last ${r.label}`
                    }
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              <button
                className={`chip archived-toggle${showArchived ? ' on' : ''}`}
                onClick={() => setShowArchived((v) => !v)}
                aria-pressed={showArchived}
                title="Show what you've archived"
              >
                Archived
              </button>
            </div>

            {lanes.length > 0 && (
              <div className="lanes" role="group" aria-label="Filter by lane">
                <button
                  className={`chip${lane === 'all' ? ' on' : ''}`}
                  onClick={() => setLane('all')}
                >
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
          </>
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

        {!loading && !error && feed && (view === 'skills' || view === 'ideas') && (
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
            showArchived={showArchived}
            onReset={() => {
              setQuery('');
              setLane('all');
              setRange(0);
              setShowArchived(false);
            }}
            onGoIdeas={() => setView('ideas')}
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
        <kbd>/</kbd> search · <kbd>r</kbd> refresh · <kbd>t</kbd> theme
      </div>

      <CommandK commands={commands} open={paletteOpen} onOpenChange={setPaletteOpen} />

      {appearanceOpen && (
        <Appearance
          theme={theme}
          palette={palette}
          onTheme={setTheme}
          onPalette={setPalette}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
    </div>
  );
}

/** Two arcs and two arrowheads — a cycle, not a reload glyph. */
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M20 11a8 8 0 0 0-13.7-5.6L3 8.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M3 4v4.5h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M4 13a8 8 0 0 0 13.7 5.6L21 15.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M21 20v-4.5h-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
 * The last run as one compact strip. It was a five-column block with bars,
 * which pushed the first skill most of a screen down — the funnel is context,
 * not the content, so it gets one line.
 */
function Funnel({ feed }: { feed: Feed }) {
  const s = feed.stats;
  const steps = [
    { label: 'scanned', value: s.scanned, hint: 'Repos found by search + trending' },
    { label: 'kept', value: s.kept_by_filter, hint: 'Kept by the AI-project filter' },
    { label: 'skills', value: s.new_skills_this_run, hint: 'Generated from extracted workflows' },
  ];

  return (
    <section className="runbar" aria-label="Last pipeline run">
      <span className="runbar-stats mono">
        {steps.map((step, i) => (
          <span key={step.label} title={step.hint}>
            {i > 0 && <span className="c-sep"> › </span>}
            <b>{(step.value ?? 0).toLocaleString()}</b> {step.label}
          </span>
        ))}
      </span>
      <span className="runbar-when mono">{relative(feed.generated_at)}</span>
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
  showArchived,
  onReset,
  onGoIdeas,
}: {
  view: View;
  query: string;
  lane: string;
  feed: Feed | null;
  showArchived: boolean;
  onReset: () => void;
  onGoIdeas: () => void;
}) {
  if (showArchived) {
    return (
      <div className="state pagefade">
        <h2>Nothing archived</h2>
        <p>
          Press <kbd>x</kbd> on anything you don’t want to see again. It lands here, not in
          the bin.
        </p>
        <button className="btn primary" onClick={onReset}>
          Back to the feed
        </button>
      </div>
    );
  }

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
        <button className="btn primary" onClick={onGoIdeas}>
          Back to ideas
        </button>
      </div>
    );
  }

  if (view === 'ideas') {
    return (
      <div className="state pagefade">
        <h2>Nothing in this window</h2>
        <p>
          No projects match the current look-back. Widen it, or clear the lane filter.
        </p>
        <button className="btn primary" onClick={onReset}>
          Widen the window
        </button>
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
        <button className="btn primary" onClick={onGoIdeas}>
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
