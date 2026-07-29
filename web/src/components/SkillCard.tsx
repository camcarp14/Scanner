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

/**
 * The card face answers two questions only: what is this, and what does it do.
 * Every measurement — scores, star counts, doc counts, the reviewer's full
 * reasoning — sits behind Details. Six facts and three paragraphs on the face
 * made a list of eight skills unscannable.
 */
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
  const [open, setOpen] = useState<'none' | 'skill' | 'details'>('none');
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => renderMarkdown(item.body), [item.body]);
  const verdict = item.review?.verdict ?? 'hold';
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
      className={`card skill v-${verdict}${selected ? ' selected' : ''}${item.mock ? ' mock' : ''}`}
      aria-current={selected || undefined}
    >
      <header className="c-head">
        <h3 className="c-name mono">{item.slug ?? item.name}</h3>
        <div className="c-chips">
          {item.published && <span className="pill published">Published</span>}
          {!item.published && <span className={`pill verdict ${verdict}`}>{VERDICT_LABEL[verdict]}</span>}
          {item.review?.grounded === false && (
            <span className="pill flag" title="The reviewer could not trace every claim to the source docs">
              Unverified
            </span>
          )}
          {item.mock && <span className="pill warn">Mock</span>}
          {isNew && <span className="pill new">New</span>}
        </div>
      </header>

      <p className="hook">{item.description}</p>

      <p className="c-origin">
        <a href={item.source.url} target="_blank" rel="noreferrer noopener" className="mono">
          {item.source.full_name}
        </a>
        {item.source.language && (
          <>
            <span className="c-sep">·</span>
            <span className="dot" style={{ background: languageColor(item.source.language) }} />
            {item.source.language}
          </>
        )}
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
        <button
          className={`btn ghost${open === 'skill' ? ' on' : ''}`}
          onClick={() => setOpen(open === 'skill' ? 'none' : 'skill')}
          aria-expanded={open === 'skill'}
        >
          SKILL.md
        </button>
        <button
          className={`btn ghost${open === 'details' ? ' on' : ''}`}
          onClick={() => setOpen(open === 'details' ? 'none' : 'details')}
          aria-expanded={open === 'details'}
        >
          Details
          <span className="caret" aria-hidden="true">
            {open === 'details' ? '▾' : '▸'}
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
          <div className="panel-actions">
            <button className="btn ghost" onClick={copy}>
              {copied ? 'Copied' : 'Copy SKILL.md'}
            </button>
          </div>
        </div>
      </Expand>

      <Expand open={open === 'details'}>
        <div className="details">
          <dl className="facts">
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
              <dt>Score</dt>
              <dd className="mono">{Math.round(item.skill_score)}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{relative(item.first_seen)}</dd>
            </div>
          </dl>

          {item.review?.reasons?.length ? (
            <>
              <p className="eyebrow panel-label">Reviewer</p>
              <ul className="reasons">
                {item.review.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="eyebrow panel-label">Scoring</p>
          {Object.entries(item.skill_breakdown).map(([key, value]) => (
            <div className="bar-row" key={key}>
              <span className="bar-label">{BREAKDOWN_LABELS[key] ?? key}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${value}%` }} />
              </span>
              <span className="bar-val mono">{value}</span>
            </div>
          ))}

          {item.skill_path && (
            <p className="breakdown-note">
              Published to <code>{item.skill_path}</code>
            </p>
          )}

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
