/**
 * Fake Chat Service
 * Generates synchronized fake chat messages to make spectating entertaining
 * Uses deterministic seeding based on match ID + time for cross-client sync
 */

import type { ChatMessage } from "../../hooks/useSpectatorChat";

// =============================================================================
// REALISTIC USERNAMES
// =============================================================================

const REALISTIC_USERNAMES = [
    "alex_22", "sarah.k", "justin_time", "cryptofan99", "stellar_king",
    "moonwalker", "veil_knight", "block_hero", "satoshis_vision", "trader_joe",
    "alice_in_chains", "bob_builder", "charlie_horse", "dave_the_wave", "eve_online",
    "frank_tank", "grace_hopper", "heidi_sql", "ivan_on_tech", "judy_bloom",
    "kevin_g", "laura_croft", "mike_drop", "nancy_drew", "oscar_wild",
    "paul_bearer", "quinn_t", "rachel_green", "steve_fan", "tina_turner",
    "ursula_k", "victor_hugo", "wendy_city", "xander_cage", "yvonne_s",
    "zack_frost", "pixel_pete", "code_ninja", "data_miner", "hash_brown",
    "iron_fist", "captain_crypto", "thor_odinson", "hulk_smash_button",
    "black_widow_maker", "hawkeye_pierce", "spider_duerman", "doctor_strange_love",
    "panther_party", "ant_man_fan", "wasp_queen", "vision_quest",
    "scarlet_witch_craft", "quicksilver_fox", "gamora_guardian", "drax_destroyer",
    "rocket_racoon_city", "groot_root", "nebula_cloud", "mantis_shrimp",
    "loki_lowkey", "thanos_snap", "winter_soldier_boy", "falcon_punch",
    "war_machine_gun", "star_lord_galaxy", "nick_fury_road", "maria_hill_top",
    "coulson_agent", "daisy_johnson", "may_day", "fitz_simmons", "mack_truck",
    "yoyo_ma", "ghost_rider_bike", "punisher_skull", "daredevil_blind",
    "jessica_jones_pi", "luke_cage_fighter", "iron_fist_bump"
];

const USERNAME_COLORS = [
    "#FF6B6B", "#4ECDC4", "#FFE66D", "#A855F7", "#22D3EE",
    "#F97316", "#10B981", "#EC4899", "#8B5CF6", "#06B6D4"
];

// =============================================================================
// MESSAGE DATASETS
// =============================================================================

const REACTION_MESSAGES = [
    "wow", "nice", "lol", "gg", "omg", "sheesh", "damn", "crazy",
    "let's go", "hype", "wild", "insane", "bruh", "what??", "no way",
    "yoooo", "LFG", "pog", "poggers", "based", "cringe", "KEKW",
    "monkaS", "PepeHands", "EZ", "Clap", "OMEGALUL", "sadge",
    "copium", "hopium", "rekt", "destroyed", "f", "big f",
    "wait what", "how", "scripted", "rigged", "lag?", "hax",
    "bot diff", "gap", "clean", "smooth", "crispy", "washed",
    "legendary", "epic", "mythic", "godlike", "unreal",
    "savage", "ruthless", "mercy", "stop he's dead", "violence",
    "cinema", "kino", "movie", "clip it", "mom get the camera",
    "worldstar", "top 10 anime battles", "emotional damage", "pay him",
    "check paypal", "paid actor", "bot 1 throwing", "bot 2 smurfing",
    "my eyes", "can't look", "too brutal", "nsfw tag pls",
    "popcorn time", "getting good", "heating up", "spicy", "chilly"
];

const BETTING_MESSAGES = [
    "who else bet on p1?", "p2 is gonna win this", "my bags are packed",
    "easy money", "rip my bet", "should have bet more", "all in",
    "doubling down next time", "bets locked?", "need a miracle",
    "p1 threw", "p2 is farming", "free money", "whales eating today",
    "hold on i bet on the wrong one", "wait i misclicked", "can i refund?",
    "admin refund pls", "scam odds", "p1 odds were too good", "p2 odds trap",
    "never betting on p1 again", "always bet on p2", "p2 team rules",
    "my rent money gone", "wife gonna kill me",
    "kids college fund secure", "lambo soon", "wen lambo", "wen moon",
    "p1 to the moon", "p2 dumping", "rugpull", "exit scam",
    "just lost my life savings", "just doubled my net worth", "ez 2x",
    "thanks for the donation p2 bettors", "p1 bettors in shambles",
    "send xlm pls", "wallet drain", "rekt city",
    "liquidation imminent", "margin call", "short p1", "long p2",
    "diamond hands p1", "paper hands p2", "hodl p1", "sold p2",
    "whale alert", "shark tank", "minnow life", "shrimp gang"
];

