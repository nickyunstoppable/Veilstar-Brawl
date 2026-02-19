-- =============================================================================
-- Spectate System — Betting Tables Migration
-- Run via Supabase Dashboard > SQL Editor
-- =============================================================================

-- Betting Pools table
CREATE TABLE IF NOT EXISTS betting_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'pvp' CHECK (match_type IN ('pvp', 'bot')),
    player1_total BIGINT NOT NULL DEFAULT 0,
    player2_total BIGINT NOT NULL DEFAULT 0,
    total_pool BIGINT NOT NULL DEFAULT 0,
    total_fees BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'resolved', 'refunded')),
    winner TEXT CHECK (winner IN ('player1', 'player2')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(match_id, match_type)
);

-- Bets table
CREATE TABLE IF NOT EXISTS bets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES betting_pools(id) ON DELETE CASCADE,
    bettor_address TEXT NOT NULL,
    bet_on TEXT NOT NULL CHECK (bet_on IN ('player1', 'player2')),
    amount BIGINT NOT NULL,
    fee_paid BIGINT NOT NULL DEFAULT 0,
    net_amount BIGINT NOT NULL,
    tx_id TEXT,
    payout_amount BIGINT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'won', 'lost', 'refunded')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(pool_id, bettor_address)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_betting_pools_match_id ON betting_pools(match_id);
CREATE INDEX IF NOT EXISTS idx_betting_pools_status ON betting_pools(status);
CREATE INDEX IF NOT EXISTS idx_bets_pool_id ON bets(pool_id);
CREATE INDEX IF NOT EXISTS idx_bets_bettor_address ON bets(bettor_address);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_betting_pools_updated_at') THEN
        CREATE TRIGGER update_betting_pools_updated_at
            BEFORE UPDATE ON betting_pools
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_bets_updated_at') THEN
        CREATE TRIGGER update_bets_updated_at
            BEFORE UPDATE ON bets
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- RLS Policies (if needed)
ALTER TABLE betting_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (server-side operations)
CREATE POLICY "Service role full access on betting_pools" ON betting_pools
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on bets" ON bets
    FOR ALL USING (true) WITH CHECK (true);
