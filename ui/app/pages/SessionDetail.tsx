// Session detail: a split view. Left is a selectable span tree rebuilt from
// span.id / span.parent_id, each node tagged with a task-type icon. Right shows
// the full attributes of the selected span, formatted by task kind.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { TextInput } from "@dynatrace/strato-components/forms";
import { ChevronDownIcon, ChevronUpIcon, ChevronRightIcon, ChevronLeftIcon, CheckmarkIcon, XmarkIcon, ChatIcon, ContainerIcon, LinkIcon, WarningIcon, LockIcon, TerminalIcon, WorldmapIcon, GhostIcon } from "@dynatrace/strato-icons";
import { sendIntent } from "@dynatrace-sdk/navigation";

import { StatTile } from "../components/StatTile";
import { QueryState } from "../components/QueryState";
import { toneColor, subduedText, surfaceStyle } from "../components/tokens";
import { classifySpan, type TaskKind, type Tone } from "../data/taskKind";
import { assistantBrandIcon } from "../components/brandIcons";
import { useTimeframedDql, num } from "../data/useQuery";
import { fmtInt, fmtTokens, fmtUSD, fmtDuration, fmtTime } from "../data/normalize";
import { sessionSpansQuery, sessionToolInputsQuery, downstreamTraceQuery, sessionOutcomesQuery } from "../data/queries";
import { outcomeMap, outcomesAvailable } from "../data/outcomes";
import { matchesAny, SECRET_PATTERNS, CREDENTIAL_PATTERNS, DESTRUCTIVE_PATTERNS, JAILBREAK_PATTERNS } from "../data/securityPatterns";

type Span = Record<string, unknown>;
interface TreeNode {
  span: Span;
  children: TreeNode[];
  depth: number;
}

/** An LLM/model call — its own span, but too noisy for the tree. Rolled up onto its parent turn. */
export interface Rollup {
  count: number;
  models: Record<string, number>;
  inTok: number;
  outTok: number;
  crTok: number;
  ccTok: number;
  cost: number;
  ttftSum: number;
  ttftN: number;
  failures: number;
  shadowCount: number;
  calls: Span[];
}

function isLlmSpan(s: Span): boolean {
  const name = String(s.name ?? "");
  return name === "claude_code.llm_request" || String(s.genOp) === "chat" || name.startsWith("chat ");
}

/** Aggregate every model call under its parent span id. */
function computeRollups(records: Span[]): Map<string, Rollup> {
  const map = new Map<string, Rollup>();
  for (const s of records) {
    if (!isLlmSpan(s)) continue;
    const pid = s.parent ? String(s.parent) : "";
    if (!pid) continue;
    let r = map.get(pid);
    if (!r) {
      r = { count: 0, models: {}, inTok: 0, outTok: 0, crTok: 0, ccTok: 0, cost: 0, ttftSum: 0, ttftN: 0, failures: 0, shadowCount: 0, calls: [] };
      map.set(pid, r);
    }
    r.count += 1;
    const m = String(s.model || "?");
    r.models[m] = (r.models[m] || 0) + 1;
    r.inTok += num(s.inTok);
    r.outTok += num(s.outTok);
    r.crTok += num(s.crTok);
    r.ccTok += num(s.ccTok);
    r.cost += num(s.cost);
    if (num(s.ttft) > 0) {
      r.ttftSum += num(s.ttft);
      r.ttftN += 1;
    }
    if (s.success === false) r.failures += 1;
    if (s.is_llm && s.is_personal) r.shadowCount += 1;
    r.calls.push(s);
  }
  return map;
}

