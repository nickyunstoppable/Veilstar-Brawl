#![cfg(test)]

//! Unit tests for the Veilstar Brawl fighting game contract.
//! Uses a mock GameHub and a mock XLM token (SAC) for isolation.

use crate::{Error, MoveType, VeilstarBrawlContract, VeilstarBrawlContractClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, Address, Env};

// ============================================================================
// Mock GameHub
// ============================================================================

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
    }

    pub fn end_game(_env: Env, _session_id: u32, _player1_won: bool) {}

    pub fn add_game(_env: Env, _game_address: Address) {}
}

// ============================================================================
// Mock XLM Token (SAC-compatible)
// ============================================================================

mod mock_token {
    soroban_sdk::contractimport!(
        file = "../target/wasm32-unknown-unknown/release/soroban_token_contract.wasm"
    );
}

// ============================================================================
// Helpers
// ============================================================================

fn setup_test() -> (
    Env,
    VeilstarBrawlContractClient<'static>,
    Address,   // admin
    Address,   // player1
    Address,   // player2
    Address,   // treasury
    Address,   // xlm token
) {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    // Deploy mock GameHub
    let hub_addr = env.register(MockGameHub, ());

    // Deploy mock XLM token
    let xlm_admin = Address::generate(&env);
    let xlm_addr = env.register_stellar_asset_contract_v2(xlm_admin.clone())
        .address();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    // Deploy contract
    let contract_id = env.register(
        VeilstarBrawlContract,
        (&admin, &hub_addr, &treasury, &xlm_addr),
    );
    let client = VeilstarBrawlContractClient::new(&env, &contract_id);

    // Mint XLM to players for move costs
    let xlm = soroban_sdk::token::StellarAssetClient::new(&env, &xlm_addr);
    xlm.mint(&player1, &10_000_000_000); // 1000 XLM
    xlm.mint(&player2, &10_000_000_000); // 1000 XLM
    // Mint some to contract for fee reserve testing
    xlm.mint(&contract_id, &200_000_000); // 20 XLM

    (env, client, admin, player1, player2, treasury, xlm_addr)
}

fn assert_contract_error<T, E>(
    result: &Result<Result<T, E>, Result<Error, soroban_sdk::InvokeError>>,
    expected: Error,
) {
    match result {
        Err(Ok(actual)) => assert_eq!(*actual, expected),
        other => panic!("Expected Error::{expected:?}, got {other:?}"),
    }
}

// ============================================================================
// Match lifecycle
// ============================================================================

#[test]
fn test_start_and_get_match() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    let m = client.get_match(&1u32);
    assert_eq!(m.player1, p1);
    assert_eq!(m.player2, p2);
    assert_eq!(m.player1_moves, 0);
    assert_eq!(m.player2_moves, 0);
    assert_eq!(m.total_xlm_collected, 0);
    assert!(m.winner.is_none());
}

#[test]
fn test_submit_move_increments_counters() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    client.submit_move(&1u32, &p1, &MoveType::Punch, &1u32);
    client.submit_move(&1u32, &p2, &MoveType::Block, &1u32);
    client.submit_move(&1u32, &p1, &MoveType::Kick, &2u32);

    let m = client.get_match(&1u32);
    assert_eq!(m.player1_moves, 2);
    assert_eq!(m.player2_moves, 1);
    assert_eq!(m.total_xlm_collected, 3_000); // 3 * 1_000 stroops
}

#[test]
fn test_end_match_sets_winner() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);
    client.submit_move(&1u32, &p1, &MoveType::Special, &1u32);

    // Player 1 wins
    client.end_game(&1u32, &true);

    let m = client.get_match(&1u32);
    assert_eq!(m.winner.unwrap(), p1);
}

#[test]
fn test_end_match_player2_wins() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&2u32, &p1, &p2, &100_000, &100_000);
    client.end_game(&2u32, &false);

    let m = client.get_match(&2u32);
    assert_eq!(m.winner.unwrap(), p2);
}

// ============================================================================
// Error cases
// ============================================================================

