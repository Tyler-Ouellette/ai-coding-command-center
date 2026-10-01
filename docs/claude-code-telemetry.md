# Claude Code OpenTelemetry — Semantic Conventions

Reference for the telemetry Claude Code emits, so we don't have to re-derive it. This is the schema
this app queries out of Grail. Update it only when Anthropic changes the schema (or the probe below
reveals this tenant differs).

Source: https://code.claude.com/docs/en/monitoring-usage.md (captured 2026-09-30).

> **How this app ingests it today:** every query starts from `fetch spans` (services `claude-code`,
> `claude-code-desktop`, `copilot-chat`) or `fetch logs` (scope `com.anthropic.claude_code.events`).
> **Metrics (`fetch metric` / `timeseries`) are the only source for commits, PRs, lines-of-code and
> active time** — the app must query them separately from spans/logs. See `ui/app/data/normalize.ts`
> and `ui/app/data/queries.ts`.

---

## Metrics

Pattern: `claude_code.<domain>.<type>`. All carry the standard attributes below (incl. `session.id`
by default), so they can be grouped/joined by session.

| Metric | Type | Unit | Distinguishing attributes | Notes |
|---|---|---|---|---|
| `claude_code.session.count` | Counter | count | `start_type` (`fresh`/`resume`/`continue`/`agents_view`) | One per session start |
| `claude_code.lines_of_code.count` | Counter | count | **`type` (`added`/`removed`)**, `model` | Split added vs removed by `type` |
| `claude_code.pull_request.count` | Counter | count | — | PR/MR creations |
| `claude_code.commit.count` | Counter | count | — | Git commit creations |
| `claude_code.cost.usage` | Counter | USD | `model`, `query_source` (`main`/`subagent`/`auxiliary`), `speed`, `effort`, `agent.name`*, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name` | Per API request |
| `claude_code.token.usage` | Counter | tokens | **`type` (`input`/`output`/`cacheRead`/`cacheCreation`)**, `model`, `query_source`, … | Per API request |
| `claude_code.code_edit_tool.decision` | Counter | count | **`tool_name` (`Edit`/`Write`/`NotebookEdit`)**, **`decision` (`accept`/`reject`)**, `source` (`config`/`hook`/`user_permanent`/`user_temporary`/`user_abort`/`user_reject`), `language` | Accepted edits = filter `decision=="accept"` |
| `claude_code.active_time.total` | Counter/Gauge | s (seconds) | **`type` (`user` = keyboard, `cli` = tool execution)** | Real interactive time, **not** wall-clock elapsed |

\* names like `agent.name`/`skill.name`/`mcp_*` are redacted unless `OTEL_LOG_TOOL_DETAILS=1`.

**Cost/tokens caveat:** this app's cost is derived from *span* token counts via its own per-model
rate model (`normalize.ts`), to match the "AI Coding Assistants — Executive View" dashboard. The
`claude_code.cost.usage` / `token.usage` metrics are an independent source; don't mix the two without
reconciling.

---

## Standard attributes (on all metrics + events)

| Attribute | Present by default | Env control |
|---|---|---|
| `session.id` | ✅ yes | `OTEL_METRICS_INCLUDE_SESSION_ID` (default true) |
| `user.id` | ✅ (anonymous persistent id) | always |
| `user.email` | ✅ (when available) | always |
| `user.account_uuid`, `user.account_id` | ✅ | `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` (default true) |
| `organization.id` | ✅ (when available) | always |
| `terminal.type` | ✅ (when detected) | always |
| `app.version` | ❌ | `OTEL_METRICS_INCLUDE_VERSION` (default false) |
| `app.entrypoint` | ❌ | `OTEL_METRICS_INCLUDE_ENTRYPOINT` (default false) |
| `vcs.repository.url.full`, `vcs.repository.name`, `vcs.owner.name`, `vcs.provider.name` | ❌ | `OTEL_METRICS_INCLUDE_REPOSITORY` (default false, v2.1.269+) |

`session.id` on by default is what makes per-session grouping/joining possible.

---

## Events / logs (scope `com.anthropic.claude_code.events`)

| Event | Key attributes | Notes |
|---|---|---|
| `user_prompt` | `prompt_length`, `prompt`*, `command_name`, `message.uuid` | `prompt` text only with `OTEL_LOG_USER_PROMPTS=1` |
| `assistant_response` | `response_length`, `response`*, `model`, `query_source` | v2.1.193+; text only with `OTEL_LOG_ASSISTANT_RESPONSES=1` |
| `api_request` | `model`, `cost_usd`, `input_tokens`, `output_tokens`, `duration_ms`, `speed`, `effort` | Per API call |
| `api_error` / `api_refusal` | error/refusal details | |
| `tool_decision` | `tool_name`, `decision` (`accept`/`reject`), `source`, `tool_use_id` | Alt source for accepted-edits (all tools, not just Edit/Write) |
| `tool_result` | `tool_name`, `tool_use_id`, `success` (`"true"`/`"false"`), `duration_ms`, `error_type`, `tool_input`, size bytes | App already queries this (tool inputs) |
| `permission_mode_changed`, `auth`, `mcp_server_connection`, `plugin_installed`/`plugin_loaded`, `skill_activated`, `hook_*`, `at_mention`, `managed_settings_resolved` | see docs | lifecycle events |

Correlation attributes on events: `prompt.id` (links all events from one prompt),
`event.sequence`, `request_id`, `client_request_id`, `message.uuid`, `tool_use_id`
(links `tool_decision` ↔ `tool_result`).

> **⚠️ Observed naming (this tenant):** docs prefix event names (`claude_code.tool_result`), but this
> app matches `event.name == "tool_result"` **unprefixed** (`queries.ts`) and it works. Treat the
> unprefixed form as authoritative here until the probe proves otherwise.

---

## Enabling export (env vars)

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1          # required; enables all telemetry
OTEL_METRICS_EXPORTER=otlp              # otlp | prometheus | console | none
OTEL_LOGS_EXPORTER=otlp                 # otlp | console | none   (separate from metrics)
OTEL_EXPORTER_OTLP_ENDPOINT=...         # collector endpoint
OTEL_EXPORTER_OTLP_HEADERS="Authorization=..."
OTEL_METRIC_EXPORT_INTERVAL=60000       # ms (default)
OTEL_LOGS_EXPORT_INTERVAL=5000          # ms (default)
# cardinality / content opt-ins (defaults noted above): OTEL_METRICS_INCLUDE_*, OTEL_LOG_*
```

