use poseidon::poseidon2::Poseidon2;

fn main(
    match_id: Field,
    round_number: u32,
    player_address: Field,
    surge_card: u32,
    move_0: u32,
    move_1: u32,
    move_2: u32,
    move_3: u32,
    move_4: u32,
    move_5: u32,
    move_6: u32,
    move_7: u32,
    move_8: u32,
    move_9: u32,
    nonce: Field,
) -> pub Field {
    assert(round_number > 0);

    assert(move_0 <= 4);
    assert(move_1 <= 4);
    assert(move_2 <= 4);
    assert(move_3 <= 4);
    assert(move_4 <= 4);
    assert(move_5 <= 4);
    assert(move_6 <= 4);
    assert(move_7 <= 4);
    assert(move_8 <= 4);
    assert(move_9 <= 4);

    let preimage = [
        match_id,
        round_number as Field,
        player_address,
        surge_card as Field,
        move_0 as Field,
        move_1 as Field,
        move_2 as Field,
        move_3 as Field,
        move_4 as Field,
        move_5 as Field,
        move_6 as Field,
        move_7 as Field,
        move_8 as Field,
        move_9 as Field,
        nonce,
    ];

    let computed = Poseidon2::hash(preimage, preimage.len());

    computed
}
