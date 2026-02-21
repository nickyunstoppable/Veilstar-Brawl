#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::Address as _,
    Bytes, BytesN, Env, Vec,
};

#[contract]
struct MockVerifierAcceptContract;

#[contractimpl]
impl MockVerifierAcceptContract {
    pub fn verify_round_proof(
        _env: Env,
        _vk_id: BytesN<32>,
        _proof: Bytes,
        _public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        true
    }
}

#[contract]
struct MockVerifierRejectContract;

#[contractimpl]
impl MockVerifierRejectContract {
    pub fn verify_round_proof(
        _env: Env,
        _vk_id: BytesN<32>,
        _proof: Bytes,
        _public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        false
    }
}

fn setup_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = env.register_stellar_asset_contract_v2(admin.clone()).address().clone();

    let contract_id = env.register(ZkBettingContract, (&admin, &treasury, &xlm_token));

    (env, contract_id, admin, treasury, xlm_token)
}

fn make_commitment(env: &Env, side: u8, salt: &BytesN<32>) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.push_back(side);
    let salt_bytes: Bytes = salt.clone().into();
    preimage.append(&salt_bytes);
    env.crypto().sha256(&preimage).into()
}

fn match_id(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1u8; 32])
}

fn u32_to_bytes32(env: &Env, value: u32) -> BytesN<32> {
    let mut out = [0u8; 32];
    let be = value.to_be_bytes();
    out[28] = be[0];
    out[29] = be[1];
    out[30] = be[2];
    out[31] = be[3];
    BytesN::from_array(env, &out)
}

#[test]
fn test_create_pool() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &1000);

    assert_eq!(pool_id, 1);

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.status, PoolStatus::Open);
    assert_eq!(pool.bet_count, 0);
    assert_eq!(pool.total_pool, 0);
}

#[test]
fn test_commit_and_reveal() {
    let (env, contract_id, _admin, _treasury, xlm_token) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    // Fund a bettor
    let bettor = Address::generate(&env);
    let xlm = token::StellarAssetClient::new(&env, &xlm_token);
    xlm.mint(&bettor, &100_000_000_000); // 10,000 XLM

    // Create pool
    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0); // no deadline

    // Commit bet: Player1, 10 XLM
    let salt = BytesN::from_array(&env, &[42u8; 32]);
    let commitment = make_commitment(&env, 0, &salt); // 0 = Player1
    let amount: i128 = 100_000_000; // 10 XLM

    client.commit_bet(&pool_id, &bettor, &commitment, &amount);

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.bet_count, 1);
    assert_eq!(pool.total_pool, amount);

    let bet = client.get_bet(&pool_id, &bettor);
    assert!(!bet.revealed);
    assert_eq!(bet.amount, amount);

    // Lock pool
    client.lock_pool(&pool_id);

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.status, PoolStatus::Locked);

    // Reveal bet
    client.reveal_bet(&pool_id, &bettor, &BetSide::Player1, &salt);

    let bet = client.get_bet(&pool_id, &bettor);
    assert!(bet.revealed);
    assert_eq!(bet.side, 0); // SIDE_P1

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.player1_total, amount);
    assert_eq!(pool.reveal_count, 1);
}

#[test]
fn test_settle_and_claim() {
    let (env, contract_id, _admin, _treasury, xlm_token) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let xlm = token::StellarAssetClient::new(&env, &xlm_token);

    // Two bettors
    let bettor1 = Address::generate(&env);
    let bettor2 = Address::generate(&env);
    xlm.mint(&bettor1, &100_000_000_000);
    xlm.mint(&bettor2, &100_000_000_000);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);

    // Bettor1 bets on Player1 (10 XLM)
    let salt1 = BytesN::from_array(&env, &[10u8; 32]);
    let commit1 = make_commitment(&env, 0, &salt1);
    client.commit_bet(&pool_id, &bettor1, &commit1, &100_000_000);

    // Bettor2 bets on Player2 (10 XLM)
    let salt2 = BytesN::from_array(&env, &[20u8; 32]);
    let commit2 = make_commitment(&env, 1, &salt2);
    client.commit_bet(&pool_id, &bettor2, &commit2, &100_000_000);

    // Lock
    client.lock_pool(&pool_id);

    // Reveal
    client.reveal_bet(&pool_id, &bettor1, &BetSide::Player1, &salt1);
    client.reveal_bet(&pool_id, &bettor2, &BetSide::Player2, &salt2);

    // Settle: Player1 wins
    client.settle_pool(&pool_id, &BetSide::Player1);

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.status, PoolStatus::Settled);
    assert_eq!(pool.winner_side, 0); // SIDE_P1

    // Bettor1 claims (should get entire pool: 200M stroops)
    let balance_before = token::Client::new(&env, &xlm_token).balance(&bettor1);
    let payout = client.claim_payout(&pool_id, &bettor1);
    assert_eq!(payout, 200_000_000); // 20 XLM total pool

    let balance_after = token::Client::new(&env, &xlm_token).balance(&bettor1);
    assert_eq!(balance_after - balance_before, payout);
}

