import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

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

  const numericStake = useMemo(() => {
    const parsed = Number(stakeAmount);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [stakeAmount]);

  const feeAmount = useMemo(() => (numericStake * FEE_BPS) / 10_000, [numericStake]);
  const requiredDeposit = useMemo(() => numericStake + feeAmount, [numericStake, feeAmount]);

  useEffect(() => {
    if (!matchId) return;

    const supabase = getSupabaseClient();

    if (roomChannelRef.current) {
      supabase.removeChannel(roomChannelRef.current);
      roomChannelRef.current = null;
    }

    const roomChannel = supabase
      .channel(`game:${matchId}`, { config: { broadcast: { self: true } } })
      .on("broadcast", { event: "room_joined" }, () => {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
        navigateTo(`/match/${matchId}`);
      })
      .subscribe();

    roomChannelRef.current = roomChannel;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/matches/${matchId}?lite=1`);
        if (!res.ok) return;
        const data = await res.json();
        const match = data?.match;
        if (match?.player2_address) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          navigateTo(`/match/${matchId}`);
        }
      } catch {
        // keep polling
      }
    };

    poll();
    pollingRef.current = setInterval(poll, 2000);

    return () => {
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
      <div className="w-full max-w-md bg-black/60 border border-cyber-gold/30 rounded-[20px] p-8">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-cyber-gold font-orbitron">ROOM CREATED</h2>
          <p className="text-cyber-gray text-sm mt-2">Share this code with your opponent</p>
        </div>

        <div className="flex items-center justify-center gap-3 mb-5">
          <div className="bg-black/80 border-2 border-cyber-gold rounded-xl px-8 py-4 min-w-[220px] text-center">
            <span className="text-4xl font-bold font-orbitron text-white tracking-widest">{roomCode}</span>
          </div>
          <button
            onClick={handleCopyCode}
            className="border border-cyber-gold/50 hover:bg-cyber-gold/10 rounded-xl px-3 py-2 text-cyber-gold text-xs font-orbitron"
          >
            {copied ? "COPIED" : "COPY"}
          </button>
        </div>

        {createdStakeAmount && (
          <div className="bg-cyber-gold/10 border border-cyber-gold/30 rounded-xl p-4 text-center mb-5">
            <p className="text-cyber-gold font-orbitron text-lg font-bold">
              {toDisplayXlm(createdStakeAmount)} XLM stake per player
            </p>
            <p className="text-cyber-gray text-xs mt-1">
              Required deposit: {toDisplayXlm(createdStakeAmount + (createdStakeAmount * FEE_BPS) / 10000)} XLM each
            </p>
            <p className="text-green-400 text-xs mt-1">
              Winner payout: {toDisplayXlm(createdStakeAmount * 2)} XLM
            </p>
          </div>
        )}

        <div className="text-center mb-5">
          <p className="text-cyber-gray text-sm animate-pulse">Waiting for opponent to join...</p>
        </div>

        <button
          onClick={onCancel}
          className="w-full bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl transition-all text-sm"
        >
          BACK
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md bg-black/60 border border-cyber-blue/30 rounded-[20px] p-8">
      <h2 className="text-2xl font-bold text-white font-orbitron mb-2">CREATE PRIVATE ROOM</h2>
      <p className="text-cyber-gray text-sm mb-6">Challenge a friend with a private room code.</p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 mb-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-4 mb-6">
        <button
          type="button"
          onClick={() => setEnableStake((prev) => !prev)}
          className={`w-full flex items-center justify-between rounded-xl border px-4 py-3 transition-all ${
            enableStake ? "border-cyber-gold bg-cyber-gold/10" : "border-white/10 bg-black/30"
          }`}
        >
          <div className="text-left">
            <p className={`font-orbitron text-sm ${enableStake ? "text-cyber-gold" : "text-white"}`}>ENABLE XLM STAKE</p>
            <p className="text-cyber-gray text-xs">Winner takes all, protocol fee 0.1%</p>
          </div>
          <div className={`w-11 h-6 rounded-full ${enableStake ? "bg-cyber-gold" : "bg-white/20"}`}>
            <div className={`w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${enableStake ? "translate-x-5" : "translate-x-0.5"}`} />
          </div>
        </button>

        {enableStake && (
          <div className="space-y-3">
            <label className="block text-cyber-gray text-xs font-orbitron">STAKE AMOUNT (XLM)</label>
            <input
              type="number"
              min="1"
              step="0.1"
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-3 text-white font-mono focus:border-cyber-blue/50 focus:outline-none transition-colors"
            />

            <div className="flex flex-wrap gap-2">
              {QUICK_STAKES.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStakeAmount(String(value))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-orbitron transition-all ${
                    Number(stakeAmount) === value
                      ? "bg-cyber-blue text-white"
                      : "bg-white/5 border border-white/10 text-cyber-gray"
                  }`}
                >
                  {value} XLM
                </button>
              ))}
            </div>

            {numericStake >= 1 && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-sm">
                <p className="text-emerald-400">Prize pool: {toDisplayXlm(numericStake * 2)} XLM</p>
                <p className="text-cyber-gray text-xs mt-1">
                  Each player deposits {toDisplayXlm(requiredDeposit)} XLM ({toDisplayXlm(numericStake)} + {toDisplayXlm(feeAmount)} fee)
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <button
          onClick={handleCreateRoom}
          disabled={!isConnected || isCreating}
          className="w-full bg-gradient-cyber text-white border-0 font-orbitron hover:opacity-90 py-3 rounded-xl text-sm disabled:opacity-50"
        >
          {isCreating
            ? "CREATING..."
            : enableStake
            ? `CREATE ROOM (${toDisplayXlm(numericStake)} XLM STAKE)`
            : "CREATE ROOM"}
        </button>
        <button
          onClick={onCancel}
          className="w-full bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl transition-all text-sm"
        >
          BACK
        </button>
      </div>

      {!isConnected && (
        <p className="text-center text-yellow-400 text-xs mt-4">Connect your wallet to create a room.</p>
      )}
    </div>
  );
}
