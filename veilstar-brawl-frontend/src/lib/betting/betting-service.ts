/**
 * XLM Betting Service
 * Handles odds calculation, payout computation, and pool management
 * Adapted for Stellar/XLM (stroops = 1 XLM = 10^7 stroops)
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Fee percentage (0.1%) */
export const FEE_PERCENTAGE = 0.001;

/** Bot house fee percentage (1%) */
export const HOUSE_FEE_PERCENTAGE = 0.01;

/** Stroops per XLM */
export const STROOPS_PER_XLM = BigInt(10000000);

// =============================================================================
// TYPES
// =============================================================================

export interface BettingPool {
    id: string;
    matchId: string;
    player1Total: bigint;
    player2Total: bigint;
    totalPool: bigint;
    totalFees: bigint;
    status: 'open' | 'locked' | 'resolved' | 'refunded';
    winner?: 'player1' | 'player2';
}

export interface Bet {
    id: string;
    poolId: string;
    bettorAddress: string;
    betOn: 'player1' | 'player2';
    amount: bigint;
    feePaid: bigint;
    netAmount: bigint;
    txId: string;
    payoutAmount?: bigint;
    status: 'pending' | 'confirmed' | 'won' | 'lost' | 'refunded';
}

export interface OddsInfo {
    player1Odds: number;
    player2Odds: number;
    player1Percentage: number;
    player2Percentage: number;
    totalPool: bigint;
    player1Pool: bigint;
    player2Pool: bigint;
}

export interface PayoutResult {
    bettorAddress: string;
    betAmount: bigint;
    payoutAmount: bigint;
    profit: bigint;
}

// =============================================================================
// ODDS CALCULATION
// =============================================================================

export function calculateOdds(pool: BettingPool): OddsInfo {
    const p1 = pool.player1Total;
    const p2 = pool.player2Total;
    const total = p1 + p2;

    // If no bets, default to even odds
    if (total === 0n) {
        return {
            player1Odds: 2.0,
            player2Odds: 2.0,
            player1Percentage: 50,
            player2Percentage: 50,
            totalPool: 0n,
            player1Pool: 0n,
            player2Pool: 0n,
        };
    }

    // If one side has no bets
    if (p1 === 0n) {
        return {
            player1Odds: 0,
            player2Odds: 1.0,
            player1Percentage: 0,
            player2Percentage: 100,
            totalPool: total,
            player1Pool: p1,
            player2Pool: p2,
        };
    }

    if (p2 === 0n) {
        return {
            player1Odds: 1.0,
            player2Odds: 0,
            player1Percentage: 100,
            player2Percentage: 0,
            totalPool: total,
            player1Pool: p1,
            player2Pool: p2,
        };
    }

    // Calculate odds as multiplier (total pool / winning side)
    const totalNum = Number(total);
    const p1Num = Number(p1);
    const p2Num = Number(p2);

    const player1Odds = totalNum / p1Num;
    const player2Odds = totalNum / p2Num;

    const player1Percentage = (p1Num / totalNum) * 100;
    const player2Percentage = (p2Num / totalNum) * 100;

    return {
        player1Odds,
        player2Odds,
        player1Percentage,
        player2Percentage,
        totalPool: total,
        player1Pool: p1,
        player2Pool: p2,
    };
}

// =============================================================================
// FEE CALCULATION
// =============================================================================

export function calculateFee(amount: bigint): bigint {
    // 0.1% fee
    return amount / 1000n;
}

export function calculateNetAmount(amount: bigint): bigint {
    const fee = calculateFee(amount);
    return amount - fee;
}

// =============================================================================
// PAYOUT CALCULATION
// =============================================================================

export function calculatePayout(bet: Bet, pool: BettingPool): bigint {
    const winningPool = bet.betOn === 'player1' ? pool.player1Total : pool.player2Total;
    const totalPool = pool.player1Total + pool.player2Total;

    if (winningPool === 0n || totalPool === 0n) return 0n;

    // Payout = netAmount * (totalPool / winningPool)
    return (bet.netAmount * totalPool) / winningPool;
}

export function calculateAllPayouts(bets: Bet[], pool: BettingPool): PayoutResult[] {
    if (!pool.winner) return [];

    const winningBets = bets.filter(b => b.betOn === pool.winner && b.status === 'confirmed');

    return winningBets.map(bet => {
        const payoutAmount = calculatePayout(bet, pool);
        return {
            bettorAddress: bet.bettorAddress,
            betAmount: bet.amount,
            payoutAmount,
            profit: payoutAmount - bet.amount,
        };
    });
}

