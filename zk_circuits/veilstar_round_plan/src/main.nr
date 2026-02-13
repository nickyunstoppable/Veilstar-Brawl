use poseidon::poseidon2::Poseidon2;

fn main(
    match_id: Field,
    round_number: u32,
    turn_number: u32,
    player_address: Field,
    surge_card: u32,
    selected_move: u32,
    nonce: Field,
) -> pub Field {
    assert(round_number > 0);
    assert(turn_number > 0);

    assert(selected_move <= 4);

    let preimage = [
        match_id,
        round_number as Field,
        turn_number as Field,
        player_address,
        surge_card as Field,
        selected_move as Field,
        nonce,
    ];

    let computed = Poseidon2::hash(preimage, preimage.len());

    computed
}
