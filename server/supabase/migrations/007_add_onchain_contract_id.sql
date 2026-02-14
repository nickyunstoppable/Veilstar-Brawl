ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS onchain_contract_id text;

CREATE INDEX IF NOT EXISTS idx_matches_onchain_contract_id
  ON public.matches (onchain_contract_id)
  WHERE onchain_contract_id IS NOT NULL;
