import { createServer } from 'node:http';
import { App, createNodeMiddleware } from '@octokit/app';
import { handlePullRequest } from './pr-handler.js';
import type { AppConfig } from './config.js';

export function createWebhookServer(config: AppConfig): ReturnType<typeof createServer> {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhooks: {
      secret: config.webhookSecret,
    },
  });

  app.webhooks.on('pull_request.opened', async ({ payload, octokit }) => {
    await handlePullRequest(payload, octokit, config);
  });

  app.webhooks.on('pull_request.synchronize', async ({ payload, octokit }) => {
    await handlePullRequest(payload, octokit, config);
  });

  app.webhooks.onError((error: Error) => {
    process.stderr.write(`Webhook error: ${error.message}\n`);
  });

  return createServer(createNodeMiddleware(app));
}
