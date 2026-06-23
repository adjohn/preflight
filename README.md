<div align="center">
  <img src="demo/preflight-logo.svg" alt="Preflight" width="96" height="96" />
  <h1>Preflight</h1>
  <p><strong>Observability for AI Coding Assistants</strong></p>

[![Open Source](https://img.shields.io/badge/Open%20Source-MIT-blue)](LICENSE)
[![Node 22+](https://img.shields.io/badge/Node-22%2B-brightgreen)](.nvmrc)
[![Works Offline](https://img.shields.io/badge/Works%20Offline-Yes-brightgreen)](#local-mode)
[![Dashboards Included](https://img.shields.io/badge/Dashboards-7%20Included-blue)](#dashboards)

[**Docs**](docs/ADVANCED.md) • [**Examples**](examples/) • [**Community**](https://support.newrelic.com/s/) • [**Contributing**](CONTRIBUTING.md)

</div>

---

## Why Your AI Tool Needs Observability

Your AI coding assistant makes hundreds of decisions every session — what to read, what to edit, when to run commands. But you can't see any of it. You know it was fast, but was it *efficient*? You got a PR merged, but how much did it cost? You fixed a bug, but did it get stuck in a loop first?

**Preflight is observability for AI.** See exactly what's happening, how much it costs, and where your AI is wasting time.

It captures every tool call, measures the cost, detects inefficiencies, and sends actionable data to your dashboards — so you can optimize, budget, and understand AI behavior in real time.

---

## Demo

![Preflight dashboard animation](demo/preflight-readme.gif)

See cost breakdown, efficiency scoring, anti-patterns, and live session tracking in action.

---

## What You Get

### Visibility
- **Every action captured** — file reads, edits, commands, searches
- **Live session dashboard** — see what's happening right now
- **Historical trends** — analyze patterns over weeks and months

### Cost Control
- **USD spend tracking** — per session, day, and week
- **Per-model breakdown** — know which models cost most
- **Budget alerts** — get notified before you overspend
- **Forecasting** — project monthly burn rate

### Efficiency Insights
- **Efficiency score** — 0–100 score per task, based on how directly the AI worked
- **Anti-pattern detection** — catches re-reads, blind edits, stuck loops
- **Personalized recommendations** — optimize your AI workflow
- **Weekly coaching reports** — narrative analysis vs. your historical baseline

### Ready-to-Use Dashboards
- **7 pre-built dashboards** — deploy in seconds
- **Overview** — session stats, cost summary, top tools
- **Personal** — 30-day self-reflection scoped to you
- **Team View** — aggregated cost and efficiency across developers
- **Manager View** — high-level team metrics, no tool-call content
- **Platform Comparison** — Claude Code vs. Cursor vs. Windsurf, etc.
- **Security Audit** — audit trail of sensitive file access

---

## Quick Start

### 1. Install

```bash
npm install -g @newrelic/preflight
```

### 2. Setup

```bash
preflight setup
```

Choose **cloud** to send telemetry to New Relic, or **local** for offline dashboard-only use. The wizard validates keys and most people are running in under 5 minutes.

Or skip the wizard:

```bash
preflight install \
  --license-key YOUR_LICENSE_KEY \
  --account-id YOUR_ACCOUNT_ID
```

### 3. Deploy dashboards (optional)

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  preflight deploy-dashboards --all
```

Then restart your AI tool and start coding. Every tool call is captured automatically.

---

## Works With

**Claude Code** • **Cursor** • **Windsurf** • **GitHub Copilot** • **Zed** • **Continue.dev** • **Amazon Q Developer**

---

## Requirements

### Required
- **Node.js v22 or higher** ([get it](https://nodejs.org) or use [nvm](https://github.com/nvm-sh/nvm))
- **An AI coding tool** (Claude Code recommended for deepest integration)

### Optional
- **New Relic account** — for cloud dashboards. Skip this to use [local mode](#local-mode) offline.
- **User API key** — only needed for `deploy-dashboards` and `deploy-alerts` commands

---

## Documentation

- [**ADVANCED.md**](docs/ADVANCED.md) — Configuration, dashboards, alerts, Terraform
- [**CONTRIBUTING.md**](CONTRIBUTING.md) — Development, testing, submitting PRs
- [**SECURITY.md**](docs/SECURITY.md) — Security guidelines and best practices

---

## Local Mode

No New Relic account needed. Run:

```bash
npm install -g @newrelic/preflight
preflight setup
```

Choose **local** mode. You'll get a live dashboard on `http://127.0.0.1:7777` showing your session in real time. Perfect for testing, learning, or offline use.

---

## From Source

Develop, test, or run the latest unreleased version:

```bash
git clone https://github.com/newrelic-experimental/preflight
cd preflight
nvm use              # Switch to Node v24
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm link             # Register preflight on PATH
```

Then run `preflight setup` as usual.

---

## License

Preflight is open source under the [MIT License](LICENSE).

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started. Join the [New Relic Community](https://support.newrelic.com/s/) to share ideas, ask questions, or discuss features.

---

<div align="center">
  <p><strong>Built by New Relic • Designed for developers who use AI</strong></p>
</div>
