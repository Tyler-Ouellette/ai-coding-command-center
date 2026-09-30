// Shared DQL building blocks that normalize the two telemetry shapes in this
// environment — Claude Code (`claude-code` / `claude-code-desktop`, native
// `claude_code.*` spans) and GitHub Copilot (`copilot-chat`, OTel `gen_ai.*`
// spans) — into one common set of fields, plus the cache-aware cost model
// lifted from the "AI Coding Assistants — Executive View" reference dashboard.
//
// Every query in the app starts from `base()` so tokens, cost, assistant and
// department are computed identically everywhere and reconcile with that
// dashboard.

import { personalEmailPredicateDQL } from "./config";

export const CODING_SERVICES = [
  "claude-code",
  "claude-code-desktop",
  "copilot-chat",
] as const;

// Per-model $/token rates (per 1e6 tokens): input(fresh) / cache-read /
// cache-creation / output. Matches the reference dashboard exactly so numbers
// tie out. Models not listed price to $0 (usage still counted in tokens).
const COST_EXPR = `if(contains(model,"opus"), toDouble(fresh)*15.0/1000000 + toDouble(cr)*1.5/1000000 + toDouble(cc)*18.75/1000000 + toDouble(outp)*75.0/1000000,
    else: if(contains(model,"sonnet"), toDouble(fresh)*3.0/1000000 + toDouble(cr)*0.3/1000000 + toDouble(cc)*3.75/1000000 + toDouble(outp)*15.0/1000000,
    else: if(contains(model,"gpt-4o-mini"), toDouble(fresh)*0.15/1000000 + toDouble(cr)*0.075/1000000 + toDouble(cc)*0.1875/1000000 + toDouble(outp)*0.60/1000000,
    else: 0.0)))`;

// The normalization prelude. Produces, on every span:
//   assistant, is_llm, is_tool, is_interaction, is_blocked,
//   inp/outp/cr/cc (token counts), model, is_personal, dept, fresh, cost
// Rebuilt per call so the configurable corporate-domain predicate stays current.
function normalizePrelude(): string {
  return `
| fieldsAdd assistant = if(service.name=="copilot-chat","GitHub Copilot", else:"Claude Code"),
    is_llm = (gen_ai.operation.name=="chat" or span.name=="claude_code.llm_request" or span.name=="claude-code.llm_request"),
    is_tool = (gen_ai.operation.name=="execute_tool" or span.name=="claude_code.tool" or matchesValue(span.name, "claude-code.tool.*") and not in(span.name, array("claude-code.tool.blocked_on_user", "claude-code.tool.execution"))),
    is_interaction = (span.name=="claude_code.interaction" or span.name=="claude-code.interaction"),
    is_blocked = (span.name=="claude_code.tool.blocked_on_user" or span.name=="claude-code.tool.blocked_on_user"),
    inp = coalesce(gen_ai.usage.input_tokens, input_tokens, 0),
    outp = coalesce(gen_ai.usage.output_tokens, output_tokens, 0),
    cr = coalesce(gen_ai.usage.cache_read.input_tokens, cache_read_tokens, 0),
    cc = coalesce(gen_ai.usage.cache_creation.input_tokens, cache_creation_tokens, 0),
    model = coalesce(gen_ai.request.model, model, ""),
    is_personal = ${personalEmailPredicateDQL()}
| fieldsAdd dept = if(is_personal, "Personal Account", else: coalesce(user.department, "Unmapped / Pilot")),
    uid = coalesce(user.email, user.name, "(unknown)"),
    fresh = if(service.name=="copilot-chat", if(toLong(inp)-toLong(cr)-toLong(cc)<0, 0, else: toLong(inp)-toLong(cr)-toLong(cc)), else: toLong(inp))
| fieldsAdd cost = ${COST_EXPR}`;
}

const serviceArray = CODING_SERVICES.map((s) => `"${s}"`).join(",");

/** `fetch spans` scoped to the coding services, with all normalized fields added. */
export function base(): string {
  return `fetch spans\n| filter in(service.name, array(${serviceArray}))${normalizePrelude()}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers (kept here so formatting is consistent app-wide).
// ---------------------------------------------------------------------------

export function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  return Math.round(n).toLocaleString("en-US");
}

/** Compact token count: 1234 -> "1.2K", 3_400_000 -> "3.4M". */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** USD: 4.17 -> "$4.17", 1234 -> "$1.2k". */
export function fmtUSD(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "–";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `$${n.toFixed(3)}`;
}

/** Milliseconds -> "820ms" / "4.2s" / "3m 12s" / "1h 4m". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** ISO/epoch timestamp -> short local datetime. */
export function fmtTime(ts: string | number | null | undefined): string {
  if (ts == null) return "–";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
