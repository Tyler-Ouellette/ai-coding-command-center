// App-wide, tenant-scoped settings. Currently: the list of corporate email
// domains that define "shadow AI" (see data/config.ts). Persisted via the App
// State service so the definition is shared across everyone using the app.
//
// The DQL builders read the domains from a module variable in config.ts, so on
// load/change we (1) push the value into that module and (2) bump a context
// value that useTimeframedDql subscribes to, forcing every query consumer to
// rebuild its DQL string with the new predicate.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSetAppState } from "@dynatrace-sdk/react-hooks";
import { isNotFound, stateClient } from "@dynatrace-sdk/client-state";

import {
  CORPORATE_DOMAINS_STATE_KEY,
  OPUS_TRIVIAL_OUTPUT_TOKENS_STATE_KEY,
  DEFAULT_CORPORATE_DOMAINS,
  DEFAULT_OPUS_TRIVIAL_OUTPUT_TOKENS,
  getCorporateDomains,
  getOpusTrivialOutputTokens,
  normalizeDomains,
  setCorporateDomainsModule,
  setOpusTrivialOutputTokensModule,
} from "./config";

/**
 * True when an App State read failed *only* because the key has never been
 * written yet. The State service answers such reads with HTTP 404 and a body of
 * `{"error":{"code":404,"message":"Unknown key: <key>"}}`, which the SDK throws
 * as a `NotFound` error. This is an expected "not set yet" condition — the
 * caller should fall back to its default rather than surface it as an error.
 *
 * We match generously: the typed `isNotFound` guard first, then defensively on
 * the HTTP status / envelope code / message text in case of SDK version drift.
 */
function isMissingKeyError(err: unknown): boolean {
  if (isNotFound(err)) return true;
  const e = err as
    | { response?: { status?: number }; body?: { error?: { code?: number; message?: string } }; message?: string }
    | null
    | undefined;
  if (!e) return false;
  if (e.response?.status === 404 || e.body?.error?.code === 404) return true;
  const msg = e.body?.error?.message ?? e.message ?? "";
  return /unknown key/i.test(msg);
}

/**
 * Read a single App State value, tolerating the "never written yet" case.
 * Returns `undefined` when the key is unset (so the caller keeps its default);
 * re-throws any genuine failure (auth, network, 5xx) for the caller to log.
 */
async function readAppStateValue(key: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const state = await stateClient.getAppState({ key, abortSignal: signal });
    return state?.value;
  } catch (err) {
    if (isMissingKeyError(err)) return undefined;
    throw err;
  }
}

interface SettingsCtx {
  corporateDomains: string[];
  setCorporateDomains: (domains: string[]) => Promise<void>;
  opusTrivialOutputTokens: number;
  setOpusTrivialOutputTokens: (tokens: number) => Promise<void>;
  isLoading: boolean;
  isSaving: boolean;
  /** Bumped whenever a setting changes; consumed by useTimeframedDql. */
  version: number;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const setState = useSetAppState();
  const [domains, setDomains] = useState<string[]>(() => getCorporateDomains());
  const [version, setVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const setThresholdState = useSetAppState();
  const [opusTrivialOutputTokens, setOpusTrivialOutputTokensLocal] = useState<number>(() =>
    getOpusTrivialOutputTokens(),
  );
  const [thresholdLoading, setThresholdLoading] = useState(true);

  // Hydrate the module + local state from the persisted value on load. An unset
  // key (404 "Unknown key") means no one has ever saved this setting in the
  // tenant yet — rather than just keeping the in-memory default (which leaves
  // the key perpetually unset and every future read 404ing again), persist the
  // default once so subsequent reads by any user get a normal 200.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const raw = await readAppStateValue(CORPORATE_DOMAINS_STATE_KEY, controller.signal);
        if (cancelled) return;
        if (raw === undefined) {
          void setState.execute({
            key: CORPORATE_DOMAINS_STATE_KEY,
            body: { value: JSON.stringify(DEFAULT_CORPORATE_DOMAINS) },
          });
          return;
        }
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setCorporateDomainsModule(parsed.map(String));
          setDomains(getCorporateDomains());
          setVersion((v) => v + 1);
        }
      } catch (err) {
        // Malformed persisted value or a genuine read failure: keep defaults.
        if (!cancelled) console.error(`Failed to load setting "${CORPORATE_DOMAINS_STATE_KEY}"`, err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Intentionally run once on mount: `setState` is a mutation hook whose
    // identity can churn across renders, and re-running this on every such
    // change would re-probe/re-seed the key instead of just hydrating once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const raw = await readAppStateValue(OPUS_TRIVIAL_OUTPUT_TOKENS_STATE_KEY, controller.signal);
        if (cancelled) return;
        if (raw === undefined) {
          void setThresholdState.execute({
            key: OPUS_TRIVIAL_OUTPUT_TOKENS_STATE_KEY,
            body: { value: String(DEFAULT_OPUS_TRIVIAL_OUTPUT_TOKENS) },
          });
          return;
        }
        if (!raw) return;
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
          setOpusTrivialOutputTokensModule(parsed);
          setOpusTrivialOutputTokensLocal(getOpusTrivialOutputTokens());
          setVersion((v) => v + 1);
        }
      } catch (err) {
        // Malformed persisted value or a genuine read failure: keep defaults.
        if (!cancelled) console.error(`Failed to load setting "${OPUS_TRIVIAL_OUTPUT_TOKENS_STATE_KEY}"`, err);
      } finally {
        if (!cancelled) setThresholdLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount, see above
  }, []);

  const setCorporateDomains = useCallback(
    async (next: string[]) => {
      const norm = normalizeDomains(next);
      setCorporateDomainsModule(norm);
      setDomains(getCorporateDomains());
      setVersion((v) => v + 1);
      await setState.execute({
        key: CORPORATE_DOMAINS_STATE_KEY,
        body: { value: JSON.stringify(norm) },
      });
    },
    [setState],
  );

  const setOpusTrivialOutputTokens = useCallback(
    async (tokens: number) => {
      const n = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : DEFAULT_OPUS_TRIVIAL_OUTPUT_TOKENS;
      setOpusTrivialOutputTokensModule(n);
      setOpusTrivialOutputTokensLocal(getOpusTrivialOutputTokens());
      setVersion((v) => v + 1);
      await setThresholdState.execute({
        key: OPUS_TRIVIAL_OUTPUT_TOKENS_STATE_KEY,
        body: { value: String(n) },
      });
    },
    [setThresholdState],
  );

  const value = useMemo<SettingsCtx>(
    () => ({
      corporateDomains: domains,
      setCorporateDomains,
      opusTrivialOutputTokens,
      setOpusTrivialOutputTokens,
      isLoading: isLoading || thresholdLoading,
      isSaving: setState.isLoading || setThresholdState.isLoading,
      version,
    }),
    [
      domains,
      setCorporateDomains,
      opusTrivialOutputTokens,
      setOpusTrivialOutputTokens,
      isLoading,
      thresholdLoading,
      setState.isLoading,
      setThresholdState.isLoading,
      version,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
