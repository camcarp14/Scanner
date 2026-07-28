// Motion + state primitives. One physics for the whole app: durations and
// easings live in styles.css as custom properties, everything here uses them.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* ---------------- numbers count to their value ---------------- */

export function useTween(target: number | null, dur = 650): number | null {
  const [value, setValue] = useState(target ?? 0);
  const fromRef = useRef(target ?? 0);

  useEffect(() => {
    if (target == null) return;
    const from = fromRef.current ?? 0;
    if (from === target) {
      setValue(target);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      setValue(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);

  return target == null ? null : Math.round(value);
}

export function Num({
  v,
  f = (x: number) => x.toLocaleString('en-US'),
  dur,
}: {
  v: number | null;
  f?: (x: number) => string;
  dur?: number;
}) {
  const shown = useTween(typeof v === 'number' ? v : null, dur);
  return <>{shown == null ? '—' : f(shown)}</>;
}

/* ---------------- skeletons ---------------- */

export const SkLine = ({ w }: { w?: 'w40' | 'w60' | 'w80' }) => (
  <div className={`sk sk-line${w ? ` ${w}` : ''}`} />
);

export const SkCard = () => (
  <article className="card sk-card" aria-hidden="true">
    <SkLine w="w40" />
    <div className="sk sk-big" />
    <SkLine w="w80" />
    <SkLine w="w60" />
  </article>
);

export function SkFeed({ cards = 5 }: { cards?: number }) {
  return (
    <div className="pagefade" aria-busy="true" aria-label="Loading feed">
      <div className="feed">
        {Array.from({ length: cards }).map((_, i) => (
          <SkCard key={i} />
        ))}
      </div>
    </div>
  );
}

/* ---------------- height:auto expansion, zero measuring ---------------- */

export function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`expand${open ? ' open' : ''}`} aria-hidden={!open}>
      <div>{open ? children : null}</div>
    </div>
  );
}

/* ---------------- toasts ---------------- */

type ToastItem = { id: string; msg: string; err?: boolean; out?: boolean };
type PushToast = (msg: string, opts?: { err?: boolean; ms?: number }) => void;

const ToastCtx = createContext<PushToast>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push: PushToast = (msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    const ms = opts.ms ?? 2400;
    setItems((xs) => [...xs, { id, msg, err: opts.err }]);
    setTimeout(
      () => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))),
      ms,
    );
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ms + 260);
  };

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast${t.err ? ' err' : ''}${t.out ? ' out' : ''}`}
          >
            <span className="tdot" />
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ---------------- ⌘K command palette ---------------- */

export interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
  run: () => void;
}

export function CommandK({
  commands,
  open,
  onOpenChange,
}: {
  commands: Command[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) ||
        (c.keywords ?? []).some((k) => k.includes(needle)),
    );
  }, [q, commands]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  // Scroll lock while the palette is up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => setIndex(0), [q]);

  if (!open) return null;

  const run = (command: Command) => {
    onOpenChange(false);
    command.run();
  };

  return (
    <div
      className="cmdk-wrap"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="cmdk" role="dialog" aria-label="Command palette" aria-modal="true">
        <input
          ref={inputRef}
          value={q}
          placeholder="Filter, sort, jump…"
          aria-label="Command"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && shown[index]) {
              e.preventDefault();
              run(shown[index]);
            } else if (e.key === 'Escape') {
              onOpenChange(false);
            }
          }}
        />
        <div className="list">
          {shown.map((command, i) => (
            <div
              key={command.id}
              className={`item${i === index ? ' on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(command);
              }}
            >
              <span>{command.label}</span>
              {command.hint ? <kbd>{command.hint}</kbd> : <span className="k">↵</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="item">Nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  );
}
