-- Adds on-chain transaction hashes for match outcome proof + end_game finalize.
-- Required by server routes (/zk/finalize) and the public match page (/api/matches/:id/public).

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS onchain_outcome_tx_hash text,
  ADD COLUMN IF NOT EXISTS onchain_result_tx_hash text;

CREATE INDEX IF NOT EXISTS idx_matches_onchain_outcome_tx_hash
  ON public.matches (onchain_outcome_tx_hash)
  WHERE onchain_outcome_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matches_onchain_result_tx_hash
  ON public.matches (onchain_result_tx_hash)
  WHERE onchain_result_tx_hash IS NOT NULL;
