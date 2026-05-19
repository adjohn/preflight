#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createWebhookServer } from './server.js';

const config = loadConfig();
const server = createWebhookServer(config);

server.listen(config.port, () => {
  process.stderr.write(
    `nr-ai-github-app listening on port ${config.port}\n` +
    `Webhook endpoint: POST /api/github/webhooks\n`,
  );
});
