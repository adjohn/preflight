#!/usr/bin/env tsx
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const LIMIT_BYTES = 400 * 1024;
const ASSETS_DIR = resolve(process.cwd(), 'dist/web/assets');

function findMainJs(): string {
  let entries: string[];
  try {
    entries = readdirSync(ASSETS_DIR);
  } catch {
    console.error(`Bundle check failed: ${ASSETS_DIR} not found. Run 'npm run build:web' first.`);
    process.exit(1);
  }
  const mainJs = entries.find((f) => /^(index|main)-.*\.js$/.test(f));
  if (!mainJs) {
    console.error(
      `No index-*.js or main-*.js found in ${ASSETS_DIR}. Files: ${entries.join(', ')}`,
    );
    process.exit(1);
  }
  return join(ASSETS_DIR, mainJs);
}

function main(): void {
  const path = findMainJs();
  const raw = readFileSync(path);
  const gz = gzipSync(raw);
  const rawKb = (raw.length / 1024).toFixed(1);
  const gzKb = (gz.length / 1024).toFixed(1);
  const rawSize = statSync(path).size;
  console.log(`SPA bundle: ${path}`);
  console.log(`  raw:      ${rawKb} KB  (${rawSize} bytes)`);
  console.log(`  gzipped:  ${gzKb} KB`);
  console.log(`  limit:    ${(LIMIT_BYTES / 1024).toFixed(0)} KB gzipped`);
  if (gz.length > LIMIT_BYTES) {
    console.error(
      `\n✗ FAIL: gzipped bundle exceeds limit by ${((gz.length - LIMIT_BYTES) / 1024).toFixed(1)} KB`,
    );
    process.exit(1);
  }
  console.log('\n✓ OK');
}

main();
