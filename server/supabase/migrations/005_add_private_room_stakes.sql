ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS stake_amount_stroops text,
  ADD COLUMN IF NOT EXISTS stake_fee_bps integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS stake_deadline_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS player1_stake_tx_id text,
  ADD COLUMN IF NOT EXISTS player2_stake_tx_id text,
  ADD COLUMN IF NOT EXISTS player1_stake_confirmed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS player2_stake_confirmed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS stake_paid_out boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS protocol_fee_stroops text;

CREATE INDEX IF NOT EXISTS idx_matches_room_code_waiting
  ON public.matches (room_code)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_matches_stake_deadline
  ON public.matches (stake_deadline_at)
  WHERE stake_deadline_at IS NOT NULL;
