#![cfg(test)]

//! Unit tests for the Veilstar Brawl fighting game contract.
//! Uses a mock GameHub and a mock XLM token (SAC) for isolation.

use crate::{Error, MoveType, VeilstarBrawlContract, VeilstarBrawlContractClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, vec, Address, Bytes, BytesN, Env, Vec};

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

#[contract]
pub struct MockZkVerifier;

#[contractimpl]
impl MockZkVerifier {
    pub fn verify_round_proof(
        _env: Env,
        _vk_id: BytesN<32>,
        _proof: Bytes,
        _public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        true
    }
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
    Address,   // zk verifier
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

    // Deploy mock zk verifier
    let verifier_addr = env.register(MockZkVerifier, ());

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

    (env, client, admin, player1, player2, treasury, xlm_addr, verifier_addr)
}

fn assert_contract_error<T: core::fmt::Debug, E: core::fmt::Debug>(
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
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

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
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

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
fn test_submit_power_surge_collects_fee() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    client.submit_power_surge(&1u32, &p1, &1u32, &7u32);
    client.submit_power_surge(&1u32, &p2, &1u32, &3u32);

    let m = client.get_match(&1u32);
    assert_eq!(m.total_xlm_collected, 2_000); // 2 * 1_000 stroops
}

#[test]
fn test_end_match_sets_winner() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);
    client.submit_move(&1u32, &p1, &MoveType::Special, &1u32);

    // Player 1 wins
    client.end_game(&1u32, &true);

    let m = client.get_match(&1u32);
    assert_eq!(m.winner.unwrap(), p1);
}

#[test]
fn test_end_match_player2_wins() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

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
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);
    client.end_game(&1u32, &true);

    let result = client.try_submit_move(&1u32, &p1, &MoveType::Punch, &1u32);
    assert_contract_error(&result, Error::MatchAlreadyEnded);
}

#[test]
fn test_cannot_end_match_twice() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);
    client.end_game(&1u32, &true);

    let result = client.try_end_game(&1u32, &true);
    assert_contract_error(&result, Error::MatchAlreadyEnded);
}

#[test]
fn test_non_player_cannot_submit_move() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();
    let outsider = Address::generate(&env);

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    let result = client.try_submit_move(&1u32, &outsider, &MoveType::Punch, &1u32);
    assert_contract_error(&result, Error::NotPlayer);
}

#[test]
fn test_match_not_found() {
    let (_env, client, _admin, _p1, _p2, _treasury, _xlm, _verifier) = setup_test();

    let result = client.try_get_match(&999u32);
    assert_contract_error(&result, Error::MatchNotFound);
}

// ============================================================================
// Treasury sweep
// ============================================================================

#[test]
fn test_sweep_treasury() {
    let (env, client, _admin, p1, p2, treasury, xlm_addr, _verifier) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    // Fees accrue from stake settlement, not move submissions.
    client.set_match_stake(&1u32, &10_000_000i128); // 1 XLM stake per player
    client.deposit_stake(&1u32, &p1);
    client.deposit_stake(&1u32, &p2);
    client.end_game(&1u32, &true);

    let swept = client.sweep_treasury();
    assert!(swept > 0);

    // Verify treasury received funds
    let xlm = soroban_sdk::token::Client::new(&env, &xlm_addr);
    let treasury_balance = xlm.balance(&treasury);
    assert!(treasury_balance > 0);
}

#[test]
fn test_sweep_nothing_when_below_reserve() {
    let (_env, client, _admin, _p1, _p2, _treasury, _xlm, _verifier) = setup_test();

    // No accrued protocol fees yet, so sweep must fail.
    let result = client.try_sweep_treasury();
    assert_contract_error(&result, Error::NothingToSweep);
}

// ============================================================================
// Multiple matches
// ============================================================================

#[test]
fn test_multiple_independent_matches() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&10u32, &p1, &p2, &100_000, &100_000);
    client.start_game(&20u32, &p2, &p1, &200_000, &200_000);

    client.submit_move(&10u32, &p1, &MoveType::Punch, &1u32);
    client.submit_move(&20u32, &p2, &MoveType::Special, &1u32);

    let m1 = client.get_match(&10u32);
    let m2 = client.get_match(&20u32);

    assert_eq!(m1.player1_moves, 1);
    assert_eq!(m1.player2_moves, 0);
    assert_eq!(m2.player1_moves, 1); // p2 is player1 here
    assert_eq!(m2.player2_moves, 0);
}

