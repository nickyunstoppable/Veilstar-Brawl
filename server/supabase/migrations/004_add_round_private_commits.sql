CREATE TABLE IF NOT EXISTS public.round_private_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number >= 1),
  player_address text NOT NULL,
  commitment text NOT NULL,
  encrypted_plan text,
  proof_public_inputs jsonb,
  transcript_hash text,
  onchain_commit_tx_hash text,
  verified_at timestamptz,
  resolved_at timestamptz,
  resolved_round_id uuid REFERENCES public.rounds(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, round_number, player_address)
);

CREATE INDEX IF NOT EXISTS idx_round_private_commits_match_round
  ON public.round_private_commits (match_id, round_number);
