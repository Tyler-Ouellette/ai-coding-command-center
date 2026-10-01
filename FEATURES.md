# Feature Ideas / Backlog

<!-- ## Outcomes & ROI
- **Show outcomes, not just cost.** Commits, PRs, lines changed, accepted edits — Claude Code already sends these free. Unlocks "$ per merged PR" and similar ROI metrics.

## Session Quality
- **Active time vs elapsed.** Strip idle gaps to show real working time. That 77h session was ~45 min of actual work. Prevents skewed duration averages.
- **Change "High spend" attention flag to "High spend, nothing shipped."** Only surface it if the session cost a lot *and* produced no observable output (no commits, no edits accepted). -->

## Cost Optimization
- **Model right-sizing recommendation.** Detect Opus turns with small output tokens (i.e., the heavy model was used for a trivial response) and show "you could have paid Sonnet rates for X of these turns — estimated savings: $Y." Appeals to a tech-savvy CFO. Note: accuracy depends on whether the task *actually* required Opus, so frame as an estimate.

## End-to-End Traceability (big idea, WIP)
- **Link a session to what it deployed.** Prompt → pipeline → deploy → prod error. Correlate vibe-coded sessions with downstream CI/CD runs and production incidents. Catch "someone shipped a breaking change via AI" before it becomes a postmortem. Needs trace context to propagate through the pipeline.

## Security & Governance
- **Flag secrets in prompts and commands.** Implemented. Covers vendor API keys (GitHub/OpenAI/Anthropic/AWS/Slack), PEM private-key blocks, JWT bearer tokens, and generic `password=`/`token=`/`api_key=`-style assignments, matched across both prompt text and tool-call arguments — plus `.env` file access and `curl`/`wget` credential exposure (`-H "Authorization: ..."`, `--user`) under the credential-access flag. Pattern definitions live in one place, `ui/app/data/securityPatterns.ts`, shared by the Overview DQL aggregation and the per-span client checks so new rules only need to be added once.
