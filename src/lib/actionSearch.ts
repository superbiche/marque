/**
 * Search and ranking for the palette's "actions" source.
 *
 * The palette disables cmdk's own filter (`shouldFilter={false}`): file
 * results arrive pre-ranked from Rust (nucleo), so each source is the
 * authority over its own results. This module is that authority for
 * actions: a small, deterministic, dependency-free scorer.
 *
 * Matching is case-insensitive and layered in four tiers, best first:
 *
 *   0  prefix     — the query starts the label, or starts a keyword
 *   1  word start — the label or keyword, from any word boundary onward,
 *                   starts with the query (a multi-word query may span words)
 *   2  substring  — the query is a contiguous run inside the label or a keyword
 *   3  subsequence— the query's characters appear in order (fuzzy, lowest tier)
 *
 * Within a tier the definition order of the action list is preserved, so an
 * empty (or separator-only) query returns every action in its original order.
 */

export interface ActionDef {
  /** Stable identifier, used to map ranked results back to the full action. */
  id: string;
  /** Display label — the primary match target. */
  label: string;
  /** Extra match targets (synonyms, shortcuts for what the label implies). */
  keywords?: readonly string[];
}

/** Match tiers, best first (see the module docs). */
export type ActionTier = 0 | 1 | 2 | 3;

export interface RankedAction {
  id: string;
  tier: ActionTier;
}

/** Characters that count as word boundaries after lowercasing. */
const SEPARATORS = /[\s\-_/\\:.,;()[\]{}"'\u2026]+/g;

function normalize(s: string): string {
  return s.toLowerCase().replace(SEPARATORS, " ").trim();
}

/** Whether every character of `needle` appears in `hay`, in order. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Whether `s` begins with `q` at a word boundary — i.e. `s`, from the start of
 * some word onward, starts with `q`. This is the word-start tier for a
 * multi-word query that begins at a word boundary: "pane v" begins "split
 * pane vertically" at the "pane" word, so it is a word start even though the
 * query spans two words. `q` is non-empty and `s` has single-space-separated
 * words (from `normalize`).
 */
function startsAtWordBoundary(s: string, q: string): boolean {
  let start = 0;
  while (start <= s.length) {
    if (s.startsWith(q, start)) return true;
    const space = s.indexOf(" ", start);
    if (space === -1) return false;
    start = space + 1;
  }
  return false;
}

/**
 * Best tier at which `q` (already normalized) matches the normalized string
 * `s`, or `null` when it does not match at all. The tiers nest — a prefix
 * is a word start, a word start a substring, a substring a subsequence — so
 * the first hit in this order is the best.
 */
function matchTier(q: string, s: string): ActionTier | null {
  if (s.startsWith(q)) return 0;
  if (startsAtWordBoundary(s, q)) return 1;
  if (s.includes(q)) return 2;
  if (isSubsequence(q, s)) return 3;
  return null;
}

function bestTier(q: string, a: ActionDef): ActionTier | null {
  let best: ActionTier | null = null;
  for (const raw of [a.label, ...(a.keywords ?? [])]) {
    const t = matchTier(q, normalize(raw));
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * Rank `actions` against `query`. Returns the matching actions (best tier
 * first, definition order within a tier); a blank query returns all of them
 * in definition order.
 */
export function rankActions(query: string, actions: readonly ActionDef[]): RankedAction[] {
  const q = normalize(query);
  if (!q) {
    return actions.map((a) => ({ id: a.id, tier: 0 as const }));
  }
  const tiers = actions.map((a) => bestTier(q, a));
  const out: RankedAction[] = [];
  for (let tier = 0 as ActionTier; tier <= 3; tier++) {
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i] === tier) out.push({ id: actions[i].id, tier });
    }
  }
  return out;
}
