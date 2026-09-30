// App-wide, tenant-scoped settings. Currently: the list of corporate email
// domains that define "shadow AI" (see data/config.ts). Persisted via the App
// State service so the definition is shared across everyone using the app.
//
// The DQL builders read the domains from a module variable in config.ts, so on
// load/change we (1) push the value into that module and (2) bump a context
// value that useTimeframedDql subscribes to, forcing every query consumer to
// rebuild its DQL string with the new predicate.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAppState, useSetAppState } from "@dynatrace-sdk/react-hooks";

import {
  CORPORATE_DOMAINS_STATE_KEY,
  getCorporateDomains,
  normalizeDomains,
  setCorporateDomainsModule,
} from "./config";

interface SettingsCtx {
  corporateDomains: string[];
  setCorporateDomains: (domains: string[]) => Promise<void>;
  isLoading: boolean;
  isSaving: boolean;
  /** Bumped whenever the domains change; consumed by useTimeframedDql. */
  version: number;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useAppState({ key: CORPORATE_DOMAINS_STATE_KEY });
  const setState = useSetAppState();
  const [domains, setDomains] = useState<string[]>(() => getCorporateDomains());
  const [version, setVersion] = useState(0);

  // Hydrate the module + local state from the persisted value on load.
  useEffect(() => {
    const raw = data?.value;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setCorporateDomainsModule(parsed.map(String));
        setDomains(getCorporateDomains());
        setVersion((v) => v + 1);
      }
    } catch {
      /* ignore malformed persisted value; keep defaults */
    }
  }, [data?.value]);

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

  const value = useMemo<SettingsCtx>(
    () => ({ corporateDomains: domains, setCorporateDomains, isLoading, isSaving: setState.isLoading, version }),
    [domains, setCorporateDomains, isLoading, setState.isLoading, version],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
