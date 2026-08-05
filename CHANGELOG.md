# Changelog

All notable changes to the AI Coding Command Center are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.0.19]

### Added
- **Skills & Tools tab** — a new top-level tab surfacing which skills and tools
  developers use most (calls, distinct users, sessions, failure rate, avg
  duration) without drilling into individual traces. Each row opens a sheet
  listing the sessions that used it, deep-linking straight to the matching span
  in the trace via `?highlight=skill:<name>` / `tool:<name>`. A compact
  "Top skills & tools" summary was also added to the Overview page.
- **Skill name & tool context in the trace view** — session trace rows now show a
  subdued `Skill | <name>` (or tool-argument) segment next to the span label,
  mirroring the native Dynatrace distributed-tracing style. Skill spans surface the
  invoked skill; other tool rows surface their most identifying argument (command,
  file, URL, query, or pattern) without needing to open each span.
