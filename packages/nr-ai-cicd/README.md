# nr-ai-cicd

CI/CD integration for NR AI Observatory. Posts AI coding cost reports to pull requests and commit comments across GitHub and GitLab. For environments where GitHub Actions are unavailable, see [`nr-ai-github-app`](../nr-ai-github-app/README.md) — a webhook server that reuses this package's `fetchCurrentMetrics`, `fetchBaselineMetrics`, and `formatReport` to post the same reports.

## Features

- **Automatic PR cost reporting** — Posts cost breakdown to pull requests
- **Per-commit analysis** — Attributes costs to individual commits
- **Budget enforcement** — Fails CI if PR cost exceeds threshold
- **Cost attribution** — Tracks which developer/team/project incurred costs
- **Multi-provider support** — GitHub Actions and GitLab CI
- **Inline comments** — Detailed cost breakdowns in PR comments
- **Trend reporting** — Week-over-week and month-over-month comparisons

## Installation

### GitHub Actions

Add to `.github/workflows/cost-report.yml`:

```yaml
name: AI Coding Cost Report

on:
  pull_request:
  push:
    branches: [main]

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Report AI coding costs
        uses: anthropics/nr-ai-mcp-server/nr-ai-cicd@main
        with:
          license-key: ${{ secrets.NEW_RELIC_LICENSE_KEY }}
          account-id: ${{ secrets.NEW_RELIC_ACCOUNT_ID }}
          pr-budget-usd: '5.00'
          fail-on-budget-exceed: true
```

### GitLab CI

Add to `.gitlab-ci.yml`:

```yaml
ai-cost-report:
  stage: report
  script:
    - npm install -g nr-ai-cicd
    - nr-ai-report \
        --license-key $NEW_RELIC_LICENSE_KEY \
        --account-id $NEW_RELIC_ACCOUNT_ID \
        --pr-budget-usd 5.00 \
        --fail-on-exceed
  only:
    - merge_requests
    - main
```

## CLI

```bash
npm install -g nr-ai-cicd
nr-ai-report [options]
```

### Options

```
--license-key <key>           New Relic license key (required)
--account-id <id>             New Relic account ID (required)
--pr-budget-usd <amount>      Max cost for PR (default: 10.00)
--commit-budget-usd <amount>  Max cost per commit (default: 5.00)
--fail-on-exceed              Exit with error if budget exceeded (default: false)
--github-token <token>        GitHub personal access token (optional)
--gitlab-token <token>        GitLab personal access token (optional)
--format <format>             Report format: markdown, json, html (default: markdown)
--output <path>               Write report to file instead of posting
```

## Report Format

### Markdown (default)

```markdown
## 💰 AI Coding Cost Report

**Total Cost:** $1.23  
**Budget:** $5.00  
**Usage:** 24.6%

### Breakdown by Tool

| Tool | Calls | Duration | Cost | % of Total |
|------|-------|----------|------|-----------|
| Read | 45 | 2.3s | $0.45 | 36.6% |
| Edit | 23 | 1.1s | $0.32 | 26.0% |
| Bash | 12 | 0.8s | $0.28 | 22.8% |

### Breakdown by Model

| Model | Requests | Tokens | Cost |
|-------|----------|--------|------|
| claude-opus | 8 | 12,450 | $0.89 |
| claude-sonnet | 72 | 8,920 | $0.34 |

### Comparison

| Metric | This PR | Last PR | Change |
|--------|---------|---------|--------|
| Total Cost | $1.23 | $1.87 | -34% |
| Request Count | 80 | 145 | -45% |
| Avg Cost/Request | $0.015 | $0.013 | +15% |
```

### JSON

```json
{
  "pr_number": 42,
  "branch": "feat/new-feature",
  "total_cost_usd": 1.23,
  "budget_usd": 5.00,
  "usage_percent": 24.6,
  "timestamp": "2025-05-14T10:30:00Z",
  "breakdown_by_tool": {
    "Read": {"calls": 45, "duration_ms": 2300, "cost_usd": 0.45},
    "Edit": {"calls": 23, "duration_ms": 1100, "cost_usd": 0.32}
  },
  "breakdown_by_model": {
    "claude-opus": {"requests": 8, "tokens": 12450, "cost_usd": 0.89}
  },
  "comparison": {
    "last_pr_cost_usd": 1.87,
    "cost_change_percent": -34
  }
}
```

## Configuration

Config loads from **CLI > environment variables > config file > defaults**.

### Environment Variables

```bash
# New Relic (required)
export NEW_RELIC_LICENSE_KEY="175cae4b..."
export NEW_RELIC_ACCOUNT_ID=12345

# CI/CD Defaults
export NEW_RELIC_AI_PR_BUDGET_USD=10.00
export NEW_RELIC_AI_COMMIT_BUDGET_USD=5.00
export NEW_RELIC_AI_FAIL_ON_BUDGET_EXCEED=false

# Git/Provider Config
export GITHUB_TOKEN=ghp_...                   # GitHub
export GITLAB_TOKEN=glpat-...                # GitLab
export CI_REPOSITORY_URL=...                 # Auto-detected in CI
```

### Config File

`~/.nr-ai-observe/cicd.json`:

```json
{
  "licenseKey": "175cae4b...",
  "accountId": 12345,
  "prBudgetUsd": 10.00,
  "commitBudgetUsd": 5.00,
  "failOnBudgetExceed": false,
  "format": "markdown"
}
```

## How It Works

1. **Query New Relic** — Fetches cost events for the current PR/branch
2. **Attribute costs** — Maps costs to commits and developers via git metadata
3. **Calculate metrics** — Aggregates by tool, model, outcome type
4. **Compare history** — Calculates trends against previous PRs/commits
5. **Post report** — Comments on PR or writes to output file
6. **Enforce budget** — Exits with error if exceeded (if enabled)

## Integration Examples

### Slack notifications (GitHub Actions)

```yaml
- name: Post cost report to Slack
  if: always()
  uses: slackapi/slack-github-action@v1.25.0
  with:
    webhook-url: ${{ secrets.SLACK_WEBHOOK }}
    payload: ${{ env.COST_REPORT_JSON }}
```

### Database logging (GitLab CI)

```yaml
- name: Log costs to database
  script:
    - nr-ai-report --output /tmp/report.json
    - curl -X POST https://mydb.example.com/costs \
        -H "Content-Type: application/json" \
        -d @/tmp/report.json
```

### Enforce budget (Any CI)

```yaml
- name: Check budget
  script:
    - nr-ai-report
    - if [ $? -ne 0 ]; then echo "Budget exceeded"; exit 1; fi
```

---

## Testing

```bash
npm test -- packages/nr-ai-cicd
```

## TypeScript

- ESM modules with `.js` import extensions
- Strict mode enabled
- Depends on `@nr-ai-observatory/shared` for event queries

## See Also

- [@nr-ai-observatory/shared](../shared/) — Event transport and utilities
- [nr-ai-mcp-server](../nr-ai-mcp-server/) — MCP server
- [nr-ai-github-app](../nr-ai-github-app/) — GitHub App webhook server reusing this package
- [METRICS_TABLE.md](../../docs/METRICS_TABLE.md) — Event schema
