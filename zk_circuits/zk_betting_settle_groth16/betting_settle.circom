pragma circom 2.1.6;

template BettingSettle() {
    signal input match_id;
    signal input pool_id;
    signal input winner_side;

    signal input witness_match_id;
    signal input witness_pool_id;
    signal input witness_winner_side;

    witness_match_id === match_id;
    witness_pool_id === pool_id;
    witness_winner_side === winner_side;

    // winner_side must be 0 or 1
    winner_side * (winner_side - 1) === 0;
}

component main { public [match_id, pool_id, winner_side] } = BettingSettle();
