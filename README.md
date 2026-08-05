# Getting Started with your Dynatrace App

This project was bootstrapped with Dynatrace App Toolkit.

It uses React in combination with TypeScript, to provide great developer experience.

## Available Scripts

In the project directory, you can run:

### `npm run start`

Runs the app in the development mode. A new browser window with your running app will be automatically opened.

Edit a component file in `ui` and save it. The page will reload when you make changes. You may also see any errors in the console.

### `npm run build`

Builds the app for production to the `dist` folder. It correctly bundles your app in production mode and optimizes the build for the best performance.

### `npm run deploy`

Builds the app and deploys it to the specified environment in `app.config.json`.

### `npm run uninstall

Uninstalls the app from the specified environment in `app.config.json`.

### `npm run generate:function`

Generates a new serverless function for your app in the `api` folder.

### `npm run update`

Updates @dynatrace-scoped packages to the latest version and applies automatic migrations.

### `npm run info`

Outputs the CLI and environment information.

### `npm run help`

Outputs help for the Dynatrace App Toolkit.

## Learn more

You can find more information on how to use all the features of the new Dynatrace Platform in [Dynatrace Developer](https://dt-url.net/developers).

To learn React, check out the [React documentation](https://reactjs.org/).

## Roadmap

> Shipped features are tracked in [CHANGELOG.md](CHANGELOG.md).

### Planned
- **Warning icons in traces** — flag risky spans inline: destructive commands, exposed API tokens/secrets, and suspicious web requests (e.g. outbound `POST`).
- **Codex telemetry** — ingest and visualize OpenAI Codex CLI sessions alongside Claude Code and Copilot.
- Session / trace arrows to easily go to the next session

### Ideas / Backlog
- **Cost & token trends** — per-user and per-department spend over time, with top cost drivers and week-over-week deltas.
- **Model mix insights** — breakdown of model usage (Opus vs Sonnet vs GPT) and realized cache savings per session.
- **Session search & filters** — free-text search across prompts/tools plus filters by assistant, repo, outcome (success/error/blocked).
- **Error & blocked-tool drill-down** — a focused view of failed LLM calls and approval-blocked tools to spot friction.
- **Repo/branch attribution** — group sessions by repository and branch to see where AI assistance is concentrated.
- **Export & sharing** — export a session trace or overview as a shareable Dynatrace document/dashboard.
- **Prompt-injection & anomaly detection** — surface suspicious prompts and abnormal tool sequences for security review.
