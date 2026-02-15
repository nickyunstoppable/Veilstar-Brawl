CREATE TABLE IF NOT EXISTS public.round_resolution_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number >= 1),
  lock_owner text,
  lock_acquired_at timestamptz NOT NULL DEFAULT now(),
  resolved_round_id uuid REFERENCES public.rounds(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_round_resolution_locks_match_round
  ON public.round_resolution_locks (match_id, round_number);

CREATE INDEX IF NOT EXISTS idx_round_resolution_locks_resolved
  ON public.round_resolution_locks (resolved_round_id);
