// Users tab: a per-user table (sortable, filterable by department) with a
// department rollup strip. Clicking a user opens a right-side Sheet with detail.

import React, { useMemo, useState } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { DataTable } from "@dynatrace/strato-components/tables";
import { TextInput } from "@dynatrace/strato-components/forms";

import { StatTile } from "../components/StatTile";
import { Section } from "../components/Section";
import { QueryState } from "../components/QueryState";
import { subduedText } from "../components/tokens";
import { useTimeframedDql, num } from "../data/useQuery";
import { fmtInt, fmtTokens, fmtUSD, fmtTime } from "../data/normalize";
import { usersQuery, departmentsQuery, userOutcomesQuery } from "../data/queries";
import { mergeUserOutcomes, outcomesAvailable } from "../data/outcomes";
import { assistantBrandIcon, AnthropicIcon, CopilotIcon } from "../components/brandIcons";
import { CenterCell } from "../components/CenterCell";
import { FilterSelect } from "../components/FilterSelect";
import { UserDetail } from "./UserDetail";

function assistantMix(r: Record<string, unknown>): string {
  const c = num(r.claudeChats);
  const p = num(r.copilotChats);
  if (c > 0 && p > 0) return "Both";
  if (p > 0) return "Copilot";
  if (c > 0) return "Claude Code";
  return "—";
}

