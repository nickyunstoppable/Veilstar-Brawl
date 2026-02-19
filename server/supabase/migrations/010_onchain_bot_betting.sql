-- =============================================================================
-- On-chain Bot Betting Columns
-- =============================================================================

ALTER TABLE betting_pools
  ADD COLUMN IF NOT EXISTS onchain_pool_id BIGINT,
  ADD COLUMN IF NOT EXISTS onchain_status TEXT DEFAULT 'open' CHECK (onchain_status IN ('open', 'locked', 'settled', 'refunded')),
  ADD COLUMN IF NOT EXISTS onchain_last_tx_id TEXT;

ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS commitment_hash TEXT,
  ADD COLUMN IF NOT EXISTS reveal_salt TEXT,
  ADD COLUMN IF NOT EXISTS revealed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS commit_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS reveal_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS claim_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS onchain_payout_amount BIGINT;

CREATE INDEX IF NOT EXISTS idx_betting_pools_onchain_pool_id ON betting_pools(onchain_pool_id);
CREATE INDEX IF NOT EXISTS idx_bets_commitment_hash ON bets(commitment_hash);
