pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

template RoundPlanCommitment() {
    // circom2 requires public signals to be `signal input`.
    // We therefore keep `commitment` as a public input and constrain it.
    signal input commitment;

    signal input match_id;
    signal input round_number;
    signal input turn_number;
    signal input player_address;
    signal input surge_card;
    signal input nonce;

    // Full private plan for the round (10 turns)
    signal input moves[10];

    // Preimage: [match_id, round_number, turn_number, player_address, surge_card, nonce, moves[0..9]]
    component hash = Poseidon(16);
    hash.inputs[0] <== match_id;
    hash.inputs[1] <== round_number;
    hash.inputs[2] <== turn_number;
    hash.inputs[3] <== player_address;
    hash.inputs[4] <== surge_card;
    hash.inputs[5] <== nonce;

    for (var i = 0; i < 10; i++) {
        hash.inputs[6 + i] <== moves[i];
    }

    commitment === hash.out;
}

component main {public [commitment]} = RoundPlanCommitment();