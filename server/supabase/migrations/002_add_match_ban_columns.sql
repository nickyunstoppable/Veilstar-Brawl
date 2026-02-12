-- Add persistent ban columns to matches for character select recovery
ALTER TABLE public.matches
ADD COLUMN IF NOT EXISTS player1_ban_id text,
ADD COLUMN IF NOT EXISTS player2_ban_id text;