/** Build the span tree, EXCLUDING model-call spans (those are rolled up separately). */
function buildTree(records: Span[]): TreeNode[] {
  // Non-LLM spans always render. LLM/model-call spans are normally rolled up
  // under their (visible) parent row. But an LLM span whose parent is NOT a
  // visible non-LLM span — e.g. a Copilot `chat` span sitting at the trace root
  // — would otherwise be orphaned, hiding its prompt and any risk flags. Keep
  // those as rows so their warning has somewhere to surface.
  const nonLlmIds = new Set<string>();
  for (const s of records) if (!isLlmSpan(s)) nonLlmIds.add(String(s.spanId));
  const keep = (s: Span): boolean => {
    if (!isLlmSpan(s)) return true;
    const pid = s.parent ? String(s.parent) : "";
    return !(pid && nonLlmIds.has(pid));
  };
  const byId = new Map<string, TreeNode>();
  for (const s of records) {
    if (!keep(s)) continue;
    byId.set(String(s.spanId), { span: s, children: [], depth: 0 });
  }
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parent ? String(node.span.parent) : "";
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const startMs = (n: TreeNode) => new Date(String(n.span.start)).getTime() || 0;
  const sortRec = (nodes: TreeNode[], depth: number) => {
    nodes.sort((a, b) => startMs(a) - startMs(b));
    for (const n of nodes) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return roots;
}

interface SessionDetailProps {
  sessionId: string;
  show: boolean;
  onDismiss: () => void;
  highlightKey?: string;
  /** Label for the dismiss button (e.g. "Back" when opened from a drill-down). */
  dismissLabel?: string;
  /** Step to the previous/next session in the source list, if any. */
  onPrev?: () => void;
  onNext?: () => void;
  /** e.g. "3 of 20", shown next to the nav arrows. */
  positionLabel?: string;
  /** Neighbouring session ids to warm in the background for instant prev/next. */
  prefetchIds?: Array<string | undefined>;
}

// Keep a loaded session's data warm so prev/next and revisits are instant.
const SESSION_STALE_MS = 300_000;
const SESSION_QUERY_OPTS = { staleTime: SESSION_STALE_MS, runInBackground: true } as const;

/** Warms the query cache for a neighbouring session so prev/next has no load gap. */
function SessionPrefetch({ sessionId }: { sessionId: string }) {
  useTimeframedDql(sessionSpansQuery(sessionId), SESSION_QUERY_OPTS);
  useTimeframedDql(sessionToolInputsQuery(sessionId), SESSION_QUERY_OPTS);
  return null;
}

/** Per-flag span matcher used to auto-select the most relevant span on deep-link. */
const HIGHLIGHT_MATCHERS: Record<string, (s: Span) => boolean> = {
  secrets: (s) => {
    const hay = `${String(s.prompt ?? "")}\n${String(s.userRequest ?? "")}\n${String(s.cmd ?? s.args ?? "")}`.toLowerCase();
    return matchesAny(SECRET_PATTERNS, hay);
  },
  destructive: (s) => {
    const isTerminal = String(s.tool) === "Bash" || String(s.name).includes("run_in_terminal");
    const cmd = String(s.cmd ?? s.args ?? "").toLowerCase();
    return isTerminal && matchesAny(DESTRUCTIVE_PATTERNS, cmd);
  },
  credential: (s) => {
    const cmd = String(s.cmd ?? s.args ?? "").toLowerCase();
    return matchesAny(CREDENTIAL_PATTERNS, cmd);
  },
  jailbreak: (s) => {
    const prompt = `${String(s.prompt ?? "")}\n${String(s.userRequest ?? "")}`.toLowerCase();
    return matchesAny(JAILBREAK_PATTERNS, prompt);
  },
  shadow: (s) => String(s.genOp) === "chat" || String(s.name) === "claude_code.llm_request",
};

/** Parse a span's captured arguments (span field or correlated tool_result log). */
function parsedArgs(span: Span, logInput?: string): Record<string, unknown> | null {
  const raw = span.args ?? logInput;
  if (raw == null || raw === "") return null;
  try {
    const p = JSON.parse(String(raw));
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return null;
}

/** The invoked skill name for a `Skill` span, else null. */
function skillNameOf(span: Span, logInput?: string): string | null {
  if (String(span.tool ?? "").toLowerCase() !== "skill") return null;
  const p = parsedArgs(span, logInput);
  const skill = p?.skill ?? p?.skill_name ?? p?.name;
  return typeof skill === "string" && skill ? skill : null;
}

/** Normalized tool name for a span (matches the aggregation in queries.ts). */
function toolNameOf(span: Span): string {
  const k = classifySpan({ name: span.name as string, tool: span.tool as string, genOp: span.genOp as string });
  return k.kind === "tool" ? k.label : String(span.tool ?? "");
}

/** Resolve a `?highlight=` value to a span matcher. Supports the fixed security
 *  keys plus parameterized `skill:<name>` / `tool:<name>` deep-links. */
function resolveHighlightMatcher(
  key: string,
  inputByToolUse: Map<string, string>,
): ((s: Span) => boolean) | null {
  if (key.startsWith("skill:")) {
    const want = key.slice(6).toLowerCase();
    return (s) => {
      const li = s.toolUseId ? inputByToolUse.get(String(s.toolUseId)) : undefined;
      const name = skillNameOf(s, li);
      return name != null && name.toLowerCase() === want;
    };
  }
  if (key.startsWith("tool:")) {
    const want = key.slice(5).toLowerCase();
    return (s) => toolNameOf(s).toLowerCase() === want;
  }
  return HIGHLIGHT_MATCHERS[key] ?? null;
}

export function SessionDetail({ sessionId, show, onDismiss, highlightKey, dismissLabel = "Close", onPrev, onNext, positionLabel, prefetchIds }: SessionDetailProps) {
  const spans = useTimeframedDql(sessionSpansQuery(sessionId), SESSION_QUERY_OPTS);
  const toolInputs = useTimeframedDql(sessionToolInputsQuery(sessionId), SESSION_QUERY_OPTS);
  const outcomes = useTimeframedDql(sessionOutcomesQuery(sessionId));
  const records = (spans.data?.records ?? []) as Span[];
  const outcome = outcomeMap(outcomes).get(sessionId);
  const hasOutcomes = outcomesAvailable(outcomes);

  // Active time: prefer the ingested metric; else fall back to distinct active
  // minutes derived from the session's own spans.
  const activeTimeMs = useMemo(() => {
    if (outcome?.activeSec && outcome.activeSec > 0) return outcome.activeSec * 1000;
    const minutes = new Set<number>();
    for (const s of records) {
      const t = new Date(String(s.start)).getTime();
      if (!Number.isNaN(t)) minutes.add(Math.floor(t / 60000));
    }
    return minutes.size * 60000;
  }, [outcome?.activeSec, records]);
  // Selection is a single span, or a collapsed group of spans.
  const [selected, setSelected] = useState<{ id: string; spans: Span[] } | null>(null);
  const [highlighted, setHighlighted] = useState(false);

  // tool_use_id -> tool_input JSON string (Claude Code stores inputs in logs).
  const inputByToolUse = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of (toolInputs.data?.records ?? []) as Span[]) {
      if (r.toolUseId && r.toolInput) m.set(String(r.toolUseId), String(r.toolInput));
    }
    return m;
  }, [toolInputs.data]);

  // Auto-select the first span matching the highlight filter once spans load.
  useEffect(() => {
    if (highlighted || !highlightKey || records.length === 0) return;
    const matcher = resolveHighlightMatcher(highlightKey, inputByToolUse);
    if (!matcher) return;
    const match = records.find(matcher);
    if (match) {
      setSelected({ id: String(match.spanId), spans: [match] });
      setHighlighted(true);
    }
  }, [records, highlightKey, highlighted, inputByToolUse]);

  const single = selected && selected.spans.length === 1 ? selected.spans[0] : null;
  const selectedLogInput = single?.toolUseId ? inputByToolUse.get(String(single.toolUseId)) : undefined;

  const rollups = useMemo(() => computeRollups(records), [records]);
  const tree = useMemo(() => buildTree(records), [records]);
  const selectedRollup = single ? rollups.get(String(single.spanId)) : undefined;

  const summary = useMemo(() => summarize(records), [records]);

  // Close on Escape; step through the list with the arrow keys.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
      else if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, onDismiss, onPrev, onNext]);

  if (!show) return null;

  return (
    // Full-width overlay (the Strato Sheet shrink-wraps to content; this fills the page).
    <div
      onClick={onDismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "var(--dt-colors-background-surface-backdrop, rgba(20,20,30,0.35))",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "97vw",
          maxWidth: 2600,
          height: "94vh",
          marginTop: "3vh",
          background: "var(--dt-colors-background-base-default, #f9f9fa)",
          borderRadius: 12,
          boxShadow: "var(--dt-box-shadows-surface-floating-rest, 0 8px 24px rgba(0,0,0,0.2))",
          overflow: "auto",
          padding: 24,
        }}
      >
        <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 12 }}>
          <Flex alignItems="center" gap={8}>
            <Heading level={4} style={{ margin: 0 }}>Session</Heading>
            {(onPrev || onNext) && (
              <Flex alignItems="center" gap={4}>
                <Button disabled={!onPrev} onClick={onPrev} title="Previous session (←)"><ChevronLeftIcon /></Button>
                <Button disabled={!onNext} onClick={onNext} title="Next session (→)"><ChevronRightIcon /></Button>
                {positionLabel ? <Text style={{ fontSize: 12, color: subduedText }}>{positionLabel}</Text> : null}
              </Flex>
            )}
          </Flex>
          <Button onClick={onDismiss}>{dismissLabel}</Button>
        </Flex>
        <Flex flexDirection="column" gap={16} style={{ paddingBottom: 24 }}>
        <Flex flexDirection="column" gap={4}>
          <Text style={{ fontFamily: "monospace", fontSize: 12, color: subduedText }}>{sessionId}</Text>
          <Flex gap={12} flexFlow="wrap">
            <StatTile
              label="Assistant"
              value={
                <Flex alignItems="center" gap={6}>
                  {assistantBrandIcon(summary.assistant, 18)}
                  <span>{summary.assistant}</span>
                </Flex>
              }
            />
            <StatTile label="Duration" value={fmtDuration(summary.durationMs)} />
            <StatTile label="Active time" value={fmtDuration(activeTimeMs)} />
            <StatTile label="Interactions" value={fmtInt(summary.interactions)} />
            <StatTile label="Tool calls" value={fmtInt(summary.tools)} />
            <StatTile label="Tokens" value={fmtTokens(summary.tokens)} />
            <StatTile label="Lines changed" value={hasOutcomes ? `+${fmtInt(outcome?.linesAdded ?? 0)} / −${fmtInt(outcome?.linesRemoved ?? 0)}` : "–"} />
            <StatTile label="Commits" value={hasOutcomes ? fmtInt(outcome?.commits ?? 0) : "–"} />
            <StatTile label="PRs" value={hasOutcomes ? fmtInt(outcome?.prs ?? 0) : "–"} />
            <StatTile label="Edits accepted" value={hasOutcomes ? fmtInt(outcome?.editsAccepted ?? 0) : "–"} />
            <StatTile label="Est. spend" value={fmtUSD(summary.cost)} tone="primary" />
          </Flex>
          {summary.repo ? (
            <Text style={{ fontSize: 12, color: subduedText }}>
              {summary.repo}{summary.branch ? ` · ${summary.branch}` : ""}
            </Text>
          ) : null}
        </Flex>

        <QueryState result={spans} minHeight={300}>
          {() => (
            <Flex gap={16} alignItems="stretch" style={{ minHeight: 400 }}>
              {/* Tree */}
              <div style={{ flex: "1 1 55%", overflow: "auto", maxHeight: "70vh", ...surfaceStyle, padding: 8 }}>
                <SpanTree
                  roots={tree}
                  rollups={rollups}
                  inputByToolUse={inputByToolUse}
                  selectedId={selected?.id ?? null}
                  onSelectSpan={(sp) => setSelected({ id: String(sp.spanId), spans: [sp] })}
                  onSelectGroup={(gid, spans) => setSelected({ id: gid, spans })}
                />
              </div>
              {/* Detail */}
              <div style={{ flex: "1 1 45%", overflow: "auto", maxHeight: "70vh", ...surfaceStyle, padding: 16 }}>
                {selected && selected.spans.length > 1 ? (
                  <GroupDetail spans={selected.spans} inputByToolUse={inputByToolUse} rollups={rollups} />
                ) : (
                  <SpanDetail span={single} logInput={selectedLogInput} rollup={selectedRollup} />
                )}
              </div>
            </Flex>
          )}
        </QueryState>
        </Flex>
      </div>
      {prefetchIds
        ?.filter((id): id is string => !!id && id !== sessionId)
        .map((id) => <SessionPrefetch key={id} sessionId={id} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

function classifyOf(span: Span) {
  return classifySpan({
    name: span.name as string,
    tool: span.tool as string,
    model: span.model as string,
    genOp: span.genOp as string,
    agent: span.agent as string,
  });
}

// ---------------------------------------------------------------------------
// Inline risk flags
// ---------------------------------------------------------------------------

/** A risk flag surfaced inline on a trace row. */
export interface SpanWarning {
  key: "destructive" | "secret" | "credential" | "webPost";
  label: string;
  tone: Tone;
  Icon: TaskKind["Icon"];
}

/** True when a shell command or captured tool arguments issue an outbound POST. */
function isOutboundPost(span: Span, cmdLower: string, parsed: Record<string, unknown> | null): boolean {
  if (/\bcurl\b/.test(cmdLower) &&
    (/-x\s*post/.test(cmdLower) || /--request\s+post/.test(cmdLower) ||
      /\s-d\b/.test(cmdLower) || /--data(-raw|-binary|-urlencode)?\b/.test(cmdLower))) {
    return true;
  }
  if (/\bwget\b/.test(cmdLower) && /--post-(data|file)\b/.test(cmdLower)) return true;
  if (parsed) {
    const method = String(parsed.method ?? parsed.httpMethod ?? "").toUpperCase();
    if (method === "POST") return true;
  }
  return false;
}

// Inline risk flags for a span: destructive shell commands, exposed secrets /
// API tokens, credential/file access, and suspicious outbound web requests
// (e.g. POST). Reuses the same pattern lists as the Overview security flags
// (ui/app/data/securityPatterns.ts) but renders per-row in the trace.
function spanWarnings(span: Span, logInput?: string): SpanWarning[] {
  const raw = String(span.cmd ?? span.args ?? logInput ?? "");
  const prompt = `${String(span.prompt ?? "")}\n${String(span.userRequest ?? "")}`.trim();
  if (!raw && !prompt) return [];

  const cmdLower = raw.toLowerCase();
  const isTerminal = String(span.tool) === "Bash" || String(span.name).includes("run_in_terminal");
  const parsed = parsedArgs(span, logInput);
  const warnings: SpanWarning[] = [];

  if (isTerminal && matchesAny(DESTRUCTIVE_PATTERNS, cmdLower)) {
    warnings.push({ key: "destructive", label: "Destructive command", tone: "critical", Icon: TerminalIcon });
  }

  const hay = `${raw}\n${prompt}`.toLowerCase();
  if (matchesAny(SECRET_PATTERNS, hay)) {
    warnings.push({ key: "secret", label: "Exposed API token / secret", tone: "critical", Icon: LockIcon });
  }

  if (matchesAny(CREDENTIAL_PATTERNS, cmdLower)) {
    warnings.push({ key: "credential", label: "Credential file / auth access", tone: "warning", Icon: LockIcon });
  }

  if (isOutboundPost(span, cmdLower, parsed)) {
    warnings.push({ key: "webPost", label: "Outbound POST request", tone: "warning", Icon: WorldmapIcon });
  }

  return warnings;
}

/** Collapse a list of warnings to one per distinct kind, preserving order. */
function dedupeWarnings(warnings: SpanWarning[]): SpanWarning[] {
  const seen = new Set<string>();
  const out: SpanWarning[] = [];
  for (const w of warnings) {
    if (seen.has(w.key)) continue;
    seen.add(w.key);
    out.push(w);
  }
  return out;
}

/** Small inline cluster of warning icons for a trace row. */
function WarningIcons({ warnings, size = 13 }: { warnings: SpanWarning[]; size?: number }) {
  if (warnings.length === 0) return null;
  return (
    <Flex alignItems="center" gap={2}>
      {warnings.map((w) => (
        <span
          key={w.key}
          title={w.label}
          style={{ color: toneColor(w.tone), display: "flex" }}
        >
          <w.Icon size={size} />
        </span>
      ))}
    </Flex>
  );
}

/** Full-width callout listing a span's risk flags in the detail panel. */
function WarningBanner({ warnings }: { warnings: SpanWarning[] }) {
  const critical = warnings.some((w) => w.tone === "critical");
  const tone: Tone = critical ? "critical" : "warning";
  return (
    <Flex
      flexDirection="column"
      gap={4}
      style={{
        padding: "8px 10px",
        borderRadius: 4,
        border: `1px solid ${toneColor(tone)}`,
        background: "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.04))",
      }}
    >
      {warnings.map((w) => (
        <Flex key={w.key} alignItems="center" gap={6}>
          <span style={{ color: toneColor(w.tone), display: "flex" }}><w.Icon size={14} /></span>
          <Text style={{ fontSize: 12, color: toneColor(w.tone), fontWeight: 600 }}>{w.label}</Text>
        </Flex>
      ))}
    </Flex>
  );
}

// Subdued secondary text for a tree row, native-tracing style: the invoked
// skill name for Skill spans, else the most identifying tool argument (command,
// file, URL, …). Args live on the span (Copilot) or the correlated tool_result
// log (`logInput`, Claude Code). Returns null when nothing useful is captured.
function rowSecondary(span: Span, logInput?: string): string | null {
  const raw = span.cmd ?? span.args ?? logInput;
  if (raw == null || raw === "") return null;
  const text = String(raw);

  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(text);
    if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  // `span.cmd` (Claude Code Bash) is already the bare command string.
  if (!parsed) return shorten(text);

  const skill = parsed.skill ?? parsed.skill_name ?? parsed.name;
  const isSkill = String(span.tool ?? "").toLowerCase() === "skill" || classifyOf(span).label === "Skill";
  if (isSkill && typeof skill === "string" && skill) return shorten(skill);

  for (const k of ["command", "file_path", "filePath", "path", "url", "uri", "query", "pattern"]) {
    const v = parsed[k];
    if (typeof v === "string" && v.trim()) {
      const isPath = k === "file_path" || k === "filePath" || k === "path";
      return shorten(isPath ? v.split("/").pop() || v : v);
    }
  }
  return null;
}

/** Trim to a single tidy line for inline display. */
function shorten(v: string): string {
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

// Consecutive sibling tool spans of the same kind collapse into one group.
// Grouping is by identical adjacent runs, order-preserving: Edit×4, Bash×10,
// Edit×4 stays three groups, never merged into Edit×8 + Bash×10.
const MIN_RUN = 2;
function groupKey(n: TreeNode): string | null {
  const k = classifyOf(n.span);
  return k.kind === "tool" ? `tool:${k.label}` : null;
}

// Persisted tree expansion intent, so it carries across traces (a fresh trace
// has different span ids, so we persist the mode and re-seed, not the id set).
type TreeMode = "default" | "all" | "none";
const TREE_MODE_KEY = "sessionDetail.treeMode";

function loadTreeMode(): TreeMode {
  try {
    const v = sessionStorage.getItem(TREE_MODE_KEY);
    if (v === "all" || v === "none" || v === "default") return v;
  } catch {
    /* storage unavailable */
  }
  return "default";
}

function saveTreeMode(mode: TreeMode) {
  try {
    sessionStorage.setItem(TREE_MODE_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

/** Every span id plus every collapsible group id — the fully-expanded state. */
function collectAllIds(roots: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: TreeNode[]) => {
    let i = 0;
    while (i < nodes.length) {
      const key = groupKey(nodes[i]);
      let j = i + 1;
      if (key) while (j < nodes.length && groupKey(nodes[j]) === key) j++;
      if (key && j - i >= MIN_RUN) ids.add(`grp:${String(nodes[i].span.spanId)}`);
      i = key && j - i >= MIN_RUN ? j : i + 1;
    }
    for (const n of nodes) {
      ids.add(String(n.span.spanId));
      if (n.children.length) walk(n.children);
    }
  };
  walk(roots);
  return ids;
}

/** The first two levels expanded, groups collapsed — the default view. */
function collectDefaultIds(roots: TreeNode[]): Set<string> {
  const s = new Set<string>();
  const seed = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.depth < 1) {
        s.add(String(n.span.spanId));
        seed(n.children);
      }
    }
  };
  seed(roots);
  return s;
}

function seedFor(mode: TreeMode, roots: TreeNode[]): Set<string> {
  if (mode === "all") return collectAllIds(roots);
  if (mode === "none") return new Set();
  return collectDefaultIds(roots);
}

/** Lowercased searchable text of a span: name, tool, command/args, prompt, output. */
function spanSearchText(span: Span, logInput?: string): string {
  const args = span.args ?? logInput ?? "";
  return [span.name, span.tool, span.cmd, args, span.prompt, span.userRequest, span.toolOutputPreview]
    .map((x) => String(x ?? ""))
    .join(" ")
    .toLowerCase();
}

/** Flatten the tree into display (pre-order) order. */
function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

function SpanTree({
  roots,
  rollups,
  inputByToolUse,
  selectedId,
  onSelectSpan,
  onSelectGroup,
}: {
  roots: TreeNode[];
  rollups: Map<string, Rollup>;
  inputByToolUse: Map<string, string>;
  selectedId: string | null;
  onSelectSpan: (span: Span) => void;
  onSelectGroup: (gid: string, spans: Span[]) => void;
}) {
  // Expansion intent persists across traces; the id set is re-seeded per trace.
  const [treeMode, setTreeMode] = useState<TreeMode>(loadTreeMode);
  const [expanded, setExpanded] = useState<Set<string>>(() => seedFor(loadTreeMode(), roots));

  const applyMode = (mode: TreeMode) => {
    setTreeMode(mode);
    saveTreeMode(mode);
    setExpanded(seedFor(mode, roots));
  };

  // Re-apply the persisted mode whenever a new trace loads.
  useEffect(() => {
    setExpanded(seedFor(treeMode, roots));
    // treeMode is intentionally omitted: applyMode already re-seeds on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // In-trace text search: highlight matching spans, step through them, and
  // (while a query is active) force the whole tree open so no match is hidden.
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(0);
  const term = search.trim().toLowerCase();

  const matchIds = useMemo(() => {
    if (!term) return [] as string[];
    return flattenTree(roots)
      .filter((n) => spanSearchText(n.span, n.span.toolUseId ? inputByToolUse.get(String(n.span.toolUseId)) : undefined).includes(term))
      .map((n) => String(n.span.spanId));
  }, [term, roots, inputByToolUse]);

  const matchSet = useMemo(() => new Set(matchIds), [matchIds]);
  const allIds = useMemo(() => (term ? collectAllIds(roots) : null), [term, roots]);
  const view = allIds ?? expanded;

  // Reset the cursor and jump to the first match whenever the match set changes.
  useEffect(() => {
    setCursor(0);
    if (matchIds.length > 0) {
      const first = roots.length ? flattenTree(roots).find((n) => String(n.span.spanId) === matchIds[0]) : undefined;
      if (first) onSelectSpan(first.span);
    }
    // onSelectSpan/roots are stable enough; keying on the ordered id list avoids loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIds.join("|")]);

  const stepMatch = (dir: 1 | -1) => {
    if (matchIds.length === 0) return;
    const next = (cursor + dir + matchIds.length) % matchIds.length;
    setCursor(next);
    const node = flattenTree(roots).find((n) => String(n.span.spanId) === matchIds[next]);
    if (node) onSelectSpan(node.span);
  };

  const renderNode = (n: TreeNode): React.ReactNode => {
    const id = String(n.span.spanId);
    const isOpen = view.has(id);
    const hasChildren = n.children.length > 0;
    return (
      <div key={id}>
        <SpanRow
          node={n}
          rollup={rollups.get(id)}
          logInput={n.span.toolUseId ? inputByToolUse.get(String(n.span.toolUseId)) : undefined}
          isOpen={isOpen}
          hasChildren={hasChildren}
          selected={selectedId === id}
          isMatch={matchSet.has(id)}
          onToggle={() => toggle(id)}
          onSelect={() => onSelectSpan(n.span)}
        />
        {hasChildren && isOpen ? renderNodes(n.children) : null}
      </div>
    );
  };

  const renderNodes = (nodes: TreeNode[]): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    let i = 0;
    while (i < nodes.length) {
      const key = groupKey(nodes[i]);
      let j = i + 1;
      if (key) while (j < nodes.length && groupKey(nodes[j]) === key) j++;
      const runLen = j - i;
      if (key && runLen >= MIN_RUN) {
        const run = nodes.slice(i, j);
        const gid = `grp:${String(run[0].span.spanId)}`;
        const open = view.has(gid);
        const kind = classifyOf(run[0].span);
        const groupWarnings = dedupeWarnings(
          run.flatMap((n) =>
            spanWarnings(n.span, n.span.toolUseId ? inputByToolUse.get(String(n.span.toolUseId)) : undefined),
          ),
        );
        out.push(
          <div key={gid}>
            <GroupRow
              depth={run[0].depth}
              Icon={kind.Icon}
              tone={kind.tone}
              label={kind.label}
              count={runLen}
              warnings={groupWarnings}
              open={open}
              selected={selectedId === gid}
              onToggle={() => toggle(gid)}
              onSelect={() => onSelectGroup(gid, run.map((n) => n.span))}
            />
            {open ? run.map(renderNode) : null}
          </div>,
        );
        i = j;
      } else {
        out.push(renderNode(nodes[i]));
        i += 1;
      }
    }
    return out;
  };

  return (
    <div>
      <Flex
        gap={8}
        alignItems="center"
        style={{ position: "sticky", top: 0, zIndex: 1, background: surfaceStyle.background, paddingBottom: 6 }}
      >
        <Button variant="emphasized" onClick={() => applyMode("all")}>Expand all</Button>
        <Button variant="emphasized" onClick={() => applyMode("none")}>Collapse all</Button>
        <div style={{ flex: 1, minWidth: 120 }}>
          <TextInput
            value={search}
            onChange={(v) => setSearch(v)}
            placeholder="Search spans…"
            onKeyDown={(e) => {
              if (e.key === "Enter") stepMatch(e.shiftKey ? -1 : 1);
            }}
          />
        </div>
        {term ? (
          <Flex alignItems="center" gap={4}>
            <Text style={{ fontSize: 12, color: subduedText, minWidth: 54, textAlign: "right" }}>
              {matchIds.length ? `${cursor + 1} / ${matchIds.length}` : "No matches"}
            </Text>
            <Button disabled={matchIds.length === 0} onClick={() => stepMatch(-1)} title="Previous match (Shift+Enter)"><ChevronUpIcon /></Button>
            <Button disabled={matchIds.length === 0} onClick={() => stepMatch(1)} title="Next match (Enter)"><ChevronDownIcon /></Button>
          </Flex>
        ) : null}
      </Flex>
      {renderNodes(roots)}
    </div>
  );
}

function GroupRow({
  depth,
  Icon,
  tone,
  label,
  count,
  warnings,
  open,
  selected,
  onToggle,
  onSelect,
}: {
  depth: number;
  Icon: TaskKind["Icon"];
  tone: TaskKind["tone"];
  label: string;
  count: number;
  warnings: SpanWarning[];
  open: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const toggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle();
  };
  return (
    <Flex
      alignItems="center"
      gap={6}
      onClick={onSelect}
      style={{
        paddingLeft: 8 + depth * 18,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        cursor: "pointer",
        borderRadius: 4,
        background: selected ? "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.06))" : undefined,
      }}
    >
      <span
        onClick={toggleClick}
        title={open ? "Collapse" : "Expand"}
        style={{ width: 16, display: "flex", justifyContent: "center", color: subduedText, cursor: "pointer" }}
      >
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </span>
      <span style={{ color: toneColor(tone), display: "flex" }}><Icon size={16} /></span>
      <Text style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</Text>
      <WarningIcons warnings={warnings} />
      {!open ? <Text style={{ fontSize: 11, color: subduedText }}>collapsed</Text> : null}
      <span
        onClick={toggleClick}
        title={open ? "Collapse" : "Expand"}
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: subduedText,
          background: "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.06))",
          borderRadius: 10,
          padding: "0 7px",
          cursor: "pointer",
        }}
      >
        ×{count}
      </span>
    </Flex>
  );
}

function SpanRow({
  node,
  rollup,
  logInput,
  isOpen,
  hasChildren,
  selected,
  isMatch,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  rollup?: Rollup;
  logInput?: string;
  isOpen: boolean;
  hasChildren: boolean;
  selected: boolean;
  isMatch?: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const s = node.span;
  const kind = classifySpan({
    name: s.name as string,
    tool: s.tool as string,
    model: s.model as string,
    genOp: s.genOp as string,
    agent: s.agent as string,
  });
  const success = s.success;
  const durMs = num(s.durMs);
  const cost = num(s.cost) + (rollup?.cost ?? 0);
  const Icon = kind.Icon;
  const secondary = rowSecondary(s, logInput);
  const warnings = spanWarnings(s, logInput);
  const isShadowAI = s.is_llm && s.is_personal;
  // Shadow-AI model calls hidden inside this row's rollup (365 of 371 sit under a parent turn).
  const rollupShadow = rollup?.shadowCount ?? 0;
  const shadowFlagged = isShadowAI || rollupShadow > 0;
  // Brand the turn (root) node with the assistant's logo.
  const brand = node.depth === 0 ? assistantBrandIcon(String(s.assistant ?? ""), 16) : null;

  // Bring a programmatically-selected row (e.g. a security deep-link) into view.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div ref={rowRef}>
    <Flex
      alignItems="center"
      gap={6}
      onClick={onSelect}
      style={{
        paddingLeft: 8 + node.depth * 18,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        cursor: "pointer",
        borderRadius: 4,
        background: selected 
          ? "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.06))"
          : isMatch
          ? "rgba(255, 199, 0, 0.22)"
          : shadowFlagged
          ? "rgba(252, 188, 5, 0.08)"
          : undefined,
        boxShadow: selected ? "inset 3px 0 0 var(--dt-colors-background-accent-primary-default, #464cce)" : undefined,
        border: shadowFlagged && !selected ? "1px solid rgba(252, 188, 5, 0.3)" : undefined,
      }}
    >
      <span
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) onToggle();
        }}
        style={{ width: 16, display: "flex", justifyContent: "center", color: subduedText }}
      >
        {hasChildren ? (isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />) : null}
      </span>
      <span style={{ color: toneColor(kind.tone), display: "flex" }}>{brand ?? <Icon size={16} />}</span>
      <Text style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600 }}>{kind.label}</span>
        {secondary ? <span style={{ color: subduedText }}>{` | ${secondary}`}</span> : null}
      </Text>
      {shadowFlagged ? (
        <Flex
          alignItems="center"
          gap={2}
          title={rollupShadow > 0 && !isShadowAI
            ? `${rollupShadow} shadow-AI model call${rollupShadow > 1 ? "s" : ""} (personal account) rolled up here`
            : "Shadow-AI call from personal account"}
        >
          <GhostIcon size={12} style={{ color: toneColor("warning") }} />
          {rollupShadow > 1 && !isShadowAI ? (
            <Text style={{ fontSize: 11, color: toneColor("warning") }}>×{rollupShadow}</Text>
          ) : null}
        </Flex>
      ) : null}
      <WarningIcons warnings={warnings} />
      {rollup ? (
        <Flex alignItems="center" gap={2} style={{ color: toneColor("info") }} title={`${rollup.count} model call${rollup.count > 1 ? "s" : ""}`}>
          <ChatIcon size={12} />
          <Text style={{ fontSize: 11, color: toneColor("info") }}>×{rollup.count}</Text>
        </Flex>
      ) : null}
      {cost > 0 ? <Text style={{ fontSize: 11, color: subduedText }}>{fmtUSD(cost)}</Text> : null}
      {durMs > 0 ? <Text style={{ fontSize: 11, color: subduedText, minWidth: 44, textAlign: "right" }}>{fmtDuration(durMs)}</Text> : null}
      {success === false ? (
        <XmarkIcon size={13} style={{ color: toneColor("critical") }} />
      ) : success === true ? (
        <CheckmarkIcon size={13} style={{ color: toneColor("primary") }} />
      ) : null}
    </Flex>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "" ) return null;
  return (
    <Flex gap={12} style={{ padding: "3px 0" }}>
      <Text style={{ fontSize: 12, color: subduedText, minWidth: 120 }}>{label}</Text>
      <Text style={{ fontSize: 13, flex: 1, wordBreak: "break-word" }}>{value}</Text>
    </Flex>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        borderRadius: 4,
        fontSize: 12,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 320,
        overflow: "auto",
        background: "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.05))",
      }}
    >
      {text}
    </pre>
  );
}

