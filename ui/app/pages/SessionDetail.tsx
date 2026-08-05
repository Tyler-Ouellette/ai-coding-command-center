// Session detail: a split view. Left is a selectable span tree rebuilt from
// span.id / span.parent_id, each node tagged with a task-type icon. Right shows
// the full attributes of the selected span, formatted by task kind.

import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { ChevronDownIcon, ChevronRightIcon, CheckmarkIcon, XmarkIcon, ChatIcon, ContainerIcon, LinkIcon } from "@dynatrace/strato-icons";
import { sendIntent } from "@dynatrace-sdk/navigation";

import { StatTile } from "../components/StatTile";
import { QueryState } from "../components/QueryState";
import { toneColor, subduedText, surfaceStyle } from "../components/tokens";
import { classifySpan, type TaskKind } from "../data/taskKind";
import { assistantBrandIcon } from "../components/brandIcons";
import { useTimeframedDql, num } from "../data/useQuery";
import { fmtInt, fmtTokens, fmtUSD, fmtDuration, fmtTime } from "../data/normalize";
import { sessionSpansQuery, sessionToolInputsQuery, downstreamTraceQuery } from "../data/queries";

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
      r = { count: 0, models: {}, inTok: 0, outTok: 0, crTok: 0, ccTok: 0, cost: 0, ttftSum: 0, ttftN: 0, failures: 0, calls: [] };
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
    r.calls.push(s);
  }
  return map;
}

/** Build the span tree, EXCLUDING model-call spans (those are rolled up separately). */
function buildTree(records: Span[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const s of records) {
    if (isLlmSpan(s)) continue;
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
}

/** Per-flag span matcher used to auto-select the most relevant span on deep-link. */
const HIGHLIGHT_MATCHERS: Record<string, (s: Span) => boolean> = {
  secrets: (s) => {
    const prompt = String(s.prompt ?? "").toLowerCase();
    return prompt.includes("ghp_") || prompt.includes("sk-") || prompt.includes("akia") ||
      prompt.includes("sk-ant-api03-") || (prompt.includes("-----begin") && prompt.includes("private key"));
  },
  destructive: (s) => {
    const cmd = String(s.cmd ?? s.args ?? "").toLowerCase();
    return (String(s.tool) === "Bash" || String(s.name).includes("run_in_terminal")) &&
      (cmd.includes("rm -rf") || cmd.includes("chmod 777") || cmd.includes("mkfs") || cmd.includes("dd if="));
  },
  credential: (s) => {
    const cmd = String(s.cmd ?? s.args ?? "").toLowerCase();
    return cmd.includes("id_rsa") || cmd.includes("id_ed25519") || cmd.includes(".pem") ||
      cmd.includes(".ssh/") || cmd.includes(".aws/credentials") || cmd.includes("private_key");
  },
  jailbreak: (s) => {
    const prompt = String(s.prompt ?? "").toLowerCase();
    return prompt.includes("ignore all previous instruction") || prompt.includes("reveal your system prompt") ||
      prompt.includes("do anything now") || prompt.includes("bypass your");
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

export function SessionDetail({ sessionId, show, onDismiss, highlightKey }: SessionDetailProps) {
  const spans = useTimeframedDql(sessionSpansQuery(sessionId));
  const toolInputs = useTimeframedDql(sessionToolInputsQuery(sessionId));
  const records = (spans.data?.records ?? []) as Span[];
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

  // Close on Escape.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, onDismiss]);

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
          <Heading level={4} style={{ margin: 0 }}>Session</Heading>
          <Button onClick={onDismiss}>Close</Button>
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
            <StatTile label="Interactions" value={fmtInt(summary.interactions)} />
            <StatTile label="Tool calls" value={fmtInt(summary.tools)} />
            <StatTile label="Tokens" value={fmtTokens(summary.tokens)} />
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
  // Default: expand the first two levels. Groups start collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
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
  });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const renderNode = (n: TreeNode): React.ReactNode => {
    const id = String(n.span.spanId);
    const isOpen = expanded.has(id);
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
        const open = expanded.has(gid);
        const kind = classifyOf(run[0].span);
        out.push(
          <div key={gid}>
            <GroupRow
              depth={run[0].depth}
              Icon={kind.Icon}
              tone={kind.tone}
              label={kind.label}
              count={runLen}
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

  return <>{renderNodes(roots)}</>;
}

function GroupRow({
  depth,
  Icon,
  tone,
  label,
  count,
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
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  rollup?: Rollup;
  logInput?: string;
  isOpen: boolean;
  hasChildren: boolean;
  selected: boolean;
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
  // Brand the turn (root) node with the assistant's logo.
  const brand = node.depth === 0 ? assistantBrandIcon(String(s.assistant ?? ""), 16) : null;

  return (
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
        background: selected ? "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.06))" : undefined,
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

  return (
    <Flex flexDirection="column" gap={8}>
      <Flex alignItems="center" gap={8}>
        <span style={{ color: toneColor(kind.tone), display: "flex" }}><Icon size={20} /></span>
        <Heading level={5} style={{ margin: 0 }}>{kind.label}</Heading>
      </Flex>

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
  const raw = span.args ?? logInput;
  if (raw == null || raw === "") {
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
    if (name === "claude_code.interaction") interactions += 1;
    if (name === "claude_code.tool" || String(s.genOp) === "execute_tool") tools += 1;
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
