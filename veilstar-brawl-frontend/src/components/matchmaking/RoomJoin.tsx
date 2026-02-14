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
    <div className="w-full max-w-md bg-[#050505]/95 border border-cyber-gold/20 backdrop-blur-md rounded-2xl shadow-2xl flex flex-col gap-6 py-8">
      <div className="text-center px-8 border-b border-white/5 pb-6">
        <h2 className="text-xl sm:text-2xl font-bold font-orbitron text-cyber-gold tracking-wide">
          JOIN PRIVATE ROOM
        </h2>
        <p className="text-gray-400 text-sm mt-2 font-medium">
          Enter the room code shared by your opponent
        </p>
      </div>

      <div className="px-8">
        {/* Room Code Input */}
        <div>
          <label className="text-xs text-gray-500 block mb-2 ml-1 uppercase tracking-widest font-bold font-orbitron">
            Room Code
          </label>
          <input
            type="text"
            value={roomCode}
            onChange={(e) => handleCodeChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && roomCode.length === 6) {
                handleJoinRoom();
              }
            }}
            className="w-full bg-[#0A0A0A] border-2 border-gray-800 focus:border-cyber-gold rounded-xl px-4 py-5 text-center text-4xl font-bold font-orbitron text-white tracking-[0.3em] placeholder:text-gray-800 focus:outline-none transition-all duration-300 shadow-inner"
            placeholder="XXXXXX"
            autoComplete="off"
            maxLength={6}
            autoFocus
          />
          <p className="text-xs text-gray-600 text-center font-mono mt-2">
            {roomCode.length}/6 characters
          </p>
        </div>

        {/* Stake Preview (shown when joining a staked room) */}
        {stakePreview && (
          <div className="mt-8 bg-[#051105] border border-green-900/50 rounded-md p-4 text-center animate-in fade-in slide-in-from-top-4">
            <span className="text-gray-400 text-sm">Total Prize Pool: </span>
            <span className="text-lg font-bold text-green-500 font-orbitron">
              {(stakePreview * 2).toFixed(3).replace(/\.000$/, "")} XLM
            </span>
            <p className="text-xs text-gray-500 mt-1">
              Requires {stakePreview.toFixed(3).replace(/\.000$/, "")} XLM Stake
            </p>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="mt-6 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
            <p className="text-red-400 text-sm font-medium">{error}</p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="pt-8">
          <button
            onClick={handleJoinRoom}
            disabled={!isConnected || isJoining || roomCode.length !== 6}
            className="w-full bg-gradient-to-r from-[#FFB800] to-[#E03609] text-black font-black tracking-widest font-orbitron hover:brightness-110 py-4 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(255,184,0,0.2)] hover:shadow-[0_0_30px_rgba(255,184,0,0.4)] transition-all duration-300"
          >
            {isJoining ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>
                JOINING...
              </span>
            ) : (
              "JOIN ROOM"
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
            Connect your wallet to join a room
          </p>
        )}
      </div>
    </div>
  );
}