function SpanDetail({ span, logInput, rollup }: { span: Span | null; logInput?: string; rollup?: Rollup }) {
  if (!span) {
    return (
      <Flex justifyContent="center" alignItems="center" style={{ minHeight: 200, color: subduedText }}>
        <Text>Select a span to see its details.</Text>
      </Flex>
    );
  }
  const kind = classifySpan({
    name: span.name as string,
    tool: span.tool as string,
    model: span.model as string,
    genOp: span.genOp as string,
    agent: span.agent as string,
  });
  const Icon = kind.Icon;
  const success = span.success;
  const warnings = spanWarnings(span, logInput);

  return (
    <Flex flexDirection="column" gap={8}>
      <Flex alignItems="center" gap={8}>
        <span style={{ color: toneColor(kind.tone), display: "flex" }}><Icon size={20} /></span>
        <Heading level={5} style={{ margin: 0 }}>{kind.label}</Heading>
      </Flex>

      {warnings.length > 0 ? <WarningBanner warnings={warnings} /> : null}

      <div>
        <Row label="Type" value={String(span.name ?? "")} />
        <Row label="Started" value={fmtTime(String(span.start))} />
        <Row label="Duration" value={num(span.durMs) > 0 ? fmtDuration(num(span.durMs)) : null} />
        {success != null ? <Row label="Status" value={success === true ? "Success" : "Failed"} /> : null}
        {span.attempt != null ? <Row label="Attempt" value={String(span.attempt)} /> : null}
      </div>

      {kind.kind === "llm" && (
        <div>
          <Row label="Model" value={String(span.model ?? "")} />
          <Row label="Input tokens" value={fmtInt(num(span.inTok))} />
          <Row label="Output tokens" value={fmtInt(num(span.outTok))} />
          <Row label="Cache read" value={fmtInt(num(span.crTok))} />
          <Row label="Cache creation" value={fmtInt(num(span.ccTok))} />
          <Row label="Est. cost" value={fmtUSD(num(span.cost))} />
          {num(span.ttft) > 0 ? <Row label="Time to first token" value={fmtDuration(num(span.ttft))} /> : null}
        </div>
      )}

      {kind.kind === "interaction" && (
        <div>
          {span.seq != null ? <Row label="Turn" value={String(span.seq)} /> : null}
          {span.promptLen != null ? <Row label="Prompt length" value={`${fmtInt(num(span.promptLen))} chars`} /> : null}
          {span.prompt ? (
            <Flex flexDirection="column" gap={4} style={{ marginTop: 6 }}>
              <Text style={{ fontSize: 12, color: subduedText }}>User prompt</Text>
              <CodeBlock text={String(span.prompt)} />
            </Flex>
          ) : null}
        </div>
      )}

      {(kind.kind === "tool" || kind.kind === "execution") ? <ToolArgs span={span} logInput={logInput} /> : null}

      {kind.kind === "agent" && span.agent ? <Row label="Agent" value={String(span.agent)} /> : null}

      {kind.kind === "tool" && span.traceId && String(span.tool ?? "").startsWith("mcp__") ? (
        <DownstreamTrace span={span} />
      ) : null}

      {rollup ? <ModelRollup rollup={rollup} /> : null}

      <Text style={{ fontSize: 11, color: subduedText, marginTop: 8, fontFamily: "monospace" }}>
        span {String(span.spanId)}
      </Text>
    </Flex>
  );
}

