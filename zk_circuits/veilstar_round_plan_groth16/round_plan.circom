pragma circom 2.1.6;

template RoundPlanCommitment() {
    signal input commitment;

    signal input match_id;
    signal input round_number;
    signal input turn_number;
    signal input player_address;
    signal input surge_card;
    signal input selected_move;
    signal input nonce;

    signal computed;

    computed <==
        match_id
        + round_number * 1000003
        + turn_number * 1000033
        + player_address * 1000037
        + surge_card * 1000039
        + selected_move * 1000081
        + nonce * 1000099;

    commitment === computed;
}

component main {public [commitment]} = RoundPlanCommitment();