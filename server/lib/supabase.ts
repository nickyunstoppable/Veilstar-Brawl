/**
 * Supabase Server Client
 * Uses service role key for full database access (bypasses RLS)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ensureEnvLoaded } from "./env";

ensureEnvLoaded();

let supabaseInstance: SupabaseClient | null = null;

/**
 * Get (or create) the server-side Supabase client.
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process.env.
 */
export function getSupabase(): SupabaseClient {
    if (supabaseInstance) return supabaseInstance;

    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. " +
            "Add them to the root .env file."
        );
    }

    supabaseInstance = createClient(url, serviceKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });

    return supabaseInstance;
}
