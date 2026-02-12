#![no_std]

//! # Veilstar Brawl — Fighting Game Contract
//!
//! A two-player fighting game contract purpose-built for the Veilstar Brawl game.
//! Every combat move (punch, kick, block, special) is recorded on-chain and costs
//! 0.0001 XLM per move, transferred via the native XLM Stellar Asset Contract.
//!
//! **Game Hub Integration:**
//! Calls `start_game()` and `end_game()` on the Game Hub contract to satisfy
//! hackathon requirements and register every match lifecycle event.
//!
//! **XLM Flow:**
//! - Each `submit_move` transfers 0.0001 XLM from the player to this contract.
//! - Each `submit_power_surge` also transfers 0.0001 XLM from the player.
//! - Admin can call `sweep_treasury` to forward accumulated XLM to a treasury
//!   wallet, keeping a 10 XLM reserve for transaction fees.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype,
    symbol_short, token, Address, BytesN, Env, IntoVal, vec,
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
    pub winner: Option<Address>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Match(u32),
    GameHubAddress,
    Admin,
    TreasuryAddress,
    XlmToken,
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
            winner: None,
        };

        let key = DataKey::Match(session_id);
        env.storage().temporary().set(&key, &m);
        env.storage()
            .temporary()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);

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

        let winner = if player1_won {
            m.player1.clone()
        } else {
            m.player2.clone()
        };
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

    // ======================================================================
    // Treasury sweep
    // ======================================================================

    /// Transfer accumulated XLM to the treasury wallet, keeping a 10 XLM reserve.
    pub fn sweep_treasury(env: Env) -> Result<i128, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let xlm_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::XlmToken)
            .expect("XLM token not set");
        let xlm = token::Client::new(&env, &xlm_addr);

        let balance = xlm.balance(&env.current_contract_address());
        let sweepable = balance - RESERVE_STROOPS;

        if sweepable <= 0 {
            return Err(Error::NothingToSweep);
        }

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::TreasuryAddress)
            .expect("Treasury not set");

        xlm.transfer(&env.current_contract_address(), &treasury, &sweepable);

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

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

// ==========================================================================
// Tests
// ==========================================================================

#[cfg(test)]
mod test;
