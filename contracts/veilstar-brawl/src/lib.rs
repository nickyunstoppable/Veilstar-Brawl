#![no_std]

//! # Veilstar Brawl — Fighting Game Contract
//!
//! A two-player fighting game contract purpose-built for the Veilstar Brawl game.
//! It supports:
//! - on-chain combat move recording,
//! - optional per-match XLM staking (winner takes 2x stake),
//! - protocol fee accounting (0.1% per player stake deposit),
//! - periodic fee sweep to treasury.
//!
//! **Game Hub Integration:**
//! Calls `start_game()` and `end_game()` on the Game Hub contract to satisfy
//! hackathon requirements and register every match lifecycle event.
//!
//! **XLM Flow:**
//! - `set_match_stake` sets the base stake for a session.
//! - `deposit_stake` charges each player: `stake + 0.1% fee`.
//! - `end_game` pays winner `2 * stake` and accrues fees on contract storage.
//! - `sweep_treasury` can transfer accrued fees to treasury once every 24 hours.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    symbol_short, token, Address, Bytes, BytesN, Env, IntoVal, Vec, vec,
};

// ==========================================================================
// Game Hub interface (hackathon requirement)
// ==========================================================================

#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

#[contractclient(name = "ZkVerifierContractClient")]
pub trait ZkVerifierContract {
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
    MatchNotFound = 1,
    NotPlayer = 2,
    MatchAlreadyEnded = 3,
    MatchNotInProgress = 4,
    InsufficientBalance = 5,
    NothingToSweep = 6,
    InvalidStake = 7,
    StakeNotConfigured = 8,
    StakeAlreadyPaid = 9,
    StakeNotPaid = 10,
    SweepTooEarly = 11,
    StakeDepositExpired = 12,
    DeadlineNotReached = 13,
    MatchCancelled = 14,
    InvalidZkCommitment = 15,
    ZkCommitAlreadySubmitted = 16,
    ZkCommitRequired = 17,
    InvalidZkVerifier = 18,
    ZkCommitNotFound = 19,
    ZkVerificationAlreadySubmitted = 20,
    ZkProofInvalid = 21,
    ZkVerifierNotConfigured = 22,
    ZkMatchOutcomeRequired = 23,
    InvalidWinnerClaim = 24,
}

// ==========================================================================
// Move types — mirrors the game's actual combat system
// ==========================================================================

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MoveType {
    Punch = 0,
    Kick = 1,
    Block = 2,
    Special = 3,
}

