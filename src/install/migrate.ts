import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_STORAGE_PATH } from '../config.js';

/**
 * One-time migration: rename ~/.nr-ai-observe → ~/.newrelic-preflight when the
 * new path doesn't exist yet. Safe to call from any entry point (install,
 * update, setup wizard, server startup). Runs silently on success; warns on
 * failure but never aborts the caller.
 */
export function migrateStoragePath(): void {
  const oldPath = resolve(homedir(), '.nr-ai-observe');
  const newPath = DEFAULT_STORAGE_PATH;
  if (!existsSync(oldPath)) return;
  if (existsSync(newPath)) {
    // Both paths exist — newPath may have been created by `preflight install`
    // before the server was ever started. Warn whenever the old directory has
    // ANY content (config.json, sessions/, alerts/, etc.) so the user can
    // manually merge rather than silently losing configuration or history.
    const hasOldContent =
      existsSync(resolve(oldPath, 'config.json')) ||
      existsSync(resolve(oldPath, 'sessions')) ||
      existsSync(resolve(oldPath, 'alerts')) ||
      existsSync(resolve(oldPath, 'weekly_summaries'));
    if (hasOldContent) {
      process.stderr.write(
        `[preflight] Notice: found old data at ${oldPath} but ${newPath} already exists.\n` +
          `  To migrate your config, sessions, and alert rules, run:\n` +
          `    cp -rn "${oldPath}/." "${newPath}/" || true\n` +
          `    rm -r "${oldPath}"\n` +
          `  (The || true suppresses exit code 1 from cp on macOS when files are skipped.)\n`,
      );
    }
    return;
  }
  try {
    renameSync(oldPath, newPath);
    process.stderr.write(
      `[preflight] Migrated storage directory:\n` +
        `  ${oldPath}\n` +
        `  → ${newPath}\n` +
        `  Your sessions, config, and alert rules have been moved automatically.\n`,
    );
  } catch (err) {
    // ENOENT means another preflight process already completed the migration
    // (oldPath is gone, newPath exists) — return silently.
    // ENOTEMPTY means newPath was created between our existsSync check and the
    // rename call (e.g. a concurrent `preflight install`). In that case oldPath
    // still exists with user data — fall through to the warning so the user
    // knows to merge manually.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && existsSync(newPath)) {
      return;
    }
    process.stderr.write(
      `[preflight] Warning: could not migrate storage directory from ${oldPath} to ${newPath}.\n` +
        `  Please rename it manually, or set NEW_RELIC_AI_MCP_STORAGE_PATH to override.\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