// ============================================================================
// All move types
// ============================================================================

#[test]
fn test_all_move_types() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&1u32, &p1, &p2, &100_000, &100_000);

    client.submit_move(&1u32, &p1, &MoveType::Punch, &1u32);
    client.submit_move(&1u32, &p1, &MoveType::Kick, &2u32);
    client.submit_move(&1u32, &p1, &MoveType::Block, &3u32);
    client.submit_move(&1u32, &p1, &MoveType::Special, &4u32);

    let m = client.get_match(&1u32);
    assert_eq!(m.player1_moves, 4);
}

#[test]
fn test_set_match_stake_is_idempotent_for_same_amount() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&55u32, &p1, &p2, &100_000, &100_000);

    client.set_match_stake(&55u32, &10_000_000i128);
    client.set_match_stake(&55u32, &10_000_000i128);

    let m = client.get_match(&55u32);
    assert_eq!(m.stake_amount_stroops, 10_000_000i128);
}

#[test]
fn test_deposit_stake_is_idempotent_per_player() {
    let (_env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&77u32, &p1, &p2, &100_000, &100_000);
    client.set_match_stake(&77u32, &10_000_000i128);

    client.deposit_stake(&77u32, &p1);
    client.deposit_stake(&77u32, &p1);
    client.deposit_stake(&77u32, &p2);

    let m = client.get_match(&77u32);
    assert!(m.player1_stake_paid);
    assert!(m.player2_stake_paid);
}

#[test]
fn test_end_game_requires_zk_commit_when_gate_enabled() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&101u32, &p1, &p2, &100_000, &100_000);
    client.set_zk_gate_required(&true);

    let c1 = BytesN::from_array(&env, &[1u8; 32]);
    let c2 = BytesN::from_array(&env, &[2u8; 32]);
    client.submit_zk_commit(&101u32, &p1, &1u32, &1u32, &c1);
    client.submit_zk_commit(&101u32, &p2, &1u32, &1u32, &c2);

    let result = client.try_end_game(&101u32, &true);
    assert_contract_error(&result, Error::ZkCommitRequired);
}

#[test]
fn test_submit_zk_commit_allows_end_game_under_gate() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, verifier) = setup_test();

    client.start_game(&102u32, &p1, &p2, &100_000, &100_000);
    client.set_zk_gate_required(&true);

    let c1 = BytesN::from_array(&env, &[1u8; 32]);
    let c2 = BytesN::from_array(&env, &[2u8; 32]);

    client.submit_zk_commit(&102u32, &p1, &1u32, &1u32, &c1);
    client.submit_zk_commit(&102u32, &p2, &1u32, &1u32, &c2);

    client.set_zk_verifier_contract(&verifier);

    let vk_id = BytesN::from_array(&env, &[3u8; 32]);
    client.set_zk_verifier_vk_id(&vk_id);
    let proof = Bytes::from_array(&env, &[4u8; 256]);
    let public_inputs = vec![&env, BytesN::from_array(&env, &[5u8; 32])];

    client.submit_zk_verification(
        &102u32,
        &p1,
        &1u32,
        &1u32,
        &c1,
        &vk_id,
        &proof,
        &public_inputs,
    );
    client.submit_zk_verification(
        &102u32,
        &p2,
        &1u32,
        &1u32,
        &c2,
        &vk_id,
        &proof,
        &public_inputs,
    );

    client.submit_zk_match_outcome(&102u32, &p1, &vk_id, &proof, &public_inputs);

    client.end_game(&102u32, &true);
    let m = client.get_match(&102u32);
    assert_eq!(m.winner.unwrap(), p1);
    assert_eq!(m.player1_zk_commits, 1);
    assert_eq!(m.player2_zk_commits, 1);
    assert_eq!(m.player1_zk_verified, 1);
    assert_eq!(m.player2_zk_verified, 1);
}

