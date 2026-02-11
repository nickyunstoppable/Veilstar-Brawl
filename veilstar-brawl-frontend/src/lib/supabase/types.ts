/**
 * Supabase Database Types (placeholder)
 * Add table types as the schema evolves.
 */
export interface Database {
    public: {
        Tables: Record<string, never>;
        Views: Record<string, never>;
        Functions: Record<string, never>;
        Enums: Record<string, never>;
    };
}