#[test]
fn test_refund_pool() {
    let (env, contract_id, _admin, _treasury, xlm_token) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let xlm = token::StellarAssetClient::new(&env, &xlm_token);
    let bettor = Address::generate(&env);
    xlm.mint(&bettor, &100_000_000_000);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);

    let salt = BytesN::from_array(&env, &[99u8; 32]);
    let commit = make_commitment(&env, 0, &salt);
    let amount: i128 = 50_000_000; // 5 XLM

    let balance_before = token::Client::new(&env, &xlm_token).balance(&bettor);
    client.commit_bet(&pool_id, &bettor, &commit, &amount);

    // Refund
    client.refund_pool(&pool_id);

    let balance_after = token::Client::new(&env, &xlm_token).balance(&bettor);
    // Should get full amount + fee back
    assert_eq!(balance_after, balance_before);

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.status, PoolStatus::Refunded);
}

#[test]
fn test_invalid_reveal_rejected() {
    let (env, contract_id, _admin, _treasury, xlm_token) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let xlm = token::StellarAssetClient::new(&env, &xlm_token);
    let bettor = Address::generate(&env);
    xlm.mint(&bettor, &100_000_000_000);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);

    // Commit for Player1
    let salt = BytesN::from_array(&env, &[55u8; 32]);
    let commit = make_commitment(&env, 0, &salt); // side=0 (Player1)
    client.commit_bet(&pool_id, &bettor, &commit, &10_000_000);

    client.lock_pool(&pool_id);

    // Try to reveal as Player2 — should fail
    let wrong_salt = BytesN::from_array(&env, &[55u8; 32]);
    let result = client.try_reveal_bet(&pool_id, &bettor, &BetSide::Player2, &wrong_salt);
    assert!(result.is_err());
}

#[test]
fn test_duplicate_bet_rejected() {
    let (env, contract_id, _admin, _treasury, xlm_token) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let xlm = token::StellarAssetClient::new(&env, &xlm_token);
    let bettor = Address::generate(&env);
    xlm.mint(&bettor, &100_000_000_000);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);

    let salt = BytesN::from_array(&env, &[77u8; 32]);
    let commit = make_commitment(&env, 0, &salt);
    client.commit_bet(&pool_id, &bettor, &commit, &10_000_000);

    // Second bet should fail
    let salt2 = BytesN::from_array(&env, &[78u8; 32]);
    let commit2 = make_commitment(&env, 1, &salt2);
    let result = client.try_commit_bet(&pool_id, &bettor, &commit2, &10_000_000);
    assert!(result.is_err());
}

#[test]
fn test_pool_counter_increments() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let mid = match_id(&env);
    let id1 = client.create_pool(&mid, &0);
    let id2 = client.create_pool(&mid, &0);
    let id3 = client.create_pool(&mid, &0);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);
    assert_eq!(client.get_pool_counter(), 3);
}

#[test]
fn test_settle_pool_zk_success_with_bound_inputs() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let verifier = env.register(MockVerifierAcceptContract, ());
    let vk_id = BytesN::from_array(&env, &[7u8; 32]);
    client.set_zk_verifier(&verifier, &vk_id);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);
    client.lock_pool(&pool_id);

    let proof = Bytes::from_array(&env, &[5u8; 256]);
    let winner_side = 0u32;
    let public_inputs = Vec::from_array(
        &env,
        [
            mid.clone(),
            u32_to_bytes32(&env, pool_id),
            u32_to_bytes32(&env, winner_side),
        ],
    );

    client.settle_pool_zk(&pool_id, &BetSide::Player1, &vk_id, &proof, &public_inputs);

    let pool = client.get_pool(&pool_id);
    assert_eq!(pool.status, PoolStatus::Settled);
    assert_eq!(pool.winner_side, winner_side);
}

