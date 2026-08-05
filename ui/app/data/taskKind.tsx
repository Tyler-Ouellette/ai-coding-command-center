// Classifies a span into a task "kind" with a label, an icon and a semantic
// tone. Drives the icons in the session span tree and the per-span detail
// panel, and gives every task type a consistent look across the app.

import React from "react";
import {
  AccountIcon,
  AgentIcon,
  ChatIcon,
  CodeIcon,
  DatabaseIcon,
  DocumentIcon,
  EditIcon,
  FilterIcon,
  ListIcon,
  PauseIcon,
  PlayIcon,
  TerminalIcon,
  WorldmapIcon,
} from "@dynatrace/strato-icons";

export type Tone = "primary" | "neutral" | "warning" | "critical" | "info";
export type IconType = React.ComponentType<Record<string, unknown>>;

export interface TaskKind {
  /** Coarse category, used for grouping / filtering. */
  kind:
    | "interaction"
    | "llm"
    | "tool"
    | "execution"
    | "blocked"
    | "agent"
    | "embeddings"
    | "other";
  /** Human label for the node (e.g. the tool name or model). */
  label: string;
  Icon: IconType;
  tone: Tone;
}

/** Minimal span shape the classifier needs (subset of sessionSpansQuery fields). */
export interface SpanLike {
  name?: string | null;
  tool?: string | null;
  model?: string | null;
  genOp?: string | null;
  agent?: string | null;
}

/** Strip the OTel-style prefix from a Copilot span name ("execute_tool read_file" -> "read_file"). */
function afterPrefix(name: string, prefix: string): string {
  return name.slice(prefix.length).trim();
}

/** Pick an icon for a concrete tool name. */
export function toolIcon(toolRaw: string): IconType {
  const t = toolRaw.toLowerCase();
  if (/(bash|terminal|shell|command|run_in_terminal)/.test(t)) return TerminalIcon;
  if (/(read|view|cat|open)/.test(t)) return DocumentIcon;
  if (/(edit|write|patch|apply|create|replace|multiedit)/.test(t)) return EditIcon;
  if (/(todo|task_?list|plan)/.test(t)) return ListIcon;
  if (/(glob|grep|search|find|lookup)/.test(t)) return FilterIcon;
  if (/(web|fetch|url|http|browser)/.test(t)) return WorldmapIcon;
  if (/(embed|vector)/.test(t)) return DatabaseIcon;
  return CodeIcon;
}

export function classifySpan(span: SpanLike): TaskKind {
  const name = (span.name ?? "").trim();
  const genOp = (span.genOp ?? "").trim();

  // Claude Code native span types
  if (name === "claude_code.interaction") {
    return { kind: "interaction", label: "User prompt", Icon: AccountIcon, tone: "primary" };
  }
  if (name === "claude_code.llm_request") {
    return { kind: "llm", label: span.model || "LLM request", Icon: ChatIcon, tone: "info" };
  }
  if (name === "claude_code.tool.blocked_on_user") {
    return { kind: "blocked", label: "Awaiting approval", Icon: PauseIcon, tone: "warning" };
  }
  if (name === "claude_code.tool.execution") {
    return { kind: "execution", label: "Execution", Icon: PlayIcon, tone: "neutral" };
  }
  if (name === "claude_code.tool") {
    const tool = span.tool || "Tool";
    return { kind: "tool", label: tool, Icon: toolIcon(tool), tone: "neutral" };
  }

  // GitHub Copilot / OTel gen_ai span types (label carried in the span name)
  if (genOp === "chat" || name.startsWith("chat ")) {
    return { kind: "llm", label: span.model || afterPrefix(name, "chat ") || "chat", Icon: ChatIcon, tone: "info" };
  }
  if (genOp === "invoke_agent" || name.startsWith("invoke_agent ")) {
    return { kind: "agent", label: span.agent || afterPrefix(name, "invoke_agent ") || "agent", Icon: AgentIcon, tone: "primary" };
  }
  if (genOp === "execute_tool" || name.startsWith("execute_tool ")) {
    const tool = span.tool || afterPrefix(name, "execute_tool ") || "tool";
    return { kind: "tool", label: tool, Icon: toolIcon(tool), tone: "neutral" };
  }
  if (name.startsWith("embeddings")) {
    return { kind: "embeddings", label: afterPrefix(name, "embeddings") || "embeddings", Icon: DatabaseIcon, tone: "neutral" };
  }

  return { kind: "other", label: name || "span", Icon: CodeIcon, tone: "neutral" };
}
