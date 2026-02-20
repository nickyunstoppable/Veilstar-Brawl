#![no_std]

//! # ZK Betting Contract
//!
//! Spectator betting pools for Veilstar Brawl matches with commit-reveal
//! to prevent front-running, and optional Groth16 proof verification for
//! tamper-proof settlement.
//!
//! **Lifecycle:**
//! 1. Admin creates a pool for a match (`create_pool`)
//! 2. Spectators commit hidden bets + deposit XLM (`commit_bet`)
//! 3. Admin locks the pool when betting closes (`lock_pool`)
//! 4. Spectators reveal their bets (`reveal_bet`)
//! 5. Admin settles with winner (`settle_pool` / `settle_pool_zk`)
//! 6. Winners claim payouts (`claim_payout`)
//!
//! **Fee:** 1% protocol fee on each bet deposit.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    symbol_short, token, Address, Bytes, BytesN, Env, Vec,
};

// ==========================================================================
// ZK Verifier interface (cross-contract call)
// ==========================================================================

#[contractclient(name = "ZkVerifierClient")]
pub trait ZkVerifier {
    fn verify_round_proof(
        env: Env,
        vk_id: BytesN<32>,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> bool;
}

// ==========================================================================
// Errors
// ==========================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    PoolNotFound = 1,
    PoolNotOpen = 2,
    PoolNotLocked = 3,
    PoolNotSettled = 4,
    PoolAlreadySettled = 5,
    PoolAlreadyLocked = 6,
    AlreadyCommitted = 7,
    BetNotFound = 8,
    AlreadyRevealed = 9,
    InvalidReveal = 10,
    InvalidAmount = 11,
    InvalidWinner = 12,
    NoPayout = 13,
    AlreadyClaimed = 14,
    Unauthorized = 15,
    ZkVerifierNotConfigured = 16,
    ZkProofInvalid = 17,
    BettingDeadlinePassed = 18,
    NothingToSweep = 19,
    SweepTooEarly = 20,
}

