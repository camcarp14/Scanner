import { useMemo, useState } from 'react';
import type { SkillItem } from '../types';
import { Expand } from './primitives';
import { compact, languageColor, relative } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

const BREAKDOWN_LABELS: Record<string, string> = {
  specificity: 'Specificity',
  actionability: 'Actionability',
  grounding: 'Grounded in docs',
  reusability: 'Reusability',
  sourceQuality: 'Source quality',
};

const VERDICT_LABEL: Record<string, string> = {
  approve: 'approved',
  hold: 'held for review',
  reject: 'rejected',
};

interface Props {
  item: SkillItem;
  isNew: boolean;
  bookmarked: boolean;
  archived: boolean;
  selected: boolean;
  onBookmark: () => void;
  onArchive: () => void;
  cardRef?: (el: HTMLElement | null) => void;
}

export function SkillCard({
  item,
  isNew,
  bookmarked,
  archived,
  selected,
  onBookmark,
  onArchive,
  cardRef,
}: Props) {
  const [open, setOpen] = useState<'none' | 'skill' | 'why'>('none');
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => renderMarkdown(item.body), [item.body]);
  const verdict = item.review?.verdict ?? 'hold';
  // The README always counts, even when the tree walk found nothing else.
  const docCount = item.source.doc_files.length || 1;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `---\nname: ${item.slug ?? item.name}\ndescription: ${item.description}\n---\n\n${item.body}\n`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article
      ref={cardRef}
      className={`card skill${selected ? ' selected' : ''}${item.mock ? ' mock' : ''}`}
      aria-current={selected || undefined}
    >
      <header className="card-top">
        <span className="skill-name mono">{item.slug ?? item.name}</span>
        <div className="card-top-right">
          {item.mock && <span className="pill warn">mock</span>}
          {isNew && <span className="pill new">new</span>}
          {item.published ? (
            <span className="pill published">published</span>
          ) : (
            <span className={`pill verdict ${verdict}`}>{VERDICT_LABEL[verdict]}</span>
          )}
        </div>
      </header>

      <p className="hook">{item.description}</p>

      <div className="meta">
        <a className="meta-item source" href={item.source.url} target="_blank" rel="noreferrer noopener">
          from <span className="mono">{item.source.full_name}</span>
        </a>
        {item.source.language && (
          <span className="meta-item">
            <span className="dot" style={{ background: languageColor(item.source.language) }} />
            {item.source.language}
          </span>
        )}
        <span className="meta-item mono">★ {compact(item.source.stars)}</span>
        <span className="meta-item" title={item.source.doc_files.join(', ')}>
          {docCount} doc{docCount === 1 ? '' : 's'} read
        </span>
        <span className="meta-item dim">generated {relative(item.first_seen)}</span>
      </div>

      {item.review?.reasons?.length ? (
        <p className="why">
          <span className="why-tag">reviewer</span>
          {item.review.reasons.join(' ')}
        </p>
      ) : null}

      <footer className="actions">
        <button
          className={`btn ghost${bookmarked ? ' on' : ''}`}
          onClick={onBookmark}
          aria-pressed={bookmarked}
          title="Save for later (b)"
        >
          {bookmarked ? '★ Saved' : '☆ Save'}
        </button>
        <button
          className={`btn ghost${open === 'skill' ? ' on' : ''}`}
          onClick={() => setOpen(open === 'skill' ? 'none' : 'skill')}
          aria-expanded={open === 'skill'}
        >
          SKILL.md
        </button>
        <button className="btn ghost" onClick={copy} title="Copy the SKILL.md">
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn ghost" onClick={onArchive} title="Archive (x)">
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          className="btn ghost score-btn"
          onClick={() => setOpen(open === 'why' ? 'none' : 'why')}
          aria-expanded={open === 'why'}
          title="How this scored"
        >
          <span className="score mono">{Math.round(item.skill_score)}</span>
          <span className="caret" aria-hidden="true">
            {open === 'why' ? '▾' : '▸'}
          </span>
        </button>
      </footer>

      <Expand open={open === 'skill'}>
        <div className="skillmd">
          <div className="skillmd-frontmatter mono">
            <span className="dim">name:</span> {item.slug ?? item.name}
            <br />
            <span className="dim">description:</span> {item.description}
          </div>
          <div className="skillmd-body" dangerouslySetInnerHTML={{ __html: html }} />
          {item.workflow?.evidence && (
            <p className="evidence">
              <span className="why-tag">evidence</span>
              {item.workflow.evidence}
            </p>
          )}
          {item.skill_path && (
            <p className="breakdown-note">
              Published to <code>{item.skill_path}</code>
            </p>
          )}
        </div>
      </Expand>

      <Expand open={open === 'why'}>
        <div className="breakdown">
          {Object.entries(item.skill_breakdown).map(([key, value]) => (
            <div className="bar-row" key={key}>
              <span className="bar-label">{BREAKDOWN_LABELS[key] ?? key}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${value}%` }} />
              </span>
              <span className="bar-val mono">{value}</span>
            </div>
          ))}
          <p className="breakdown-note">
            Rules score first, then the reviewer{' '}
            {item.review ? (
              <>
                returned <strong>{VERDICT_LABEL[verdict]}</strong> at {item.review.quality}/100
                {item.review.grounded ? ' and judged it grounded' : ' and could not confirm grounding'}.
              </>
            ) : (
              'has not run on this one yet.'
            )}
          </p>
        </div>
      </Expand>
    </article>
  );
}
