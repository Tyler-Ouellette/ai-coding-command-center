// Thin wrapper over useDql that injects the app-wide timeframe, so callers just
// pass a DQL string. Returns the standard useDql surface ({ data, error,
// isLoading, refetch, ... }); `data.records` are the row objects.

import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { useTimeframe } from "./timeframe";
import { useSettings } from "./settings";

const FALLBACK_START = new Date(Date.now() - 24 * 3_600_000).toISOString();
// The API's default result cap (1000) silently truncates queries that declare a
// larger `| limit`; raise it so each query's own limit is the effective cap.
const MAX_RESULT_RECORDS = 20000;

export function useTimeframedDql(
  query: string,
  options?: { enabled?: boolean; staleTime?: number; runInBackground?: boolean },
) {
  const { tf } = useTimeframe();
  // Subscribe to settings so a corporate-domain change re-renders the caller,
  // which rebuilds its `query` string via base() with the new predicate.
  useSettings();
  const { start, end } = useMemo(
    () => ({
      start: tf?.from?.absoluteDate ?? FALLBACK_START,
      end: tf?.to?.absoluteDate ?? new Date().toISOString(),
    }),
    [tf?.from?.absoluteDate, tf?.to?.absoluteDate],
  );

  return useDql(
    {
      query,
      defaultTimeframeStart: start,
      defaultTimeframeEnd: end,
      maxResultRecords: MAX_RESULT_RECORDS,
    },
    options,
  );
}

/** Coerce DQL string/number cells to a JS number (Grail returns big ints as strings). */
export function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
