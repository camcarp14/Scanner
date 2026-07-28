import { useState } from 'react';
import type { CandidateItem } from '../types';
import { Expand, Num } from './primitives';
import { ageLabel, compact, languageColor, relative, velocityLabel } from '../lib/format';

const BREAKDOWN_LABELS: Record<string, string> = {
  momentum: 'Momentum',
  freshness: 'Freshness',
  novelty: 'Novelty',
  substance: 'Substance',
  obscurity: 'Under the radar',
};

interface Props {
  item: CandidateItem;
  isNew: boolean;
  bookmarked: boolean;
  opened: boolean;
  selected: boolean;
  archived: boolean;
  onBookmark: () => void;
  onArchive: () => void;
  onOpen: () => void;
  cardRef?: (el: HTMLElement | null) => void;
}

export function Card({
  item,
  isNew,
  bookmarked,
  opened,
  selected,
  archived,
  onBookmark,
  onArchive,
  onOpen,
  cardRef,
}: Props) {
  const [showWhy, setShowWhy] = useState(false);

  return (
    <article
      ref={cardRef}
      className={`card${selected ? ' selected' : ''}${opened ? ' opened' : ''}`}
      aria-current={selected || undefined}
    >
      <header className="card-top">
        <a
          className="repo"
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={onOpen}
        >
          <span className="owner">{item.owner}</span>
          <span className="slash">/</span>
          <span className="name">{item.name}</span>
        </a>

        <div className="card-top-right">
          {isNew && <span className="pill new">new</span>}
          {item.skills_extracted > 0 && (
            <span className="pill published" title="Skills extracted from this repo">
              {item.skills_extracted} skill{item.skills_extracted === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </header>

      <p className="hook">{item.hook}</p>

      <div className="meta">
        {item.language && (
          <span className="meta-item">
            <span className="dot" style={{ background: languageColor(item.language) }} />
            {item.language}
          </span>
        )}
        <span className="meta-item mono" title={`${item.stars.toLocaleString()} stars`}>
          ★ <Num v={item.stars} f={compact} />
        </span>
        {item.stars_gained > 0 && (
          <span className="meta-item gain" title="Stars gained since this first appeared here">
            +{compact(item.stars_gained)} since found
          </span>
        )}
        <span className="meta-item mono">{velocityLabel(item.star_velocity)}</span>
        <span className="meta-item">{ageLabel(item.age_days)}</span>
        {item.doc_files.length > 0 && (
          <span className="meta-item" title={item.doc_files.join(', ')}>
            {item.doc_files.length} doc{item.doc_files.length === 1 ? '' : 's'} read
          </span>
        )}
        <span className="meta-item dim">found {relative(item.first_seen)}</span>
      </div>

      {item.tags.length > 0 && (
        <div className="tags">
          {item.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      <footer className="actions">
        <button
          className={`btn ghost${bookmarked ? ' on' : ''}`}
          onClick={onBookmark}
          aria-pressed={bookmarked}
          title="Save for later (b)"
        >
          {bookmarked ? '★ Saved' : '☆ Save'}
        </button>
        <a
          className="btn ghost"
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={onOpen}
          title="Open on GitHub (o)"
        >
          Open ↗
        </a>
        <button className="btn ghost" onClick={onArchive} title="Archive (x)">
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          className="btn ghost score-btn"
          onClick={() => setShowWhy((v) => !v)}
          aria-expanded={showWhy}
          title="Why this surfaced"
        >
          <span className="score mono">{Math.round(item.score)}</span>
          <span className="caret" aria-hidden="true">
            {showWhy ? '▾' : '▸'}
          </span>
        </button>
      </footer>

      <Expand open={showWhy}>
        <div className="breakdown">
          {Object.entries(item.breakdown).map(([key, value]) => (
            <div className="bar-row" key={key}>
              <span className="bar-label">{BREAKDOWN_LABELS[key] ?? key}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${value}%` }} />
              </span>
              <span className="bar-val mono">{value}</span>
            </div>
          ))}
          <p className="breakdown-note">
            {item.ai_signals.length > 0
              ? `Kept by the AI filter on: ${item.ai_signals.join(', ')}.`
              : 'Kept by the AI filter.'}{' '}
            {item.skills_extracted > 0
              ? `${item.skills_extracted} skill${item.skills_extracted === 1 ? '' : 's'} extracted so far.`
              : 'No reusable workflow extracted from its docs yet.'}
          </p>
        </div>
      </Expand>
    </article>
  );
}
