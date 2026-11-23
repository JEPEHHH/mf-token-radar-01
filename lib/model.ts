// Dynamic pre-token valuation model for Token Launch Radar (Node 22+, stdlib only).
//
// Reads the sealed DefiLlama snapshot and derives every valuation parameter directly from
// the snapshot's own live-token peer ratios, TVL, 7-day TVL momentum, operating age without
// a token, multi-chain footprint, and TVL scale elasticity. Zero protocol names are hardcoded.

/** Raw protocol record from snapshot.json (exact 10-field schema). */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** Sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Calibrated peer multiple statistics for one DeFi category. */
export interface CategoryBenchmark {
  category: string;
  peer_count: number;
  raw_median: number | null;
  p25: number | null;
  p75: number | null;
  shrunk_multiple: number;
  credibility_weight: number;
}

/** Transparent, inspectable model hyperparameters (adjustable in the UI sandbox). */
export interface ModelConfig {
  version: string;
  prior_strength: number;
  peer_ratio_floor: number;
  peer_ratio_cap: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_bonus_per_extra: number;
  chain_bonus_max_extra: number;
  scale_anchor_usd: number;
  scale_exponent: number;
  scale_floor: number;
  scale_cap: number;
}

export const DEFAULT_MODEL: ModelConfig = {
  version: 'peer-bayes-v2',
  prior_strength: 6,
  peer_ratio_floor: 0.04,
  peer_ratio_cap: 1.0,
  multiple_floor: 0.08,
  multiple_cap: 0.8,
  growth_floor_pct: -50,
  growth_cap_pct: 120,
  growth_weight: 0.45,
  maturity_floor: 0.65,
  maturity_range: 0.45,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_bonus_per_extra: 0.03,
  chain_bonus_max_extra: 8,
  scale_anchor_usd: 100_000_000,
  scale_exponent: -0.05,
  scale_floor: 0.85,
  scale_cap: 1.15,
};

/** Full breakdown of how a single protocol's implied value was computed. */
export interface ValuationBreakdown {
  category_multiple: number;
  category_peer_count: number;
  global_median_multiple: number;
  base_value_usd: number;
  growth_pct_clamped: number;
  growth_multiplier: number;
  age_days: number | null;
  maturity_multiplier: number;
  chain_count: number;
  multichain_multiplier: number;
  scale_multiplier: number;
  composite_multiple: number;
  low_value_usd: number;
  high_value_usd: number;
  readiness_score: number;
}

/** One ranked row written to /output/board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  tier: 'watchlist' | 'early';
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: ValuationBreakdown;
  farm_steps: string[];
}

/** Live-token protocol kept strictly separate as a market benchmark. */
export interface LiveBenchmarkRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl_ratio: number;
  change_7d: number | null;
  symbol: string | null;
  listed_at: string | null;
}

/** Calibration output derived purely from the snapshot's live-token peers. */
export interface PeerCalibration {
  global_median: number;
  peer_total: number;
  by_category: Record<string, CategoryBenchmark>;
}

