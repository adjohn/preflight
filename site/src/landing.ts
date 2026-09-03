export const SITE_URL = 'https://newrelic-experimental.github.io/preflight';
export const BASE = '/preflight';
const REPO_URL = 'https://github.com/newrelic-experimental/preflight';
export const INSTALL_COMMAND = 'npm install -g @newrelic/preflight && preflight setup';
export const AGENT_PROMPT = `Read ${SITE_URL}/start.md and set up Preflight on this machine, then confirm it is capturing this session.`;

interface ShowcaseTab {
  readonly id: string;
  readonly label: string;
  readonly ask: string;
  readonly answer: string;
  readonly tool: string;
}

export const SHOWCASE: readonly ShowcaseTab[] = [
  {
    id: 'session',
    label: 'Session',
    ask: 'What has this session done so far?',
    answer:
      "About 17 minutes in, with 40 tool calls: 20 shell commands, 9 file reads, 6 edits, and 5 searches. 38 of them succeeded, a 95% success rate. You've changed 4 files. Tool calls are averaging 1.6 seconds.",
    tool: 'nr_observe_get_session_stats',
  },
  {
    id: 'cost',
    label: 'Cost',
    ask: 'How much has this cost?',
    answer:
      '$0.015 so far, all on Claude Sonnet 4.6. Almost everything came from cache: 1.45M tokens read from cache against 5K fresh input tokens, which works out to about a cent per million tokens. Output was 25K tokens.',
    tool: 'nr_observe_get_cost_breakdown',
  },
  {
    id: 'efficiency',
    label: 'Efficiency',
    ask: 'How efficient was that last task?',
    answer:
      'The last task scored 0.63 out of 1. Autonomy and first-attempt quality were both perfect and correctness was 0.5, but speed scored 0, which pulled the average down. Across the 11 tasks scored this session, the average is also 0.63.',
    tool: 'nr_observe_get_efficiency_score',
  },
  {
    id: 'anti-patterns',
    label: 'Anti-patterns',
    ask: 'Did you get stuck anywhere?',
    answer:
      'Once. I read src/metrics/cost-tracker.ts four times, which usually means the context was compressed and I lost what I had already read. Splitting the task into smaller pieces would avoid that.',
    tool: 'nr_observe_get_anti_patterns',
  },
];

type Coverage = 'full-hooks' | 'mcp-tools-only' | 'self-reported';

interface Platform {
  readonly name: string;
  readonly coverage: Coverage;
}

export const PLATFORMS: readonly Platform[] = [
  { name: 'Claude Code', coverage: 'full-hooks' },
  { name: 'Kiro', coverage: 'full-hooks' },
  { name: 'Amazon Q', coverage: 'full-hooks' },
  { name: 'Droid', coverage: 'full-hooks' },
  { name: 'Codex', coverage: 'full-hooks' },
  { name: 'opencode', coverage: 'full-hooks' },
  { name: 'Kilo Code', coverage: 'full-hooks' },
  { name: 'Pi', coverage: 'full-hooks' },
  { name: 'GitHub Copilot', coverage: 'full-hooks' },
  { name: 'GitHub Copilot SDK', coverage: 'full-hooks' },
  { name: 'GitHub Copilot app', coverage: 'full-hooks' },
  { name: 'Gemini CLI', coverage: 'full-hooks' },
  { name: 'Cursor', coverage: 'full-hooks' },
  { name: 'Windsurf', coverage: 'full-hooks' },
  { name: 'Antigravity', coverage: 'full-hooks' },
  { name: 'Zed', coverage: 'mcp-tools-only' },
  { name: 'Continue.dev', coverage: 'mcp-tools-only' },
  { name: 'Cline', coverage: 'mcp-tools-only' },
  { name: 'Generic MCP', coverage: 'self-reported' },
];

interface Feature {
  readonly title: string;
  readonly body: string;
  readonly href: string;
}

export const FEATURES: readonly Feature[] = [
  {
    title: 'Visibility',
    body: 'Every file read, edit, command, and search captured as it happens. A live session view plus trends across weeks.',
    href: `${BASE}/metrics-table/`,
  },
  {
    title: 'Cost control',
    body: 'USD spend per session, day, and week, split by model and cache tier. Budget alerts before you overspend.',
    href: `${BASE}/advanced/#local-alerts`,
  },
  {
    title: 'Efficiency insights',
    body: 'A score per task, detection of re-reads, blind edits, and stuck loops, and weekly coaching from your own history.',
    href: `${BASE}/commands-table/#workflow-tools`,
  },
  {
    title: 'Dashboards',
    body: 'A local dashboard at localhost:7777 with no account, and 7 prebuilt New Relic dashboards for teams.',
    href: `${BASE}/getting-started/`,
  },
];

interface Link {
  readonly label: string;
  readonly href: string;
}

export const NAV: readonly Link[] = [
  { label: 'Docs', href: `${BASE}/getting-started/` },
  { label: "What's New", href: `${BASE}/whats-new/` },
  { label: 'GitHub', href: REPO_URL },
];

export const FOOTER: readonly { readonly heading: string; readonly links: readonly Link[] }[] = [
  {
    heading: 'Docs',
    links: [
      { label: "What's New", href: `${BASE}/whats-new/` },
      { label: 'Getting Started', href: `${BASE}/getting-started/` },
      { label: 'Architecture', href: `${BASE}/architecture/` },
      { label: 'Platform Adapters', href: `${BASE}/adapters/` },
      { label: 'MCP Commands Reference', href: `${BASE}/commands-table/` },
      { label: 'Metrics Reference', href: `${BASE}/metrics-table/` },
      { label: 'Advanced Configuration', href: `${BASE}/advanced/` },
      { label: 'Test Patterns', href: `${BASE}/test-patterns/` },
      { label: 'Contributing', href: `${BASE}/contributing/` },
    ],
  },
  {
    heading: 'Project',
    links: [
      { label: 'GitHub', href: REPO_URL },
      { label: 'Changelog', href: `${REPO_URL}/blob/main/CHANGELOG.md` },
      { label: 'Issues', href: `${REPO_URL}/issues` },
      { label: 'npm', href: 'https://www.npmjs.com/package/@newrelic/preflight' },
      { label: 'Contributing', href: `${BASE}/contributing/` },
    ],
  },
];
