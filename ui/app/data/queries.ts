// DQL query builders. Every builder composes `base()` from normalize.ts so all
// tokens/cost/assistant/department fields are computed identically. Timeframe is
// NOT embedded here — it is supplied per-call by `useDql` via
// defaultTimeframeStart/defaultTimeframeEnd (see data/timeframe.tsx).

import { base } from "./normalize";
import {
  SECRET_PATTERNS,
  CREDENTIAL_PATTERNS,
  DESTRUCTIVE_PATTERNS,
  JAILBREAK_PATTERNS,
  dqlMatchesAny,
  dqlContextLabelExpr,
} from "./securityPatterns";
import { getOpusTrivialOutputTokens } from "./config";

/** Escape a value interpolated into a DQL double-quoted string literal. */
function q(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Cache-read tokens would have cost the full "fresh input" rate had they not
// been cached; the delta is the realized cache saving.
const SAVINGS_EXPR = `if(contains(model,"opus"), toDouble(cr)*13.5/1000000,
    else: if(contains(model,"sonnet"), toDouble(cr)*2.7/1000000,
    else: if(contains(model,"gpt-4o-mini"), toDouble(cr)*0.075/1000000, else: 0.0)))`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function overviewKpisQuery(): string {
  return `${base()}
| fieldsAdd savings = ${SAVINGS_EXPR}
| summarize {
    users = countDistinct(uid),
    sessions = countDistinct(\`session.id\`),
    chats = countIf(is_llm),
    interactions = countIf(is_interaction),
    tools = countIf(is_tool),
    blocked = countIf(is_blocked),
    errors = countIf(is_llm and success == false),
    inTok = sum(toLong(inp)), outTok = sum(toLong(outp)),
    crTok = sum(toLong(cr)), ccTok = sum(toLong(cc)),
    cost = sum(cost),
    savings = sum(savings),
    avgInteractionMs = avg(interaction.duration_ms)
  }`;
}

export function spendTimeseriesQuery(): string {
  return `${base()}
| filter is_llm == true
| makeTimeseries spend = sum(cost), by:{assistant}`;
}

export function modelSpendQuery(): string {
  return `${base()}
| filter is_llm == true and model != ""
| summarize spend = sum(cost), chats = count(), tokens = sum(toLong(inp) + toLong(outp)), by:{model}
| sort spend desc`;
}

// What an Opus call would have cost at Sonnet rates, given the same token
// counts. Mirrors the Sonnet branch of COST_EXPR in normalize.ts — kept as its
// own expression (rather than exported from there) since every query here
// defines its rate math inline (see SAVINGS_EXPR above).
const SONNET_RATE_EXPR = `toDouble(fresh)*3.0/1000000 + toDouble(cr)*0.3/1000000 + toDouble(cc)*3.75/1000000 + toDouble(outp)*15.0/1000000`;

/** Shared right-sizing filter/fields: Opus calls that succeeded, flagged "trivial"
 *  when output tokens are under the configured threshold. */
function rightSizingPrelude(): string {
  const threshold = getOpusTrivialOutputTokens();
  return `${base()}
| filter is_llm == true and contains(model, "opus") and success == true
| fieldsAdd isTrivial = toLong(outp) < ${threshold}, sonnetCost = ${SONNET_RATE_EXPR}
| fieldsAdd savingsIfSonnet = cost - sonnetCost`;
}

/** Scalar summary for the "Model right-sizing" optimization card: how many
 *  Opus turns had a trivial (small) output, and what they'd have cost at
 *  Sonnet rates. An estimate — a small output doesn't prove Opus wasn't
 *  needed, only that this is worth a look. */
export function modelRightSizingQuery(): string {
  return `${rightSizingPrelude()}
| summarize {
    trivialTurns = countIf(isTrivial),
    totalOpusTurns = count(),
    savings = sum(if(isTrivial, savingsIfSonnet, else: 0.0))
  }`;
}

/** Per-session breakdown of trivial-output Opus turns, for the detail sheet. */
export function modelRightSizingDetailQuery(): string {
  return `${rightSizingPrelude()}
| summarize {
    user = takeFirst(coalesce(user.name, user.email, "(unknown)")),
    dept = takeFirst(dept),
    trivialTurns = countIf(isTrivial),
    spend = sum(cost),
    savings = sum(if(isTrivial, savingsIfSonnet, else: 0.0)),
    lastSeen = max(start_time)
  }, by:{\`session.id\`}
| fieldsRename sessionId = \`session.id\`
| filter trivialTurns > 0
| sort savings desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One row per session. `extraFilter` (a bare DQL predicate) scopes it, e.g. `uid == "x"`.
 *  `edits` (successful edit-type tool calls) and `activeMin` (distinct 1-minute buckets that
 *  contain a span) are span-derived fallbacks: `edits` backstops the "nothing shipped" flag when
 *  outcome metrics are absent, `activeMin` backstops active-time when `active_time.total` is absent.
 *  See sessionOutcomesQuery() for the metric-backed primary source. */
export function sessionsQuery(extraFilter?: string): string {
  const flt = extraFilter ? `\n| filter ${extraFilter}` : "";
  return `${base()}${flt}
| fieldsAdd editTool = ${TOOL_NAME_EXPR}, minuteBucket = bin(start_time, 1m)
| summarize {
    assistant = takeFirst(assistant),
    user = takeFirst(coalesce(user.name, user.email, "(unknown)")),
    uid = takeFirst(uid),
    dept = takeFirst(dept),
    repo = takeFirst(github.copilot.git.repository),
    start = min(start_time), end = max(end_time),
    activeMin = countDistinct(minuteBucket),
    interactions = countIf(is_interaction),
    llm = countIf(is_llm),
    tools = countIf(is_tool),
    edits = countIf(is_tool and in(editTool, array("Edit","Write","MultiEdit","NotebookEdit","insert_edit_into_file","create_file","apply_patch","str_replace_editor"))),
    blocked = countIf(is_blocked),
    errors = countIf(is_llm and success == false),
    shadow = countIf(is_llm and is_personal),
    toolNames = collectDistinct(coalesce(tool_name, \`tool.name\`)),
    prompts = collectDistinct(coalesce(user_prompt, \`prompt.preview\`)),
    inTok = sum(toLong(inp)), outTok = sum(toLong(outp)),
    crTok = sum(toLong(cr)), ccTok = sum(toLong(cc)),
    cost = sum(cost)
  }, by:{\`session.id\`}
| fieldsRename sessionId = \`session.id\`
| sort start desc
| limit 1000`;
}

/**
 * Metric-backed per-session outcomes (commits, PRs, lines changed, accepted edits, active time).
 * These live ONLY in Claude Code's `claude_code.*` OTel metrics — never on spans/logs — so this is
 * the sole source for them. Validated against the tenant with dtctl.
 *
 * Returned in LONG form — one row per (sessionId, metric, value) — and pivoted to per-session
 * objects by outcomeMap() in ui/app/data/outcomes.ts. The long/append shape is deliberate: a single
 * multi-aggregate `timeseries { a=…, b=… }` collapses to ZERO rows if ANY aggregate has no series in
 * the window (verified: `pull_request.count` when no PR was opened, or a filter matching nothing,
 * nulls out the entire result). Emitting each metric as its own single-aggregate `timeseries` and
 * unioning them with `append` avoids that — an empty metric just contributes no rows. `arraySum`
 * collapses each per-bucket timeseries array to a scalar total across the app-injected timeframe.
 *
 * If no `claude_code.*` metrics are ingested, this returns zero rows and callers fall back to the
 * span-derived signals on sessionsQuery (`edits`, `activeMin`). See docs/claude-code-telemetry.md.
 */
export function sessionOutcomesQuery(sessionId?: string): string {
  const branch = (label: string, agg: string) =>
    `timeseries v = ${agg}, by:{ \`session.id\` }\n` +
    `| fieldsAdd v = arraySum(v), metric = "${label}"\n` +
    `| fields sessionId = \`session.id\`, metric, v`;
  const branches = [
    branch("commits", "sum(claude_code.commit.count)"),
    branch("prs", "sum(claude_code.pull_request.count)"),
    branch("activeSec", "sum(claude_code.active_time.total)"),
    branch("linesAdded", `sum(claude_code.lines_of_code.count, filter: { type == "added" })`),
    branch("linesRemoved", `sum(claude_code.lines_of_code.count, filter: { type == "removed" })`),
    branch("editsAccepted", `sum(claude_code.code_edit_tool.decision, filter: { decision == "accept" })`),
  ];
  const scope = sessionId ? `\n| filter sessionId == "${q(sessionId)}"` : "";
  return (
    branches[0] +
    "\n" +
    branches
      .slice(1)
      .map((b) => `| append [ ${b} ]`)
      .join("\n") +
    `\n| filter isNotNull(v) and v > 0${scope}\n| limit 6000`
  );
}

/**
 * Metric-backed per-user outcome totals (commits, PRs, lines changed, accepted edits).
 * Same append/long-form pattern as sessionOutcomesQuery but grouped by `user.email` so
 * results join onto the user rows' `uid` / `email` fields. Returns zero rows when no
 * `claude_code.*` metrics are ingested; callers should gate metric-only columns with
 * outcomesAvailable().
 */
export function userOutcomesQuery(): string {
  const branch = (label: string, agg: string) =>
    `timeseries v = ${agg}, by:{ \`user.email\` }\n` +
    `| fieldsAdd v = arraySum(v), metric = "${label}"\n` +
    `| fields uid = \`user.email\`, metric, v`;
  const branches = [
    branch("commits", "sum(claude_code.commit.count)"),
    branch("prs", "sum(claude_code.pull_request.count)"),
    branch("linesAdded", `sum(claude_code.lines_of_code.count, filter: { type == "added" })`),
    branch("linesRemoved", `sum(claude_code.lines_of_code.count, filter: { type == "removed" })`),
    branch("editsAccepted", `sum(claude_code.code_edit_tool.decision, filter: { decision == "accept" })`),
  ];
  return (
    branches[0] +
    "\n" +
    branches
      .slice(1)
      .map((b) => `| append [ ${b} ]`)
      .join("\n") +
    `\n| filter isNotNull(v) and v > 0\n| limit 3000`
  );
}

/** All spans in one session, flattened — the client rebuilds the tree from parent/id. */
export function sessionSpansQuery(sessionId: string): string {
  return `${base()}
| filter \`session.id\` == "${q(sessionId)}"
| fields
    spanId = span.id, parent = span.parent_id, name = span.name,
    tool = coalesce(tool_name, \`tool.name\`), cmd = full_command, args = gen_ai.tool.call.arguments,
    toolOutputPreview = \`tool.output.preview\`,
    toolUseId = coalesce(tool_use_id, gen_ai.tool.call.id), model,
    inTok = toLong(inp), outTok = toLong(outp), crTok = toLong(cr), ccTok = toLong(cc), cost,
    ttft = ttft_ms, success, attempt,
    seq = interaction.sequence, prompt = coalesce(user_prompt, \`prompt.preview\`), promptLen = user_prompt_length,
    userRequest = copilot_chat.user_request,
    durMs = coalesce(duration_ms, interaction.duration_ms),
    start = start_time, end = end_time, traceId = toString(trace.id),
    assistant, genOp = gen_ai.operation.name, agent = gen_ai.agent.name,
    repo = github.copilot.git.repository, branch = github.copilot.git.branch,
    is_llm, is_personal
| sort start asc
| limit 5000`;
}

/**
 * The downstream spans of a distributed trace that belong to instrumented
 * services OTHER than the coding assistant — e.g. an MCP server and its HTTP
 * calls. They share the assistant's `trace.id` (a `uid`, so compared via
 * `toUid`), linked to the tool's `tool.execution` span by `span.parent_id`.
 */
export function downstreamTraceQuery(traceId: string): string {
  return `fetch spans
| filter trace.id == toUid("${q(traceId)}")
    and not in(service.name, array("claude-code", "claude-code-desktop", "copilot-chat"))
| fields service = service.name, name = span.name, spanId = span.id, parent = span.parent_id,
    durMs = toDouble(duration) / 1000000.0, start = start_time, status = span.status_code
| sort start asc
| limit 500`;
}

/**
 * Claude Code records the actual tool inputs (command, file path, WebFetch URL,
 * …) only in its `tool_result` log events — not on the spans. This fetches them
 * for one session, keyed by tool_use_id, so the span detail panel can show them.
 */
export function sessionToolInputsQuery(sessionId: string): string {
  return `fetch logs
| filter otel.scope.name == "com.anthropic.claude_code.events"
    and \`session.id\` == "${q(sessionId)}"
    and event.name == "tool_result"
    and isNotNull(tool_input)
| fields toolUseId = tool_use_id, toolInput = tool_input, tool = tool_name,
    success = success, durMs = duration_ms
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Skills & Tools
// ---------------------------------------------------------------------------

/** Normalized tool name: Claude Code carries it in `tool_name`; Copilot puts it
 *  in the span name after an `execute_tool ` prefix. */
const TOOL_NAME_EXPR = `if(isNotNull(tool_name) and tool_name != "", tool_name,
    else: trim(replaceString(span.name, "execute_tool ", "")))`;

/** One row per tool across all sessions — the "which tools are used most" table. */
export function toolUsageQuery(): string {
  return `${base()}
| filter is_tool == true
| fieldsAdd toolName = ${TOOL_NAME_EXPR}
| filter toolName != "" and toolName != "Skill"
| summarize {
    calls = count(),
    users = countDistinct(uid),
    sessions = countDistinct(\`session.id\`),
    failures = countIf(success == false),
    avgMs = avg(coalesce(duration_ms, toDouble(duration) / 1000000.0)),
    lastSeen = max(start_time)
  }, by:{ tool = toolName }
| sort calls desc
| limit 100`;
}

/** Sessions that used one specific tool, for the drill-down sheet. */
export function toolSessionsQuery(tool: string): string {
  return `${base()}
| filter is_tool == true
| fieldsAdd toolName = ${TOOL_NAME_EXPR}
| filter toolName == "${q(tool)}"
| summarize {
    calls = count(),
    failures = countIf(success == false),
    user = takeFirst(coalesce(user.name, user.email, "(unknown)")),
    dept = takeFirst(dept),
    lastSeen = max(start_time)
  }, by:{ sessionId = \`session.id\`, uid }
| sort calls desc
| limit 200`;
}

/** Raw Skill invocations (Claude Code `Skill` tool). The skill name lives inside
 *  the `tool_input` JSON, so callers parse and aggregate it client-side. */
export function skillLogsQuery(): string {
  return `fetch logs
| filter otel.scope.name == "com.anthropic.claude_code.events"
    and event.name == "tool_result"
    and tool_name == "Skill"
    and isNotNull(tool_input)
| fields toolInput = tool_input, sessionId = \`session.id\`,
    email = user.email, name = user.name, dept = user.department,
    success = success, ts = timestamp
| sort ts desc
| limit 5000`;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function usersQuery(): string {
  return `${base()}
| summarize {
    user = takeFirst(coalesce(user.name, user.email, "(unknown)")),
    email = takeFirst(user.email),
    dept = takeFirst(dept),
    claudeChats = countIf(assistant == "Claude Code" and is_llm),
    copilotChats = countIf(assistant == "GitHub Copilot" and is_llm),
    sessions = countDistinct(\`session.id\`),
    interactions = countIf(is_interaction),
    llm = countIf(is_llm),
    tools = countIf(is_tool),
    inTok = sum(toLong(inp)), outTok = sum(toLong(outp)), crTok = sum(toLong(cr)),
    cost = sum(cost),
    lastActive = max(start_time)
  }, by:{uid}
| sort cost desc
| limit 500`;
}

/** Per-department rollup for the Users tab header / grouping. */
export function departmentsQuery(): string {
  return `${base()}
| summarize {
    users = countDistinct(uid),
    sessions = countDistinct(\`session.id\`),
    chats = countIf(is_llm),
    cost = sum(cost)
  }, by:{dept}
| sort cost desc`;
}

// ----- user detail (used inside the Sheet; scoped by uid) -----

export function userSpendTsQuery(uid: string): string {
  return `${base()}
| filter uid == "${q(uid)}" and is_llm == true
| makeTimeseries spend = sum(cost), by:{assistant}`;
}

export function userModelMixQuery(uid: string): string {
  return `${base()}
| filter uid == "${q(uid)}" and is_llm == true and model != ""
| summarize chats = count(), tokens = sum(toLong(inp) + toLong(outp)), by:{model}
| sort chats desc`;
}

export function userToolMixQuery(uid: string): string {
  return `${base()}
| filter uid == "${q(uid)}" and is_tool == true
| fieldsAdd toolNm = coalesce(tool_name, gen_ai.tool.name, span.name)
| summarize calls = count(), by:{toolNm}
| sort calls desc
| limit 15`;
}

// ---------------------------------------------------------------------------
// Security strip (Overview) — condensed version of the reference dashboard's
// governance flags, per department.
// ---------------------------------------------------------------------------

// Shared `fieldsAdd` prelude for both security queries below: normalizes the
// tool-call/command text (`cmd_args`) and the prompt text across both
// assistants' fields (`req_lower`), then unions them into `hay_secret` so
// the secrets flag covers "any tool input or prompt chunk" per FEATURES.md,
// not just the prompt.
const SECURITY_PRELUDE = `
| fieldsAdd
    is_terminal = (gen_ai.tool.name == "run_in_terminal" or tool_name == "Bash"),
    cmd_args = lower(coalesce(gen_ai.tool.call.arguments, full_command, "")),
    req_lower = lower(coalesce(copilot_chat.user_request, user_prompt, \`prompt.preview\`, "")),
    hay_secret = concat(req_lower, "\\n", cmd_args)`;

export function securityByDeptQuery(): string {
  return `${base()}${SECURITY_PRELUDE}
| fieldsAdd
    flag_secret = ${dqlMatchesAny("hay_secret", SECRET_PATTERNS)},
    flag_destr = (is_terminal and ${dqlMatchesAny("cmd_args", DESTRUCTIVE_PATTERNS)}),
    flag_cred = ${dqlMatchesAny("cmd_args", CREDENTIAL_PATTERNS)},
    flag_jail = ${dqlMatchesAny("req_lower", JAILBREAK_PATTERNS)},
    flag_shadow = (is_llm and is_personal)
| summarize {
    secrets = countIf(flag_secret),
    destructive = countIf(flag_destr),
    credential = countIf(flag_cred),
    jailbreak = countIf(flag_jail),
    shadow = countIf(flag_shadow)
  }, by:{dept}
| fieldsAdd total = secrets + destructive + credential + jailbreak + shadow
| sort total desc`;
}

/** Per-session breakdown for a specific security flag. */
export function securityFlagDetailQuery(flagKey: "secrets" | "destructive" | "credential" | "jailbreak" | "shadow"): string {
  const flagExpr: Record<string, string> = {
    secrets: dqlMatchesAny("hay_secret", SECRET_PATTERNS),
    destructive: `(is_terminal and ${dqlMatchesAny("cmd_args", DESTRUCTIVE_PATTERNS)})`,
    credential: dqlMatchesAny("cmd_args", CREDENTIAL_PATTERNS),
    jailbreak: dqlMatchesAny("req_lower", JAILBREAK_PATTERNS),
    shadow: `(is_llm and is_personal)`,
  };
  // Extra context field per flag type. `secrets`/`credential` show which
  // pattern matched (a label, e.g. "GitHub token") rather than the raw
  // command/prompt text — echoing the raw text for `credential` would leak
  // the literal Authorization header/credential value the flag exists to
  // catch.
  const contextField: Record<string, string> = {
    secrets: `context = ${dqlContextLabelExpr("hay_secret", SECRET_PATTERNS, "Secret pattern")}`,
    destructive: `context = coalesce(full_command, gen_ai.tool.call.arguments, "")`,
    credential: `context = ${dqlContextLabelExpr("cmd_args", CREDENTIAL_PATTERNS, "Credential access")}`,
    jailbreak: `context = if(isNotNull(copilot_chat.user_request), substring(copilot_chat.user_request, from:0, to:120), else: "")`,
    shadow: `context = coalesce(user.email, user.name, "")`,
  };

  return `${base()}${SECURITY_PRELUDE}
| fieldsAdd flag = ${flagExpr[flagKey]}, ${contextField[flagKey]}
| filter flag == true
| summarize {
    hits = count(),
    context = takeFirst(context),
    lastSeen = max(start_time)
  }, by:{\`session.id\`, uid, dept}
| fieldsRename sessionId = \`session.id\`
| sort lastSeen desc
| limit 200`;
}

// ---------------------------------------------------------------------------
// Optimization recommendations — deterministic inefficiency signals.
//
// Tool inputs (commands, URLs, file paths) live as JSON: Claude Code records
// them in `tool_result` log events (`tool_input`); Copilot records them on the
// span (`gen_ai.tool.call.arguments`). These builders union both, extract the
// relevant field, and count exact repeats. "Repeat" = the same value used more
// than once — a redundant call that could be cached / scripted / avoided.
// ---------------------------------------------------------------------------

/** JSON field access on a parsed variant, with fallbacks. */
function jget(...keys: string[]): string {
  return `coalesce(${keys.map((k) => `j[\`${k}\`]`).join(", ")})`;
}

const CLAUDE_TOOL_LOGS = `fetch logs
| filter otel.scope.name == "com.anthropic.claude_code.events" and event.name == "tool_result" and isNotNull(tool_input)`;

const COPILOT_TOOL_SPANS = `fetch spans
| filter service.name == "copilot-chat" and gen_ai.operation.name == "execute_tool" and isNotNull(gen_ai.tool.call.arguments)`;

/**
 * Build a "repeated tool input" query. `extract` is the JSON accessor for the
 * value of interest; `claudeTools` / `copilotTools` restrict which tools count.
 */
function repeatedInputsQuery(opts: {
  extract: string;
  claudeTools: string[];
  copilotTools: string[];
  countName: string;
  extraFilter?: string;
}): string {
  const { extract, claudeTools, copilotTools, countName, extraFilter } = opts;
  const claudeIn = `in(tool_name, array(${claudeTools.map((t) => `"${t}"`).join(", ")}))`;
  const copilotIn = `in(span.name, array(${copilotTools.map((t) => `"${t}"`).join(", ")}))`;
  const who = `coalesce(user.email, user.name, "(unknown)")`;
  const flt = extraFilter ? ` and ${extraFilter}` : "";
  return `${CLAUDE_TOOL_LOGS} and ${claudeIn}
| parse tool_input, "JSON:j"
| fieldsAdd item = ${extract}, sid = \`session.id\`, who = ${who}
| fields item, sid, who
| append [
    ${COPILOT_TOOL_SPANS} and ${copilotIn}
    | parse gen_ai.tool.call.arguments, "JSON:j"
    | fieldsAdd item = ${extract}, sid = \`session.id\`, who = ${who}
    | fields item, sid, who
  ]
| filter isNotNull(item) and item != ""${flt}
| summarize ${countName} = count(), sessions = countDistinct(sid), users = countDistinct(who), by:{item}
| filter ${countName} > 1
| sort ${countName} desc
| limit 40`;
}

/** Same URL fetched more than once — cache candidates. */
export function repeatedFetchesQuery(): string {
  return repeatedInputsQuery({
    extract: jget("url", "uri"),
    claudeTools: ["WebFetch"],
    copilotTools: ["execute_tool open_browser_page", "execute_tool fetch_webpage", "execute_tool open_simple_browser"],
    countName: "fetches",
  });
}

/** Same shell command executed more than once — automation candidates. */
export function repeatedCommandsQuery(): string {
  return repeatedInputsQuery({
    extract: `trim(${jget("command", "commandLine")})`,
    claudeTools: ["Bash"],
    copilotTools: ["execute_tool run_in_terminal", "execute_tool Bash"],
    countName: "runs",
    // ignore trivial navigation / status noise
    extraFilter: `not (matchesValue(item, "cd *") or matchesValue(item, "ls*") or item == "pwd" or item == "clear" or matchesValue(item, "git status*"))`,
  });
}

/** Same file read more than once — context-inefficiency candidates. */
export function repeatedReadsQuery(): string {
  return repeatedInputsQuery({
    extract: jget("file_path", "filePath", "path"),
    claudeTools: ["Read"],
    copilotTools: ["execute_tool read_file", "execute_tool Read"],
    countName: "reads",
  });
}

/** Tool failure rate and LLM retry count — wasted cycles. */
export function toolHealthQuery(): string {
  return `${CLAUDE_TOOL_LOGS}
| summarize toolTotal = count(), toolFailures = countIf(success == "false")`;
}

export function toolFailureDetailQuery(): string {
  return `${CLAUDE_TOOL_LOGS}
| summarize total = count(), failures = countIf(success == "false"), sessions = countDistinct(\`session.id\`), by:{tool_name}
| fieldsAdd rate = round(toDouble(failures) / toDouble(total) * 100, decimals:1)
| filter failures > 0
| sort failures desc`;
}

export function llmRetryQuery(): string {
  return `fetch spans
| filter span.name == "claude_code.llm_request"
| summarize llmTotal = count(), retries = countIf(toLong(attempt) > 1)`;
}

export function llmRetryDetailQuery(): string {
  return `fetch spans
| filter span.name == "claude_code.llm_request" and toLong(attempt) > 1
| fieldsAdd who = coalesce(user.email, user.name, "(unknown)")
| summarize retries = count(), sessions = countDistinct(\`session.id\`), users = countDistinct(who), by:{model}
| sort retries desc`;
}

// Shadow AI (LLM calls from personal accounts). One row per session, since 371
// individual model calls collapse into a handful of sessions from personal users.
export function shadowAICallsQuery(): string {
  return `${base()}
| filter is_llm and is_personal
| summarize {
    user = takeFirst(coalesce(user.name, user.email, "(unknown)")),
    uid = takeFirst(uid),
    assistant = takeFirst(assistant),
    models = countDistinct(model),
    calls = count(),
    start = min(start_time), end = max(end_time),
    inTok = sum(toLong(inp)), outTok = sum(toLong(outp)),
    crTok = sum(toLong(cr)), ccTok = sum(toLong(cc)),
    cost = sum(cost)
  }, by:{\`session.id\`}
| fieldsRename sessionId = \`session.id\`
| sort calls desc
| limit 1000`;
}

export function shadowAIStatsQuery(): string {
  return `${base()}
| filter is_llm and is_personal
| summarize {
    totalCalls = count(),
    uniqueSessions = countDistinct(\`session.id\`),
    uniqueUsers = countDistinct(uid),
    totalCost = sum(cost),
    inTok = sum(toLong(inp)), outTok = sum(toLong(outp)),
    crTok = sum(toLong(cr)), ccTok = sum(toLong(cc))
  }`;
}