// =============================================================================
// POOL SIMULATION
// =============================================================================

export function simulateOddsAfterBet(
    pool: BettingPool,
    betOn: 'player1' | 'player2',
    amount: bigint
): OddsInfo {
    const netAmount = calculateNetAmount(amount);
    const simPool: BettingPool = {
        ...pool,
        player1Total: pool.player1Total + (betOn === 'player1' ? netAmount : 0n),
        player2Total: pool.player2Total + (betOn === 'player2' ? netAmount : 0n),
        totalPool: pool.totalPool + netAmount,
    };
    return calculateOdds(simPool);
}

export function calculatePotentialWinnings(
    pool: BettingPool,
    betOn: 'player1' | 'player2',
    amount: bigint
): { payout: bigint; profit: bigint; odds: number } {
    const simOdds = simulateOddsAfterBet(pool, betOn, amount);
    const netAmount = calculateNetAmount(amount);
    const odds = betOn === 'player1' ? simOdds.player1Odds : simOdds.player2Odds;
    const payout = BigInt(Math.floor(Number(netAmount) * odds));
    return { payout, profit: payout - amount, odds };
}

export function calculateHouseFee(amount: bigint): bigint {
    return amount / 100n;
}

export function calculateHouseTotalCost(amount: bigint): bigint {
    return amount + calculateHouseFee(amount);
}

export function calculateHousePayout(amount: bigint): bigint {
    return amount * 2n;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

export function stroopsToXlm(stroops: bigint): number {
    return Number(stroops) / Number(STROOPS_PER_XLM);
}

export function xlmToStroops(xlm: number): bigint {
    return BigInt(Math.round(xlm * Number(STROOPS_PER_XLM)));
}

export function formatOdds(odds: number): string {
    if (odds === 0) return "N/A";
    return `${odds.toFixed(2)}x`;
}

export function formatXlm(stroops: bigint): string {
    const xlm = stroopsToXlm(stroops);
    if (xlm >= 1000) return `${(xlm / 1000).toFixed(1)}K XLM`;
    if (xlm >= 1) return `${xlm.toFixed(2)} XLM`;
    return `${xlm.toFixed(4)} XLM`;
}

// =============================================================================
// DATABASE HELPERS
// =============================================================================

export function transformPoolFromDb(row: {
    id: string;
    match_id: string;
    player1_total: number;
    player2_total: number;
    total_pool: number;
    total_fees: number;
    status: string;
    winner?: string;
}): BettingPool {
    return {
        id: row.id,
        matchId: row.match_id,
        player1Total: BigInt(row.player1_total),
        player2Total: BigInt(row.player2_total),
        totalPool: BigInt(row.total_pool),
        totalFees: BigInt(row.total_fees),
        status: row.status as BettingPool['status'],
        winner: row.winner as BettingPool['winner'],
    };
}

export function transformBetFromDb(row: {
    id: string;
    pool_id: string;
    bettor_address: string;
    bet_on: string;
    amount: number;
    fee_paid: number;
    net_amount: number;
    tx_id: string;
    payout_amount?: number;
    status: string;
}): Bet {
    return {
        id: row.id,
        poolId: row.pool_id,
        bettorAddress: row.bettor_address,
        betOn: row.bet_on as Bet['betOn'],
        amount: BigInt(row.amount),
        feePaid: BigInt(row.fee_paid),
        netAmount: BigInt(row.net_amount),
        txId: row.tx_id,
        payoutAmount: row.payout_amount ? BigInt(row.payout_amount) : undefined,
        status: row.status as Bet['status'],
    };
}

// =============================================================================
// BETTING LOCK LOGIC
// =============================================================================

export function shouldLockBetting(
    matchStatus: string,
    player1RoundsWon: number,
    player2RoundsWon: number,
    format: 'best_of_3' | 'best_of_5'
): boolean {
    // Lock if match is completed or cancelled
    if (matchStatus === 'completed' || matchStatus === 'cancelled') return true;

    // Lock if match is not yet in progress
    if (matchStatus !== 'in_progress') return false;

    const roundsToWin = format === 'best_of_3' ? 2 : 3;

    // Lock if any player is one round away from winning
    if (player1RoundsWon >= roundsToWin - 1 || player2RoundsWon >= roundsToWin - 1) {
        return true;
    }

    return false;
}
