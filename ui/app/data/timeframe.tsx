// App-wide timeframe. Stored as a Strato Timeframe { from, to } in context so
// every page queries the same window; the picker lives in the header.

import React, { createContext, useContext, useState } from "react";
import type { Timeframe as StratoTimeframe } from "@dynatrace/strato-components/core";
import { TimeframeSelector } from "@dynatrace/strato-components/filters";

export type { StratoTimeframe as Timeframe };

interface TimeframeCtx {
  tf: StratoTimeframe | null;
  setTf: (tf: StratoTimeframe | null) => void;
}

const Ctx = createContext<TimeframeCtx | null>(null);

export function TimeframeProvider({ children }: { children: React.ReactNode }) {
  const [tf, setTf] = useState<StratoTimeframe | null>(() => {
    const now = new Date();
    return {
      from: { absoluteDate: new Date(now.getTime() - 24 * 3_600_000).toISOString(), value: "-24h", type: "expression" },
      to: { absoluteDate: now.toISOString(), value: "now()", type: "expression" },
    };
  });
  return <Ctx.Provider value={{ tf, setTf }}>{children}</Ctx.Provider>;
}

export function useTimeframe(): TimeframeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTimeframe must be used within TimeframeProvider");
  return ctx;
}

/** Header control for choosing the timeframe. */
export function TimeframePicker() {
  const { tf, setTf } = useTimeframe();
  return (
    <TimeframeSelector
      value={tf}
      onChange={setTf}
    />
  );
}
