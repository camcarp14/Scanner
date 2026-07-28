export interface ScoreBreakdown {
  momentum: number;
  freshness: number;
  novelty: number;
  substance: number;
  obscurity: number;
}

export interface SkillBreakdown {
  specificity: number;
  actionability: number;
  grounding: number;
  reusability: number;
  sourceQuality: number;
}

export interface Review {
  verdict: 'approve' | 'hold' | 'reject';
  grounded: boolean;
  quality: number;
  reasons: string[];
}

export interface SkillSource {
  full_name: string;
  owner: string;
  url: string;
  language: string | null;
  stars: number;
  doc_files: string[];
  repo_id: string;
}

export interface Workflow {
  title: string;
  when_to_use: string;
  steps: string[];
  prerequisites: string[];
  tools: string[];
  evidence: string;
}

/** The output of the pipeline: a generated SKILL.md awaiting or past review. */
export interface SkillItem {
  type: 'skill';
  id: string;
  name: string;
  description: string;
  body: string;
  when_to_use: string;
  steps: string[];
  prerequisites: string[];
  tools: string[];
  workflow: Workflow;
  source: SkillSource;
  skill_score: number;
  skill_breakdown: SkillBreakdown;
  review: Review | null;
  published: boolean;
  slug: string | null;
  skill_path?: string;
  mock: boolean;
  first_seen: string;
  last_seen: string;
}

/** A repo that passed scout + filter but hasn't produced a skill (yet). */
export interface CandidateItem {
  type: 'candidate';
  id: string;
  full_name: string;
  owner: string;
  name: string;
  url: string;
  description: string;
  hook: string;
  tags: string[];
  language: string | null;
  stars: number;
  topics: string[];
  created_at: string;
  pushed_at: string;
  age_days: number;
  star_velocity: number;
  score: number;
  breakdown: ScoreBreakdown;
  lanes: string[];
  ai_signals: string[];
  doc_files: string[];
  skills_extracted: number;
  first_seen: string;
  last_seen: string;
  stars_at_first_seen: number;
  stars_gained: number;
}

export type FeedItem = SkillItem | CandidateItem;

export interface Lane {
  id: string;
  label: string;
  blurb: string;
}

export interface Feed {
  version: number;
  generated_at: string;
  mode: 'live' | 'mock' | 'off' | 'unavailable';
  lanes: Lane[];
  stats: {
    total: number;
    skills: number;
    published: number;
    candidates: number;
    scanned: number;
    kept_by_filter: number;
    docs_read: number;
    new_skills_this_run: number;
    published_this_run: number;
  };
  items: FeedItem[];
}

export type View = 'skills' | 'candidates' | 'saved' | 'archive';
export type SortKey = 'score' | 'newest' | 'momentum' | 'stars';

export const isSkill = (item: FeedItem): item is SkillItem => item.type === 'skill';
export const isCandidate = (item: FeedItem): item is CandidateItem =>
  item.type === 'candidate';
