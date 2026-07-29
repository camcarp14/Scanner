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
  approve: 'Approved',
  hold: 'Needs review',
  reject: 'Rejected',
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
  const docCount = item.source.doc_files.length || 1;
  const score = Math.round(item.skill_score);

  // The most decision-useful signal on the card: whether the reviewer could
  // trace the claims back to the docs. It gets its own chip rather than sitting
  // buried in the breakdown, because it is the thing that decides whether a
  // skill is worth reading at all.
  const grounded = item.review?.grounded;

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
      className={`card skill v-${verdict}${selected ? ' selected' : ''}${item.mock ? ' mock' : ''}`}
      aria-current={selected || undefined}
    >
      <header className="sk-head">
        <span className={`sk-score v-${verdict}`} title="Rule-based skill score out of 100">
          {score}
        </span>

        <div className="sk-titles">
          <h3 className="sk-name mono">{item.slug ?? item.name}</h3>
          <div className="sk-chips">
            <span className={`pill verdict ${verdict}`}>{VERDICT_LABEL[verdict]}</span>
            {item.published && <span className="pill published">Published</span>}
            {grounded === false && (
              <span
                className="pill flag"
                title="The reviewer could not trace every claim back to the source documentation"
              >
                Unverified claims
              </span>
            )}
            {item.mock && <span className="pill warn">Mock</span>}
            {isNew && <span className="pill new">New</span>}
          </div>
        </div>
      </header>

      <p className="hook">{item.description}</p>

      <dl className="sk-facts">
        <div>
          <dt>Source</dt>
          <dd>
            <a href={item.source.url} target="_blank" rel="noreferrer noopener" className="mono">
              {item.source.full_name}
            </a>
          </dd>
        </div>
        <div>
          <dt>Language</dt>
          <dd>
            {item.source.language ? (
              <>
                <span
                  className="dot"
                  style={{ background: languageColor(item.source.language) }}
                />
                {item.source.language}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Stars</dt>
          <dd className="mono">{compact(item.source.stars)}</dd>
        </div>
        <div>
          <dt>Docs read</dt>
          <dd className="mono" title={item.source.doc_files.join(', ')}>
            {docCount}
          </dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd className="mono">{item.steps.length || '—'}</dd>
        </div>
        <div>
          <dt>Generated</dt>
          <dd>{relative(item.first_seen)}</dd>
        </div>
      </dl>

      {item.review?.reasons?.length ? (
        <ul className="sk-reasons">
          {item.review.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
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
          className={`btn ghost score-btn${open === 'why' ? ' on' : ''}`}
          onClick={() => setOpen(open === 'why' ? 'none' : 'why')}
          aria-expanded={open === 'why'}
          title="How this scored"
        >
          Scoring
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
              <span className="why-tag">Evidence</span>
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
                returned <strong>{VERDICT_LABEL[verdict].toLowerCase()}</strong> at{' '}
                {item.review.quality}/100
                {item.review.grounded
                  ? ' and judged it grounded'
                  : ' and could not confirm grounding'}
                . Where the two disagree, trust the reviewer — the rules measure
                vocabulary overlap, not whether a claim is true.
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