// Detail for a selected collapsed group: the aggregate header plus every
// grouped span's full detail, stacked.
function GroupDetail({
  spans,
  inputByToolUse,
  rollups,
}: {
  spans: Span[];
  inputByToolUse: Map<string, string>;
  rollups: Map<string, Rollup>;
}) {
  const kind = classifyOf(spans[0]);
  const Icon = kind.Icon;
  const totalMs = spans.reduce((a, s) => a + num(s.durMs), 0);
  return (
    <Flex flexDirection="column" gap={12}>
      <Flex alignItems="center" gap={8}>
        <span style={{ color: toneColor(kind.tone), display: "flex" }}><Icon size={20} /></span>
        <Heading level={5} style={{ margin: 0 }}>{kind.label} ×{spans.length}</Heading>
      </Flex>
      <Text style={{ fontSize: 12, color: subduedText }}>
        {spans.length} consecutive {kind.label} call{spans.length === 1 ? "" : "s"}
        {totalMs > 0 ? ` · ${fmtDuration(totalMs)} total` : ""}
      </Text>
      {spans.map((s, i) => (
        <div
          key={String(s.spanId)}
          style={{ borderTop: "1px solid var(--dt-colors-border-neutral-default, rgba(0,0,0,0.12))", paddingTop: 10 }}
        >
          <Text style={{ fontSize: 11, color: subduedText, fontWeight: 600 }}>#{i + 1}</Text>
          <SpanDetail
            span={s}
            logInput={s.toolUseId ? inputByToolUse.get(String(s.toolUseId)) : undefined}
            rollup={rollups.get(String(s.spanId))}
          />
        </div>
      ))}
    </Flex>
  );
}