#[test]
fn test_end_game_requires_match_outcome_when_gate_enabled() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, verifier) = setup_test();

    client.start_game(&110u32, &p1, &p2, &100_000, &100_000);
    client.set_zk_gate_required(&true);

    let c1 = BytesN::from_array(&env, &[1u8; 32]);
    let c2 = BytesN::from_array(&env, &[2u8; 32]);
    let vk_id = BytesN::from_array(&env, &[3u8; 32]);
    let proof = Bytes::from_array(&env, &[4u8; 256]);
    let public_inputs = vec![&env, BytesN::from_array(&env, &[5u8; 32])];

    client.set_zk_verifier_contract(&verifier);
    client.set_zk_verifier_vk_id(&vk_id);
    client.submit_zk_commit(&110u32, &p1, &1u32, &1u32, &c1);
    client.submit_zk_commit(&110u32, &p2, &1u32, &1u32, &c2);
    client.submit_zk_verification(&110u32, &p1, &1u32, &1u32, &c1, &vk_id, &proof, &public_inputs);
    client.submit_zk_verification(&110u32, &p2, &1u32, &1u32, &c2, &vk_id, &proof, &public_inputs);

    let result = client.try_end_game(&110u32, &true);
    assert_contract_error(&result, Error::ZkMatchOutcomeRequired);
}

#[test]
fn test_end_game_rejects_winner_mismatch_with_match_outcome() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, verifier) = setup_test();

    client.start_game(&111u32, &p1, &p2, &100_000, &100_000);
    client.set_zk_gate_required(&true);

    let c1 = BytesN::from_array(&env, &[6u8; 32]);
    let c2 = BytesN::from_array(&env, &[7u8; 32]);
    let vk_id = BytesN::from_array(&env, &[8u8; 32]);
    let proof = Bytes::from_array(&env, &[9u8; 256]);
    let public_inputs = vec![&env, BytesN::from_array(&env, &[10u8; 32])];

    client.set_zk_verifier_contract(&verifier);
    client.set_zk_verifier_vk_id(&vk_id);
    client.submit_zk_commit(&111u32, &p1, &1u32, &1u32, &c1);
    client.submit_zk_commit(&111u32, &p2, &1u32, &1u32, &c2);
    client.submit_zk_verification(&111u32, &p1, &1u32, &1u32, &c1, &vk_id, &proof, &public_inputs);
    client.submit_zk_verification(&111u32, &p2, &1u32, &1u32, &c2, &vk_id, &proof, &public_inputs);
    client.submit_zk_match_outcome(&111u32, &p2, &vk_id, &proof, &public_inputs);

    let result = client.try_end_game(&111u32, &true);
    assert_contract_error(&result, Error::InvalidWinnerClaim);

    client.end_game(&111u32, &false);
    let m = client.get_match(&111u32);
    assert_eq!(m.winner.unwrap(), p2);
}

#[test]
fn test_duplicate_zk_commit_rejected() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, _verifier) = setup_test();

    client.start_game(&103u32, &p1, &p2, &100_000, &100_000);

    let c1 = BytesN::from_array(&env, &[9u8; 32]);
    client.submit_zk_commit(&103u32, &p1, &2u32, &3u32, &c1);

    // Idempotent duplicate commit should succeed and not inflate counters.
    client.submit_zk_commit(&103u32, &p1, &2u32, &3u32, &c1);
    let m = client.get_match(&103u32);
    assert_eq!(m.player1_zk_commits, 1);
}

#[test]
fn test_duplicate_zk_verification_rejected() {
    let (env, client, _admin, p1, p2, _treasury, _xlm, verifier) = setup_test();

    client.start_game(&104u32, &p1, &p2, &100_000, &100_000);

    let c1 = BytesN::from_array(&env, &[7u8; 32]);
    client.set_zk_verifier_contract(&verifier);

    let vk_id = BytesN::from_array(&env, &[8u8; 32]);
    client.set_zk_verifier_vk_id(&vk_id);
    let proof = Bytes::from_array(&env, &[9u8; 256]);
    let public_inputs = vec![&env, BytesN::from_array(&env, &[10u8; 32])];

    client.submit_zk_commit(&104u32, &p1, &1u32, &2u32, &c1);
    client.submit_zk_verification(
        &104u32,
        &p1,
        &1u32,
        &2u32,
        &c1,
        &vk_id,
        &proof,
        &public_inputs,
    );

    // Idempotent duplicate verification should succeed and not inflate counters.
    client.submit_zk_verification(
        &104u32,
        &p1,
        &1u32,
        &2u32,
        &c1,
        &vk_id,
        &proof,
        &public_inputs,
    );

    let m = client.get_match(&104u32);
    assert_eq!(m.player1_zk_verified, 1);
}
