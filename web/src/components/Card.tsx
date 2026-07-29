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
  const score = Math.round(item.score);

  return (
    <article
      ref={cardRef}
      className={`card${selected ? ' selected' : ''}${opened ? ' opened' : ''}`}
      aria-current={selected || undefined}
    >
      {/* Same anatomy as a skill card — dominant score, title, then a labelled
          fact grid — so both lists scan the same way and the columns line up
          from one card to the next. */}
      <header className="sk-head">
        <span className="sk-score" title="Repo score out of 100">
          {score}
        </span>

        <div className="sk-titles">
          <h3 className="sk-name">
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
          <div className="sk-chips">
            {item.skills_extracted > 0 && (
              <span className="pill published" title="Skills extracted from this repo">
                {item.skills_extracted} skill{item.skills_extracted === 1 ? '' : 's'}
              </span>
            )}
            {isNew && <span className="pill new">New</span>}
            {item.lanes.slice(0, 2).map((lane) => (
              <span className="pill" key={lane}>
                {lane}
              </span>
            ))}
          </div>
        </div>
      </header>

      <p className="hook">{item.hook}</p>

      <dl className="sk-facts">
        <div>
          <dt>Language</dt>
          <dd>
            {item.language ? (
              <>
                <span className="dot" style={{ background: languageColor(item.language) }} />
                {item.language}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Stars</dt>
          <dd className="mono">{compact(item.stars)}</dd>
        </div>
        <div>
          <dt>Since found</dt>
          <dd className={`mono${item.stars_gained > 0 ? ' gain' : ''}`}>
            {item.stars_gained > 0 ? `+${compact(item.stars_gained)}` : '—'}
          </dd>
        </div>
        <div>
          <dt>Velocity</dt>
          <dd className="mono">{velocityLabel(item.star_velocity)}</dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd>{ageLabel(item.age_days)}</dd>
        </div>
        <div>
          <dt>Docs read</dt>
          <dd className="mono" title={item.doc_files.join(', ')}>
            {item.doc_files.length || '—'}
          </dd>
        </div>
      </dl>

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
          className={`btn ghost score-btn${showWhy ? ' on' : ''}`}
          onClick={() => setShowWhy((v) => !v)}
          aria-expanded={showWhy}
          title="Why this surfaced"
        >
          Scoring
          <span className="caret" aria-hidden="true">
            {showWhy ? '▾' : '▸'}
          </span>
        </button>
        <span className="found">found {relative(item.first_seen)}</span>
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
