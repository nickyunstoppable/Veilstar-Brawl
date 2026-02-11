/**
 * Fight State Types
 * Types for server-side fight scene state synchronization
 */

/**
 * Phase of the fight scene
 */
export type FightPhase =
    | "waiting"      // Waiting for match to start
    | "countdown"    // 3-2-1 FIGHT countdown
    | "selecting"    // Players selecting moves
    | "resolving"    // Turn is being resolved (animations playing)
    | "round_end"    // Round ended, showing results
    | "match_end";   // Match finished

/**
 * Animation phase during resolution
 */
export type AnimationPhase =
    | "none"
    | "running_to_center"
    | "p1_attacking"
    | "p2_attacking"
    | "both_attacking"
    | "running_back"
    | "round_end_death"
    | "round_end_text"
    | "round_end_countdown";

/**
 * Character animation type
 */
export type CharacterAnimation =
    | "idle"
    | "run"
    | "punch"
    | "kick"
    | "block"
    | "special"
    | "dead"
    | "victory";

/**
 * Player state within a fight
 */
export interface FightPlayerState {
    health: number;
    maxHealth: number;
    energy: number;
    maxEnergy: number;
    guardMeter: number;
    roundsWon: number;
    isStunned: boolean;
    currentAnimation: CharacterAnimation;
    hasSubmittedMove: boolean;
}

/**
 * Complete fight state snapshot
 */
export interface FightStateSnapshot {
    id: string;
    matchId: string;

    // Game progress
    currentRound: number;
    currentTurn: number;

    // Phase
    phase: FightPhase;
    phaseStartedAt: number; // Unix timestamp

    // Player states
    player1: FightPlayerState;
    player2: FightPlayerState;

    // Timer state
    moveDeadlineAt: number | null;
    countdownEndsAt: number | null;

    // Animation state (for resolving phase)
    animationPhase: AnimationPhase | null;
    animationStartedAt: number | null;
    animationEndsAt: number | null;

    // Round end state
    roundWinner: "player1" | "player2" | "draw" | null;
    roundEndCountdown: number | null;

    // Last resolved turn data (for replay on reconnect)
    lastResolved: {
        player1Move: string | null;
        player2Move: string | null;
        narrative: string | null;
    };

    // Metadata
    updatedAt: number; // Unix timestamp
}

/**
 * Fight state update payload (partial update)
 */
export interface FightStateUpdate {
    phase?: FightPhase;
    currentRound?: number;
    currentTurn?: number;

    player1Health?: number;
    player1Energy?: number;
    player1GuardMeter?: number;
    player1RoundsWon?: number;
    player1IsStunned?: boolean;
    player1CurrentAnimation?: CharacterAnimation;
    player1HasSubmittedMove?: boolean;

    player2Health?: number;
    player2Energy?: number;
    player2GuardMeter?: number;
    player2RoundsWon?: number;
    player2IsStunned?: boolean;
    player2CurrentAnimation?: CharacterAnimation;
    player2HasSubmittedMove?: boolean;

    moveDeadlineAt?: number | null;
    countdownEndsAt?: number | null;

    animationPhase?: AnimationPhase | null;
    animationStartedAt?: number | null;
    animationEndsAt?: number | null;

    roundWinner?: "player1" | "player2" | "draw" | null;
    roundEndCountdown?: number | null;

    lastResolvedPlayer1Move?: string | null;
    lastResolvedPlayer2Move?: string | null;
    lastNarrative?: string | null;
}

/**
 * Fight state broadcast event payload
 */
export interface FightStateBroadcast {
    type: "fight_state_update";
    matchId: string;
    update: FightStateUpdate;
    timestamp: number;
}

/**
 * Convert API response to FightStateSnapshot
 */
export function parseFightStateResponse(data: any): FightStateSnapshot {
    return {
        id: data.id,
        matchId: data.matchId,
        currentRound: data.currentRound,
        currentTurn: data.currentTurn,
        phase: data.phase,
        phaseStartedAt: new Date(data.phaseStartedAt).getTime(),
        player1: {
            health: data.player1Health,
            maxHealth: data.player1MaxHealth,
            energy: data.player1Energy,
            maxEnergy: data.player1MaxEnergy,
            guardMeter: data.player1GuardMeter,
            roundsWon: data.player1RoundsWon,
            isStunned: data.player1IsStunned,
            currentAnimation: data.player1CurrentAnimation as CharacterAnimation,
            hasSubmittedMove: data.player1HasSubmittedMove,
        },
        player2: {
            health: data.player2Health,
            maxHealth: data.player2MaxHealth,
            energy: data.player2Energy,
            maxEnergy: data.player2MaxEnergy,
            guardMeter: data.player2GuardMeter,
            roundsWon: data.player2RoundsWon,
            isStunned: data.player2IsStunned,
            currentAnimation: data.player2CurrentAnimation as CharacterAnimation,
            hasSubmittedMove: data.player2HasSubmittedMove,
        },
        moveDeadlineAt: data.moveDeadlineAt ? new Date(data.moveDeadlineAt).getTime() : null,
        countdownEndsAt: data.countdownEndsAt ? new Date(data.countdownEndsAt).getTime() : null,
        animationPhase: data.animationPhase as AnimationPhase | null,
        animationStartedAt: data.animationStartedAt ? new Date(data.animationStartedAt).getTime() : null,
        animationEndsAt: data.animationEndsAt ? new Date(data.animationEndsAt).getTime() : null,
        roundWinner: data.roundWinner,
        roundEndCountdown: data.roundEndCountdown,
        lastResolved: {
            player1Move: data.lastResolvedPlayer1Move,
            player2Move: data.lastResolvedPlayer2Move,
            narrative: data.lastNarrative,
        },
        updatedAt: new Date(data.updatedAt).getTime(),
    };
}

/**
 * Animation timing constants (in milliseconds)
 */
export const ANIMATION_TIMING = {
    COUNTDOWN_SECONDS: 3,
    MOVE_TIMER_MS: 20000,
    RUN_TO_CENTER_MS: 600,
    ATTACK_ANIMATION_MS: 1200,
    RUN_BACK_MS: 600,
    DEATH_ANIMATION_MS: 1500,
    ROUND_RESULT_TEXT_MS: 1500,
    ROUND_END_COUNTDOWN_SECONDS: 5,
    MATCH_END_DELAY_MS: 5000,
} as const;