/** Full universe accounting across all protocols in the snapshot. */
export interface UniverseCounts {
  total_protocols: number;
  watchlist_count: number;
  early_count: number;
  board_count: number;
  excluded_pre_token_count: number;
  live_token_count: number;
  live_with_mcap_count: number;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Categories representing wrapped, bridged, staked, or centralized exchange products. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_OR_STAKED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compute quantile q in [0, 1] on a non-empty numeric array. */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Whole days between listedAt and asOf (clamped >= 0), or null when unavailable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** True when DefiLlama records no token (no market cap, no CoinGecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when a protocol is a wrapped, staked, bridged, versioned, or CEX product. */
export function isExcludedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_OR_STAKED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

/**
 * Calibrate category mcap/TVL multiples dynamically from the snapshot's live-token peers
 * (excluding CEX). Uses winsorized peer ratios and empirical-Bayes shrinkage toward the
 * global DeFi median so thin categories never explode from single outliers.
 */
export function calibratePeerMultiples(snapshot: Snapshot, cfg: ModelConfig = DEFAULT_MODEL): PeerCalibration {
  const peers = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );

  const allWinsorized: number[] = [];
  const buckets = new Map<string, number[]>();

  for (const p of peers) {
    const rawRatio = (p.mcap_usd as number) / p.tvl_usd;
    const winsorized = clamp(rawRatio, cfg.peer_ratio_floor, cfg.peer_ratio_cap);
    allWinsorized.push(winsorized);
    const cat = p.category ?? 'Uncategorized';
    const list = buckets.get(cat);
    if (list === undefined) buckets.set(cat, [winsorized]);
    else list.push(winsorized);
  }

  const globalMedian = allWinsorized.length > 0 ? quantile(allWinsorized, 0.5) : 0.22;
  const byCategory: Record<string, CategoryBenchmark> = {};

  const categories = [...buckets.keys()].sort(cmpStr);
  for (const cat of categories) {
    const arr = buckets.get(cat)!;
    const n = arr.length;
    const rawMed = quantile(arr, 0.5);
    const p25 = quantile(arr, 0.25);
    const p75 = quantile(arr, 0.75);
    const weight = n / (n + cfg.prior_strength);
    const shrunk = clamp(weight * rawMed + (1 - weight) * globalMedian, cfg.multiple_floor, cfg.multiple_cap);
    byCategory[cat] = {
      category: cat,
      peer_count: n,
      raw_median: round4(rawMed),
      p25: round4(p25),
      p75: round4(p75),
      shrunk_multiple: round4(shrunk),
      credibility_weight: round4(weight),
    };
  }

  return {
    global_median: round4(globalMedian),
    peer_total: peers.length,
    by_category: byCategory,
  };
}

/** Score one pre-token protocol and return its implied value and full factor breakdown. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: PeerCalibration,
  cfg: ModelConfig = DEFAULT_MODEL,
): { implied_value_usd: number; breakdown: ValuationBreakdown } {
  const catKey = protocol.category ?? 'Uncategorized';
  const bench = calibration.by_category[catKey];
  const categoryMultiple = bench !== undefined ? bench.shrunk_multiple : clamp(calibration.global_median, cfg.multiple_floor, cfg.multiple_cap);
  const peerCount = bench !== undefined ? bench.peer_count : 0;

  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const growthClamped = clamp(rawGrowth, cfg.growth_floor_pct, cfg.growth_cap_pct);
  const growthMult = 1 + (growthClamped / 100) * cfg.growth_weight;

  const age = ageDays(asOf, protocol.listed_at);
  const effectiveAge = age ?? cfg.unknown_age_days;
  const maturityMult = cfg.maturity_floor + (clamp(effectiveAge, 0, cfg.maturity_days) / cfg.maturity_days) * cfg.maturity_range;

  const chainCount = Math.max(1, protocol.chains.length);
  const extraChains = Math.min(Math.max(chainCount - 1, 0), cfg.chain_bonus_max_extra);
  const multichainMult = 1 + extraChains * cfg.chain_bonus_per_extra;

  const scaleRatio = Math.max(protocol.tvl_usd, 1) / cfg.scale_anchor_usd;
  const scaleMult = clamp(scaleRatio ** cfg.scale_exponent, cfg.scale_floor, cfg.scale_cap);

  const baseValue = protocol.tvl_usd * categoryMultiple;
  const compositeMult = categoryMultiple * growthMult * maturityMult * multichainMult * scaleMult;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * compositeMult));

  // Valuation band reflecting peer dispersion when >=3 peers exist, else +/- 35%.
  let spreadLow = 0.68;
  let spreadHigh = 1.42;
  if (bench !== undefined && bench.peer_count >= 3 && bench.p25 !== null && bench.p75 !== null && bench.raw_median !== null && bench.raw_median > 0) {
    spreadLow = clamp(bench.p25 / bench.raw_median, 0.45, 0.82);
    spreadHigh = clamp(bench.p75 / bench.raw_median, 1.22, 1.85);
  }
  const lowValue = Math.max(1, Math.round(implied * spreadLow));
  const highValue = Math.max(implied, Math.round(implied * spreadHigh));

  // Readiness index (0..100): combines TVL depth, operating runway without token, momentum, and chain reach.
  const tvlComponent = clamp((Math.log10(Math.max(protocol.tvl_usd, 1_000_000)) - 6.7) / 2.8, 0, 1) * 42;
  const ageComponent = clamp(effectiveAge / 730, 0, 1) * 26;
  const momentumComponent = clamp((growthClamped + 30) / 80, 0, 1) * 18;
  const reachComponent = clamp((chainCount - 1) / 8, 0, 1) * 14;
  const readiness = Math.round(clamp(tvlComponent + ageComponent + momentumComponent + reachComponent, 1, 99));

  return {
    implied_value_usd: implied,
    breakdown: {
      category_multiple: round4(categoryMultiple),
      category_peer_count: peerCount,
      global_median_multiple: calibration.global_median,
      base_value_usd: Math.max(1, Math.round(baseValue)),
      growth_pct_clamped: round4(growthClamped),
      growth_multiplier: round4(growthMult),
      age_days: age,
      maturity_multiplier: round4(maturityMult),
      chain_count: chainCount,
      multichain_multiplier: round4(multichainMult),
      scale_multiplier: round4(scaleMult),
      composite_multiple: round4(compositeMult),
      low_value_usd: lowValue,
      high_value_usd: highValue,
      readiness_score: readiness,
    },
  };
}

/** Build the separated live-token benchmark table sorted by market cap descending. */
export function buildLiveBenchmarks(snapshot: Snapshot, limit = 40): LiveBenchmarkRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || b.tvl_usd - a.tvl_usd || cmpStr(a.slug, b.slug))
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      mcap_tvl_ratio: round4((p.mcap_usd as number) / p.tvl_usd),
      change_7d: p.change_7d,
      symbol: p.symbol,
      listed_at: p.listed_at,
    }));
}