const WAITING_FOR_BETS_MESSAGES = [
    "placing my bet now", "which one should i pick?", "p1 or p2 hmm",
    "checking the odds", "p1 looking good", "p2 stats are better",
    "gonna bet big on this one", "small bet for me", "degen mode activated",
    "YOLO p1", "YOLO p2", "all in on p1", "all in on p2",
    "lets see the matchup first", "analyzing the bots", "stats check",
    "p1 has better win rate", "p2 on a streak", "tough choice",
    "coin flip time", "eeny meeny miny moe", "going with my gut",
    "trust the process", "betting on the underdog", "favorite looks safe",
    "odds seem off", "value bet on p2", "overlay on p1",
    "sharps are on p1", "public money on p2", "fading the public",
    "tailing the whale bet", "contrarian play", "safe bet",
    "risky but worth it", "hedge bet placed", "doubled my position",
    "waiting for better odds", "odds moved already", "line shopping",
    "max bet incoming", "minimum bet lol", "testing the waters",
    "revenge bet from last match", "chasing losses", "locking in profit",
    "bankroll management", "kelly criterion says p1", "going broke on p2",
    "this is the one", "feeling lucky", "bad feeling about this",
    "lock it in", "bet submitted", "confirmation received",
    "hurry up and bet", "timer running out", "last second bet",
    "almost forgot to bet", "glad i made it", "cutting it close",
    "lets gooo", "may the odds be with me", "fingers crossed"
];

const COMMENTARY_TEMPLATES_BOT = [
    "bot 1 is aggressive", "bot 2 playing it safe",
    "bot 1 needs to chill", "bot 2 waking up",
    "bot 1 exe has stopped working", "bot 2 downloading update",
    "installing skills...", "skill issue", "diff in the chat",
    "bot 1 throwing", "bot 2 smurfing"
];

const COMMENTARY_TEMPLATES_HUMAN = [
    "{p1} looks confident", "{p2} playing the spacing game",
    "respect the neutral", "unsafe approach by {p1}",
    "{p2} is in their head", "mind games", "downloading their habits",
    "{p1} stamina management check", "frame trap attempt",
    "{p2} fishing for counters", "footsies masterclass"
];

const COMMENTARY_TEMPLATES_SHARED = [
    "that combo was clean", "huge damage!", "blocked it perfect",
    "energy management is key", "1hp clutch incoming?",
    "waiting for big special", "shields up", "rng gods please",
    "momentum shift", "can he recover?", "is it over?", "not like this",
    "comeback season?", "defense variation looking good",
    "frame perfect inputs", "pixel perfect",
    "calculated", "all according to plan", "200 iq play", "negative iq",
    "brain lag", "input delay?", "server lag?", "ping diff",
    "look at that movement", "footwork insanity", "spacing god",
    "whiff punish", "animation cancel", "tech chase", "option select",
    "reading the inputs", "literally cheating",
    "aimbot enabled", "wallhacks on", "god mode activated"
];

const CONTEXT_MESSAGES = {
    bigHit: [
        "OUCH", "that hurt", "massive damage!", "crushed him", "deleted",
        "health bar melted", "where did his health go?", "one shot?",
        "nuked", "blasted", "hammered", "bonk", "destroyed",
        "call an ambulance", "medic!", "he needs some milk", "critical condition",
        "damage overlay broken", "9999 damage", "limit break"
    ],
    critical: [
        "CRITICAL!", "boom", "critical hit let's go", "lucky crit", "huge numbers",
        "yellow numbers!", "crit chance 100%", "always crits", "crit god",
        "rng carried", "lucky", "pure luck", "skill based crit", "rolled",
        "jackpot", "casino gaming", "gacha luck", "shiny pull"
    ],
    block: [
        "nice block", "defense on point", "can't touch this", "blocked", "clutch defense",
        "brick wall", "iron defense", "tank mode", "zero damage", "tink",
        "parried", "deflected", "bounced off", "not today", "denied",
        "access denied", "security breach failed", "firewall active", "shield broken?"
    ],
    win: [
        "GG!", "well played", "ez clap", "what a match", "deserved win",
        "ggwp", "close one", "stomp", "robbed", "upset",
        "never in doubt", "sweaty match", "intense", "heart attack",
        "my hands are shaking", "mom i won", "gg no re", "run it back",
        "rematch?", "best of 3?", "tournament winner?", "champion"
    ],
    comeback: [
        "THE COMEBACK", "no way", "how did he survive?", "turnaround!", "scripted? lol",
        "plot armor", "anime logic", "power of friendship", "main character energy",
        "never give up", "clutch gene", "ice in veins", "miracle run",
        "started from the bottom", "zero to hero", "phoenix rising", "uno reverse card"
    ]
};

