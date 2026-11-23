// Concrete, attribute-driven farming playbook generator (Node 22+, stdlib only).
//
// Derives every step from the protocol's category, chains, TVL tier, 7-day TVL momentum,
// and operating age without hardcoding any protocol names. Every step states the exact
// action, estimated capital/gas cost, time commitment, and primary risk.

import type { SnapshotProtocol } from './model.ts';

/** Structured farm step used by both board.json serialization and the dashboard UI. */
export interface FarmStepDetail {
  step: number;
  phase: string;
  action: string;
  cost: string;
  time: string;
  risk: string;
}

/** High-level summary of capital, gas, duration, and risk profile for one protocol. */
export interface FarmPlanSummary {
  primary_chain: string;
  secondary_chain: string | null;
  suggested_capital_usd: number;
  estimated_gas_usd: number;
  hold_days: number;
  risk_tier: 'Moderate' | 'Elevated' | 'High';
  steps: FarmStepDetail[];
}

interface ChainFeeProfile {
  gasToken: string;
  setupGasUsd: number;
  weeklyGasUsd: number;
  unwindGasUsd: number;
  feeNote: string;
}

/** Derive realistic per-transaction fee estimates from the primary chain name. */
export function chainFeeProfile(chain: string): ChainFeeProfile {
  const c = chain.toLowerCase();
  if (c === 'ethereum') {
    return { gasToken: 'ETH', setupGasUsd: 9, weeklyGasUsd: 3, unwindGasUsd: 6, feeNote: 'batch during low-gwei UTC windows' };
  }
  if (c === 'bitcoin' || c === 'bsquared' || c === 'babylon genesis') {
    return { gasToken: 'BTC', setupGasUsd: 5, weeklyGasUsd: 2, unwindGasUsd: 4, feeNote: 'use medium-priority sat/vB fees' };
  }
  if (c === 'solana' || c === 'sui' || c === 'algorand' || c === 'stellar' || c === 'aptos' || c === 'noble' || c === 'ripple') {
    return { gasToken: chain, setupGasUsd: 0.2, weeklyGasUsd: 0.05, unwindGasUsd: 0.1, feeNote: 'keep a $5 native fee buffer' };
  }
  if (c === 'tron' || c === 'binance' || c === 'avalanche' || c === 'flare' || c === 'core' || c === 'bittensor') {
    return { gasToken: chain, setupGasUsd: 0.8, weeklyGasUsd: 0.25, unwindGasUsd: 0.5, feeNote: 'keep a $8 native gas buffer' };
  }
  // L2s and modern EVM chains (Base, Arbitrum, Optimism, Monad, Ink, Plume, Arc, etc.)
  return { gasToken: 'ETH/native', setupGasUsd: 0.5, weeklyGasUsd: 0.15, unwindGasUsd: 0.3, feeNote: 'keep a $5 L2 gas buffer' };
}

