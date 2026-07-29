import { useState } from 'react';
import type { CandidateItem } from '../types';
import { Expand } from './primitives';
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

/** Same face as a skill card: what it is, what it does, where it came from. */
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
  const [showDetails, setShowDetails] = useState(false);

  return (
    <article
      ref={cardRef}
      className={`card${selected ? ' selected' : ''}${opened ? ' opened' : ''}`}
      aria-current={selected || undefined}
    >
      <header className="c-head">
        <h3 className="c-name">
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
        </h3>
        <div className="c-chips">
          {item.skills_extracted > 0 && (
            <span className="pill published">
              {item.skills_extracted} skill{item.skills_extracted === 1 ? '' : 's'}
            </span>
          )}
          {isNew && <span className="pill new">New</span>}
        </div>
      </header>

      <p className="hook">{item.hook}</p>

      {/* One line of the numbers that actually drive scanning: how big, how
          fast, how new. Everything else is behind Details. */}
      <p className="c-origin">
        {item.language && (
          <>
            <span className="dot" style={{ background: languageColor(item.language) }} />
            {item.language}
            <span className="c-sep">·</span>
          </>
        )}
        <span className="mono">{compact(item.stars)}★</span>
        {item.stars_gained > 0 && (
          <>
            <span className="c-sep">·</span>
            <span className="mono gain">+{compact(item.stars_gained)}</span>
          </>
        )}
        <span className="c-sep">·</span>
        {ageLabel(item.age_days)}
      </p>

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
        <button
          className={`btn ghost${showDetails ? ' on' : ''}`}
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
        >
          Details
          <span className="caret" aria-hidden="true">
            {showDetails ? '▾' : '▸'}
          </span>
        </button>
      </footer>

      <Expand open={showDetails}>
        <div className="details">
          <dl className="facts">
            <div>
              <dt>Velocity</dt>
              <dd className="mono">{velocityLabel(item.star_velocity)}</dd>
            </div>
            <div>
              <dt>Docs read</dt>
              <dd className="mono" title={item.doc_files.join(', ')}>
                {item.doc_files.length || '—'}
              </dd>
            </div>
            <div>
              <dt>Score</dt>
              <dd className="mono">{Math.round(item.score)}</dd>
            </div>
            <div>
              <dt>Found</dt>
              <dd>{relative(item.first_seen)}</dd>
            </div>
          </dl>

          {item.tags.length > 0 && (
            <div className="tags">
              {item.tags.slice(0, 6).map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          )}

          <p className="eyebrow panel-label">Scoring</p>
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

          <div className="panel-actions">
            <button className="btn ghost" onClick={onArchive}>
              {archived ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        </div>
      </Expand>
    </article>
  );
}
