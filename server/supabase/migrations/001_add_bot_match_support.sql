-- Migration: Add bot match support
-- Adds is_bot_match and bot_character_id columns to matches table
-- Removes player2_address FK constraint to allow bot addresses not in players table

-- 1. Add bot match columns
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS is_bot_match boolean NOT NULL DEFAULT false;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS bot_character_id text;

-- 2. Drop FK constraints that block bot addresses
-- player2_address FK (bots don't exist in players table)
ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_player2_fkey;

-- rounds.winner_address FK (bot can win a round)
ALTER TABLE public.rounds
  DROP CONSTRAINT IF EXISTS rounds_winner_fkey;

-- moves.player_address FK (bot moves are recorded)
ALTER TABLE public.moves
  DROP CONSTRAINT IF EXISTS moves_player_fkey;