// ==========================================================================
// Data types
// ==========================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Match {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub player1_moves: u32,
    pub player2_moves: u32,
    pub total_xlm_collected: i128,
    pub stake_amount_stroops: i128,
    pub stake_fee_bps: u32,
    pub stake_deadline_ts: u64,
    pub player1_stake_paid: bool,
    pub player2_stake_paid: bool,
    pub fee_accrued_stroops: i128,
    pub player1_zk_commits: u32,
    pub player2_zk_commits: u32,
    pub player1_zk_verified: u32,
    pub player2_zk_verified: u32,
    pub is_cancelled: bool,
    pub winner: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ZkVerificationRecord {
    pub verifier_contract: Address,
    pub commitment: BytesN<32>,
    pub vk_id: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ZkMatchOutcomeRecord {
    pub verifier_contract: Address,
    pub winner: Address,
    pub vk_id: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Match(u32),
    MatchSalt(u32),
    ZkCommit(u32, BytesN<32>, u32, u32, bool),
    ZkVerified(u32, BytesN<32>, u32, u32, bool),
    ZkMatchOutcome(u32),
    GameHubAddress,
    Admin,
    ZkVerifierContractAddress,
    ZkVerifierVkId,
    TreasuryAddress,
    XlmToken,
    FeeAccrued,
    LastSweepTs,
    ZkGateRequired,
}

// ==========================================================================
// Constants
// ==========================================================================

/// 30-day TTL in ledgers (~5 s per ledger)
const MATCH_TTL_LEDGERS: u32 = 518_400;

/// 0.0001 XLM in stroops (7 decimals): 0.0001 * 10^7 = 1_000
const MOVE_COST_STROOPS: i128 = 1_000;

/// Minimum reserve kept in contract (10 XLM)
const RESERVE_STROOPS: i128 = 100_000_000;

/// 0.1% protocol fee in basis points.
const STAKE_FEE_BPS: u32 = 10;

/// 24h sweep interval.
const FEE_SWEEP_INTERVAL_SECONDS: u64 = 86_400;

/// 60s stake deposit window after stake is configured.
const STAKE_DEPOSIT_WINDOW_SECONDS: u64 = 60;

// ==========================================================================
// Contract
// ==========================================================================

#[contract]
pub struct VeilstarBrawlContract;

#[contractimpl]
impl VeilstarBrawlContract {
    // ======================================================================
    // Constructor
    // ======================================================================

    /// Initialise the contract.
    ///
    /// # Arguments
    /// * `admin`     – admin wallet (can sweep, upgrade, etc.)
    /// * `game_hub`  – Game Hub contract address
    /// * `treasury`  – wallet that receives swept XLM
    /// * `xlm_token` – SAC contract address for native XLM
    pub fn __constructor(
        env: Env,
        admin: Address,
        game_hub: Address,
        treasury: Address,
        xlm_token: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &game_hub);
        env.storage()
            .instance()
            .set(&DataKey::TreasuryAddress, &treasury);
        env.storage().instance().set(&DataKey::XlmToken, &xlm_token);
        env.storage().instance().set(&DataKey::FeeAccrued, &0_i128);
        env.storage().instance().set(&DataKey::LastSweepTs, &0_u64);
        env.storage().instance().set(&DataKey::ZkGateRequired, &false);
        env.storage().instance().set(&DataKey::ZkVerifierVkId, &BytesN::from_array(&env, &[0u8; 32]));
    }

    // ======================================================================
    // Match lifecycle
    // ======================================================================

    /// Start a new game – calls Game Hub `start_game`.
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 {
            panic!("Cannot play against yourself");
        }

        // Both players authorise locking points
        player1.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player1_points.into_val(&env)],
        );
        player2.require_auth_for_args(
            vec![&env, session_id.into_val(&env), player2_points.into_val(&env)],
        );

        // Register with Game Hub
        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub not set");
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let m = Match {
            player1: player1.clone(),
            player2: player2.clone(),
            player1_points,
            player2_points,
            player1_moves: 0,
            player2_moves: 0,
            total_xlm_collected: 0,
            stake_amount_stroops: 0,
            stake_fee_bps: STAKE_FEE_BPS,
            stake_deadline_ts: 0,
            player1_stake_paid: false,
            player2_stake_paid: false,
            fee_accrued_stroops: 0,
            player1_zk_commits: 0,
            player2_zk_commits: 0,
            player1_zk_verified: 0,
            player2_zk_verified: 0,
            is_cancelled: false,
            winner: None,
        };

        let key = DataKey::Match(session_id);
        let mut salt_bytes = [0u8; 8];
        salt_bytes[..4].copy_from_slice(&session_id.to_be_bytes());
        salt_bytes[4..].copy_from_slice(&env.ledger().sequence().to_be_bytes());
        let match_salt = env.crypto().sha256(&Bytes::from_array(&env, &salt_bytes));
        let salt_key = DataKey::MatchSalt(session_id);

        env.storage().temporary().set(&key, &m);
        env.storage().temporary().set(&salt_key, &match_salt);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        env.storage()
            .temporary()
            .extend_ttl(&salt_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        Ok(())
    }

    /// Record a combat move on-chain and collect 0.0001 XLM from the player.
    pub fn submit_move(
        env: Env,
        session_id: u32,
        player: Address,
        move_type: MoveType,
        turn: u32,
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        // Verify caller is a participant
        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;
        if !is_p1 && !is_p2 {
            return Err(Error::NotPlayer);
        }

        // Transfer 0.0001 XLM from player → this contract via SAC
        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM token not set");
        let xlm = token::Client::new(&env, &xlm_addr);
        xlm.transfer(&player, &env.current_contract_address(), &MOVE_COST_STROOPS);

        // Update move counters
        if is_p1 {
            m.player1_moves += 1;
        } else {
            m.player2_moves += 1;
        }
        m.total_xlm_collected += MOVE_COST_STROOPS;

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        // Emit event for indexers / explorers
        env.events().publish(
            (symbol_short!("move"), session_id, turn),
            (player, move_type),
        );

        Ok(())
    }

    /// Record a power surge pick on-chain and collect 0.0001 XLM from the player.
    pub fn submit_power_surge(
        env: Env,
        session_id: u32,
        player: Address,
        round: u32,
        card_code: u32,
    ) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        // Verify caller is a participant
        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;
        if !is_p1 && !is_p2 {
            return Err(Error::NotPlayer);
        }

        // Transfer 0.0001 XLM from player → this contract via SAC
        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM token not set");
        let xlm = token::Client::new(&env, &xlm_addr);
        xlm.transfer(&player, &env.current_contract_address(), &MOVE_COST_STROOPS);

        // Track payment collected by contract
        m.total_xlm_collected += MOVE_COST_STROOPS;

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        // Emit event for indexers / explorers
        env.events().publish(
            (symbol_short!("surge"), session_id, round),
            (player, card_code),
        );

        Ok(())
    }

    /// End a game and report to Game Hub.
    /// Only admin can finalise a game result.
    pub fn end_game(
        env: Env,
        session_id: u32,
        player1_won: bool,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        let zk_gate_required: bool = env
            .storage()
            .instance()
            .get(&DataKey::ZkGateRequired)
            .unwrap_or(false);

        if zk_gate_required && (m.player1_zk_verified == 0 || m.player2_zk_verified == 0) {
            return Err(Error::ZkCommitRequired);
        }

        let winner = if zk_gate_required {
            let outcome_key = DataKey::ZkMatchOutcome(session_id);
            let outcome: ZkMatchOutcomeRecord = env
                .storage()
                .temporary()
                .get(&outcome_key)
                .ok_or(Error::ZkMatchOutcomeRequired)?;

            let expected_player1_won = outcome.winner == m.player1;
            if expected_player1_won != player1_won {
                return Err(Error::InvalidWinnerClaim);
            }

            outcome.winner
        } else if player1_won {
            m.player1.clone()
        } else {
            m.player2.clone()
        };

        // If stake is configured, require both players to have deposited before finalizing.
        if m.stake_amount_stroops > 0 {
            if !m.player1_stake_paid || !m.player2_stake_paid {
                return Err(Error::StakeNotPaid);
            }

            // Winner gets exactly 2 * stake amount. Fee is retained in contract accounting.
            let xlm_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::XlmToken)
                .expect("XLM token not set");
            let xlm = token::Client::new(&env, &xlm_addr);

            let winner_payout = m.stake_amount_stroops * 2;
            xlm.transfer(&env.current_contract_address(), &winner, &winner_payout);

            // Retain total fee from both sides in contract-level accrued fee bucket.
            let per_player_fee = Self::calc_fee(m.stake_amount_stroops, m.stake_fee_bps);
            let total_fee = per_player_fee * 2;
            let mut accrued: i128 = env
                .storage()
                .instance()
                .get(&DataKey::FeeAccrued)
                .unwrap_or(0_i128);
            accrued += total_fee;
            env.storage().instance().set(&DataKey::FeeAccrued, &accrued);
            m.fee_accrued_stroops += total_fee;
        }

        m.winner = Some(winner);

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        // Report to Game Hub
        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub not set");
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.end_game(&session_id, &player1_won);

        Ok(())
    }

    pub fn submit_zk_match_outcome(
        env: Env,
        session_id: u32,
        winner: Address,
        vk_id: BytesN<32>,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<(), Error> {
        if proof.len() != 256 || public_inputs.is_empty() {
            return Err(Error::ZkProofInvalid);
        }

        let key = DataKey::Match(session_id);
        let m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let configured_vk_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerifierVkId)
            .unwrap_or(zero.clone());

        if configured_vk_id == zero || vk_id != configured_vk_id {
            return Err(Error::ZkProofInvalid);
        }

        if winner != m.player1 && winner != m.player2 {
            return Err(Error::InvalidWinnerClaim);
        }

        let verifier_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerifierContractAddress)
            .ok_or(Error::ZkVerifierNotConfigured)?;

        let verifier = ZkVerifierContractClient::new(&env, &verifier_contract);
        let verified = verifier.verify_round_proof(&vk_id, &proof, &public_inputs);
        if !verified {
            return Err(Error::ZkProofInvalid);
        }

        let outcome_key = DataKey::ZkMatchOutcome(session_id);
        if env.storage().temporary().has(&outcome_key) {
            return Err(Error::ZkVerificationAlreadySubmitted);
        }

        let record = ZkMatchOutcomeRecord {
            verifier_contract: verifier_contract.clone(),
            winner,
            vk_id,
        };

        env.storage().temporary().set(&outcome_key, &record);
        env.storage()
            .temporary()
            .extend_ttl(&outcome_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        env.events().publish((symbol_short!("zkout"), session_id), verifier_contract);

        Ok(())
    }

    pub fn submit_zk_commit(
        env: Env,
        session_id: u32,
        player: Address,
        round: u32,
        turn: u32,
        commitment: BytesN<32>,
    ) -> Result<(), Error> {
        player.require_auth();

        if round == 0 || turn == 0 {
            return Err(Error::InvalidZkCommitment);
        }

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;
        if !is_p1 && !is_p2 {
            return Err(Error::NotPlayer);
        }

        let match_salt: BytesN<32> = env
            .storage()
            .temporary()
            .get(&DataKey::MatchSalt(session_id))
            .ok_or(Error::MatchNotFound)?;

        let zk_key = DataKey::ZkCommit(session_id, match_salt, round, turn, is_p1);
        let had_existing_commit = env.storage().temporary().has(&zk_key);
        env.storage().temporary().set(&zk_key, &commitment);
        env.storage()
            .temporary()
            .extend_ttl(&zk_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        if !had_existing_commit {
            if is_p1 {
                m.player1_zk_commits += 1;
            } else if is_p2 {
                m.player2_zk_commits += 1;
            }
        }

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("zkcmt"), session_id, round, turn),
            (player, commitment),
        );

        Ok(())
    }

    pub fn submit_zk_verification(
        env: Env,
        session_id: u32,
        player: Address,
        round: u32,
        turn: u32,
        commitment: BytesN<32>,
        vk_id: BytesN<32>,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<(), Error> {
        if round == 0 || turn == 0 {
            return Err(Error::InvalidZkCommitment);
        }

        if proof.len() == 0 {
            return Err(Error::ZkProofInvalid);
        }

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;
        if !is_p1 && !is_p2 {
            return Err(Error::NotPlayer);
        }

        let match_salt: BytesN<32> = env
            .storage()
            .temporary()
            .get(&DataKey::MatchSalt(session_id))
            .ok_or(Error::MatchNotFound)?;

        let commit_key = DataKey::ZkCommit(session_id, match_salt.clone(), round, turn, is_p1);
        let stored_commitment: BytesN<32> = env
            .storage()
            .temporary()
            .get(&commit_key)
            .ok_or(Error::ZkCommitNotFound)?;

        if stored_commitment != commitment {
            return Err(Error::InvalidZkCommitment);
        }

        let verify_key = DataKey::ZkVerified(session_id, match_salt, round, turn, is_p1);
        let had_existing_verification = env.storage().temporary().has(&verify_key);

        let configured_vk_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerifierVkId)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]));

        if configured_vk_id != BytesN::from_array(&env, &[0u8; 32]) && vk_id != configured_vk_id {
            return Err(Error::ZkProofInvalid);
        }

        if proof.len() != 256 || public_inputs.is_empty() {
            return Err(Error::ZkProofInvalid);
        }

        let verifier_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerifierContractAddress)
            .ok_or(Error::ZkVerifierNotConfigured)?;

        let verifier = ZkVerifierContractClient::new(&env, &verifier_contract);
        let verified = verifier.verify_round_proof(&vk_id, &proof, &public_inputs);
        if !verified {
            return Err(Error::ZkProofInvalid);
        }

        let record = ZkVerificationRecord {
            verifier_contract: verifier_contract.clone(),
            commitment,
            vk_id,
        };

        env.storage().temporary().set(&verify_key, &record);
        env.storage()
            .temporary()
            .extend_ttl(&verify_key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        if !had_existing_verification {
            if is_p1 {
                m.player1_zk_verified += 1;
            } else if is_p2 {
                m.player2_zk_verified += 1;
            }
        }

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        env.events().publish(
            (symbol_short!("zkver"), session_id, round, turn),
            (player, verifier_contract),
        );

        Ok(())
    }

    /// Configure stake for a session before deposits begin.
    /// Stake amount is the base wager (e.g. 1 XLM). Each player deposits stake + 0.1% fee.
    pub fn set_match_stake(env: Env, session_id: u32, stake_amount_stroops: i128) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if stake_amount_stroops <= 0 {
            return Err(Error::InvalidStake);
        }

        if m.stake_amount_stroops > 0 {
            if m.stake_amount_stroops != stake_amount_stroops {
                return Err(Error::InvalidStake);
            }

            env.storage().temporary().set(&key, &m);
            env.storage()
                .temporary()
                .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
            return Ok(());
        }

        m.stake_amount_stroops = stake_amount_stroops;
        m.stake_fee_bps = STAKE_FEE_BPS;
        m.stake_deadline_ts = env.ledger().timestamp().saturating_add(STAKE_DEPOSIT_WINDOW_SECONDS);

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        Ok(())
    }

    /// Player deposit for stake-enabled matches.
    /// Required amount is stake + 0.1% fee, transferred to this contract.
    pub fn deposit_stake(env: Env, session_id: u32, player: Address) -> Result<(), Error> {
        player.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.stake_amount_stroops <= 0 {
            return Err(Error::StakeNotConfigured);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        if m.stake_deadline_ts > 0 && env.ledger().timestamp() > m.stake_deadline_ts {
            return Err(Error::StakeDepositExpired);
        }

        let is_p1 = player == m.player1;
        let is_p2 = player == m.player2;
        if !is_p1 && !is_p2 {
            return Err(Error::NotPlayer);
        }

        if (is_p1 && m.player1_stake_paid) || (is_p2 && m.player2_stake_paid) {
            env.storage().temporary().set(&key, &m);
            env.storage()
                .temporary()
                .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
            return Ok(());
        }

        let fee = Self::calc_fee(m.stake_amount_stroops, m.stake_fee_bps);
        let required = m.stake_amount_stroops + fee;

        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM token not set");
        let xlm = token::Client::new(&env, &xlm_addr);
        xlm.transfer(&player, &env.current_contract_address(), &required);

        if is_p1 {
            m.player1_stake_paid = true;
        } else {
            m.player2_stake_paid = true;
        }

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        Ok(())
    }

    /// Expire stake deposit window and cancel the match.
    /// - If both deposits are missing: cancel without transfers.
    /// - If exactly one player deposited: refund full deposited amount (stake + fee) to that player.
    pub fn expire_stake(env: Env, session_id: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        if m.stake_amount_stroops <= 0 {
            return Err(Error::StakeNotConfigured);
        }

        if m.stake_deadline_ts == 0 || env.ledger().timestamp() < m.stake_deadline_ts {
            return Err(Error::DeadlineNotReached);
        }

        if m.player1_stake_paid ^ m.player2_stake_paid {
            let xlm_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::XlmToken)
                .expect("XLM token not set");
            let xlm = token::Client::new(&env, &xlm_addr);

            let refund_fee = Self::calc_fee(m.stake_amount_stroops, m.stake_fee_bps);
            let refund_amount = m.stake_amount_stroops + refund_fee;
            let refund_to = if m.player1_stake_paid {
                m.player1.clone()
            } else {
                m.player2.clone()
            };

            xlm.transfer(&env.current_contract_address(), &refund_to, &refund_amount);
        }

        m.player1_stake_paid = false;
        m.player2_stake_paid = false;
        m.is_cancelled = true;

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub not set");
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.end_game(&session_id, &false);

        Ok(())
    }

    /// Cancel an active match and refund any paid stakes.
    /// Intended for abandonment/disconnect cancellation.
    pub fn cancel_match(env: Env, session_id: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let key = DataKey::Match(session_id);
        let mut m: Match = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::MatchNotFound)?;

        if m.winner.is_some() {
            return Err(Error::MatchAlreadyEnded);
        }

        if m.is_cancelled {
            return Err(Error::MatchCancelled);
        }

        if m.stake_amount_stroops > 0 {
            let xlm_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::XlmToken)
                .expect("XLM token not set");
            let xlm = token::Client::new(&env, &xlm_addr);

            let refund_fee = Self::calc_fee(m.stake_amount_stroops, m.stake_fee_bps);
            let refund_amount = m.stake_amount_stroops + refund_fee;

            if m.player1_stake_paid {
                xlm.transfer(&env.current_contract_address(), &m.player1, &refund_amount);
            }
            if m.player2_stake_paid {
                xlm.transfer(&env.current_contract_address(), &m.player2, &refund_amount);
            }
        }

        m.player1_stake_paid = false;
        m.player2_stake_paid = false;
        m.is_cancelled = true;

        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub not set");
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.end_game(&session_id, &false);

        Ok(())
    }

    // ======================================================================
    // Treasury sweep
    // ======================================================================

    /// Transfer accrued protocol fees to treasury wallet at most once every 24 hours.
    pub fn sweep_treasury(env: Env) -> Result<i128, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let now_ts = env.ledger().timestamp();
        let last_sweep: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastSweepTs)
            .unwrap_or(0_u64);

        if last_sweep > 0 && now_ts.saturating_sub(last_sweep) < FEE_SWEEP_INTERVAL_SECONDS {
            return Err(Error::SweepTooEarly);
        }

        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM token not set");
        let xlm = token::Client::new(&env, &xlm_addr);

        let accrued_fee: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeAccrued)
            .unwrap_or(0_i128);

        if accrued_fee <= 0 {
            return Err(Error::NothingToSweep);
        }

        let balance = xlm.balance(&env.current_contract_address());
        let sweepable = if balance > RESERVE_STROOPS {
            let above_reserve = balance - RESERVE_STROOPS;
            if above_reserve < accrued_fee {
                above_reserve
            } else {
                accrued_fee
            }
        } else {
            0
        };

        if sweepable <= 0 {
            return Err(Error::NothingToSweep);
        }

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::TreasuryAddress)
            .expect("Treasury not set");

        xlm.transfer(&env.current_contract_address(), &treasury, &sweepable);

        let remaining_fee = accrued_fee - sweepable;
        env.storage().instance().set(&DataKey::FeeAccrued, &remaining_fee);
        env.storage().instance().set(&DataKey::LastSweepTs, &now_ts);

        Ok(sweepable)
    }

    // ======================================================================
    // Read helpers
    // ======================================================================

    /// Get match state.
    pub fn get_match(env: Env, session_id: u32) -> Result<Match, Error> {
        env.storage()
            .temporary()
            .get(&DataKey::Match(session_id))
            .ok_or(Error::MatchNotFound)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set")
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub not set")
    }

    pub fn get_treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::TreasuryAddress)
            .expect("Treasury not set")
    }

    pub fn get_fee_accrued(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeeAccrued)
            .unwrap_or(0_i128)
    }

    pub fn get_last_sweep_ts(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::LastSweepTs)
            .unwrap_or(0_u64)
    }

    pub fn get_zk_gate_required(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::ZkGateRequired)
            .unwrap_or(false)
    }

    pub fn get_zk_verifier_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::ZkVerifierContractAddress)
            .ok_or(Error::ZkVerifierNotConfigured)
    }

    pub fn get_zk_verifier_vk_id(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::ZkVerifierVkId)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }

    pub fn get_zk_match_outcome(env: Env, session_id: u32) -> Result<ZkMatchOutcomeRecord, Error> {
        env.storage()
            .temporary()
            .get(&DataKey::ZkMatchOutcome(session_id))
            .ok_or(Error::ZkMatchOutcomeRequired)
    }

    // ======================================================================
    // Admin setters
    // ======================================================================

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn set_treasury(env: Env, new_treasury: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TreasuryAddress, &new_treasury);
    }

    pub fn set_zk_gate_required(env: Env, required: bool) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::ZkGateRequired, &required);
    }

    pub fn set_zk_verifier_contract(env: Env, verifier_contract: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::ZkVerifierContractAddress, &verifier_contract);
    }

    pub fn set_zk_verifier_vk_id(env: Env, vk_id: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.storage().instance().set(&DataKey::ZkVerifierVkId, &vk_id);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    fn calc_fee(stake_amount_stroops: i128, fee_bps: u32) -> i128 {
        // round up so 1 XLM always charges at least 0.001 XLM equivalent if needed by precision,
        // but with stroops precision this computes exact for many values (e.g. 1 XLM => 10,000 stroops).
        ((stake_amount_stroops * fee_bps as i128) + 9_999) / 10_000
    }
}

// ==========================================================================
// Tests
// ==========================================================================

#[cfg(test)]
mod test;