// =============================================================================
// BOT TURN DATA TYPE (simplified — only fields needed for chat)
// =============================================================================

export interface BotTurnData {
    turnNumber: number;
    roundNumber: number;
    bot1Move: string;
    bot2Move: string;
    bot1Hp: number;
    bot2Hp: number;
    [key: string]: unknown;
}

// =============================================================================
// UTILS
// =============================================================================

function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
    };
}

function stringToSeed(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

function humanizeMessage(text: string, rng: () => number): string {
    const style = rng();
    if (style < 0.4) return text.toLowerCase();
    if (style > 0.9) return text.toUpperCase();
    if (style > 0.8) return text.replace(/[?!.',]/g, "");
    return text;
}

function formatMessage(text: string, p1: string, p2: string): string {
    return text.replace(/\{p1\}/g, p1)
        .replace(/\{p2\}/g, p2)
        .replace(/bot 1/gi, p1)
        .replace(/bot 2/gi, p2);
}

// =============================================================================
// GENERATOR
// =============================================================================

export interface FakeChatConfig {
    matchId: string;
    matchStartTime: number;
    turns?: BotTurnData[];
    bot1MaxHp?: number;
    bot2MaxHp?: number;
    minIntervalMs?: number;
    maxIntervalMs?: number;
    isBotMatch?: boolean;
    player1Name?: string;
    player2Name?: string;
    bettingPhaseEndTime?: number;
}

export interface FakeChatGenerator {
    getMessagesUntil: (currentTime: number) => ChatMessage[];
    getNextMessageTime: (currentTime: number) => number | null;
}

export function createFakeChatGenerator(config: FakeChatConfig): FakeChatGenerator {
    const {
        matchId,
        matchStartTime,
        turns = [],
        minIntervalMs = 1500,
        maxIntervalMs = 5000,
        isBotMatch = true,
        player1Name = isBotMatch ? "Bot 1" : "Player 1",
        player2Name = isBotMatch ? "Bot 2" : "Player 2",
        bettingPhaseEndTime
    } = config;

    const baseSeed = stringToSeed(matchId);
    const messageSchedule: { time: number; message: ChatMessage }[] = [];
    const rng = seededRandom(baseSeed);

    const commentaryPool = [
        ...COMMENTARY_TEMPLATES_SHARED,
        ...(isBotMatch ? COMMENTARY_TEMPLATES_BOT : COMMENTARY_TEMPLATES_HUMAN)
    ];

    const actualMatchStart = bettingPhaseEndTime || matchStartTime;
    let currentTime = matchStartTime + 1000;

    // Generate waiting-for-bets messages
    if (bettingPhaseEndTime && bettingPhaseEndTime > matchStartTime) {
        while (currentTime < bettingPhaseEndTime - 1000) {
            const username = REALISTIC_USERNAMES[Math.floor(rng() * REALISTIC_USERNAMES.length)];
            const color = USERNAME_COLORS[Math.floor(rng() * USERNAME_COLORS.length)];
            const catRoll = rng();
            let rawText = "";

            if (catRoll < 0.7) {
                rawText = WAITING_FOR_BETS_MESSAGES[Math.floor(rng() * WAITING_FOR_BETS_MESSAGES.length)];
            } else if (catRoll < 0.85) {
                rawText = REACTION_MESSAGES[Math.floor(rng() * REACTION_MESSAGES.length)];
            } else {
                rawText = BETTING_MESSAGES[Math.floor(rng() * BETTING_MESSAGES.length)];
            }

            let messageText = formatMessage(rawText, player1Name, player2Name);
            messageText = humanizeMessage(messageText, rng);

            const id = `fake-${matchId.slice(0, 5)}-bet${currentTime}`;

            messageSchedule.push({
                time: currentTime,
                message: { id, username, message: messageText, timestamp: currentTime, isFake: true, color }
            });

            const interval = minIntervalMs + rng() * (maxIntervalMs - minIntervalMs);
            currentTime += interval;
        }
        currentTime = actualMatchStart + 2000;
    } else {
        currentTime = matchStartTime + 2000;
    }

    // Generate generic filler messages during match
    const duration = turns.length > 0 ? turns.length * 5000 : 60000;

    while (currentTime < actualMatchStart + duration + 10000) {
        const username = REALISTIC_USERNAMES[Math.floor(rng() * REALISTIC_USERNAMES.length)];
        const color = USERNAME_COLORS[Math.floor(rng() * USERNAME_COLORS.length)];
        const catRoll = rng();
        let rawText = "";

        if (catRoll < 0.3) rawText = REACTION_MESSAGES[Math.floor(rng() * REACTION_MESSAGES.length)];
        else if (catRoll < 0.6) rawText = BETTING_MESSAGES[Math.floor(rng() * BETTING_MESSAGES.length)];
        else rawText = commentaryPool[Math.floor(rng() * commentaryPool.length)];

        let messageText = formatMessage(rawText, player1Name, player2Name);
        messageText = humanizeMessage(messageText, rng);

        const id = `fake-${matchId.slice(0, 5)}-t${currentTime}`;

        messageSchedule.push({
            time: currentTime,
            message: { id, username, message: messageText, timestamp: currentTime, isFake: true, color }
        });

        const interval = minIntervalMs + rng() * (maxIntervalMs - minIntervalMs);
        currentTime += interval;
    }

    // Inject context-aware messages based on turns
    if (turns.length > 0) {
        const TURN_DURATION_EST = 4000;

        turns.forEach((turn, index) => {
            const turnTime = actualMatchStart + (index * TURN_DURATION_EST);
            const prevTurn = index > 0 ? turns[index - 1] : null;

            const prevBp1 = prevTurn ? prevTurn.bot1Hp : 100;
            const prevBp2 = prevTurn ? prevTurn.bot2Hp : 100;

            const startBp1 = index === 0 && config.bot1MaxHp ? config.bot1MaxHp : prevBp1;
            const startBp2 = index === 0 && config.bot2MaxHp ? config.bot2MaxHp : prevBp2;

            const damageOnBot1 = Math.max(0, startBp1 - turn.bot1Hp);
            const damageOnBot2 = Math.max(0, startBp2 - turn.bot2Hp);

            const maxDamage = Math.max(damageOnBot1, damageOnBot2);

            let eventType: keyof typeof CONTEXT_MESSAGES | null = null;

            if (maxDamage > 25) eventType = "bigHit";

            if ((turn.bot1Move === "block" && damageOnBot1 === 0 && turn.bot2Move !== "block" && turn.bot2Move !== "stunned") ||
                (turn.bot2Move === "block" && damageOnBot2 === 0 && turn.bot1Move !== "block" && turn.bot1Move !== "stunned")) {
                eventType = "block";
            }

            if (maxDamage > 30) eventType = "critical";

            if (eventType && rng() > 0.5) {
                const delay = 1000 + rng() * 2000;
                const msgTime = turnTime + delay;

                const templates = CONTEXT_MESSAGES[eventType];
                const rawText = templates[Math.floor(rng() * templates.length)];
                let messageText = formatMessage(rawText, player1Name, player2Name);
                messageText = humanizeMessage(messageText, rng);

                const username = REALISTIC_USERNAMES[Math.floor(rng() * REALISTIC_USERNAMES.length)];
                const color = USERNAME_COLORS[Math.floor(rng() * USERNAME_COLORS.length)];
                const id = `fake-evt-${matchId.slice(0, 5)}-${index}`;

                messageSchedule.push({
                    time: msgTime,
                    message: { id, username, message: messageText, timestamp: msgTime, isFake: true, color }
                });
            }
        });

        // Add GG at end
        const endTime = actualMatchStart + (turns.length * TURN_DURATION_EST);
        for (let k = 0; k < 3; k++) {
            const msgTime = endTime + rng() * 3000;
            const rawText = CONTEXT_MESSAGES.win[Math.floor(rng() * CONTEXT_MESSAGES.win.length)];
            let messageText = formatMessage(rawText, player1Name, player2Name);
            messageText = humanizeMessage(messageText, rng);
            const username = REALISTIC_USERNAMES[Math.floor(rng() * REALISTIC_USERNAMES.length)];
            const color = USERNAME_COLORS[Math.floor(rng() * USERNAME_COLORS.length)];
            messageSchedule.push({
                time: msgTime,
                message: { id: `gg-${k}`, username, message: messageText, timestamp: msgTime, isFake: true, color }
            });
        }
    }

    // Sort schedule by time
    messageSchedule.sort((a, b) => a.time - b.time);

    return {
        getMessagesUntil(time: number): ChatMessage[] {
            return messageSchedule
                .filter((entry) => entry.time <= time)
                .map((entry) => entry.message);
        },
        getNextMessageTime(time: number): number | null {
            const next = messageSchedule.find((entry) => entry.time > time);
            return next ? next.time : null;
        },
    };
}
