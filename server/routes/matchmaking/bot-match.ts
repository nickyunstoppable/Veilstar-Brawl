/**
 * Bot Match Route
 * POST /api/matchmaking/create-bot-match
 * Creates a match against a bot when no opponent is found within the timeout.
 * The bot auto-selects a random character.
 */

import { getSupabase } from "../../lib/supabase";
import { GAME_CONSTANTS } from "../../lib/game-types";

// Available character IDs for bot selection
const BOT_CHARACTER_IDS = [
    "cyber-ninja", "sonic-striker", "chrono-drifter", "neon-wraith", "viperblade",
    "ledger-titan", "heavy-loader", "gene-smasher", "bastion-hulk", "scrap-goliath",
    "soroban-sage", "technomancer", "nano-brawler", "razor-bot-7", "cyber-paladin",
    "hash-hunter", "prism-duelist", "kitsune-09", "void-reaper", "aeon-guard",
];

interface CreateBotMatchBody {
    player1Address: string;
    player2Address: string;
    player2Name?: string;
}

/**
 * Check if an address is a bot address.
 */
export function isBotAddress(address: string): boolean {
    return address.startsWith("GBOT");
}

/**
 * Pick a random character for the bot.
 */
export function pickBotCharacter(): string {
    return BOT_CHARACTER_IDS[Math.floor(Math.random() * BOT_CHARACTER_IDS.length)];
}

/**
 * Pick a random bot move, weighted toward smarter play.
 */
export function pickBotMove(energy: number): string {
    const moves = ["punch", "kick", "block", "special"];
    const affordable = moves.filter((m) => {
        if (m === "kick") return energy >= 15;
        if (m === "special") return energy >= 40;
        return true;
    });
    return affordable[Math.floor(Math.random() * affordable.length)];
}

export async function handleCreateBotMatch(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as CreateBotMatchBody;

        if (!body.player1Address || !body.player2Address) {
            return Response.json(
                { error: "Missing 'player1Address' or 'player2Address'" },
                { status: 400 }
            );
        }

        const supabase = getSupabase();

        const selectionDeadline = new Date(
            Date.now() + GAME_CONSTANTS.CHARACTER_SELECT_SECONDS * 1000
        ).toISOString();

        const botCharacterId = pickBotCharacter();

        // Create match with bot opponent — bot character pre-selected
        const { data, error } = await supabase
            .from("matches")
            .insert({
                player1_address: body.player1Address,
                player2_address: body.player2Address,
                status: "character_select",
                format: "best_of_3",
                selection_deadline_at: selectionDeadline,
                fight_phase: "waiting",
                is_bot_match: true,
                bot_character_id: botCharacterId,
                player2_character_id: botCharacterId,
            })
            .select("id")
            .single();

        if (error || !data) {
            console.error("[BotMatch] Failed to create bot match:", error);
            return Response.json(
                { error: "Failed to create bot match" },
                { status: 500 }
            );
        }

        // Create initial fight state snapshot
        await supabase.from("fight_state_snapshots").insert({
            match_id: data.id,
            phase: "waiting",
        });

        // Remove player from queue
        await supabase
            .from("matchmaking_queue")
            .delete()
            .eq("address", body.player1Address);

        console.log(
            `[BotMatch] Created bot match: ${data.id} (bot: ${botCharacterId}) for ${body.player1Address.slice(0, 8)}...`
        );

        return Response.json({
            matchId: data.id,
            botCharacterId,
        });
    } catch (err) {
        console.error("[BotMatch] Error:", err);
        return Response.json(
            { error: "Failed to create bot match" },
            { status: 500 }
        );
    }
}
