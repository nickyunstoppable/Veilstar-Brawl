/**
 * Supabase Browser Client
 * Singleton client for browser-side Supabase operations
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Supabase client singleton.
 */
let supabaseClient: SupabaseClient<Database> | null = null;

/**
 * Get or create the Supabase browser client.
 * Uses VITE_ environment variables for configuration.
 */
export function getSupabaseClient(): SupabaseClient<Database> {
    if (supabaseClient) {
        return supabaseClient;
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error(
            "Missing Supabase environment variables. " +
            "Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env."
        );
    }

    supabaseClient = createClient<Database>(supabaseUrl, supabaseAnonKey);

    return supabaseClient;
}

/**
 * Alias for getSupabaseClient for convenience.
 */
export const supabase = () => getSupabaseClient();

/**
 * Create a Supabase Realtime channel.
 */
export function createChannel(channelName: string) {
    return getSupabaseClient().channel(channelName);
}

/**
 * Subscribe to a Supabase Realtime channel with presence.
 */
export function subscribeToPresence(
    channelName: string,
    initialState: Record<string, unknown>
) {
    const channel = createChannel(channelName);

    return channel
        .on("presence", { event: "sync" }, () => {
            const state = channel.presenceState();
            console.log("Presence sync:", state);
        })
        .on("presence", { event: "join" }, ({ key, newPresences }) => {
            console.log("Presence join:", key, newPresences);
        })
        .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
            console.log("Presence leave:", key, leftPresences);
        })
        .subscribe(async (status) => {
            if (status === "SUBSCRIBED") {
                await channel.track(initialState);
            }
        });
}

/**
 * Subscribe to a Supabase Realtime broadcast channel.
 */
export function subscribeToBroadcast<T>(
    channelName: string,
    eventName: string,
    callback: (payload: T) => void
) {
    const channel = createChannel(channelName);

    return channel
        .on("broadcast", { event: eventName }, ({ payload }) => {
            callback(payload as T);
        })
        .subscribe();
}

/**
 * Broadcast a message to a channel via REST API.
 */
export async function broadcast<T>(
    channelName: string,
    eventName: string,
    payload: T
) {
    const client = getSupabaseClient();
    const channel = client.channel(channelName);

    const result = await channel.send({
        type: "broadcast",
        event: eventName,
        payload,
    });

    // Clean up the channel after sending
    await client.removeChannel(channel);

    return result;
}
