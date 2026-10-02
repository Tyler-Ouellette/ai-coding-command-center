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

/** sessionId -> outcome totals, read from sessionOutcomesQuery's wide-format rows
 *  (one row per session with all metric columns). */
export function outcomeMap(result: DqlResultLike): Map<string, SessionOutcome> {
  const map = new Map<string, SessionOutcome>();
  for (const r of result.data?.records ?? []) {
    const id = String(r.sessionId ?? "");
    if (!id) continue;
    map.set(id, {
      commits: num(r.commits),
      prs: num(r.prs),
      linesAdded: num(r.linesAdded),
      linesRemoved: num(r.linesRemoved),
      editsAccepted: num(r.editsAccepted),
      activeSec: num(r.activeSec),
    });
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

export interface UserOutcome {
  commits: number;
  prs: number;
  linesAdded: number;
  linesRemoved: number;
  editsAccepted: number;
}

/** uid -> per-user outcome totals, read from userOutcomesQuery's wide-format rows. */
export function userOutcomeMap(result: DqlResultLike): Map<string, UserOutcome> {
  const map = new Map<string, UserOutcome>();
  for (const r of result.data?.records ?? []) {
    const id = String(r.uid ?? "");
    if (!id) continue;
    map.set(id, {
      commits: num(r.commits),
      prs: num(r.prs),
      linesAdded: num(r.linesAdded),
      linesRemoved: num(r.linesRemoved),
      editsAccepted: num(r.editsAccepted),
    });
  }
  return map;
}

/** Returns new user rows with outcome fields merged in, defaulting to 0 when absent.
 *  Matches on uid first (which equals user.email when present), then email as fallback. */
export function mergeUserOutcomes(
  users: Array<Record<string, unknown>>,
  outcomes: DqlResultLike,
): Array<Record<string, unknown>> {
  const map = userOutcomeMap(outcomes);
  return users.map((u) => {
    const o = map.get(String(u.uid ?? "")) ?? map.get(String(u.email ?? ""));
    return {
      ...u,
      commits: o?.commits ?? 0,
      prs: o?.prs ?? 0,
      linesAdded: o?.linesAdded ?? 0,
      linesRemoved: o?.linesRemoved ?? 0,
      editsAccepted: o?.editsAccepted ?? 0,
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
