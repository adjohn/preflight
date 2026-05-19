# nr-ai-github-app

Posts AI coding cost and efficiency reports on pull requests. Runs as a webhook server — no GitHub Actions required.

## Setup

### 1. Register the GitHub App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (or the enterprise equivalent).

Required settings:
- **Webhook URL**: `https://your-server.example.com/api/github/webhooks`
- **Webhook secret**: generate a random string and save it as `GITHUB_WEBHOOK_SECRET`
- **Repository permissions**:
  - Issues: Read & write (for posting PR comments)
  - Commit statuses: Read & write (optional — only needed for quality gate)
  - Pull requests: Read-only (for receiving PR events)
- **Subscribe to events**: Pull request

After creating the app, note the **App ID** and generate a **Private key** (downloads as a `.pem` file).

### 2. Install the app on your repository

From the GitHub App page, click **Install App** and select the repositories you want to monitor.

### 3. Configure environment variables

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-secret
NEW_RELIC_API_KEY=your-nr-api-key
NEW_RELIC_ACCOUNT_ID=your-account-id
NR_AI_REPORT_HOURS=24          # optional, default 24
NR_AI_REPORT_FAIL_BELOW=40     # optional quality gate — sets commit status
PORT=3000                      # optional, default 3000
```

When setting `GITHUB_APP_PRIVATE_KEY` in hosting platforms, replace real newlines with `\n`.

### 4. Start the server

```
npx nr-ai-github-app
```

Or build and run directly:

```
npm run build
node dist/index.js
```
