-- Veilstar Brawl: Core Schema
-- Scoped to ranked quick-match only
-- Apply to your Supabase project via SQL editor or migrations

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================================
-- PLAYERS
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.players (
  address text NOT NULL,
  display_name text CHECK (
    display_name IS NULL
    OR (length(display_name) <= 32 AND display_name ~ '^[a-zA-Z0-9_]+$')
  ),
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  rating integer NOT NULL DEFAULT 1000 CHECK (rating >= 100 AND rating <= 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT players_pkey PRIMARY KEY (address)
);

-- =====================================================================
-- MATCHES
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.matches (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  room_code text UNIQUE CHECK (room_code IS NULL OR room_code ~ '^[A-Z0-9]{6}$'),
  player1_address text NOT NULL,
  player2_address text,
  player1_character_id text,
  player2_character_id text,
  format text NOT NULL DEFAULT 'best_of_3' CHECK (format IN ('best_of_3', 'best_of_5')),
  status text NOT NULL DEFAULT 'waiting' CHECK (
    status IN ('waiting', 'character_select', 'in_progress', 'completed', 'cancelled')
  ),
  winner_address text,
  player1_rounds_won integer NOT NULL DEFAULT 0,
  player2_rounds_won integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  selection_deadline_at timestamptz,
  player1_disconnected_at timestamptz,
  player2_disconnected_at timestamptz,
  disconnect_timeout_seconds integer DEFAULT 30,
  fight_phase text DEFAULT 'waiting' CHECK (
    fight_phase IS NULL OR fight_phase IN (
      'waiting', 'countdown', 'selecting', 'resolving', 'round_end', 'match_end'
    )
  ),
  fight_phase_started_at timestamptz,
  power_surge_deck jsonb,
  CONSTRAINT matches_pkey PRIMARY KEY (id),
  CONSTRAINT matches_player1_fkey FOREIGN KEY (player1_address) REFERENCES public.players(address),
  CONSTRAINT matches_player2_fkey FOREIGN KEY (player2_address) REFERENCES public.players(address),
  CONSTRAINT matches_winner_fkey FOREIGN KEY (winner_address) REFERENCES public.players(address)
);

-- =====================================================================
-- MATCHMAKING QUEUE
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.matchmaking_queue (
  address text NOT NULL,
  rating integer NOT NULL DEFAULT 1000,
  joined_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'searching' CHECK (status IN ('searching', 'matched')),
  matched_with text,
  CONSTRAINT matchmaking_queue_pkey PRIMARY KEY (address),
  CONSTRAINT matchmaking_queue_address_fkey FOREIGN KEY (address) REFERENCES public.players(address),
  CONSTRAINT matchmaking_queue_matched_fkey FOREIGN KEY (matched_with) REFERENCES public.players(address)
);

-- =====================================================================
-- ROUNDS
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rounds (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  match_id uuid NOT NULL,
  round_number integer NOT NULL CHECK (round_number > 0),
  turn_number integer DEFAULT 1 CHECK (turn_number >= 1),
  player1_move text CHECK (player1_move IN ('punch', 'kick', 'block', 'special', 'stunned')),
  player2_move text CHECK (player2_move IN ('punch', 'kick', 'block', 'special', 'stunned')),
  player1_damage_dealt integer CHECK (player1_damage_dealt IS NULL OR player1_damage_dealt >= 0),
  player2_damage_dealt integer CHECK (player2_damage_dealt IS NULL OR player2_damage_dealt >= 0),
  player1_health_after integer CHECK (player1_health_after IS NULL OR player1_health_after >= 0),
  player2_health_after integer CHECK (player2_health_after IS NULL OR player2_health_after >= 0),
  player1_energy integer DEFAULT 0,
  player2_energy integer DEFAULT 0,
  player1_guard_meter integer DEFAULT 0,
  player2_guard_meter integer DEFAULT 0,
  winner_address text,
  move_deadline_at timestamptz,
  countdown_started_at timestamptz,
  countdown_seconds integer DEFAULT 3,
  player1_is_stunned boolean DEFAULT false,
  player2_is_stunned boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rounds_pkey PRIMARY KEY (id),
  CONSTRAINT rounds_match_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id),
  CONSTRAINT rounds_winner_fkey FOREIGN KEY (winner_address) REFERENCES public.players(address)
);

