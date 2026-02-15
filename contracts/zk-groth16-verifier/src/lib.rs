#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    Address, Bytes, BytesN, Env, Vec,
};

const PROOF_GROTH16_BYTES_LEN: u32 = 256;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidVk = 1,
    InvalidProof = 2,
    InvalidPublicInputs = 3,
    Unauthorized = 4,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    VerificationKey(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Groth16VerificationKey {
    pub alpha_g1: BytesN<64>,
    pub beta_g2: BytesN<128>,
    pub gamma_g2: BytesN<128>,
    pub delta_g2: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

#[contract]
pub struct ZkGroth16VerifierContract;

#[contractimpl]
impl ZkGroth16VerifierContract {
    pub fn __constructor(env: Env, admin: Address, _game_hub: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn set_verification_key(
        env: Env,
        vk_id: BytesN<32>,
        alpha_g1: BytesN<64>,
        beta_g2: BytesN<128>,
        gamma_g2: BytesN<128>,
        delta_g2: BytesN<128>,
        ic: Vec<BytesN<64>>,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if ic.len() == 0 {
            return Err(Error::InvalidVk);
        }

        let vk = Groth16VerificationKey {
            alpha_g1,
            beta_g2,
            gamma_g2,
            delta_g2,
            ic,
        };

        env.storage().instance().set(&DataKey::VerificationKey(vk_id), &vk);
        Ok(())
    }

    pub fn verify_round_proof(
        env: Env,
        vk_id: BytesN<32>,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        let vk: Groth16VerificationKey = match env.storage().instance().get(&DataKey::VerificationKey(vk_id)) {
            Some(vk) => vk,
            None => return false,
        };

        if proof.len() != PROOF_GROTH16_BYTES_LEN {
            return false;
        }

        let expected_ic_len = public_inputs.len().saturating_add(1);
        if vk.ic.len() != expected_ic_len {
            return false;
        }

        let proof_a = match Self::proof_g1_slice(&env, &proof, 0, 64) {
            Some(v) => v,
            None => return false,
        };
        let proof_b = match Self::proof_g2_slice(&env, &proof, 64, 192) {
            Some(v) => v,
            None => return false,
        };
        let proof_c = match Self::proof_g1_slice(&env, &proof, 192, 256) {
            Some(v) => v,
            None => return false,
        };

        let alpha_g1 = Bn254G1Affine::from_bytes(vk.alpha_g1);
        let beta_g2 = Bn254G2Affine::from_bytes(vk.beta_g2);
        let gamma_g2 = Bn254G2Affine::from_bytes(vk.gamma_g2);
        let delta_g2 = Bn254G2Affine::from_bytes(vk.delta_g2);

        let mut vk_x = Bn254G1Affine::from_bytes(vk.ic.get(0).unwrap());
        for idx in 0..public_inputs.len() {
            let input_scalar = Fr::from_bytes(public_inputs.get(idx).unwrap());
            let ic_point = Bn254G1Affine::from_bytes(vk.ic.get(idx + 1).unwrap());
            let term = env.crypto().bn254().g1_mul(&ic_point, &input_scalar);
            vk_x = env.crypto().bn254().g1_add(&vk_x, &term);
        }

        let g1_points = soroban_sdk::vec![&env, -proof_a, alpha_g1, vk_x, proof_c];
        let g2_points = soroban_sdk::vec![&env, proof_b, beta_g2, gamma_g2, delta_g2];

        env.crypto().bn254().pairing_check(g1_points, g2_points)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set")
    }

    fn proof_g1_slice(env: &Env, proof: &Bytes, start: u32, end: u32) -> Option<Bn254G1Affine> {
        if end <= start || end > proof.len() {
            return None;
        }
        let bytes = proof.slice(start..end);
        if bytes.len() != 64 {
            return None;
        }
        let mut arr = [0u8; 64];
        bytes.copy_into_slice(&mut arr);
        Some(Bn254G1Affine::from_array(env, &arr))
    }

    fn proof_g2_slice(env: &Env, proof: &Bytes, start: u32, end: u32) -> Option<Bn254G2Affine> {
        if end <= start || end > proof.len() {
            return None;
        }
        let bytes = proof.slice(start..end);
        if bytes.len() != 128 {
            return None;
        }
        let mut arr = [0u8; 128];
        bytes.copy_into_slice(&mut arr);
        Some(Bn254G2Affine::from_array(env, &arr))
    }

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        Ok(())
    }
}