Metrics and logs are **separate exporters** — a tenant can have one without the other. That's why
this app builds span/log fallbacks for anything that would otherwise depend on metrics.

---

## Validated against this tenant (dtctl, 2026-09-30, joh43990.sprint, 30-day window)

- **Metrics ARE ingested**, and `session.id` is a real dimension you can group by:
  `claude_code.commit.count` (30), `lines_of_code.count` (14,762; split by `type`),
  `code_edit_tool.decision` (612; split by `decision`), `active_time.total` (110,897 s),
  `token.usage` (1.2B), `cost.usage` ($789). Query metrics with the **`timeseries`** command
  (`fetch metric` is not how you read them); scalar-per-session = `arraySum()` over the series array.
- **`claude_code.pull_request.count` has NO data** here (no PR was created) — the metric key is
  effectively absent.
- **Events** (unprefixed `event.name`, confirming the naming note): `tool_decision` (3,368),
  `tool_result` (3,346), `api_request`, `assistant_response`, `user_prompt`, `hook_*`,
  `mcp_server_connection`, `skill_activated`, `permission_mode_changed`, `managed_settings_resolved`, …
- **Cross-check:** span-derived `edits` (count of Edit/Write/… tool spans) equals the metric
  `code_edit_tool.decision{decision=accept}` for the same session — good agreement between the
  fallback and the primary.

### ⚠️ Gotcha: multi-aggregate `timeseries` collapses on any empty series

A single `timeseries { a = sum(m1), b = sum(m2) }, by:{…}` returns **zero rows** if *any* aggregate
has no series in the window — whether the metric key is absent (`pull_request.count`) **or** a
`filter:` matches nothing (e.g. `decision == "accept"` in a window with only rejects). It's an inner
join across the aggregates. So `sessionOutcomesQuery` emits **one single-aggregate `timeseries` per
metric, unioned with `append`** (long form `sessionId, metric, value`, pivoted client-side in
outcomes.ts). An empty metric then just contributes no rows instead of nulling everything.

### Probe queries

```dql
// Metrics ingested + session.id as a dimension:
timeseries c = sum(claude_code.commit.count), by:{ `session.id` }, from:now()-7d
// repeat per metric: pull_request.count, lines_of_code.count (filter type), code_edit_tool.decision (filter decision), active_time.total

// Events present (is tool_decision alongside tool_result?):
fetch logs, from:now()-7d
| filter otel.scope.name == "com.anthropic.claude_code.events"
| summarize count(), by:{ event.name }
```

**If metrics are absent** in some tenant, the app falls back to span-derived signals on
`sessionsQuery`: `edits` (Edit/Write/… tool spans) and `activeMin` (distinct 1-min buckets of span
`start_time`). PR count and exact lines-changed have no fallback — shown as "–".

---

## Version notes

- `assistant_response` event: v2.1.193+
- `vcs.*` attributes: v2.1.269+
- `managed_settings_resolved` event: v2.1.274+