// Some tool calls (notably MCP tools) fan out into an instrumented downstream
// service — an MCP server span and the HTTP request it makes — which share the
// assistant's distributed trace. This shows that downstream subtree and offers
// a jump into the full distributed trace.
function DownstreamTrace({ span }: { span: Span }) {
  const traceId = String(span.traceId ?? "");
  const ds = useTimeframedDql(downstreamTraceQuery(traceId));
  const records = (ds.data?.records ?? []) as Span[];

  if (ds.isLoading && records.length === 0) {
    return <Text style={{ fontSize: 12, color: subduedText, marginTop: 10 }}>Checking for downstream spans…</Text>;
  }
  if (records.length === 0) return null; // no instrumented downstream service in this trace

  // Correlate the selected tool to its downstream server span by name:
  // "mcp__dynatrace-test__get_dad_joke" -> matches span "tool.get_dad_joke".
  const toolName = String(span.tool ?? "");
  const key = (toolName.includes("__") ? toolName.split("__").pop()! : toolName).toLowerCase();

  const childrenOf = new Map<string, Span[]>();
  for (const r of records) {
    const p = r.parent ? String(r.parent) : "";
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(r);
  }
  const startMs = (s: Span) => new Date(String(s.start)).getTime() || 0;
  const rootSpan =
    key.length > 2
      ? records.find((r) => {
          const n = String(r.name ?? "").toLowerCase();
          return n === `tool.${key}` || n.endsWith(key);
        })
      : undefined;

  const subtree: Array<{ span: Span; depth: number }> = [];
  if (rootSpan) {
    const walk = (s: Span, depth: number) => {
      subtree.push({ span: s, depth });
      (childrenOf.get(String(s.spanId)) ?? []).sort((a, b) => startMs(a) - startMs(b)).forEach((c) => walk(c, depth + 1));
    };
    walk(rootSpan, 0);
  }

  const services = Array.from(new Set(records.map((r) => String(r.service))));
  const openTrace = () => {
    if (!traceId) return;
    sendIntent({ "dt.query": `fetch spans | filter trace.id == toUid("${traceId}")` });
  };

  return (
    <Flex flexDirection="column" gap={6} style={{ marginTop: 10 }}>
      <Flex alignItems="center" gap={6}>
        <span style={{ color: toneColor("info"), display: "flex" }}><ContainerIcon size={16} /></span>
        <Heading level={6} style={{ margin: 0 }}>Downstream trace</Heading>
      </Flex>
      <Text style={{ fontSize: 12, color: subduedText }}>
        {records.length} span{records.length === 1 ? "" : "s"} from {services.length} instrumented service
        {services.length === 1 ? "" : "s"} ({services.join(", ")}) share this distributed trace.
      </Text>

      {subtree.length > 0 ? (
        <div style={{ ...surfaceStyle, boxShadow: "none", padding: 8 }}>
          {subtree.map(({ span: s, depth }) => (
            <Flex key={String(s.spanId)} alignItems="center" gap={8} style={{ paddingLeft: depth * 16, padding: "2px 0" }}>
              <span style={{ color: toneColor("info"), display: "flex" }}><LinkIcon size={12} /></span>
              <Text style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(s.name)}</Text>
              <Text style={{ color: subduedText, fontSize: 11 }}>{String(s.service)}</Text>
              {num(s.durMs) > 0 ? <Text style={{ color: subduedText, fontSize: 11, minWidth: 44, textAlign: "right" }}>{fmtDuration(num(s.durMs))}</Text> : null}
              {String(s.status) === "ERROR" ? <XmarkIcon size={12} style={{ color: toneColor("critical") }} /> : null}
            </Flex>
          ))}
        </div>
      ) : (
        <Text style={{ fontSize: 12, color: subduedText }}>
          Couldn’t isolate this tool’s subtree automatically — open the full trace to inspect it.
        </Text>
      )}

      <Button onClick={openTrace} variant="emphasized" style={{ alignSelf: "flex-start" }}>
        <Button.Prefix><LinkIcon /></Button.Prefix>
        View full distributed trace
      </Button>
    </Flex>
  );
}

