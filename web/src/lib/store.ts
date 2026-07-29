// Persistence lives behind this interface on purpose.
//
// Today everything is local to the browser, which is the right default for a
// personal feed: no accounts, no server, works offline. If cross-device sync is
// ever wanted, implement `IdeaStore` against Supabase (or anything else) and
// swap the export at the bottom — nothing in the UI changes.

export interface StoreState {
  bookmarks: string[];
  dismissed: string[];
  opened: string[];
  lastVisit: string | null;
}

export interface IdeaStore {
  load(): Promise<StoreState>;
  save(state: StoreState): Promise<void>;
}

const KEY = 'ideafeed.state.v1';

const EMPTY: StoreState = {
  bookmarks: [],
  dismissed: [],
  opened: [],
  lastVisit: null,
};

function readLocal(): StoreState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<StoreState>;
    return {
      bookmarks: parsed.bookmarks ?? [],
      dismissed: parsed.dismissed ?? [],
      opened: parsed.opened ?? [],
      lastVisit: parsed.lastVisit ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export const localStore: IdeaStore = {
  async load() {
    return readLocal();
  },
  async save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Quota errors are survivable — the session keeps working in memory.
    }
  },
};

export const store: IdeaStore = localStore;

/* ---------- theme, kept separate so the pre-paint inline script can read it --------- */

export type Theme = 'dark' | 'light';

// Both guarded: touching localStorage throws outright when storage is blocked
// (Safari with cookies disabled, an embedded third-party frame), and setItem
// throws on quota. Unguarded, either one takes down the whole app from inside
// an effect — a white screen, not a lost preference.

export function readTheme(): Theme {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('ideafeed.theme');
  } catch {
    saved = null;
  }
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function writeTheme(theme: Theme) {
  // The attribute is what actually themes the page, so it goes first and
  // applies even when the preference can't be persisted.
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('ideafeed.theme', theme);
  } catch {
    // Preference won't survive a reload; the current session is unaffected.
  }
}

/* ---------- export, for getting saved items back out ---------- */

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox ignores a click on an anchor that isn't in the document, and
  // revoking the URL in the same tick can cancel a download that hasn't
  // started yet — so: attach, click, then revoke on the next turn.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
