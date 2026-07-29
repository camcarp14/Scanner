import { useEffect, useRef } from 'react';
import { PALETTES, type Palette } from '../design/palettes';
import type { Theme } from '../lib/store';

/**
 * A palette rendered as what it actually is: the page ground, a card lifted
 * off it, two bars of text, one accent chip. Colours come from palettes.ts,
 * generated from the same table as themes.css — so a swatch physically cannot
 * show a colour the theme doesn't use.
 */
function Swatch({ palette, mode, selected }: { palette: Palette; mode: Theme; selected: boolean }) {
  const c = palette[mode];
  return (
    <span
      aria-hidden
      className="swatch"
      style={{
        background: c.bg,
        // box-shadow rather than border: a border changes the box size, which
        // reflows the whole grid every time the selection moves.
        boxShadow: selected
          ? `inset 0 0 0 1px color-mix(in srgb, ${c.text} 16%, transparent), 0 0 0 2px var(--accent)`
          : `inset 0 0 0 1px color-mix(in srgb, ${c.text} 16%, transparent)`,
      }}
    >
      <span className="s-card" style={{ background: c.panel }} />
      <span className="s-line" style={{ background: c.text }} />
      <span className="s-line short" style={{ background: c.text }} />
      <span className="s-dot" style={{ background: c.accent }} />
    </span>
  );
}

const MODES: { key: Theme; label: string; hint: string }[] = [
  { key: 'light', label: 'Light', hint: 'Paper' },
  { key: 'dark', label: 'Dark', hint: 'After hours' },
];

interface Props {
  theme: Theme;
  palette: string;
  onTheme: (theme: Theme) => void;
  onPalette: (key: string) => void;
  onClose: () => void;
}

export function Appearance({ theme, palette, onTheme, onPalette, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = PALETTES.find((p) => p.key === palette);

  return (
    <div className="cmdk-wrap sheet-wrap" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="cmdk sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Appearance"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>Appearance</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          <p className="eyebrow panel-label">Mode</p>
          <div className="seg mode-seg" role="group" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m.key}
                className={theme === m.key ? 'on' : ''}
                aria-pressed={theme === m.key}
                onClick={() => onTheme(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* The grid previews every scheme in the mode CURRENTLY in force, so
              what you see is what tapping it gives you. Both axes on one
              screen is the point: picking a scheme while the preview showed
              the other mode would read as the picker being broken. */}
          <div className="panel-label-row">
            <p className="eyebrow panel-label">Colour</p>
            <span className="dim">{current?.label}</span>
          </div>

          <div className="palette-grid">
            {PALETTES.map((p) => {
              const selected = p.key === palette;
              return (
                <button
                  key={p.key}
                  type="button"
                  className={`palette-cell${selected ? ' on' : ''}`}
                  onClick={() => onPalette(p.key)}
                  aria-pressed={selected}
                  aria-label={`${p.label} — ${p.blurb}`}
                  title={p.blurb}
                >
                  <Swatch palette={p} mode={theme} selected={selected} />
                  <span className="palette-name">{p.label}</span>
                </button>
              );
            })}
          </div>

          <p className="breakdown-note">
            Every scheme has a light and a dark version — the rows above choose which. Verdict
            colours stay put: rejected is red in all twenty.
          </p>
        </div>
      </div>
    </div>
  );
}