-- =====================================================================
-- MOVES (individual move records with Stellar signatures)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.moves (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  round_id uuid NOT NULL,
  player_address text NOT NULL,
  move_type text NOT NULL CHECK (move_type IN ('punch', 'kick', 'block', 'special', 'stunned')),
  signature text,  -- Stellar signature for move verification
  signed_message text,  -- The signed message payload
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moves_pkey PRIMARY KEY (id),
  CONSTRAINT moves_round_fkey FOREIGN KEY (round_id) REFERENCES public.rounds(id),
  CONSTRAINT moves_player_fkey FOREIGN KEY (player_address) REFERENCES public.players(address)
);

-- =====================================================================
-- FIGHT STATE SNAPSHOTS (reconnection/sync)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.fight_state_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL UNIQUE,
  current_round integer NOT NULL DEFAULT 1 CHECK (current_round >= 1),
  current_turn integer NOT NULL DEFAULT 1 CHECK (current_turn >= 1),
  phase text NOT NULL DEFAULT 'waiting' CHECK (
    phase IN ('waiting', 'countdown', 'selecting', 'resolving', 'round_end', 'match_end')
  ),
  phase_started_at timestamptz NOT NULL DEFAULT now(),
  player1_health integer NOT NULL DEFAULT 100 CHECK (player1_health >= 0),
  player1_max_health integer NOT NULL DEFAULT 100 CHECK (player1_max_health > 0),
  player1_energy integer NOT NULL DEFAULT 100 CHECK (player1_energy >= 0),
  player1_max_energy integer NOT NULL DEFAULT 100 CHECK (player1_max_energy > 0),
  player1_guard_meter integer NOT NULL DEFAULT 0 CHECK (player1_guard_meter >= 0 AND player1_guard_meter <= 100),
  player1_rounds_won integer NOT NULL DEFAULT 0 CHECK (player1_rounds_won >= 0),
  player1_is_stunned boolean NOT NULL DEFAULT false,
  player1_has_submitted_move boolean NOT NULL DEFAULT false,
  player2_health integer NOT NULL DEFAULT 100 CHECK (player2_health >= 0),
  player2_max_health integer NOT NULL DEFAULT 100 CHECK (player2_max_health > 0),
  player2_energy integer NOT NULL DEFAULT 100 CHECK (player2_energy >= 0),
  player2_max_energy integer NOT NULL DEFAULT 100 CHECK (player2_max_energy > 0),
  player2_guard_meter integer NOT NULL DEFAULT 0 CHECK (player2_guard_meter >= 0 AND player2_guard_meter <= 100),
  player2_rounds_won integer NOT NULL DEFAULT 0 CHECK (player2_rounds_won >= 0),
  player2_is_stunned boolean NOT NULL DEFAULT false,
  player2_has_submitted_move boolean NOT NULL DEFAULT false,
  move_deadline_at timestamptz,
  countdown_ends_at timestamptz,
  last_resolved_player1_move text,
  last_resolved_player2_move text,
  last_narrative text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fight_state_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT fight_state_snapshots_match_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id)
);

-- =====================================================================
-- INDEXES
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_matches_status ON public.matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_player1 ON public.matches(player1_address);
CREATE INDEX IF NOT EXISTS idx_matches_player2 ON public.matches(player2_address);
CREATE INDEX IF NOT EXISTS idx_rounds_match ON public.rounds(match_id);
CREATE INDEX IF NOT EXISTS idx_moves_round ON public.moves(round_id);
CREATE INDEX IF NOT EXISTS idx_matchmaking_status ON public.matchmaking_queue(status);

-- =====================================================================
-- ROW LEVEL SECURITY (basic — tighten for production)
-- =====================================================================
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matchmaking_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fight_state_snapshots ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; anon/auth policies added per need
CREATE POLICY "Service role full access" ON public.players FOR ALL USING (true);
CREATE POLICY "Service role full access" ON public.matches FOR ALL USING (true);
CREATE POLICY "Service role full access" ON public.matchmaking_queue FOR ALL USING (true);
CREATE POLICY "Service role full access" ON public.rounds FOR ALL USING (true);
CREATE POLICY "Service role full access" ON public.moves FOR ALL USING (true);
CREATE POLICY "Service role full access" ON public.fight_state_snapshots FOR ALL USING (true);

-- =====================================================================
-- REALTIME (enable for matches and fight_state_snapshots)
-- =====================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
ALTER PUBLICATION supabase_realtime ADD TABLE public.fight_state_snapshots;
