import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, 'test-results');

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.min(sorted.length - 1, Math.max(0, idx));
  return sorted[clamped];
}

function mean(values) {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function padRight(str, n) {
  return String(str).padEnd(n, ' ');
}

const timingFiles = [];
for await (const file of walk(outputDir)) {
  if (path.basename(file) === 'timings.json') timingFiles.push(file);
}

timingFiles.sort();

if (timingFiles.length === 0) {
  console.error(`No timings.json files found under ${outputDir}. Run the tests first.`);
  process.exit(1);
}

const rows = [];
for (const file of timingFiles) {
  const raw = await fs.readFile(file, 'utf8');
  let timings;
  try {
    timings = JSON.parse(raw);
  } catch {
    continue;
  }

  const rel = path.relative(repoRoot, path.dirname(file));
  rows.push({
    testOutputDir: rel,
    timings,
  });
}

// Collect all action keys.
const actionKeys = new Set();
for (const r of rows) {
  for (const k of Object.keys(r.timings ?? {})) actionKeys.add(k);
}
const actions = [...actionKeys].sort();

// Build aggregates per action.
const aggregates = actions.map((action) => {
  const values = rows
    .map((r) => Number(r.timings?.[action]))
    .filter((v) => Number.isFinite(v));

  return {
    action,
    n: values.length,
    mean: mean(values),
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : undefined,
  };
});

const lines = [];
lines.push('# Mystapp perf summary');
lines.push('');
lines.push(`Found ${rows.length} run(s) with timings.`);
lines.push('');

lines.push('## Aggregates (ms)');
lines.push('');
lines.push('| Action | n | mean | p50 | p90 | p95 | p99 | max |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const a of aggregates) {
  lines.push(
    `| ${a.action} | ${a.n} | ${a.mean ?? ''} | ${a.p50 ?? ''} | ${a.p90 ?? ''} | ${a.p95 ?? ''} | ${a.p99 ?? ''} | ${a.max ?? ''} |`
  );
}
lines.push('');

lines.push('## Per run (ms)');
lines.push('');
lines.push('| Test output dir | ' + actions.join(' | ') + ' |');
lines.push('|---|' + actions.map(() => '---:').join('|') + '|');
for (const r of rows) {
  const cells = actions.map((k) => {
    const v = r.timings?.[k];
    return Number.isFinite(Number(v)) ? String(v) : '';
  });
  lines.push(`| ${r.testOutputDir} | ${cells.join(' | ')} |`);
}
lines.push('');

const outPath = path.join(outputDir, 'mystapp-perf-summary.md');
await fs.writeFile(outPath, lines.join('\n'), 'utf8');

// Also print a friendly pointer.
console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
