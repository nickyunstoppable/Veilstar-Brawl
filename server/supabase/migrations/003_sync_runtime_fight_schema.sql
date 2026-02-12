-- Migration: Sync runtime fight schema with current server/frontend expectations
-- Safe/idempotent updates for environments that started from older schema versions.

-- -----------------------------------------------------------------------------
-- matches columns used by current runtime flows
-- -----------------------------------------------------------------------------
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS player1_ban_id text;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS player2_ban_id text;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS player1_disconnected_at timestamp with time zone;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS player2_disconnected_at timestamp with time zone;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS disconnect_timeout_seconds integer DEFAULT 30;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS fight_phase text DEFAULT 'waiting'::text;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS fight_phase_started_at timestamp with time zone;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS power_surge_deck jsonb;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS is_bot_match boolean NOT NULL DEFAULT false;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS bot_character_id text;

-- -----------------------------------------------------------------------------
-- rounds columns used by countdown/timeout/stun flows
-- -----------------------------------------------------------------------------
ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS turn_number integer DEFAULT 1;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS move_deadline_at timestamp with time zone;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS countdown_started_at timestamp with time zone;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS countdown_seconds integer DEFAULT 3;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS player1_is_stunned boolean DEFAULT false;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS player2_is_stunned boolean DEFAULT false;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS player1_energy integer DEFAULT 0;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS player2_energy integer DEFAULT 0;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS player1_guard_meter integer DEFAULT 0;

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS player2_guard_meter integer DEFAULT 0;

-- -----------------------------------------------------------------------------
-- Snapshot table (server authoritative fight state)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fight_state_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL UNIQUE,
  current_round integer NOT NULL DEFAULT 1,
  current_turn integer NOT NULL DEFAULT 1,
  phase text NOT NULL DEFAULT 'waiting'::text,
  phase_started_at timestamp with time zone NOT NULL DEFAULT now(),
  player1_health integer NOT NULL DEFAULT 100,
  player1_max_health integer NOT NULL DEFAULT 100,
  player1_energy integer NOT NULL DEFAULT 100,
  player1_max_energy integer NOT NULL DEFAULT 100,
  player1_guard_meter integer NOT NULL DEFAULT 0,
  player1_rounds_won integer NOT NULL DEFAULT 0,
  player1_is_stunned boolean NOT NULL DEFAULT false,
  player1_has_submitted_move boolean NOT NULL DEFAULT false,
  player2_health integer NOT NULL DEFAULT 100,
  player2_max_health integer NOT NULL DEFAULT 100,
  player2_energy integer NOT NULL DEFAULT 100,
  player2_max_energy integer NOT NULL DEFAULT 100,
  player2_guard_meter integer NOT NULL DEFAULT 0,
  player2_rounds_won integer NOT NULL DEFAULT 0,
  player2_is_stunned boolean NOT NULL DEFAULT false,
  player2_has_submitted_move boolean NOT NULL DEFAULT false,
  move_deadline_at timestamp with time zone,
  countdown_ends_at timestamp with time zone,
  last_resolved_player1_move text,
  last_resolved_player2_move text,
  last_narrative text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT fight_state_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT fight_state_snapshots_match_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id)
);

CREATE INDEX IF NOT EXISTS idx_fight_state_snapshots_match_id
  ON public.fight_state_snapshots(match_id);

-- -----------------------------------------------------------------------------
-- Power surge relational mirror table (used by polling paths in frontend)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.power_surges (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL,
  round_number integer NOT NULL,
  player1_card_id text,
  player2_card_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT power_surges_pkey PRIMARY KEY (id),
  CONSTRAINT power_surges_match_round_key UNIQUE (match_id, round_number),
  CONSTRAINT power_surges_match_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id)
);

CREATE INDEX IF NOT EXISTS idx_power_surges_match_round
  ON public.power_surges(match_id, round_number);
