import type { Octokit } from '@octokit/core';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { fetchCurrentMetrics, fetchBaselineMetrics, formatReport } from 'nr-ai-cicd';
import type { AppConfig } from './config.js';

type PullRequestEventPayload = EmitterWebhookEvent<
  'pull_request.opened' | 'pull_request.synchronize'
>['payload'];

export async function handlePullRequest(
  payload: PullRequestEventPayload,
  octokit: Octokit,
  config: AppConfig,
): Promise<void> {
  const prNumber = payload.pull_request.number;
  const developer = payload.pull_request.user?.login;
  if (!developer) {
    process.stderr.write(`PR #${prNumber} has no user (ghost account) — skipping\n`);
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const sha = payload.pull_request.head.sha;

  process.stderr.write(
    `PR #${prNumber} by ${developer} on ${owner}/${repo} — fetching metrics\n`,
  );

  const [current, baseline] = await Promise.all([
    fetchCurrentMetrics(config.newRelicApiKey, config.newRelicAccountId, developer, config.reportHours),
    fetchBaselineMetrics(config.newRelicApiKey, config.newRelicAccountId, developer),
  ]);

  const report = formatReport(current, baseline, config.reportHours, developer);

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: prNumber,
    body: report,
  });

  process.stderr.write(`Posted report on PR #${prNumber}\n`);

  if (config.failBelow !== null && current.efficiencyScore !== null) {
    const state: 'success' | 'failure' =
      current.efficiencyScore >= config.failBelow ? 'success' : 'failure';
    const description =
      state === 'success'
        ? `Efficiency score ${current.efficiencyScore.toFixed(1)} ≥ ${config.failBelow}`
        : `Efficiency score ${current.efficiencyScore.toFixed(1)} < ${config.failBelow}`;

    await octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
      owner,
      repo,
      sha,
      state,
      description,
      context: 'nr-ai-observatory / efficiency',
    });

    process.stderr.write(`Set commit status: ${state} (${description})\n`);
  }
}