// The model calls that happened under this turn, rolled up (they are no longer
// shown as their own tree nodes).
function ModelRollup({ rollup }: { rollup: Rollup }) {
  const modelSummary = Object.entries(rollup.models)
    .sort((a, b) => b[1] - a[1])
    .map(([m, c]) => `${m} ×${c}`)
    .join(", ");
  const avgTtft = rollup.ttftN > 0 ? rollup.ttftSum / rollup.ttftN : 0;
  return (
    <Flex flexDirection="column" gap={6} style={{ marginTop: 6 }}>
      <Flex alignItems="center" gap={6}>
        <span style={{ color: toneColor("info"), display: "flex" }}><ChatIcon size={16} /></span>
        <Heading level={6} style={{ margin: 0 }}>Model requests ({rollup.count})</Heading>
      </Flex>
      <div>
        <Row label="Models" value={modelSummary} />
        <Row label="Input tokens" value={fmtInt(rollup.inTok)} />
        <Row label="Output tokens" value={fmtInt(rollup.outTok)} />
        <Row label="Cache read" value={fmtInt(rollup.crTok)} />
        <Row label="Est. cost" value={fmtUSD(rollup.cost)} />
        {avgTtft > 0 ? <Row label="Avg time to first token" value={fmtDuration(avgTtft)} /> : null}
        {rollup.failures > 0 ? <Row label="Failures" value={String(rollup.failures)} /> : null}
      </div>
      {/* Per-call breakdown */}
      <Flex flexDirection="column" gap={2} style={{ marginTop: 2 }}>
        {rollup.calls.map((c, i) => (
          <Flex key={String(c.spanId ?? i)} alignItems="center" gap={8} style={{ fontSize: 12 }}>
            <Text style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{String(c.model ?? "?")}</Text>
            <Text style={{ color: subduedText, fontSize: 12 }}>{fmtTokens(num(c.inTok))}→{fmtTokens(num(c.outTok))}</Text>
            <Text style={{ fontSize: 12, minWidth: 52, textAlign: "right" }}>{fmtUSD(num(c.cost))}</Text>
            {c.success === false ? <XmarkIcon size={12} style={{ color: toneColor("critical") }} /> : <CheckmarkIcon size={12} style={{ color: toneColor("primary") }} />}
          </Flex>
        ))}
      </Flex>
    </Flex>
  );
}

