ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS onchain_session_id integer,
  ADD COLUMN IF NOT EXISTS onchain_tx_hash text;

CREATE INDEX IF NOT EXISTS idx_matches_onchain_session_id
  ON public.matches (onchain_session_id)
  WHERE onchain_session_id IS NOT NULL;
