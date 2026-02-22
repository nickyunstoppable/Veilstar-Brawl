import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

// Quick stake amounts in XLM
const QUICK_STAKES = [1, 5, 10, 25, 50, 100];
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const FEE_BPS = 10;

interface RoomCreateProps {
  onRoomCreated?: (matchId: string, roomCode: string, stakeAmountXlm?: number) => void;
  onCancel?: () => void;
}

function toDisplayXlm(value: number): string {
  return value.toFixed(3).replace(/\.000$/, "");
}

function navigateTo(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function RoomCreate({ onRoomCreated, onCancel }: RoomCreateProps) {
  const { publicKey: address, isConnected } = useWallet();
  const [isCreating, setIsCreating] = useState(false);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enableStake, setEnableStake] = useState(false);
  const [stakeAmount, setStakeAmount] = useState<string>("1");
  const [createdStakeAmount, setCreatedStakeAmount] = useState<number | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomChannelRef = useRef<RealtimeChannel | null>(null);
  const hasNavigatedRef = useRef(false);

  const numericStake = useMemo(() => {
    const parsed = Number(stakeAmount);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [stakeAmount]);

  const feeAmount = useMemo(() => (numericStake * FEE_BPS) / 10_000, [numericStake]);
  const requiredDeposit = useMemo(() => numericStake + feeAmount, [numericStake, feeAmount]);

  useEffect(() => {
    if (!matchId) return;

    const supabase = getSupabaseClient();
    let isUnmounted = false;

    hasNavigatedRef.current = false;

    const navigateToMatch = () => {
      if (hasNavigatedRef.current || isUnmounted) return;
      hasNavigatedRef.current = true;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      navigateTo(`/match/${matchId}`);
    };

    if (roomChannelRef.current) {
      supabase.removeChannel(roomChannelRef.current);
      roomChannelRef.current = null;
    }

    const roomChannel = supabase
      .channel(`game:${matchId}`, { config: { broadcast: { self: true } } })
      .on("broadcast", { event: "room_joined" }, () => {
        navigateToMatch();
      })
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "matches",
          filter: `id=eq.${matchId}`,
        },
        (payload) => {
          const next = payload.new as { player2_address?: string | null; status?: string | null };
          if (next?.player2_address || (next?.status && next.status !== "waiting")) {
            navigateToMatch();
          }
        }
      )
      .subscribe();

    roomChannelRef.current = roomChannel;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/matches/${matchId}?lite=1&t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();
        const match = data?.match;
        if (match?.player2_address || (match?.status && match.status !== "waiting")) {
          navigateToMatch();
        }
      } catch {
        // keep polling
      }
    };

    poll();
    pollingRef.current = setInterval(poll, 1000);

    return () => {
      isUnmounted = true;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }

      if (roomChannelRef.current) {
        supabase.removeChannel(roomChannelRef.current);
        roomChannelRef.current = null;
      }
    };
  }, [matchId]);

  const handleCreateRoom = async () => {
    if (!isConnected || !address) {
      setError("Connect your wallet first");
      return;
    }

    const stakeValue = enableStake ? Number(stakeAmount) : undefined;
    if (enableStake) {
      const parsedStake = stakeValue ?? 0;
      if (!Number.isFinite(parsedStake) || parsedStake < 1) {
        setError("Minimum stake is 1 XLM");
        return;
      }
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/matchmaking/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          stakeAmount: stakeValue,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create room");
      }

      setRoomCode(data.roomCode);
      setMatchId(data.matchId);
      setCreatedStakeAmount(stakeValue ?? null);
      onRoomCreated?.(data.matchId, data.roomCode, stakeValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyCode = async () => {
    if (!roomCode) return;

    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (roomCode) {
    return (
      <div className="w-full max-w-md bg-[#050505]/95 border border-cyber-gold/20 backdrop-blur-md rounded-2xl shadow-2xl flex flex-col gap-6 py-8">
        <div className="text-center px-8">
          <h2 className="text-xl sm:text-2xl font-bold font-orbitron text-cyber-gold tracking-wide">
            ROOM CREATED
          </h2>
          <p className="text-gray-400 text-sm mt-3 font-medium">
            Share this code with your opponent
          </p>
        </div>

        <div className="px-8 space-y-6">
          {/* Room Code Display */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <div className="bg-black/50 border border-cyber-gold/30 rounded-lg px-8 py-4 w-full text-center shadow-inner">
              <span className="text-3xl font-bold font-orbitron text-white tracking-[0.2em]">
                {roomCode}
              </span>
            </div>
            <button
              onClick={handleCopyCode}
              className="h-full aspect-square p-4 bg-cyber-gold/10 border border-cyber-gold/30 hover:bg-cyber-gold/20 rounded-lg transition-colors text-cyber-gold flex items-center justify-center"
              title="Copy Code"
            >
              {copied ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          </div>

          {/* Stake Info */}
          {createdStakeAmount && (
            <div className="!mt-6 bg-cyber-gold/5 border border-cyber-gold/20 rounded-lg p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-cyber-gold font-orbitron">
                <span className="text-lg font-bold">{toDisplayXlm(createdStakeAmount)} XLM</span>
                <span className="text-sm text-gray-400">stake per player</span>
              </div>
              <p className="text-xs text-cyber-gray mt-2">
                Winner takes {toDisplayXlm(createdStakeAmount * 2)} XLM
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Deposit: {toDisplayXlm(requiredDeposit)} XLM (includes 0.1% fee)
              </p>
            </div>
          )}

          {/* Waiting Status */}
          <div className="text-center py-2">
            <div className="flex items-center justify-center gap-3">
              <div className="w-5 h-5 border-2 border-cyber-gold border-t-transparent rounded-full animate-spin"></div>
              <span className="text-gray-400 text-sm animate-pulse">Waiting for opponent...</span>
            </div>
          </div>

          {/* Cancel Button */}
          <button
            onClick={onCancel}
            className="w-full bg-black text-white hover:bg-emerald-600 hover:text-white border border-gray-800 hover:border-emerald-500 py-3 rounded-md transition-all duration-200 text-sm font-orbitron tracking-wider uppercase"
          >
            Cancel Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md bg-[#050505]/95 border border-cyber-gold/20 backdrop-blur-md rounded-2xl shadow-2xl flex flex-col gap-6 py-8">
      <div className="text-center px-8 border-b border-white/5 pb-6">
        <h2 className="text-xl sm:text-2xl font-bold font-orbitron text-cyber-gold tracking-wide">
          CREATE PRIVATE ROOM
        </h2>
        <p className="text-gray-400 text-sm mt-2 font-medium">
          Challenge a specific opponent with a room code
        </p>
      </div>

      <div className="px-8">
        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
            <p className="text-red-400 text-sm font-medium">{error}</p>
          </div>
        )}

        {/* Stake Toggle */}
        <button
          type="button"
          onClick={() => setEnableStake(!enableStake)}
          className={`w-full flex items-center justify-between p-4 rounded-xl border transition-all duration-300 ${enableStake
            ? "border-cyber-gold/50 bg-cyber-gold/5"
            : "border-gray-800 bg-gray-900/40 hover:border-gray-700"
            }`}
        >
          <div className="flex items-center gap-4">
            <div className={`flex items-center justify-center w-10 h-10 rounded-full bg-black border ${enableStake ? "border-cyber-gold text-cyber-gold" : "border-gray-800 text-gray-500"}`}>
              {/* Star/Coin Icon */}
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
              </svg>
            </div>
            <div className="text-left">
              <div className={`text-base font-bold font-orbitron ${enableStake ? "text-white" : "text-gray-300"}`}>
                Add Stakes
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                Both players bet XLM, winner takes all
              </div>
            </div>
          </div>
          <div className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 relative ${enableStake ? "bg-cyber-gold" : "bg-gray-700"}`}>
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-300 ${enableStake ? "left-7" : "left-1"}`} />
          </div>
        </button>

        {/* Stake Amount (shown when enabled) */}
        <div className={`overflow-hidden transition-all duration-300 ${enableStake ? "max-h-[400px] opacity-100" : "max-h-0 opacity-0"}`}>
          <div className="relative mt-6">
            <label className="text-xs text-gray-500 mb-2 block ml-1">Stake Amount (XLM)</label>
            <input
              type="number"
              min="1"
              step="0.1"
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              className="w-full bg-[#0A0A0A] border border-gray-800 rounded-lg px-4 py-3 text-white font-orbitron text-xl focus:border-cyber-gold focus:ring-1 focus:ring-cyber-gold/50 outline-none transition-all placeholder:text-gray-700"
              placeholder="10"
            />
          </div>

          {/* Quick stake buttons */}
          <div className="flex gap-2 flex-wrap mt-4">
            {QUICK_STAKES.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => setStakeAmount(amount.toString())}
                className={`px-4 py-2 text-xs font-bold rounded-md transition-all border ${stakeAmount === amount.toString()
                  ? "bg-cyber-gold text-black border-cyber-gold"
                  : "bg-[#1A1A1A] border-transparent text-gray-400 hover:bg-[#2A2A2A] hover:text-white"
                  }`}
              >
                {amount} XLM
              </button>
            ))}
          </div>

          {/* Prize pool preview */}
          {numericStake >= 1 && (
            <div className="mt-6 bg-[#051105] border border-green-900/50 rounded-md p-3 text-center">
              <span className="text-gray-400 text-sm">Total Prize Pool: </span>
              <span className="text-lg font-bold text-green-500 font-orbitron">
                {toDisplayXlm(numericStake * 2)} XLM
              </span>
            </div>
          )}
        </div>

        <div className="pt-8">
          <button
            onClick={handleCreateRoom}
            disabled={!isConnected || isCreating}
            className="w-full bg-gradient-to-r from-[#FFB800] to-[#E03609] text-black font-black tracking-widest font-orbitron hover:brightness-110 py-4 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(255,184,0,0.2)] hover:shadow-[0_0_30px_rgba(255,184,0,0.4)] transition-all duration-300"
          >
            {isCreating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>
                CREATING...
              </span>
            ) : enableStake ? (
              `CREATE ROOM (${toDisplayXlm(numericStake)} XLM STAKE)`
            ) : (
              "CREATE ROOM"
            )}
          </button>

          <button
            onClick={onCancel}
            className="w-full mt-6 bg-black text-white hover:bg-emerald-600 hover:text-white border border-gray-800 hover:border-emerald-500 py-3 rounded-md transition-all duration-200 text-sm font-orbitron tracking-wider uppercase font-bold"
          >
            Back
          </button>
        </div>

        {!isConnected && (
          <p className="text-center text-xs text-yellow-500/80 font-medium mt-6">
            Connect your wallet to create a room
          </p>
        )}
      </div>
    </div>
  );
}