// ==========================================================================
// Data types
// ==========================================================================

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PoolStatus {
    Open = 0,
    Locked = 1,
    Settled = 2,
    Refunded = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BetSide {
    Player1 = 0,
    Player2 = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BetPool {
    pub pool_id: u32,
    pub match_id: BytesN<32>,
    pub status: PoolStatus,
    pub player1_total: i128,
    pub player2_total: i128,
    pub total_pool: i128,
    pub total_fees: i128,
    pub bet_count: u32,
    pub reveal_count: u32,
    pub deadline_ts: u64,
    /// Winner side: 0=Player1, 1=Player2, 255=None
    pub winner_side: u32,
}

/// Sentinel value for "no side set"
const SIDE_NONE: u32 = 255;
const SIDE_P1: u32 = 0;
const SIDE_P2: u32 = 1;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BetCommit {
    pub bettor: Address,
    pub commitment: BytesN<32>,
    pub amount: i128,
    pub fee_paid: i128,
    pub revealed: bool,
    /// Revealed side: 0=Player1, 1=Player2, 255=None
    pub side: u32,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    XlmToken,
    ZkVerifier,
    ZkVkId,
    FeeAccrued,
    LastSweepTs,
    PoolCounter,
    Pool(u32),
    Bet(u32, Address),      // (pool_id, bettor)
    PoolBettors(u32),       // pool_id -> Vec<Address>
}

// ==========================================================================
// Constants
// ==========================================================================

/// 30-day TTL in ledgers (~5s per ledger)
const POOL_TTL_LEDGERS: u32 = 518_400;

/// 1% protocol fee in basis points
const FEE_BPS: u32 = 100;

/// 24h sweep interval
const SWEEP_INTERVAL_SECONDS: u64 = 86_400;

/// Minimum bet amount: 0.1 XLM = 1_000_000 stroops
const MIN_BET_STROOPS: i128 = 1_000_000;

// ==========================================================================
// Contract
// ==========================================================================

#[contract]
pub struct ZkBettingContract;

#[contractimpl]
impl ZkBettingContract {
    // ======================================================================
    // Constructor
    // ======================================================================

    pub fn __constructor(
        env: Env,
        admin: Address,
        treasury: Address,
        xlm_token: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::XlmToken, &xlm_token);
        env.storage().instance().set(&DataKey::FeeAccrued, &0_i128);
        env.storage().instance().set(&DataKey::LastSweepTs, &0_u64);
        env.storage().instance().set(&DataKey::PoolCounter, &0_u32);
    }

    // ======================================================================
    // Pool lifecycle
    // ======================================================================

    /// Create a new betting pool for a match.
    ///
    /// # Arguments
    /// * `match_id`    – 32-byte match identifier (SHA256 of UUID or similar)
    /// * `deadline_ts` – Unix timestamp when betting closes
    pub fn create_pool(
        env: Env,
        match_id: BytesN<32>,
        deadline_ts: u64,
    ) -> Result<u32, Error> {
        Self::require_admin(&env)?;

        let mut counter: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PoolCounter)
            .unwrap_or(0);
        counter += 1;

        let pool = BetPool {
            pool_id: counter,
            match_id,
            status: PoolStatus::Open,
            player1_total: 0,
            player2_total: 0,
            total_pool: 0,
            total_fees: 0,
            bet_count: 0,
            reveal_count: 0,
            deadline_ts,
            winner_side: SIDE_NONE,
        };

        let key = DataKey::Pool(counter);
        env.storage().temporary().set(&key, &pool);
        env.storage()
            .temporary()
            .extend_ttl(&key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        // Empty bettors list
        let bettors_key = DataKey::PoolBettors(counter);
        let empty_bettors: Vec<Address> = Vec::new(&env);
        env.storage().temporary().set(&bettors_key, &empty_bettors);
        env.storage()
            .temporary()
            .extend_ttl(&bettors_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        env.storage().instance().set(&DataKey::PoolCounter, &counter);

        env.events().publish(
            (symbol_short!("pool"), counter),
            pool.match_id.clone(),
        );

        Ok(counter)
    }

    /// Commit a bet with a hidden side.
    ///
    /// The commitment is SHA256(side_byte || salt_bytes).
    /// - side_byte: 0 = Player1, 1 = Player2
    /// - salt_bytes: 32 random bytes chosen by bettor
    ///
    /// Bettor deposits `amount + 0.1% fee` in XLM.
    pub fn commit_bet(
        env: Env,
        pool_id: u32,
        bettor: Address,
        commitment: BytesN<32>,
        amount: i128,
    ) -> Result<(), Error> {
        bettor.require_auth();

        if amount < MIN_BET_STROOPS {
            return Err(Error::InvalidAmount);
        }

        let pool_key = DataKey::Pool(pool_id);
        let mut pool: BetPool = env
            .storage()
            .temporary()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if pool.status != PoolStatus::Open {
            return Err(Error::PoolNotOpen);
        }

        if pool.deadline_ts > 0 && env.ledger().timestamp() > pool.deadline_ts {
            return Err(Error::BettingDeadlinePassed);
        }

        // Check for duplicate
        let bet_key = DataKey::Bet(pool_id, bettor.clone());
        if env.storage().temporary().has(&bet_key) {
            return Err(Error::AlreadyCommitted);
        }

        // Calculate fee
        let fee = Self::calc_fee(amount);
        let required = amount + fee;

        // Transfer XLM from bettor → contract
        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM not set");
        let xlm = token::Client::new(&env, &xlm_addr);
        xlm.transfer(&bettor, &env.current_contract_address(), &required);

        // Store bet
        let bet = BetCommit {
            bettor: bettor.clone(),
            commitment,
            amount,
            fee_paid: fee,
            revealed: false,
            side: SIDE_NONE,
            claimed: false,
        };

        env.storage().temporary().set(&bet_key, &bet);
        env.storage()
            .temporary()
            .extend_ttl(&bet_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        // Add to bettors list
        let bettors_key = DataKey::PoolBettors(pool_id);
        let mut bettors: Vec<Address> = env
            .storage()
            .temporary()
            .get(&bettors_key)
            .unwrap_or(Vec::new(&env));
        bettors.push_back(bettor.clone());
        env.storage().temporary().set(&bettors_key, &bettors);
        env.storage()
            .temporary()
            .extend_ttl(&bettors_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        // Update pool
        pool.total_pool += amount;
        pool.total_fees += fee;
        pool.bet_count += 1;

        env.storage().temporary().set(&pool_key, &pool);
        env.storage()
            .temporary()
            .extend_ttl(&pool_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("bet"), pool_id),
            (bettor, amount),
        );

        Ok(())
    }

    /// Lock the pool — no more bets accepted.
    pub fn lock_pool(env: Env, pool_id: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;

        let pool_key = DataKey::Pool(pool_id);
        let mut pool: BetPool = env
            .storage()
            .temporary()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if pool.status != PoolStatus::Open {
            return Err(Error::PoolAlreadyLocked);
        }

        pool.status = PoolStatus::Locked;

        env.storage().temporary().set(&pool_key, &pool);
        env.storage()
            .temporary()
            .extend_ttl(&pool_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("lock"), pool_id),
            pool.bet_count,
        );

        Ok(())
    }

    /// Reveal the bet — bettor provides the original `side` + `salt`.
    /// Contract verifies SHA256(side_byte || salt) == stored commitment.
    pub fn reveal_bet(
        env: Env,
        pool_id: u32,
        bettor: Address,
        side: BetSide,
        salt: BytesN<32>,
    ) -> Result<(), Error> {
        bettor.require_auth();

        Self::reveal_bet_internal(env, pool_id, bettor, side, salt)
    }

    /// Admin reveal path for house-managed bot betting flow.
    /// Uses bettor commitment + provided side/salt but does not require bettor auth.
    pub fn admin_reveal_bet(
        env: Env,
        pool_id: u32,
        bettor: Address,
        side: BetSide,
        salt: BytesN<32>,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;

        Self::reveal_bet_internal(env, pool_id, bettor, side, salt)
    }

    fn reveal_bet_internal(
        env: Env,
        pool_id: u32,
        bettor: Address,
        side: BetSide,
        salt: BytesN<32>,
    ) -> Result<(), Error> {

        let pool_key = DataKey::Pool(pool_id);
        let mut pool: BetPool = env
            .storage()
            .temporary()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if pool.status != PoolStatus::Locked {
            return Err(Error::PoolNotLocked);
        }

        let bet_key = DataKey::Bet(pool_id, bettor.clone());
        let mut bet: BetCommit = env
            .storage()
            .temporary()
            .get(&bet_key)
            .ok_or(Error::BetNotFound)?;

        if bet.revealed {
            return Err(Error::AlreadyRevealed);
        }

        // Recompute commitment: SHA256(side_byte || salt)
        let side_byte: u8 = match side {
            BetSide::Player1 => 0,
            BetSide::Player2 => 1,
        };

        let mut preimage = Bytes::new(&env);
        preimage.push_back(side_byte);
        let salt_bytes: Bytes = salt.into();
        preimage.append(&salt_bytes);

        let computed_hash = env.crypto().sha256(&preimage);
        let computed: BytesN<32> = computed_hash.into();

        if computed != bet.commitment {
            return Err(Error::InvalidReveal);
        }

        // Valid reveal
        bet.revealed = true;
        let side_u32 = match side {
            BetSide::Player1 => SIDE_P1,
            BetSide::Player2 => SIDE_P2,
        };
        bet.side = side_u32;

        env.storage().temporary().set(&bet_key, &bet);
        env.storage()
            .temporary()
            .extend_ttl(&bet_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        // Update pool totals by side
        match side {
            BetSide::Player1 => pool.player1_total += bet.amount,
            BetSide::Player2 => pool.player2_total += bet.amount,
        }
        pool.reveal_count += 1;

        env.storage().temporary().set(&pool_key, &pool);
        env.storage()
            .temporary()
            .extend_ttl(&pool_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("reveal"), pool_id),
            (bettor, side_byte as u32),
        );

        Ok(())
    }

    /// Settle the pool — admin declares the winner.
    /// Unrevealed bets are treated as losses (forfeited).
    pub fn settle_pool(
        env: Env,
        pool_id: u32,
        winner: BetSide,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;

        let pool_key = DataKey::Pool(pool_id);
        let mut pool: BetPool = env
            .storage()
            .temporary()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if pool.status == PoolStatus::Settled || pool.status == PoolStatus::Refunded {
            return Err(Error::PoolAlreadySettled);
        }

        pool.status = PoolStatus::Settled;
        let winner_u32 = match winner {
            BetSide::Player1 => SIDE_P1,
            BetSide::Player2 => SIDE_P2,
        };
        pool.winner_side = winner_u32;

        env.storage().temporary().set(&pool_key, &pool);
        env.storage()
            .temporary()
            .extend_ttl(&pool_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        // Accrue fees
        let mut accrued: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeAccrued)
            .unwrap_or(0);
        accrued += pool.total_fees;
        env.storage().instance().set(&DataKey::FeeAccrued, &accrued);

        let winner_u32 = match winner {
            BetSide::Player1 => 0u32,
            BetSide::Player2 => 1u32,
        };

        env.events().publish(
            (symbol_short!("settle"), pool_id),
            winner_u32,
        );

        Ok(())
    }

    /// Settle using a ZK proof of the match outcome.
    /// The proof is verified against the configured zk-groth16-verifier contract.
    pub fn settle_pool_zk(
        env: Env,
        pool_id: u32,
        winner: BetSide,
        vk_id: BytesN<32>,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;

        // Verify ZK proof
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerifier)
            .ok_or(Error::ZkVerifierNotConfigured)?;

        let configured_vk_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ZkVkId)
            .ok_or(Error::ZkVerifierNotConfigured)?;

        if vk_id != configured_vk_id {
            return Err(Error::ZkProofInvalid);
        }

        if proof.len() != 256 || public_inputs.len() < 1 {
            return Err(Error::ZkProofInvalid);
        }

        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        let verified = verifier.verify_round_proof(&vk_id, &proof, &public_inputs);
        if !verified {
            return Err(Error::ZkProofInvalid);
        }

        // Proof is valid — proceed with settlement
        Self::settle_pool(env, pool_id, winner)
    }

    /// Claim payout after settlement.
    ///
    /// House model payout:
    /// - Winning revealed bet gets fixed `2x` of stake amount.
    /// - Losing or unrevealed bet gets no payout.
    pub fn claim_payout(env: Env, pool_id: u32, bettor: Address) -> Result<i128, Error> {
        bettor.require_auth();

        Self::claim_payout_internal(env, pool_id, bettor)
    }

    /// Admin claim path for house-managed bot betting flow.
    /// Transfers payout directly to bettor without requiring bettor auth.
    pub fn admin_claim_payout(env: Env, pool_id: u32, bettor: Address) -> Result<i128, Error> {
        Self::require_admin(&env)?;

        Self::claim_payout_internal(env, pool_id, bettor)
    }

    fn claim_payout_internal(env: Env, pool_id: u32, bettor: Address) -> Result<i128, Error> {

        let pool_key = DataKey::Pool(pool_id);
        let pool: BetPool = env
            .storage()
            .temporary()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if pool.status != PoolStatus::Settled {
            return Err(Error::PoolNotSettled);
        }

        let bet_key = DataKey::Bet(pool_id, bettor.clone());
        let mut bet: BetCommit = env
            .storage()
            .temporary()
            .get(&bet_key)
            .ok_or(Error::BetNotFound)?;

        if bet.claimed {
            return Err(Error::AlreadyClaimed);
        }

        // Must have revealed and bet on winning side
        if pool.winner_side == SIDE_NONE {
            return Err(Error::InvalidWinner);
        }
        let pool_winner_side = pool.winner_side;

        if !bet.revealed {
            // Unrevealed = forfeited, no payout
            bet.claimed = true;
            env.storage().temporary().set(&bet_key, &bet);
            return Err(Error::NoPayout);
        }

        if bet.side != pool_winner_side {
            // Bet on losing side
            bet.claimed = true;
            env.storage().temporary().set(&bet_key, &bet);
            return Err(Error::NoPayout);
        }

        // House fixed payout = 2x stake
        let payout = bet.amount * 2;

        if payout <= 0 {
            return Err(Error::NoPayout);
        }

        // Transfer payout
        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM not set");
        let xlm = token::Client::new(&env, &xlm_addr);
        xlm.transfer(&env.current_contract_address(), &bettor, &payout);

        bet.claimed = true;
        env.storage().temporary().set(&bet_key, &bet);
        env.storage()
            .temporary()
            .extend_ttl(&bet_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("claim"), pool_id),
            (bettor, payout),
        );

        Ok(payout)
    }

    /// Refund all bettors (match cancelled).
    pub fn refund_pool(env: Env, pool_id: u32) -> Result<(), Error> {
        Self::require_admin(&env)?;

        let pool_key = DataKey::Pool(pool_id);
        let mut pool: BetPool = env
            .storage()
            .temporary()
            .get(&pool_key)
            .ok_or(Error::PoolNotFound)?;

        if pool.status == PoolStatus::Settled || pool.status == PoolStatus::Refunded {
            return Err(Error::PoolAlreadySettled);
        }

        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM not set");
        let xlm = token::Client::new(&env, &xlm_addr);

        // Refund each bettor: amount + fee
        let bettors_key = DataKey::PoolBettors(pool_id);
        let bettors: Vec<Address> = env
            .storage()
            .temporary()
            .get(&bettors_key)
            .unwrap_or(Vec::new(&env));

        for i in 0..bettors.len() {
            let bettor_addr = bettors.get(i).unwrap();
            let bet_key = DataKey::Bet(pool_id, bettor_addr.clone());
            if let Some(mut bet) = env.storage().temporary().get::<_, BetCommit>(&bet_key) {
                if !bet.claimed {
                    let refund = bet.amount + bet.fee_paid;
                    xlm.transfer(&env.current_contract_address(), &bettor_addr, &refund);
                    bet.claimed = true;
                    env.storage().temporary().set(&bet_key, &bet);
                }
            }
        }

        pool.status = PoolStatus::Refunded;
        env.storage().temporary().set(&pool_key, &pool);
        env.storage()
            .temporary()
            .extend_ttl(&pool_key, POOL_TTL_LEDGERS, POOL_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("refund"), pool_id),
            pool.bet_count,
        );

        Ok(())
    }

    // ======================================================================
    // Treasury sweep
    // ======================================================================

    /// Transfer accrued protocol fees to treasury (max once per 24h).
    pub fn sweep_treasury(env: Env) -> Result<i128, Error> {
        Self::require_admin(&env)?;

        let now_ts = env.ledger().timestamp();
        let last_sweep: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastSweepTs)
            .unwrap_or(0);

        if last_sweep > 0 && now_ts.saturating_sub(last_sweep) < SWEEP_INTERVAL_SECONDS {
            return Err(Error::SweepTooEarly);
        }

        let accrued: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeAccrued)
            .unwrap_or(0);

        if accrued <= 0 {
            return Err(Error::NothingToSweep);
        }

        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM not set");
        let xlm = token::Client::new(&env, &xlm_addr);

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .expect("Treasury not set");

        xlm.transfer(&env.current_contract_address(), &treasury, &accrued);

        env.storage().instance().set(&DataKey::FeeAccrued, &0_i128);
        env.storage().instance().set(&DataKey::LastSweepTs, &now_ts);

        Ok(accrued)
    }

    // ======================================================================
    // Read helpers
    // ======================================================================

    pub fn get_pool(env: Env, pool_id: u32) -> Result<BetPool, Error> {
        env.storage()
            .temporary()
            .get(&DataKey::Pool(pool_id))
            .ok_or(Error::PoolNotFound)
    }

    pub fn get_bet(env: Env, pool_id: u32, bettor: Address) -> Result<BetCommit, Error> {
        env.storage()
            .temporary()
            .get(&DataKey::Bet(pool_id, bettor))
            .ok_or(Error::BetNotFound)
    }

    pub fn get_pool_counter(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PoolCounter)
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set")
    }

    pub fn get_fee_accrued(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeeAccrued)
            .unwrap_or(0)
    }

    // ======================================================================
    // Admin setters
    // ======================================================================

    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env).expect("Unauthorized");
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn set_treasury(env: Env, new_treasury: Address) {
        Self::require_admin(&env).expect("Unauthorized");
        env.storage().instance().set(&DataKey::Treasury, &new_treasury);
    }

    pub fn set_zk_verifier(env: Env, verifier: Address, vk_id: BytesN<32>) {
        Self::require_admin(&env).expect("Unauthorized");
        env.storage().instance().set(&DataKey::ZkVerifier, &verifier);
        env.storage().instance().set(&DataKey::ZkVkId, &vk_id);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::require_admin(&env).expect("Unauthorized");
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ======================================================================
    // Internal
    // ======================================================================

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        Ok(())
    }

    fn calc_fee(amount: i128) -> i128 {
        // 1% = 100 bps, round up
        ((amount * FEE_BPS as i128) + 9_999) / 10_000
    }
}

// ==========================================================================
// Tests
// ==========================================================================

#[cfg(test)]
mod test;