/** Format dollar gas figures cleanly without noisy decimals. */
function fmtGas(usd: number): string {
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/** Suggest pragmatic capital sizing based on TVL scale (higher TVL requires more weight to clear pro-rata floors). */
export function suggestedCapitalUsd(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 500;
  if (tvlUsd >= 250_000_000) return 300;
  if (tvlUsd >= 50_000_000) return 200;
  if (tvlUsd >= 15_000_000) return 125;
  return 75;
}

/** Recommend minimum continuous hold window from protocol operating age. */
export function recommendedHoldDays(ageDays: number | null): number {
  if (ageDays === null) return 45;
  if (ageDays < 150) return 60;
  if (ageDays < 450) return 45;
  return 30;
}

/** Derive overall farm risk tier from TVL depth, age, and 7-day TVL velocity. */
export function assessRiskTier(p: SnapshotProtocol, ageDays: number | null): 'Moderate' | 'Elevated' | 'High' {
  const chg = p.change_7d ?? 0;
  const young = ageDays !== null && ageDays < 120;
  const small = p.tvl_usd < 20_000_000;
  const outflow = chg < -12;
  const spike = chg > 100;
  const c = (p.category ?? '').toLowerCase();
  const complexCat = c.includes('leveraged') || c.includes('derivative') || c.includes('basis') || c.includes('prediction');

  let points = 0;
  if (small) points += 2;
  else if (p.tvl_usd < 50_000_000) points += 1;
  if (young) points += 1;
  if (outflow || spike) points += 1;
  if (complexCat) points += 1;

  if (points >= 3) return 'High';
  if (points >= 1) return 'Elevated';
  return 'Moderate';
}

/** Build the category-specific primary on-chain action and its dominant risk. */
function corePositionAction(
  p: SnapshotProtocol,
  chain: string,
  capital: number,
): { action: string; risk: string; setupMinutes: number } {
  const cat = (p.category ?? '').toLowerCase();
  const n = p.name;

  if (cat.includes('risk curator')) {
    return {
      action: `Deposit $${capital} USDC or ETH into ${n}'s highest-TVL curated vault on ${chain} and retain the ERC-4626 vault shares in one wallet to earn curator points.`,
      risk: 'Underlying lending-market bad debt, strategy reallocation lag, or temporary vault withdrawal queue.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('capital allocator')) {
    return {
      action: `Allocate $${capital} of blue-chip collateral into ${n}'s flagship vault on ${chain} and hold the receipt shares rather than looping across thin secondary pools.`,
      risk: 'Multi-strategy smart-contract composition risk and withdrawal cooldowns during volatility.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('lend') || cat.includes('collateral')) {
    const borrow = Math.round(capital * 0.25);
    return {
      action: `Supply $${capital} of USDC or blue-chip collateral to ${n} on ${chain}, and optionally borrow ~$${borrow} stablecoins (health factor > 2.2) to qualify on both supply and borrow tracks.`,
      risk: 'Oracle depeg, variable borrow-rate spikes, or liquidation if collateral drops sharply.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('dex') || cat.includes('liquidity manager')) {
    const swap = Math.max(25, Math.round(capital * 0.2));
    return {
      action: `Route 2 organic swaps (~$${swap} each) on ${n} (${chain}) and deploy $${capital} into its deepest major or stablecoin LP pool with a conservative price range.`,
      risk: 'Impermanent loss on volatile pairs, thin-pool slippage, or out-of-range concentrated LP inactivity.',
      setupMinutes: 20,
    };
  }
  if (cat.includes('rwa')) {
    return {
      action: `Subscribe or mint $${capital} of ${n}'s yield-bearing RWA token on ${chain} (completing eligibility checks if required) and hold the receipt on-chain.`,
      risk: 'Issuer counterparty/custody risk, regional KYC restrictions, and T+1 to T+3 redemption settlement windows.',
      setupMinutes: 20,
    };
  }
  if (cat.includes('cdp') || cat.includes('stablecoin')) {
    const mint = Math.round(capital * 0.45);
    return {
      action: `Lock $${capital} collateral on ${n} (${chain}) to mint ~$${mint} of its stable asset (>=180% collateral ratio) and stake the minted balance in the native stability or LP pool.`,
      risk: 'Stablecoin depeg, redemption-mode triggers, or collateral liquidation during sharp drawdowns.',
      setupMinutes: 20,
    };
  }
  if (cat.includes('basis trading')) {
    return {
      action: `Deposit $${capital} USDC into ${n}'s delta-neutral basis/funding vault on ${chain} and stake the receipt token to capture both funding yield and pre-TGE points.`,
      risk: 'Prolonged negative perpetual funding rates, CEX venue counterparty exposure, or unstaking cooldowns.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('derivative') || cat.includes('option')) {
    const clip = Math.max(20, Math.round(capital * 0.2));
    return {
      action: `Deposit $${capital} USDC margin on ${n} (${chain}), allocate part to the protocol liquidity vault if offered, and execute 2–3 small hedged trades (~$${clip} notional) to log verified volume.`,
      risk: 'Trading fee drag, funding slippage, and smart-contract or ADL risk on leveraged positions.',
      setupMinutes: 20,
    };
  }
  if (cat.includes('yield') || cat.includes('farm')) {
    return {
      action: `Deposit $${capital} into ${n}'s deepest non-leveraged stable or major-asset yield vault on ${chain} and let yield accrue on-chain without frequent dust withdrawals.`,
      risk: 'Underlying strategy contract vulnerability, reward-token dilution, or performance fee drag.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('restak') || cat.includes('staking') || cat.includes('btc')) {
    return {
      action: `Stake or restake $${capital} of the native asset via ${n} on ${chain}, delegate to an active operator if prompted, and keep the staked receipt untouched in your wallet.`,
      risk: 'Slashing exposure, unbonding periods (7–21 days), and receipt-token secondary-market discount.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('prediction')) {
    const ticket = Math.max(15, Math.round(capital * 0.2));
    return {
      action: `Fund $${capital} USDC on ${n} (${chain}) and place 3–4 measured positions (~$${ticket} each) across liquid markets with clear resolution rules to build organic trader history.`,
      risk: 'Directional outcome loss, bid-ask spread friction, or ambiguous market resolution disputes.',
      setupMinutes: 20,
    };
  }
  if (cat.includes('insurance')) {
    return {
      action: `Underwrite $${capital} in ${n}'s safest diversified cover pool on ${chain} (or purchase modest protocol cover) and retain the active staking/policy position.`,
      risk: 'Claim payout drawdown if an insured protocol suffers an exploit, plus lockup windows.',
      setupMinutes: 15,
    };
  }
  if (cat.includes('chain') || cat.includes('payment') || cat.includes('privacy')) {
    return {
      action: `Bridge or fund $${capital} onto ${n} (${chain}), execute 2–3 native transfers or app interactions, and keep at least 80% of the balance active in native liquidity.`,
      risk: 'Bridge smart-contract risk, lower exit liquidity on emerging networks, and fee overhead.',
      setupMinutes: 20,
    };
  }
  return {
    action: `Deposit $${capital} of USDC or the primary supported asset into ${n}'s main contract on ${chain} and maintain an active on-chain receipt balance.`,
    risk: 'Smart-contract bugs, unannounced rule changes in points programs, or withdrawal friction.',
    setupMinutes: 15,
  };
}

/** Generate a complete 5-step farming playbook tailored to the protocol's snapshot attributes. */
export function buildFarmPlan(
  p: SnapshotProtocol,
  ageDays: number | null,
  tier: 'watchlist' | 'early',
): FarmPlanSummary {
  const primaryChain = p.chains.length > 0 ? p.chains[0]! : 'its primary chain';
  const secondaryChain = p.chains.length > 1 ? p.chains[1]! : null;
  const fees = chainFeeProfile(primaryChain);
  const capital = suggestedCapitalUsd(p.tvl_usd);
  const holdDays = recommendedHoldDays(ageDays);
  const weeks = Math.max(4, Math.ceil(holdDays / 7));
  const riskTier = assessRiskTier(p, ageDays);
  const core = corePositionAction(p, primaryChain, capital);

  const weeklyGasTotal = fees.weeklyGasUsd * weeks;
  const estTotalGas = Math.round((fees.setupGasUsd + weeklyGasTotal + fees.unwindGasUsd) * 100) / 100;

  const chg = p.change_7d;
  const momentumClause =
    chg !== null && chg <= -10
      ? `TVL fell ${chg.toFixed(1)}% in 7d, so check withdrawal liquidity and cap size before adding.`
      : chg !== null && chg >= 15
        ? `TVL surged +${chg.toFixed(1)}% in 7d, indicating faster points dilution; enter early rather than chasing late.`
        : `Track weekly TVL stability (${chg === null ? '7d unreported' : `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 7d`}) and exit if utilization spikes.`;

  const multiChainCadence =
    secondaryChain !== null
      ? `Execute 1 qualifying action per week on ${primaryChain} and mirror a smaller secondary deposit or swap on ${secondaryChain} (${p.chains.length} active chains) to capture cross-chain eligibility.`
      : `Execute 1 organic qualifying action per week on ${primaryChain} (compound, rebalance, swap, or vote) so the wallet builds consistent multi-week activity rather than a single-tx footprint.`;

  const tierSizingNote =
    tier === 'early'
      ? `Because ${p.name} sits below the $50M watchlist floor ($${(p.tvl_usd / 1_000_000).toFixed(1)}M TVL), keep position sizing capped at <=2% of portfolio.`
      : `At $${(p.tvl_usd / 1_000_000).toFixed(1)}M TVL on the watchlist, avoid splitting $${capital} across dust wallets that may miss minimum balance thresholds.`;

  const steps: FarmStepDetail[] = [
    {
      step: 1,
      phase: 'Wallet & Funding',
      action: `Provision a dedicated wallet on ${primaryChain} funded with $${capital} working capital plus ${fees.gasToken} gas (${fees.feeNote}). ${tierSizingNote}`,
      cost: `~${fmtGas(fees.setupGasUsd)} funding/approval gas (+ $${capital} principal)`,
      time: '10 minutes',
      risk: 'Seed-phrase leakage, malicious approval phishing, or bridging through spoofed frontends.',
    },
    {
      step: 2,
      phase: 'Core Position',
      action: core.action,
      cost: `$${capital} deployed principal + ~${fmtGas(fees.setupGasUsd)} gas`,
      time: `${core.setupMinutes} minutes`,
      risk: core.risk,
    },
    {
      step: 3,
      phase: 'Weekly Cadence',
      action: multiChainCadence,
      cost: `~${fmtGas(fees.weeklyGasUsd)}/week (~${fmtGas(weeklyGasTotal)} over ${weeks} weeks)`,
      time: `10 minutes/week for ${weeks} weeks`,
      risk: 'Sybil filtering from repetitive bot-like patterns or cumulative gas exceeding small-wallet yield.',
    },
    {
      step: 4,
      phase: 'Retention & Monitoring',
      action: `Hold the qualifying position continuously for at least ${holdDays} days across multiple epochs. ${momentumClause}`,
      cost: `$0 monitoring fee ($${capital} opportunity cost during lock)`,
      time: `${holdDays} days active hold (5 min/week check)`,
      risk: 'Smart-contract exploit during holding period, yield compression, or sudden TVL liquidity crunch.',
    },
    {
      step: 5,
      phase: 'Verification & Unwind',
      action: `Log wallet address, entry/exit tx hashes, and epoch totals; verify any future claim strictly via ${p.name}'s official domain and revoke unused approvals before unwinding.`,
      cost: `$0 verification + ~${fmtGas(fees.unwindGasUsd)} exit/revoke gas`,
      time: '15 minutes',
      risk: 'Fake claim drainers, delayed withdrawal queues, or missing a post-snapshot claim deadline.',
    },
  ];

  return {
    primary_chain: primaryChain,
    secondary_chain: secondaryChain,
    suggested_capital_usd: capital,
    estimated_gas_usd: estTotalGas,
    hold_days: holdDays,
    risk_tier: riskTier,
    steps,
  };
}

/** Serialize one structured FarmStepDetail into a gate-compliant 20..600 char string. */
export function formatFarmStep(step: FarmStepDetail): string {
  let line = `[${step.phase}] ${step.action} Cost: ${step.cost}. Time: ${step.time}. Risk: ${step.risk}`;
  line = line.replace(/\s+/g, ' ').trim();
  if (line.length > 600) {
    line = `${line.slice(0, 597).trimEnd()}...`;
  }
  if (line.length < 20) {
    line = `${line} Verify protocol documentation before transacting.`;
  }
  return line;
}

/** Return the string array of farm steps required by /output/board.json. */
export function buildFarmStepStrings(
  p: SnapshotProtocol,
  ageDays: number | null,
  tier: 'watchlist' | 'early',
): string[] {
  return buildFarmPlan(p, ageDays, tier).steps.map(formatFarmStep);
}
