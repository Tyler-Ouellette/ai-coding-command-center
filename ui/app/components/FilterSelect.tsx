// Labelled single-select for filter bars. Options must live inside Select.Content
// or Strato renders an empty menu.

import React from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Text } from "@dynatrace/strato-components/typography";
import { Select } from "@dynatrace/strato-components/forms";

import { subduedText } from "./tokens";

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  minWidth = 170,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  minWidth?: number;
}) {
  return (
    <Flex flexDirection="column" gap={4} style={{ minWidth }}>
      <Text style={{ fontSize: 12, color: subduedText }}>{label}</Text>
      <Select<string> name={label} value={value} onChange={(v) => onChange(v ?? "all")}>
        <Select.Content>
          {options.map((o) => (
            <Select.Option key={o.value} value={o.value}>{o.label}</Select.Option>
          ))}
        </Select.Content>
      </Select>
    </Flex>
  );
}