#[test]
fn test_settle_pool_zk_requires_verifier_config() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);
    client.lock_pool(&pool_id);

    let proof = Bytes::from_array(&env, &[5u8; 256]);
    let public_inputs = Vec::from_array(
        &env,
        [
            mid.clone(),
            u32_to_bytes32(&env, pool_id),
            u32_to_bytes32(&env, 0u32),
        ],
    );
    let vk_id = BytesN::from_array(&env, &[7u8; 32]);

    let result = client.try_settle_pool_zk(&pool_id, &BetSide::Player1, &vk_id, &proof, &public_inputs);
    assert!(result.is_err());
}

#[test]
fn test_settle_pool_zk_rejects_vk_id_mismatch() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let verifier = env.register(MockVerifierAcceptContract, ());
    let configured_vk_id = BytesN::from_array(&env, &[7u8; 32]);
    client.set_zk_verifier(&verifier, &configured_vk_id);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);
    client.lock_pool(&pool_id);

    let proof = Bytes::from_array(&env, &[5u8; 256]);
    let public_inputs = Vec::from_array(
        &env,
        [
            mid.clone(),
            u32_to_bytes32(&env, pool_id),
            u32_to_bytes32(&env, 0u32),
        ],
    );
    let wrong_vk_id = BytesN::from_array(&env, &[8u8; 32]);

    let result = client.try_settle_pool_zk(&pool_id, &BetSide::Player1, &wrong_vk_id, &proof, &public_inputs);
    assert!(result.is_err());
}

#[test]
fn test_settle_pool_zk_rejects_public_input_binding_mismatch() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let verifier = env.register(MockVerifierAcceptContract, ());
    let vk_id = BytesN::from_array(&env, &[7u8; 32]);
    client.set_zk_verifier(&verifier, &vk_id);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);
    client.lock_pool(&pool_id);

    let proof = Bytes::from_array(&env, &[5u8; 256]);

    let bad_winner_inputs = Vec::from_array(
        &env,
        [
            mid.clone(),
            u32_to_bytes32(&env, pool_id),
            u32_to_bytes32(&env, 1u32),
        ],
    );
    let winner_result = client.try_settle_pool_zk(&pool_id, &BetSide::Player1, &vk_id, &proof, &bad_winner_inputs);
    assert!(winner_result.is_err());

    let bad_pool_inputs = Vec::from_array(
        &env,
        [
            mid.clone(),
            u32_to_bytes32(&env, pool_id + 1),
            u32_to_bytes32(&env, 0u32),
        ],
    );
    let pool_result = client.try_settle_pool_zk(&pool_id, &BetSide::Player1, &vk_id, &proof, &bad_pool_inputs);
    assert!(pool_result.is_err());

    let bad_match_inputs = Vec::from_array(
        &env,
        [
            BytesN::from_array(&env, &[2u8; 32]),
            u32_to_bytes32(&env, pool_id),
            u32_to_bytes32(&env, 0u32),
        ],
    );
    let match_result = client.try_settle_pool_zk(&pool_id, &BetSide::Player1, &vk_id, &proof, &bad_match_inputs);
    assert!(match_result.is_err());
}

#[test]
fn test_settle_pool_zk_rejects_when_verifier_returns_false() {
    let (env, contract_id, _admin, _treasury, _xlm) = setup_env();
    let client = ZkBettingContractClient::new(&env, &contract_id);

    let verifier = env.register(MockVerifierRejectContract, ());
    let vk_id = BytesN::from_array(&env, &[7u8; 32]);
    client.set_zk_verifier(&verifier, &vk_id);

    let mid = match_id(&env);
    let pool_id = client.create_pool(&mid, &0);
    client.lock_pool(&pool_id);

    let proof = Bytes::from_array(&env, &[5u8; 256]);
    let public_inputs = Vec::from_array(
        &env,
        [
            mid.clone(),
            u32_to_bytes32(&env, pool_id),
            u32_to_bytes32(&env, 0u32),
        ],
    );

    let result = client.try_settle_pool_zk(&pool_id, &BetSide::Player1, &vk_id, &proof, &public_inputs);
    assert!(result.is_err());
}