/** Partition the snapshot dynamically into watchlist, early pre-token candidates, excluded, and live. */
export function partitionUniverse(snapshot: Snapshot): {
  watchlistProtocols: SnapshotProtocol[];
  earlyProtocols: SnapshotProtocol[];
  counts: UniverseCounts;
} {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlistSet = new Set(snapshot.watchlist);

  const watchlistProtocols: SnapshotProtocol[] = [];
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) watchlistProtocols.push(p);
  }

  const earlyProtocols = snapshot.protocols
    .filter((p) => !watchlistSet.has(p.slug) && isPreToken(p) && !isExcludedProduct(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || cmpStr(a.slug, b.slug));

  const liveAll = snapshot.protocols.filter((p) => !isPreToken(p));
  const liveWithMcap = liveAll.filter((p) => p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const preAll = snapshot.protocols.filter((p) => isPreToken(p));
  const excludedPre = preAll.length - watchlistProtocols.length - earlyProtocols.length;

  return {
    watchlistProtocols,
    earlyProtocols,
    counts: {
      total_protocols: snapshot.protocols.length,
      watchlist_count: watchlistProtocols.length,
      early_count: earlyProtocols.length,
      board_count: watchlistProtocols.length + earlyProtocols.length,
      excluded_pre_token_count: Math.max(0, excludedPre),
      live_token_count: liveAll.length,
      live_with_mcap_count: liveWithMcap.length,
    },
  };
}

/** Build the monotonically ranked board (1..N) using the supplied farm step builder. */
export function buildRankedBoard(
  snapshot: Snapshot,
  farmBuilder: (protocol: SnapshotProtocol, age: number | null, tier: 'watchlist' | 'early') => string[],
  cfg: ModelConfig = DEFAULT_MODEL,
): {
  board: BoardRow[];
  calibration: PeerCalibration;
  live: LiveBenchmarkRow[];
  counts: UniverseCounts;
} {
  const calibration = calibratePeerMultiples(snapshot, cfg);
  const { watchlistProtocols, earlyProtocols, counts } = partitionUniverse(snapshot);
  const live = buildLiveBenchmarks(snapshot, 40);

  const candidates: Array<{ protocol: SnapshotProtocol; tier: 'watchlist' | 'early' }> = [
    ...watchlistProtocols.map((protocol) => ({ protocol, tier: 'watchlist' as const })),
    ...earlyProtocols.map((protocol) => ({ protocol, tier: 'early' as const })),
  ];

  const scored = candidates.map(({ protocol, tier }) => {
    const { implied_value_usd, breakdown } = scoreProtocol(protocol, snapshot.as_of, calibration, cfg);
    return { protocol, tier, implied_value_usd, breakdown };
  });

  scored.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.protocol.tvl_usd - a.protocol.tvl_usd ||
      cmpStr(a.protocol.slug, b.protocol.slug),
  );

  const board: BoardRow[] = scored.map((entry, idx) => ({
    rank: idx + 1,
    slug: entry.protocol.slug,
    name: entry.protocol.name,
    tier: entry.tier,
    category: entry.protocol.category,
    chains: entry.protocol.chains,
    tvl_usd: entry.protocol.tvl_usd,
    change_7d: entry.protocol.change_7d,
    mcap_usd: entry.protocol.mcap_usd,
    listed_at: entry.protocol.listed_at,
    gecko_id: entry.protocol.gecko_id,
    symbol: entry.protocol.symbol,
    token_status: 'pre-token',
    age_days: entry.breakdown.age_days,
    implied_value_usd: entry.implied_value_usd,
    model: entry.breakdown,
    farm_steps: farmBuilder(entry.protocol, entry.breakdown.age_days, entry.tier),
  }));

  return { board, calibration, live, counts };
}