// Renders a tool call's inputs. Claude Code only records a `full_command`
// (Bash); Copilot records the full arguments JSON in `gen_ai.tool.call.arguments`
// — which for a web fetch includes the URL. Other tools (WebFetch on Claude)
// carry no arguments at all in the telemetry, so there is nothing to show.
const URL_RE = /^https?:\/\/\S+$/i;
const KEY_LABELS: Record<string, string> = {
  url: "URL",
  uri: "URL",
  query: "Query",
  file_path: "File",
  filePath: "File",
  path: "Path",
  pattern: "Pattern",
  command: "Command",
  message: "Message",
  prompt: "Prompt",
};

function UrlValue({ value }: { value: string }) {
  return (
    <a href={value} target="_blank" rel="noopener noreferrer" style={{ color: toneColor("primary"), wordBreak: "break-all" }}>
      {value}
    </a>
  );
}

function ToolArgs({ span, logInput }: { span: Span; logInput?: string }) {
  // Bash-style single command (Claude Code span field)
  if (span.cmd) {
    return (
      <Flex flexDirection="column" gap={4} style={{ marginTop: 6 }}>
        <Text style={{ fontSize: 12, color: subduedText }}>Command</Text>
        <CodeBlock text={String(span.cmd)} />
      </Flex>
    );
  }

  // Arguments come from the Copilot span (gen_ai.tool.call.arguments) or, for
  // Claude Code, from the correlated tool_result log event (tool_input).
  // For the hyphenated Mac format, fall back to tool.output.preview.
  const raw = span.args ?? logInput;
  if (raw == null || raw === "") {
    if (span.toolOutputPreview && String(span.toolOutputPreview).trim()) {
      return (
        <Flex flexDirection="column" gap={4} style={{ marginTop: 6 }}>
          <Text style={{ fontSize: 12, color: subduedText }}>Output preview</Text>
          <CodeBlock text={String(span.toolOutputPreview)} />
        </Flex>
      );
    }
    return <Text style={{ fontSize: 12, color: subduedText, marginTop: 6 }}>No arguments captured for this tool.</Text>;
  }

  const text = String(raw);
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(text);
    if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch {
    /* not JSON */
  }

  if (!parsed) {
    // If the whole value is a bare URL, link it; otherwise show as-is.
    return (
      <Flex flexDirection="column" gap={4} style={{ marginTop: 6 }}>
        <Text style={{ fontSize: 12, color: subduedText }}>Arguments</Text>
        {URL_RE.test(text.trim()) ? <UrlValue value={text.trim()} /> : <CodeBlock text={text} />}
      </Flex>
    );
  }

  const entries = Object.entries(parsed);
  return (
    <Flex flexDirection="column" gap={6} style={{ marginTop: 6 }}>
      <Text style={{ fontSize: 12, color: subduedText }}>Arguments</Text>
      <div>
        {entries.map(([k, v]) => {
          const label = KEY_LABELS[k] ?? k;
          const sv = typeof v === "string" ? v : JSON.stringify(v);
          const isUrl = typeof v === "string" && URL_RE.test(v.trim());
          if (isUrl) return <Row key={k} label={label} value={<UrlValue value={v as string} />} />;
          if (typeof v === "string" && v.length > 120) {
            return (
              <Flex key={k} flexDirection="column" gap={2} style={{ padding: "3px 0" }}>
                <Text style={{ fontSize: 12, color: subduedText }}>{label}</Text>
                <CodeBlock text={v} />
              </Flex>
            );
          }
          return <Row key={k} label={label} value={sv} />;
        })}
      </div>
    </Flex>
  );
}

