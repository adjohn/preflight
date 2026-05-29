# Local-only mode v1 — smoke test

Run before opening the PR.

## Setup

```bash
mkdir -p ~/nr-ai-smoke/.nr-ai-observe
echo '{ "mode": "local" }' > ~/nr-ai-smoke/.nr-ai-observe/config.json
HOME=~/nr-ai-smoke node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
```

## Verify

- [ ] `curl -s http://127.0.0.1:7777/api/health` returns `{"ok":true,...}`.
- [ ] `curl -sI http://127.0.0.1:7777/` returns `200` and `content-type: text/html`.
- [ ] `curl -sI -H "Host: evil.com" http://127.0.0.1:7777/api/health` returns `403`.
- [ ] `curl -s http://127.0.0.1:7777/api/health -o /dev/null -w "CSP: %header{content-security-policy}\n"` shows a CSP starting with `default-src 'self'`.
- [ ] `timeout 2 curl -sN http://127.0.0.1:7777/sse | head -3` shows `: stream-open`.

## Open in browser

Navigate to **http://127.0.0.1:7777/** and verify by eye:

- [ ] Sidebar has 4 nav items, "● connected" is green.
- [ ] Today view loads with KPIs, even if values are 0.
- [ ] Sessions view loads, shows "No sessions yet — start coding with Claude" if first run.
- [ ] History view loads with both charts (may be empty on first run).
- [ ] Audit view loads with filter chips and "No matching entries." in the table.

## Trigger live data

In another terminal, while the server is still running:

- [ ] Use Claude Code briefly with this MCP server attached.
- [ ] Tool calls appear in the Today view's "recent" table within ~2s of completion.
- [ ] Spend KPI updates as cost accumulates.

## Privacy proof

- [ ] `npm test -- src/index.privacy.test.ts` passes.
- [ ] In a fresh terminal: `tcpdump -nn -i any host api.newrelic.com` shows zero packets while running with `mode: 'local'`.

## Cleanup

```bash
kill $SERVER_PID
rm -rf ~/nr-ai-smoke
```
