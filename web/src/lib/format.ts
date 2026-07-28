export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.round(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  const days = Math.round(diff / DAY);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export function ageLabel(days: number): string {
  if (days <= 1) return 'today';
  if (days < 30) return `${days}d old`;
  if (days < 365) return `${Math.round(days / 30)}mo old`;
  return `${Math.round(days / 365)}y old`;
}

/** GitHub's language colours for the handful of languages that show up most. */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Zig: '#ec915c',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  Ruby: '#701516',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  OCaml: '#ef7a08',
  Nim: '#ffc200',
  Julia: '#a270ba',
  Lua: '#000080',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Svelte: '#ff3e00',
  Vue: '#41b883',
  Clojure: '#db5855',
  Odin: '#60AFFE',
  Crystal: '#000100',
  Gleam: '#ffaff3',
  Verilog: '#b2b7f8',
  Assembly: '#6E4C13',
};

export function languageColor(language: string | null): string {
  if (!language) return 'var(--muted)';
  return LANGUAGE_COLORS[language] ?? '#8b93a7';
}

export function velocityLabel(perDay: number): string {
  if (perDay >= 100) return `${Math.round(perDay)} ★/day`;
  if (perDay >= 10) return `${perDay.toFixed(0)} ★/day`;
  if (perDay >= 1) return `${perDay.toFixed(1)} ★/day`;
  return `${perDay.toFixed(2)} ★/day`;
}
