// Skills & Tools tab: high-level view of which skills and tools developers use
// most, without drilling into individual traces. Each row opens a sheet listing
// the sessions that used it, deep-linking into the trace on the matching span.

import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { CodeIcon } from "@dynatrace/strato-icons";

import { Section } from "../components/Section";
import { QueryState } from "../components/QueryState";
import { toneColor, subduedText } from "../components/tokens";
import { useTimeframedDql, num } from "../data/useQuery";
import { fmtInt, fmtDuration, fmtTime } from "../data/normalize";
import { toolUsageQuery, toolSessionsQuery, skillLogsQuery } from "../data/queries";
import { toolIcon, type IconType } from "../data/taskKind";

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Client-side skill aggregation (skill name lives inside the tool_input JSON).
// ---------------------------------------------------------------------------

function extractSkill(toolInput: unknown): string | null {
  if (toolInput == null) return null;
  try {
    const p = JSON.parse(String(toolInput));
    const skill = p?.skill ?? p?.skill_name ?? p?.name;
    return typeof skill === "string" && skill ? skill : null;
  } catch {
    return null;
  }
}

function userOf(r: Rec): string {
  return String(r.name || r.email || "(unknown)");
}
function deptOf(r: Rec): string {
  const email = String(r.email ?? "").toLowerCase();
  if (email && !email.includes("@dynatrace.com")) return "Personal Account";
  return String(r.dept || "Unmapped / Pilot");
}

interface SkillRow {
  skill: string;
  calls: number;
  users: number;
  sessions: number;
  failures: number;
  lastSeen: string;
}

function aggregateSkills(logs: Rec[]): SkillRow[] {
  const acc = new Map<string, { calls: number; users: Set<string>; sessions: Set<string>; failures: number; lastSeen: number }>();
  for (const r of logs) {
    const skill = extractSkill(r.toolInput);
    if (!skill) continue;
    let a = acc.get(skill);
    if (!a) {
      a = { calls: 0, users: new Set(), sessions: new Set(), failures: 0, lastSeen: 0 };
      acc.set(skill, a);
    }
    a.calls += 1;
    a.users.add(userOf(r));
    a.sessions.add(String(r.sessionId ?? ""));
    if (r.success === false) a.failures += 1;
    const t = new Date(String(r.ts)).getTime();
    if (!Number.isNaN(t)) a.lastSeen = Math.max(a.lastSeen, t);
  }
  return [...acc.entries()]
    .map(([skill, a]) => ({
      skill,
      calls: a.calls,
      users: a.users.size,
      sessions: a.sessions.size,
      failures: a.failures,
      lastSeen: a.lastSeen ? new Date(a.lastSeen).toISOString() : "",
    }))
    .sort((x, y) => y.calls - x.calls);
}

interface SkillSession {
  sessionId: string;
  user: string;
  dept: string;
  calls: number;
  failures: number;
  lastSeen: string;
}

