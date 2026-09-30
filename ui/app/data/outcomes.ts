// Merges metric-backed session outcomes (from sessionOutcomesQuery) onto the span-derived session
// rows (from sessionsQuery), keyed by sessionId. Outcome metrics (commits, PRs, lines changed,
// accepted edits, active time) live only in Claude Code's `claude_code.*` OTel metrics; if those
// aren't ingested the outcomes query returns nothing and `outcomesAvailable` is false, so the UI
// shows "–" for metric-only fields and falls back to span-derived signals.

import type { DqlResultLike } from "../components/QueryState";
import { num } from "./useQuery";

export interface SessionOutcome {
  commits: number;
  prs: number;
  linesAdded: number;
  linesRemoved: number;
  editsAccepted: number;
  activeSec: number;
}

/** True when the outcomes metric query actually returned data (metrics are ingested). When false,
 *  metric-only fields (PRs, exact lines changed) have no fallback and should render as "–". */
export function outcomesAvailable(result: DqlResultLike): boolean {
  return !result.error && (result.data?.records?.length ?? 0) > 0;
}

/** sessionId -> outcome totals, pivoted from sessionOutcomesQuery's long-form
 *  (sessionId, metric, value) rows. Metric labels match the SessionOutcome keys. */
export function outcomeMap(result: DqlResultLike): Map<string, SessionOutcome> {
  const map = new Map<string, SessionOutcome>();
  const blank = (): SessionOutcome => ({
    commits: 0, prs: 0, linesAdded: 0, linesRemoved: 0, editsAccepted: 0, activeSec: 0,
  });
  for (const r of result.data?.records ?? []) {
    const id = String(r.sessionId ?? "");
    const metric = String(r.metric ?? "");
    if (!id || !metric) continue;
    const o = map.get(id) ?? blank();
    if (metric in o) (o as unknown as Record<string, number>)[metric] = num(r.v);
    map.set(id, o);
  }
  return map;
}

/** Returns new session rows with the outcome fields (commits, prs, linesAdded, linesRemoved,
 *  editsAccepted, activeSec) merged in, defaulting to 0 when a session has no metric row. */
export function mergeOutcomes(
  sessions: Array<Record<string, unknown>>,
  outcomes: DqlResultLike,
): Array<Record<string, unknown>> {
  const map = outcomeMap(outcomes);
  return sessions.map((s) => {
    const o = map.get(String(s.sessionId ?? ""));
    return {
      ...s,
      commits: o?.commits ?? 0,
      prs: o?.prs ?? 0,
      linesAdded: o?.linesAdded ?? 0,
      linesRemoved: o?.linesRemoved ?? 0,
      editsAccepted: o?.editsAccepted ?? 0,
      activeSec: o?.activeSec ?? 0,
    };
  });
}

/** Real working time in ms: the `active_time.total` metric when present, else the span-derived
 *  distinct-active-minutes fallback from sessionsQuery. */
export function activeMs(row: Record<string, unknown>): number {
  const sec = num(row.activeSec);
  if (sec > 0) return sec * 1000;
  return num(row.activeMin) * 60000;
}

/** Observable output for the "High spend, nothing shipped" flag: span-derived edits plus any
 *  metric-backed commits, PRs and accepted edits. Zero means nothing shipped. */
export function shippedCount(row: Record<string, unknown>): number {
  return num(row.edits) + num(row.commits) + num(row.prs) + num(row.editsAccepted);
}