/** Parse and validate the sealed snapshot JSON document. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json root must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json missing YYYY-MM-DD as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json missing source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json missing positive integer floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json missing protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json missing watchlist string array');
  }

  const protocols: SnapshotProtocol[] = o.protocols.map((v, idx) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json protocol[${idx}] is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol[${idx}] missing slug, name, or finite tvl_usd`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });

  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Verify all gate invariants on the generated board before writing output. */
export function validateBoard(board: readonly BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `board row count ${board.length} outside [100, 4000]`;
  }
  const validSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seenSlugs = new Set<string>();
  for (const r of board) {
    if (!validSlugs.has(r.slug)) return `unknown slug ${r.slug}`;
    if (seenSlugs.has(r.slug)) return `duplicate slug ${r.slug}`;
    seenSlugs.add(r.slug);
    if (typeof r.name !== 'string' || r.name.trim().length === 0) return `empty name for ${r.slug}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `invalid implied_value_usd ${r.implied_value_usd} for ${r.slug}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps (expected 3..12)`;
    }
    for (const step of r.farm_steps) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) {
        return `${r.slug} has a farm step of ${t.length} chars (expected 20..600)`;
      }
    }
  }
  const missingWl = snapshot.watchlist.filter((s) => !seenSlugs.has(s));
  if (missingWl.length > 0) {
    return `missing ${missingWl.length} watchlist slugs: ${missingWl.slice(0, 5).join(', ')}`;
  }
  const sortedByRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < sortedByRank.length; i++) {
    if (sortedByRank[i]!.rank !== i + 1) return `expected rank ${i + 1}, got ${sortedByRank[i]!.rank}`;
    if (i > 0 && sortedByRank[i]!.implied_value_usd > sortedByRank[i - 1]!.implied_value_usd) {
      return `rank ${i + 1} (${sortedByRank[i]!.implied_value_usd}) exceeds rank ${i} (${sortedByRank[i - 1]!.implied_value_usd})`;
    }
  }
  if (sortedByRank.length >= 2 && sortedByRank[0]!.implied_value_usd === sortedByRank[sortedByRank.length - 1]!.implied_value_usd) {
    return 'all rows share identical implied_value_usd';
  }
  return null;
}