function skillSessions(logs: Rec[], skill: string): SkillSession[] {
  const acc = new Map<string, SkillSession>();
  for (const r of logs) {
    if (extractSkill(r.toolInput) !== skill) continue;
    const sessionId = String(r.sessionId ?? "");
    let s = acc.get(sessionId);
    if (!s) {
      s = { sessionId, user: userOf(r), dept: deptOf(r), calls: 0, failures: 0, lastSeen: "" };
      acc.set(sessionId, s);
    }
    s.calls += 1;
    if (r.success === false) s.failures += 1;
    const t = String(r.ts ?? "");
    if (t > s.lastSeen) s.lastSeen = t;
  }
  return [...acc.values()].sort((a, b) => b.calls - a.calls);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const Tools = () => {
  const toolUsage = useTimeframedDql(toolUsageQuery());
  const skillLogs = useTimeframedDql(skillLogsQuery());
  const [selected, setSelected] = useState<{ type: "tool" | "skill"; name: string } | null>(null);

  const skillLogRecords = (skillLogs.data?.records ?? []) as Rec[];
  const skills = useMemo(() => aggregateSkills(skillLogRecords), [skillLogRecords]);

  return (
    <Flex flexDirection="column" gap={20} padding={24} style={{ maxWidth: 1400, margin: "0 auto" }}>
      <Flex flexDirection="column" gap={2}>
        <Heading level={2} style={{ margin: 0 }}>Skills &amp; Tools</Heading>
        <Text style={{ color: subduedText }}>
          Which skills and tools your developers use most. Select a row to see the sessions using it.
        </Text>
      </Flex>

      <Section title="Skills" subtitle="Agent skills invoked via the Skill tool (Claude Code).">
        <QueryState result={skillLogs} minHeight={80} empty={<Text style={{ color: subduedText }}>No skill invocations in this timeframe.</Text>}>
          {() =>
            skills.length === 0 ? (
              <Text style={{ color: subduedText }}>No skill invocations in this timeframe.</Text>
            ) : (
              <UsageTable
                rows={skills.map((s) => ({
                  name: s.skill,
                  Icon: CodeIcon,
                  calls: s.calls,
                  users: s.users,
                  sessions: s.sessions,
                  failures: s.failures,
                  avgMs: null,
                  lastSeen: s.lastSeen,
                }))}
                onSelect={(name) => setSelected({ type: "skill", name })}
              />
            )
          }
        </QueryState>
      </Section>

      <Section title="Tools" subtitle="Tool calls across Claude Code and GitHub Copilot.">
        <QueryState result={toolUsage} minHeight={120} empty={<Text style={{ color: subduedText }}>No tool calls in this timeframe.</Text>}>
          {(records) => (
            <UsageTable
              rows={(records as Rec[]).map((r) => {
                const name = String(r.tool ?? "");
                return {
                  name,
                  Icon: toolIcon(name),
                  calls: num(r.calls),
                  users: num(r.users),
                  sessions: num(r.sessions),
                  failures: num(r.failures),
                  avgMs: num(r.avgMs),
                  lastSeen: String(r.lastSeen ?? ""),
                };
              })}
              onSelect={(name) => setSelected({ type: "tool", name })}
            />
          )}
        </QueryState>
      </Section>

      {selected?.type === "tool" && (
        <ToolSessionsSheet tool={selected.name} onDismiss={() => setSelected(null)} />
      )}
      {selected?.type === "skill" && (
        <SkillSessionsSheet
          skill={selected.name}
          sessions={skillSessions(skillLogRecords, selected.name)}
          onDismiss={() => setSelected(null)}
        />
      )}
    </Flex>
  );
};

// ---------------------------------------------------------------------------
// Ranked usage table
// ---------------------------------------------------------------------------

interface UsageRow {
  name: string;
  Icon: IconType;
  calls: number;
  users: number;
  sessions: number;
  failures: number;
  avgMs: number | null;
  lastSeen: string;
}

function UsageTable({ rows, onSelect }: { rows: UsageRow[]; onSelect: (name: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.calls));
  return (
    <Flex flexDirection="column" gap={0}>
      <Flex gap={8} padding={8} style={{ borderBottom: "1px solid var(--dt-colors-border-neutral-default, rgba(255,255,255,0.1))" }}>
        <Text style={{ flex: 1, fontSize: 11, color: subduedText, fontWeight: 600 }}>NAME</Text>
        <Text style={{ minWidth: 90, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>CALLS</Text>
        <Text style={{ minWidth: 70, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>USERS</Text>
        <Text style={{ minWidth: 80, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>SESSIONS</Text>
        <Text style={{ minWidth: 90, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>FAIL RATE</Text>
        <Text style={{ minWidth: 90, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>AVG</Text>
        <Text style={{ minWidth: 140, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>LAST USED</Text>
      </Flex>
      {rows.map((r) => {
        const failRate = r.calls > 0 ? r.failures / r.calls : 0;
        return (
          <Flex
            key={r.name}
            gap={8}
            padding={8}
            alignItems="center"
            onClick={() => onSelect(r.name)}
            style={{ borderBottom: "1px solid var(--dt-colors-border-neutral-default, rgba(255,255,255,0.06))", cursor: "pointer" }}
          >
            <Flex alignItems="center" gap={8} style={{ flex: 1, minWidth: 0 }}>
              <span style={{ color: subduedText, display: "flex" }}><r.Icon size={16} /></span>
              <Text style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</Text>
              {/* usage bar */}
              <div style={{ flex: 1, minWidth: 40, height: 4, background: "var(--dt-colors-background-container-neutral-default, rgba(0,0,0,0.06))", borderRadius: 2 }}>
                <div style={{ width: `${(r.calls / max) * 100}%`, height: "100%", background: toneColor("primary"), borderRadius: 2 }} />
              </div>
            </Flex>
            <Text style={{ minWidth: 90, textAlign: "right", fontWeight: 600 }}>{fmtInt(r.calls)}</Text>
            <Text style={{ minWidth: 70, textAlign: "right", color: subduedText }}>{fmtInt(r.users)}</Text>
            <Text style={{ minWidth: 80, textAlign: "right", color: subduedText }}>{fmtInt(r.sessions)}</Text>
            <Text style={{ minWidth: 90, textAlign: "right", color: failRate > 0 ? toneColor("critical") : subduedText }}>
              {r.failures > 0 ? `${(failRate * 100).toFixed(0)}%` : "—"}
            </Text>
            <Text style={{ minWidth: 90, textAlign: "right", color: subduedText }}>{r.avgMs != null && r.avgMs > 0 ? fmtDuration(r.avgMs) : "—"}</Text>
            <Text style={{ minWidth: 140, textAlign: "right", color: subduedText, fontSize: 12, whiteSpace: "nowrap" }}>{r.lastSeen ? fmtTime(r.lastSeen) : "—"}</Text>
          </Flex>
        );
      })}
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Drill-down sheets: the sessions that used a given tool / skill.
// ---------------------------------------------------------------------------

function SessionsSheet({
  title,
  highlight,
  rows,
  loading,
  onDismiss,
}: {
  title: string;
  highlight: string;
  rows: Array<{ sessionId: string; user: string; dept: string; calls: number; failures: number; lastSeen: string }>;
  loading: boolean;
  onDismiss: () => void;
}) {
  return (
    <Sheet show onDismiss={onDismiss} title={title} actions={<Button onClick={onDismiss}>Close</Button>} style={{ width: "70vw" }}>
      <Flex flexDirection="column" gap={4} style={{ paddingBottom: 24 }}>
        {loading && rows.length === 0 ? (
          <Flex justifyContent="center" padding={32}><ProgressCircle aria-label="Loading" /></Flex>
        ) : rows.length === 0 ? (
          <Text style={{ color: subduedText }}>No sessions found in this timeframe.</Text>
        ) : (
          <Flex flexDirection="column" gap={0}>
            <Flex gap={8} padding={8} style={{ borderBottom: "1px solid var(--dt-colors-border-neutral-default, rgba(255,255,255,0.1))" }}>
              <Text style={{ minWidth: 200, fontSize: 11, color: subduedText, fontWeight: 600 }}>USER</Text>
              <Text style={{ minWidth: 140, fontSize: 11, color: subduedText, fontWeight: 600 }}>DEPT</Text>
              <Text style={{ minWidth: 70, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>CALLS</Text>
              <Text style={{ flex: 1, fontSize: 11, color: subduedText, fontWeight: 600 }}>SESSION</Text>
              <Text style={{ minWidth: 140, fontSize: 11, color: subduedText, fontWeight: 600, textAlign: "right" }}>LAST USED</Text>
            </Flex>
            {rows.map((r) => (
              <Link
                key={r.sessionId}
                to={`/sessions?session=${encodeURIComponent(r.sessionId)}&highlight=${encodeURIComponent(highlight)}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <Flex gap={8} padding={8} alignItems="center" style={{ borderBottom: "1px solid var(--dt-colors-border-neutral-default, rgba(255,255,255,0.06))", cursor: "pointer" }}>
                  <Text style={{ minWidth: 200, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.user}</Text>
                  <Text style={{ minWidth: 140, fontSize: 12, color: subduedText, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.dept}</Text>
                  <Text style={{ minWidth: 70, fontSize: 12, fontWeight: 600, textAlign: "right", color: r.failures > 0 ? toneColor("critical") : "inherit" }}>{fmtInt(r.calls)}</Text>
                  <Text style={{ flex: 1, fontSize: 12, fontFamily: "monospace", color: subduedText }}>{r.sessionId.slice(0, 8)}</Text>
                  <Text style={{ minWidth: 140, fontSize: 12, color: subduedText, textAlign: "right", whiteSpace: "nowrap" }}>{r.lastSeen ? fmtTime(r.lastSeen) : "—"}</Text>
                </Flex>
              </Link>
            ))}
          </Flex>
        )}
      </Flex>
    </Sheet>
  );
}

function ToolSessionsSheet({ tool, onDismiss }: { tool: string; onDismiss: () => void }) {
  const detail = useTimeframedDql(toolSessionsQuery(tool));
  const rows = ((detail.data?.records ?? []) as Rec[]).map((r) => ({
    sessionId: String(r.sessionId ?? ""),
    user: String(r.user ?? "(unknown)"),
    dept: String(r.dept ?? ""),
    calls: num(r.calls),
    failures: num(r.failures),
    lastSeen: String(r.lastSeen ?? ""),
  }));
  return (
    <SessionsSheet
      title={`Tool · ${tool}`}
      highlight={`tool:${tool}`}
      rows={rows}
      loading={detail.isLoading}
      onDismiss={onDismiss}
    />
  );
}

function SkillSessionsSheet({
  skill,
  sessions,
  onDismiss,
}: {
  skill: string;
  sessions: SkillSession[];
  onDismiss: () => void;
}) {
  return (
    <SessionsSheet
      title={`Skill · ${skill}`}
      highlight={`skill:${skill}`}
      rows={sessions}
      loading={false}
      onDismiss={onDismiss}
    />
  );
}
