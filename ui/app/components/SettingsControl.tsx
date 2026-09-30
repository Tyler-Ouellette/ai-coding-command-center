// Header gear control: app-wide settings, persisted via App State so they're
// shared across everyone using the app. Covers (1) the corporate email domains
// that define "shadow AI" and (2) the Opus "trivial output" token threshold
// used by the model right-sizing recommendation. Saving either immediately
// re-runs every query (see data/settings.tsx).

import React, { useEffect, useState } from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex, Divider } from "@dynatrace/strato-components/layouts";
import { Text } from "@dynatrace/strato-components/typography";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { TextInput } from "@dynatrace/strato-components/forms";
import { SettingIcon, PlusIcon, DeleteIcon } from "@dynatrace/strato-icons";

import { useSettings } from "../data/settings";
import { normalizeDomains } from "../data/config";
import { toneColor, subduedText, surfaceStyle } from "./tokens";

export function SettingsControl() {
  const { corporateDomains, setCorporateDomains, opusTrivialOutputTokens, setOpusTrivialOutputTokens, isSaving } =
    useSettings();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [thresholdDraft, setThresholdDraft] = useState(String(opusTrivialOutputTokens));

  // Keep the draft in sync when the persisted value hydrates after mount.
  useEffect(() => {
    setThresholdDraft(String(opusTrivialOutputTokens));
  }, [opusTrivialOutputTokens]);

  const commitThreshold = () => {
    const n = Number(thresholdDraft);
    if (Number.isFinite(n) && n > 0) {
      void setOpusTrivialOutputTokens(n);
    } else {
      setThresholdDraft(String(opusTrivialOutputTokens));
    }
  };

  const add = () => {
    const merged = normalizeDomains([...corporateDomains, draft]);
    setDraft("");
    if (merged.length !== corporateDomains.length) void setCorporateDomains(merged);
  };

  const remove = (domain: string) => {
    void setCorporateDomains(corporateDomains.filter((d) => d !== domain));
  };

  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)} aria-label="Settings">
        <Button.Prefix><SettingIcon /></Button.Prefix>
      </Button>
      {open && (
        <Sheet
          show
          onDismiss={() => setOpen(false)}
          title="Settings"
          actions={<Button onClick={() => setOpen(false)}>Close</Button>}
          style={{ width: 480 }}
        >
          <Flex flexDirection="column" gap={12} padding={4}>
            <Text style={{ color: subduedText }}>
              Corporate email domains. A model call is flagged as <strong>shadow AI</strong> when the
              signed-in user&apos;s email is <em>not</em> on any of these domains.
            </Text>

            <Flex flexDirection="column" gap={6}>
              {corporateDomains.length === 0 ? (
                <Text style={{ color: toneColor("warning"), fontSize: 13 }}>
                  No domains set — every authenticated user is treated as shadow AI.
                </Text>
              ) : (
                corporateDomains.map((d) => (
                  <Flex
                    key={d}
                    alignItems="center"
                    justifyContent="space-between"
                    gap={8}
                    style={{ ...surfaceStyle, boxShadow: "none", padding: "6px 10px", borderRadius: 4 }}
                  >
                    <Text style={{ fontSize: 13 }}>@{d}</Text>
                    <Button variant="default" onClick={() => remove(d)} disabled={isSaving} aria-label={`Remove ${d}`}>
                      <Button.Prefix><DeleteIcon /></Button.Prefix>
                    </Button>
                  </Flex>
                ))
              )}
            </Flex>

            <Flex gap={8} alignItems="center">
              <div style={{ flex: 1 }}>
                <TextInput
                  value={draft}
                  onChange={(v) => setDraft(v)}
                  placeholder="e.g. example.com"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") add();
                  }}
                />
              </div>
              <Button variant="emphasized" onClick={add} disabled={!draft.trim() || isSaving}>
                <Button.Prefix><PlusIcon /></Button.Prefix>
                Add
              </Button>
            </Flex>

            <Divider />

            <Text style={{ color: subduedText }}>
              Opus &quot;trivial output&quot; threshold. An Opus turn is flagged as a right-sizing
              opportunity when its output is under this many tokens.
            </Text>
            <Flex gap={8} alignItems="center">
              <div style={{ width: 120 }}>
                <TextInput
                  value={thresholdDraft}
                  onChange={(v) => setThresholdDraft(v)}
                  onBlur={commitThreshold}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitThreshold();
                  }}
                />
              </div>
              <Text style={{ color: subduedText, fontSize: 13 }}>output tokens</Text>
            </Flex>
          </Flex>
        </Sheet>
      )}
    </>
  );
}
