import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const STROOPS_PER_XLM = 10_000_000;

interface RoomJoinProps {
  onJoined?: (matchId: string, stakeAmountStroops?: string) => void;
  onCancel?: () => void;
}

function navigateTo(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function stroopsToXlm(stroops?: string): number | null {
  if (!stroops) return null;
  try {
    return Number(BigInt(stroops)) / STROOPS_PER_XLM;
  } catch {
    return null;
  }
}

export default function RoomJoin({ onJoined, onCancel }: RoomJoinProps) {
  const { publicKey: address, isConnected } = useWallet();
  const [roomCode, setRoomCode] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stakePreview, setStakePreview] = useState<number | null>(null);

  const handleCodeChange = (value: string) => {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    setRoomCode(normalized);
    setError(null);
    setStakePreview(null);
  };

  const handleJoinRoom = async () => {
    if (!isConnected || !address) {
      setError("Connect your wallet first");
      return;
    }

    if (roomCode.length !== 6) {
      setError("Room code must be 6 characters");
      return;
    }

    setIsJoining(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/matchmaking/rooms/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, roomCode }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to join room");
      }

      const preview = stroopsToXlm(data.stakeAmountStroops);
      if (preview) setStakePreview(preview);

      onJoined?.(data.matchId, data.stakeAmountStroops);
      navigateTo(`/match/${data.matchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join room");
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div className="w-full max-w-md bg-black/60 border border-cyber-orange/30 rounded-[20px] p-8">
      <h2 className="text-2xl font-bold text-white font-orbitron mb-2">JOIN PRIVATE ROOM</h2>
      <p className="text-cyber-gray text-sm mb-6">Enter the room code shared by your opponent.</p>

      <div className="space-y-2 mb-5">
        <label className="block text-cyber-gray text-xs font-orbitron">ROOM CODE</label>
        <input
          type="text"
          value={roomCode}
          onChange={(e) => handleCodeChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && roomCode.length === 6) {
              handleJoinRoom();
            }
          }}
          className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-3 text-white font-mono uppercase tracking-widest text-center text-lg focus:border-cyber-orange/50 focus:outline-none transition-colors"
          placeholder="XXXXXX"
          autoComplete="off"
          maxLength={6}
          autoFocus
        />
        <p className="text-cyber-gray text-xs text-right">{roomCode.length}/6</p>
      </div>

      {stakePreview && (
        <div className="bg-cyber-gold/10 border border-cyber-gold/30 rounded-xl p-3 mb-4 text-center">
          <p className="text-cyber-gold font-orbitron font-bold">Stake required: {stakePreview.toFixed(3).replace(/\.000$/, "")} XLM</p>
          <p className="text-green-400 text-xs mt-1">Winner payout: {(stakePreview * 2).toFixed(3).replace(/\.000$/, "")} XLM</p>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 mb-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <button
          onClick={handleJoinRoom}
          disabled={!isConnected || isJoining || roomCode.length !== 6}
          className="w-full bg-gradient-cyber text-white border-0 font-orbitron hover:opacity-90 py-3 rounded-xl text-sm disabled:opacity-50"
        >
          {isJoining ? "JOINING..." : "JOIN ROOM"}
        </button>
        <button
          onClick={onCancel}
          className="w-full bg-transparent border border-white/10 text-cyber-gray font-orbitron hover:bg-white/5 py-3 rounded-xl transition-all text-sm"
        >
          BACK
        </button>
      </div>

      {!isConnected && (
        <p className="text-center text-yellow-400 text-xs mt-4">Connect your wallet to join a room.</p>
      )}
    </div>
  );
}
