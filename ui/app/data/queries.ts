// DQL query builders. Every builder composes `base()` from normalize.ts so all
// tokens/cost/assistant/department fields are computed identically. Timeframe is
// NOT embedded here — it is supplied per-call by `useDql` via
// defaultTimeframeStart/defaultTimeframeEnd (see data/timeframe.tsx).

import { base } from "./normalize";

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

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One row per session. `extraFilter` (a bare DQL predicate) scopes it, e.g. `uid == "x"`. */
export function sessionsQuery(extraFilter?: string): string {
  const flt = extraFilter ? `\n| filter ${extraFilter}` : "";
  return `${base()}${flt}
| summarize {
    assistant = takeFirst(assistant),
    user = takeFirst(coalesce(user.name, user.email, "(unknown)")),
    uid = takeFirst(uid),
    dept = takeFirst(dept),
    start = min(start_time), end = max(end_time),
    interactions = countIf(is_interaction),
    llm = countIf(is_llm),
    tools = countIf(is_tool),
    blocked = countIf(is_blocked),
    errors = countIf(is_llm and success == false),
    inTok = sum(toLong(inp)), outTok = sum(toLong(outp)),
    crTok = sum(toLong(cr)), ccTok = sum(toLong(cc)),
    cost = sum(cost)
  }, by:{\`session.id\`}
| fieldsRename sessionId = \`session.id\`
| sort start desc
| limit 1000`;
}

/** All spans in one session, flattened — the client rebuilds the tree from parent/id. */
export function sessionSpansQuery(sessionId: string): string {
  return `${base()}
| filter \`session.id\` == "${q(sessionId)}"
| fields
    spanId = span.id, parent = span.parent_id, name = span.name,
    tool = tool_name, cmd = full_command, args = gen_ai.tool.call.arguments,
    toolUseId = coalesce(tool_use_id, gen_ai.tool.call.id), model,
    inTok = toLong(inp), outTok = toLong(outp), crTok = toLong(cr), ccTok = toLong(cc), cost,
    ttft = ttft_ms, success, attempt,
    seq = interaction.sequence, prompt = user_prompt, promptLen = user_prompt_length,
    durMs = coalesce(duration_ms, interaction.duration_ms),
    start = start_time, end = end_time, traceId = toString(trace.id),
    assistant, genOp = gen_ai.operation.name, agent = gen_ai.agent.name,
    repo = github.copilot.git.repository, branch = github.copilot.git.branch
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

export function securityByDeptQuery(): string {
  return `${base()}
| fieldsAdd
    is_terminal = (gen_ai.tool.name == "run_in_terminal" or tool_name == "Bash"),
    cmd_args = lower(coalesce(gen_ai.tool.call.arguments, full_command, "")),
    req_lower = if(isNotNull(copilot_chat.user_request), lower(copilot_chat.user_request), else: "")
| parse req_lower, "LD 'ghp_' (ALNUM{30,40}:ghK) LD"
| parse req_lower, "LD 'sk-' (ALNUM{40,}:oaK) LD"
| parse req_lower, "LD 'akia' (ALNUM{16}:awsK) LD"
| fieldsAdd
    flag_secret = (req_lower != "" and (isNotNull(ghK) or isNotNull(oaK) or isNotNull(awsK) or contains(req_lower, "sk-ant-api03-") or (contains(req_lower, "-----begin") and contains(req_lower, "private key")))),
    flag_destr = (is_terminal and (matchesValue(cmd_args, "rm -rf*") or contains(cmd_args, "sudo rm -rf") or contains(cmd_args, "&& rm -rf") or contains(cmd_args, "; rm -rf") or matchesValue(cmd_args, "chmod 777*") or contains(cmd_args, "mkfs") or contains(cmd_args, "dd if="))),
    flag_cred = (contains(cmd_args, "id_rsa") or contains(cmd_args, "id_ed25519") or contains(cmd_args, ".pem") or contains(cmd_args, ".ssh/") or contains(cmd_args, ".aws/credentials") or contains(cmd_args, "private_key")),
    flag_jail = (req_lower != "" and (contains(req_lower, "ignore all previous instruction") or contains(req_lower, "reveal your system prompt") or contains(req_lower, "do anything now") or contains(req_lower, "bypass your"))),
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
    secrets: `(req_lower != "" and (isNotNull(ghK) or isNotNull(oaK) or isNotNull(awsK) or contains(req_lower, "sk-ant-api03-") or (contains(req_lower, "-----begin") and contains(req_lower, "private key"))))`,
    destructive: `(is_terminal and (matchesValue(cmd_args, "rm -rf*") or contains(cmd_args, "sudo rm -rf") or contains(cmd_args, "&& rm -rf") or contains(cmd_args, "; rm -rf") or matchesValue(cmd_args, "chmod 777*") or contains(cmd_args, "mkfs") or contains(cmd_args, "dd if=")))`,
    credential: `(contains(cmd_args, "id_rsa") or contains(cmd_args, "id_ed25519") or contains(cmd_args, ".pem") or contains(cmd_args, ".ssh/") or contains(cmd_args, ".aws/credentials") or contains(cmd_args, "private_key"))`,
    jailbreak: `(req_lower != "" and (contains(req_lower, "ignore all previous instruction") or contains(req_lower, "reveal your system prompt") or contains(req_lower, "do anything now") or contains(req_lower, "bypass your")))`,
    shadow: `(is_llm and is_personal)`,
  };
  // Extra context field per flag type
  const contextField: Record<string, string> = {
    secrets: `context = if(isNotNull(ghK), "GitHub token", else: if(isNotNull(oaK), "OpenAI key", else: if(isNotNull(awsK), "AWS key", else: "Secret pattern")))`,
    destructive: `context = coalesce(full_command, gen_ai.tool.call.arguments, "")`,
    credential: `context = coalesce(full_command, gen_ai.tool.call.arguments, "")`,
    jailbreak: `context = if(isNotNull(copilot_chat.user_request), substring(copilot_chat.user_request, from:0, to:120), else: "")`,
    shadow: `context = coalesce(user.email, user.name, "")`,
  };

  return `${base()}
| fieldsAdd
    is_terminal = (gen_ai.tool.name == "run_in_terminal" or tool_name == "Bash"),
    cmd_args = lower(coalesce(gen_ai.tool.call.arguments, full_command, "")),
    req_lower = if(isNotNull(copilot_chat.user_request), lower(copilot_chat.user_request), else: "")
| parse req_lower, "LD 'ghp_' (ALNUM{30,40}:ghK) LD"
| parse req_lower, "LD 'sk-' (ALNUM{40,}:oaK) LD"
| parse req_lower, "LD 'akia' (ALNUM{16}:awsK) LD"
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