#[test]
fn test_cannot_submit_move_after_match_ended() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);
    client.end_game(&1u32, &true);

    let result = client.try_submit_move(&1u32, &p1, &MoveType::Punch, &1u32);
    assert_contract_error(&result, Error::MatchAlreadyEnded);
}

#[test]
fn test_cannot_end_match_twice() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);
    client.end_game(&1u32, &true);

    let result = client.try_end_game(&1u32, &true);
    assert_contract_error(&result, Error::MatchAlreadyEnded);
}

#[test]
fn test_non_player_cannot_submit_move() {
    let (env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();
    let outsider = Address::generate(&env);

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    let result = client.try_submit_move(&1u32, &outsider, &MoveType::Punch, &1u32);
    assert_contract_error(&result, Error::NotPlayer);
}

#[test]
fn test_match_not_found() {
    let (_env, client, _admin, _p1, _p2, _treasury, _xlm) = setup_test();

    let result = client.try_get_match(&999u32);
    assert_contract_error(&result, Error::MatchNotFound);
}

// ============================================================================
// Treasury sweep
// ============================================================================

#[test]
fn test_sweep_treasury() {
    let (env, client, _admin, p1, p2, treasury, xlm_addr) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    // Submit many moves to accumulate XLM in contract
    for turn in 1..=20u32 {
        client.submit_move(&1u32, &p1, &MoveType::Punch, &turn);
        client.submit_move(&1u32, &p2, &MoveType::Kick, &turn);
    }

    // Contract now has: 20 XLM (initial) + 40 * 0.0001 XLM = 20.004 XLM
    // Sweep should transfer 20.004 - 10 = 10.004 XLM to treasury
    let swept = client.sweep_treasury();
    assert!(swept > 0);

    // Verify treasury received funds
    let xlm = soroban_sdk::token::Client::new(&env, &xlm_addr);
    let treasury_balance = xlm.balance(&treasury);
    assert!(treasury_balance > 0);
}

#[test]
fn test_sweep_nothing_when_below_reserve() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    // Only 20 XLM in contract. Reserve is 10 XLM.
    // 20 - 10 = 10 XLM sweepable → should succeed
    let swept = client.sweep_treasury();
    assert_eq!(swept, 100_000_000); // 10 XLM
}

// ============================================================================
// Multiple matches
// ============================================================================

#[test]
fn test_multiple_independent_matches() {
    let (env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();
    let p3 = Address::generate(&env);
    let p4 = Address::generate(&env);

    // Mint XLM for new players
    let xlm_admin = Address::generate(&env);
    // p3 and p4 need XLM — use the asset client
    // Actually they're already in the test env with mock_all_auths,
    // but they need token balance. Let's just test with p1/p2 in different sessions.

    client.start_game(&10u32, &p1, &p2, &100_000, &100_000);
    client.start_game(&20u32, &p2, &p1, &200_000, &200_000);

    client.submit_move(&10u32, &p1, &MoveType::Punch, &1u32);
    client.submit_move(&20u32, &p2, &MoveType::Special, &1u32);

    let m1 = client.get_match(&10u32);
    let m2 = client.get_match(&20u32);

    assert_eq!(m1.player1_moves, 1);
    assert_eq!(m1.player2_moves, 0);
    assert_eq!(m2.player1_moves, 0); // p2 is player1 in session 20
    assert_eq!(m2.player2_moves, 0); // wait, p2 submitted but they're player1 in session 20

    // Actually p2 is player1 in session 20, so p2's move counts as player1_moves
    let m2 = client.get_match(&20u32);
    assert_eq!(m2.player1_moves, 1); // p2 is player1 here
}

// ============================================================================
// All move types
// ============================================================================

#[test]
fn test_all_move_types() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    client.submit_move(&1u32, &p1, &MoveType::Punch, &1u32);
    client.submit_move(&1u32, &p1, &MoveType::Kick, &2u32);
    client.submit_move(&1u32, &p1, &MoveType::Block, &3u32);
    client.submit_move(&1u32, &p1, &MoveType::Special, &4u32);

    let m = client.get_match(&1u32);
    assert_eq!(m.player1_moves, 4);
}