// ---------------------------------------------------------------------------

function summarize(records: Span[]) {
  let interactions = 0;
  let tools = 0;
  let tokens = 0;
  let cost = 0;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  let assistant = "—";
  let repo = "";
  let branch = "";
  for (const s of records) {
    const name = String(s.name ?? "");
    if (name === "claude_code.interaction" || name === "claude-code.interaction") interactions += 1;
    if (name === "claude_code.tool" || String(s.genOp) === "execute_tool" ||
      (name.startsWith("claude-code.tool.") && name !== "claude-code.tool.blocked_on_user" && name !== "claude-code.tool.execution")) tools += 1;
    tokens += num(s.inTok) + num(s.outTok) + num(s.crTok);
    cost += num(s.cost);
    const st = new Date(String(s.start)).getTime();
    const en = new Date(String(s.end)).getTime();
    if (!Number.isNaN(st)) minStart = Math.min(minStart, st);
    if (!Number.isNaN(en)) maxEnd = Math.max(maxEnd, en);
    if (s.assistant) assistant = String(s.assistant);
    if (s.repo) repo = String(s.repo);
    if (s.branch) branch = String(s.branch);
  }
  return {
    interactions,
    tools,
    tokens,
    cost,
    assistant,
    repo,
    branch,
    durationMs: maxEnd > minStart ? maxEnd - minStart : 0,
  };
}
