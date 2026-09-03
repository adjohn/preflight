export const SITE_URL = 'https://newrelic-experimental.github.io/preflight';
export const BASE = '/preflight';
const REPO_URL = 'https://github.com/newrelic-experimental/preflight';
export const INSTALL_COMMAND = 'npm install -g @newrelic/preflight && preflight setup';
export const AGENT_PROMPT = `Read ${SITE_URL}/start.md and set up Preflight on this machine, then confirm it is capturing this session.`;

interface ShowcaseTab {
  readonly id: string;
  readonly label: string;
  readonly ask: string;
  readonly tool: string;
  readonly response: string;
}

export const SHOWCASE: readonly ShowcaseTab[] = [
  {
    id: 'session',
    label: 'Session',
    ask: 'What has this session done so far?',
    tool: 'nr_observe_get_session_stats',
    response:
      '{"session_name":"preflight","session_duration_ms":1032043,"tool_calls":40,"tool_calls_by_type":{"Bash":20,"Read":9,"Edit":6,"Grep":5},"success_rate":0.95,"unique_files_modified":4,"avg_tool_duration_ms":1620}',
  },
  {
    id: 'cost',
    label: 'Cost',
    ask: 'How much has this cost?',
    tool: 'nr_observe_get_cost_breakdown',
    response:
      '{"total_usd":0.0152,"by_model":{"claude-sonnet-4-6":0.0152},"tokens":{"input":4976,"output":25202,"cache_read":1449739,"cache_creation":76000},"cost_per_million_tokens":0.0098}',
  },
  {
    id: 'efficiency',
    label: 'Efficiency',
    ask: 'How efficient was that last task?',
    tool: 'nr_observe_get_efficiency_score',
    response:
      '{"latest":{"score":0.625,"components":{"speed":0,"correctness":0.5,"autonomy":1,"firstAttemptQuality":1}},"session_average":{"score":0.625,"tasks_scored":11}}',
  },
  {
    id: 'anti-patterns',
    label: 'Anti-patterns',
    ask: 'Did it get stuck anywhere?',
    tool: 'nr_observe_get_anti_patterns',
    response:
      '[{"type":"re_reading","file":"src/metrics/cost-tracker.ts","read_count":4,"suggestion":"Context may have been compressed — consider breaking the task into smaller pieces"}]',
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
