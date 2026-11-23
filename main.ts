// Token Launch Radar CLI entrypoint (Node 22+, standard library only, deterministic).
//
// Reads the sealed DefiLlama snapshot from /input/snapshot.json (or --input <file|dir>),
// calibrates category peer multiples dynamically from live-token protocols, ranks all
// watchlist and early pre-token protocols by implied value, generates concrete per-protocol
// farm playbooks, writes /output/board.json and /output/data.js, copies dashboard/ and
// screenshots/ into /output, and builds /output/dossier.json via vendor/makefun-board.ts.
//
// Local usage:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFarmPlan, formatFarmStep } from './lib/farm.ts';
import type { FarmPlanSummary } from './lib/farm.ts';
import {
  DEFAULT_MODEL,
  buildRankedBoard,
  parseSnapshot,
  validateBoard,
} from './lib/model.ts';
import type {
  BoardRow,
  LiveBenchmarkRow,
  ModelConfig,
  PeerCalibration,
  UniverseCounts,
  ValuationBreakdown,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Scorer gate caps from competition rules. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const SAFE_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Row payload embedded in /output/data.js for offline dashboard rendering. */
interface DashboardRow {
  rank: number;
  slug: string;
  name: string;
  tier: 'watchlist' | 'early';
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  model: ValuationBreakdown;
  farm: FarmPlanSummary;
}

/** Complete offline payload written to /output/data.js. */
interface DashboardDataset {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConfig;
  counts: UniverseCounts;
  calibration: PeerCalibration;
  rows: DashboardRow[];
  live: LiveBenchmarkRow[];
}

/** Read a CLI flag (--name value or --name=value) with fallback. */
function readArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1]!;
  }
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  return inline === undefined ? fallback : inline.slice(prefix.length);
}

/** Deterministic lexical comparator by UTF-16 code unit. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Copy regular non-dot files deterministically from `fromDir` into `toDir`. */
function copyRegularFiles(fromDir: string, toDir: string): string[] {
  if (!existsSync(fromDir)) return [];
  mkdirSync(toDir, { recursive: true });
  const names = readdirSync(fromDir).filter((n) => !n.startsWith('.')).sort(byCodeUnit);
  const copied: string[] = [];
  for (const name of names) {
    const src = join(fromDir, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(toDir, name));
    copied.push(name);
  }
  return copied;
}

/** Serialize the offline dashboard dataset into a self-contained script. */
function buildDataScript(dataset: DashboardDataset): string {
  return `window.RADAR_DATA=${JSON.stringify(dataset)};\n`;
}

function main(): void {
  const inputArg = readArg('input', '/input');
  const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputPath)) {
    process.stderr.write(`token-radar: snapshot not found at ${inputPath}\n`);
    process.exit(2);
  }

  const outDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));

  // Cache structured farm plans by slug so board.json and data.js stay 100% consistent.
  const farmPlanBySlug = new Map<string, FarmPlanSummary>();
  const { board, calibration, live, counts } = buildRankedBoard(
    snapshot,
    (protocol, age, tier) => {
      const plan = buildFarmPlan(protocol, age, tier);
      farmPlanBySlug.set(protocol.slug, plan);
      return plan.steps.map(formatFarmStep);
    },
    DEFAULT_MODEL,
  );

  const validationError = validateBoard(board, snapshot);
  if (validationError !== null) {
    process.stderr.write(`token-radar: board validation failed: ${validationError}\n`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const boardDocument = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: DEFAULT_MODEL.version,
    counts,
    calibration,
    rows: board,
  };
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify(boardDocument)}\n`, 'utf8');

  const dashboardRows: DashboardRow[] = board.map((row: BoardRow) => ({
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    tier: row.tier,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    model: row.model,
    farm: farmPlanBySlug.get(row.slug)!,
  }));

  const dataset: DashboardDataset = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: DEFAULT_MODEL,
    counts,
    calibration,
    rows: dashboardRows,
    live,
  };
  writeFileSync(join(outDir, 'data.js'), buildDataScript(dataset), 'utf8');

  const dashFiles = copyRegularFiles(join(REPO_ROOT, 'dashboard'), join(outDir, 'dashboard'));
  const shotFiles = copyRegularFiles(join(REPO_ROOT, 'screenshots'), join(outDir, 'screenshots'));

  const skipDossier = process.argv.includes('--skip-dossier');
  if (!skipDossier) {
    if (dashFiles.length === 0) {
      process.stderr.write('token-radar: dashboard/ is empty or missing\n');
      process.exit(1);
    }
    if (shotFiles.length < 3 || shotFiles.length > 4) {
      process.stderr.write(`token-radar: screenshots/ must contain 3 to 4 images (found ${shotFiles.length})\n`);
      process.exit(1);
    }
    for (const name of shotFiles) {
      if (!SAFE_FILENAME.test(name)) {
        process.stderr.write(`token-radar: invalid screenshot filename: ${name}\n`);
        process.exit(1);
      }
    }

    const dossierBytes = buildDossier(outDir, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    });
    writeFileSync(join(outDir, 'dossier.json'), dossierBytes);
  }

  process.stdout.write(
    `token-radar: scored ${board.length} pre-token protocols (${counts.watchlist_count} watchlist, ${counts.early_count} early) from ${counts.total_protocols} snapshot records (${counts.live_token_count} live separated, ${counts.excluded_pre_token_count} wrapped/staked/bridged/CEX excluded)\n` +
      `token-radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')} (${dashFiles.length} dashboard files, ${shotFiles.length} screenshots${skipDossier ? ', dossier skipped' : ', dossier.json built'})\n`,
  );
}

main();