export const Users = () => {
  const users = useTimeframedDql(usersQuery());
  const depts = useTimeframedDql(departmentsQuery());
  const outcomes = useTimeframedDql(userOutcomesQuery());
  const [search, setSearch] = useState("");
  const [assistantFilter, setAssistantFilter] = useState<string>("all");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string>("");

  const allRows = useMemo(
    () => mergeUserOutcomes((users.data?.records ?? []) as Array<Record<string, unknown>>, outcomes),
    [users.data, outcomes.data],
  );
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (deptFilter !== "all" && String(r.dept) !== deptFilter) return false;
      if (assistantFilter !== "all" && assistantMix(r) !== assistantFilter) return false;
      if (term) {
        const blob = `${String(r.user ?? "")} ${String(r.dept ?? "")} ${String(r.email ?? "")}`.toLowerCase();
        if (!blob.includes(term)) return false;
      }
      return true;
    });
  }, [allRows, search, assistantFilter, deptFilter]);

  const deptOptions = useMemo(() => {
    const set = new Set(allRows.map((r) => String(r.dept)));
    return Array.from(set).sort();
  }, [allRows]);

  const columns = useMemo(
    () => [
      { id: "user", header: "User", accessor: (r: Record<string, unknown>) => String(r.user ?? "(unknown)"), width: "1fr" as const },
      { id: "dept", header: "Department", accessor: (r: Record<string, unknown>) => String(r.dept ?? ""), width: 170 },
      {
        id: "assistant",
        header: "Assistant",
        accessor: (r: Record<string, unknown>) => assistantMix(r),
        cell: ({ value }: { value: string }) => (
          <Flex alignItems="center" gap={6} style={{ height: "100%", paddingLeft: 8 }}>
            {value === "Both" ? (
              <>
                <AnthropicIcon size={14} />
                <CopilotIcon size={14} />
              </>
            ) : value === "—" ? null : (
              assistantBrandIcon(value, 14)
            )}
            <span>{value}</span>
          </Flex>
        ),
        width: 140,
      },
      { id: "sessions", header: "Sessions", accessor: (r: Record<string, unknown>) => num(r.sessions), sortType: "number" as const, width: 100 },
      {
        id: "commits",
        header: "Commits",
        accessor: (r: Record<string, unknown>) => num(r.commits),
        cell: ({ value }: { value: number }) => (
          <CenterCell>{!outcomesAvailable(outcomes) ? "–" : fmtInt(value)}</CenterCell>
        ),
        sortType: "number" as const,
        width: 90,
      },
      {
        id: "prs",
        header: "PRs",
        accessor: (r: Record<string, unknown>) => num(r.prs),
        cell: ({ value }: { value: number }) => (
          <CenterCell>{!outcomesAvailable(outcomes) ? "–" : fmtInt(value)}</CenterCell>
        ),
        sortType: "number" as const,
        width: 70,
      },
      {
        id: "lines",
        header: "Lines",
        accessor: (r: Record<string, unknown>) => num(r.linesAdded) + num(r.linesRemoved),
        cell: ({ rowData }: { value: number; rowData: Record<string, unknown> }) =>
          !outcomesAvailable(outcomes) ? (
            <CenterCell>–</CenterCell>
          ) : (
            <CenterCell>{`+${fmtInt(num(rowData.linesAdded))} / −${fmtInt(num(rowData.linesRemoved))}`}</CenterCell>
          ),
        sortType: "number" as const,
        width: 140,
      },
      { id: "llm", header: "Requests", accessor: (r: Record<string, unknown>) => num(r.llm), sortType: "number" as const, width: 100 },
      {
        id: "tokens",
        header: "Tokens",
        accessor: (r: Record<string, unknown>) => num(r.inTok) + num(r.outTok) + num(r.crTok),
        cell: ({ value }: { value: number }) => <CenterCell>{fmtTokens(value)}</CenterCell>,
        sortType: "number" as const,
        width: 100,
      },
      {
        id: "cost",
        header: "Est. spend",
        accessor: (r: Record<string, unknown>) => num(r.cost),
        cell: ({ value }: { value: number }) => <CenterCell>{fmtUSD(value)}</CenterCell>,
        sortType: "number" as const,
        width: 110,
      },
      {
        id: "lastActive",
        header: "Last active",
        accessor: (r: Record<string, unknown>) => String(r.lastActive ?? ""),
        cell: ({ value }: { value: string }) => <CenterCell>{fmtTime(value)}</CenterCell>,
        sortType: "datetime" as const,
        width: 150,
      },
    ],
    [outcomes],
  );

  return (
    <Flex flexDirection="column" gap={20} padding={24} style={{ maxWidth: 1400, margin: "0 auto" }}>
      <Flex justifyContent="space-between" alignItems="flex-end" gap={12} flexFlow="wrap">
        <Flex flexDirection="column" gap={2}>
          <Heading level={2} style={{ margin: 0 }}>Users</Heading>
          <Text style={{ color: subduedText }}>Coding activity by engineer. Click a row for detail.</Text>
        </Flex>
        <Flex gap={8} alignItems="flex-end" flexFlow="wrap">
          <Flex flexDirection="column" gap={4} style={{ minWidth: 220 }}>
            <Text style={{ fontSize: 12, color: subduedText }}>Search</Text>
            <TextInput value={search} onChange={(v) => setSearch(v)} placeholder="User, dept, email…" />
          </Flex>
          <FilterSelect
            label="Assistant"
            value={assistantFilter}
            onChange={setAssistantFilter}
            minWidth={150}
            options={[
              { value: "all", label: "All assistants" },
              { value: "Claude Code", label: "Claude Code" },
              { value: "Copilot", label: "Copilot" },
              { value: "Both", label: "Both" },
            ]}
          />
          <FilterSelect
            label="Department"
            value={deptFilter}
            onChange={setDeptFilter}
            minWidth={200}
            options={[{ value: "all", label: "All departments" }, ...deptOptions.map((d) => ({ value: d, label: d }))]}
          />
        </Flex>
      </Flex>

      {/* Department rollup */}
      <QueryState result={depts} minHeight={80}>
        {(records) => (
          <Flex gap={12} flexFlow="wrap">
            {records.map((d) => (
              <StatTile
                key={String(d.dept)}
                label={String(d.dept)}
                value={fmtUSD(num(d.cost))}
                hint={`${fmtInt(num(d.users))} users · ${fmtInt(num(d.sessions))} sessions`}
                onClick={() => setDeptFilter(String(d.dept))}
              />
            ))}
          </Flex>
        )}
      </QueryState>

      <Section title={`${rows.length} user${rows.length === 1 ? "" : "s"}`} bare>
        <QueryState result={users} minHeight={200}>
          {() =>
            rows.length === 0 ? (
              <Flex justifyContent="center" padding={32}>
                <Text style={{ color: subduedText }}>No users match the current filters.</Text>
              </Flex>
            ) : (
              <DataTable
                data={rows}
                columns={columns as never}
                sortable
                fullWidth
                rowId={(r: Record<string, unknown>) => String(r.uid)}
                interactiveRows
                onActiveRowChange={(uid) => {
                  if (uid) {
                    const row = rows.find((r) => String(r.uid) === uid);
                    setSelectedUser(row ? String(row.user) : uid);
                  }
                  setSelectedUid(uid);
                }}
              />
            )
          }
        </QueryState>
      </Section>

      {selectedUid && (
        <UserDetail
          uid={selectedUid}
          userName={selectedUser}
          show={!!selectedUid}
          onDismiss={() => setSelectedUid(null)}
        />
      )}
    </Flex>
  );
};
