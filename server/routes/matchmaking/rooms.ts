/**
 * Private Room Routes
 * POST /api/matchmaking/rooms
 * POST /api/matchmaking/rooms/join
 */

import { createRoom, joinRoom } from "../../lib/matchmaker";
import { broadcastGameEvent } from "../../lib/matchmaker";

interface CreateRoomBody {
    address?: string;
    stakeAmount?: number;
}

interface JoinRoomBody {
    address?: string;
    roomCode?: string;
}

const MIN_STAKE_XLM = 1;
const STROOPS_PER_XLM = 10_000_000;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

function isValidStellarAddress(value: string): boolean {
    return STELLAR_ADDRESS_REGEX.test(value);
}

function xlmToStroops(amount: number): bigint {
    return BigInt(Math.round(amount * STROOPS_PER_XLM));
}

export async function handleCreateRoom(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as CreateRoomBody;
        const { address, stakeAmount } = body;

        if (!address) {
            return Response.json({ error: "Address is required" }, { status: 400 });
        }

        if (!isValidStellarAddress(address)) {
            return Response.json({ error: "Invalid Stellar address" }, { status: 400 });
        }

        let stakeAmountStroops: bigint | undefined;
        if (stakeAmount !== undefined && stakeAmount !== null) {
            if (typeof stakeAmount !== "number" || Number.isNaN(stakeAmount) || stakeAmount < 0) {
                return Response.json({ error: "Stake amount must be a non-negative number" }, { status: 400 });
            }

            if (stakeAmount > 0 && stakeAmount < MIN_STAKE_XLM) {
                return Response.json({ error: `Minimum stake is ${MIN_STAKE_XLM} XLM` }, { status: 400 });
            }

            if (stakeAmount > 0) {
                stakeAmountStroops = xlmToStroops(stakeAmount);
            }
        }

        const room = await createRoom(address, stakeAmountStroops);
        if (!room) {
            return Response.json({ error: "Failed to create room" }, { status: 500 });
        }

        return Response.json({
            success: true,
            matchId: room.id,
            roomCode: room.code,
            stakeAmountStroops: room.stakeAmountStroops,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to create room" },
            { status: 500 }
        );
    }
}

export async function handleJoinRoom(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as JoinRoomBody;
        const { address, roomCode } = body;

        if (!address || !roomCode) {
            return Response.json({ error: "Address and roomCode are required" }, { status: 400 });
        }

        if (!isValidStellarAddress(address)) {
            return Response.json({ error: "Invalid Stellar address" }, { status: 400 });
        }

        const normalizedCode = roomCode.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(normalizedCode)) {
            return Response.json({ error: "Room code must be 6 alphanumeric characters" }, { status: 400 });
        }

        const joined = await joinRoom(address, normalizedCode);
        if (!joined) {
            return Response.json({ error: "Room not found, full, or unavailable" }, { status: 404 });
        }

        await broadcastGameEvent(joined.id, "room_joined", {
            matchId: joined.id,
            guestAddress: address,
            hostAddress: joined.hostAddress,
            selectionDeadlineAt: joined.selectionDeadlineAt,
            stakeAmountStroops: joined.stakeAmountStroops,
            stakeDeadlineAt: joined.stakeDeadlineAt,
        });

        return Response.json({
            success: true,
            matchId: joined.id,
            hostAddress: joined.hostAddress,
            selectionDeadlineAt: joined.selectionDeadlineAt,
            stakeAmountStroops: joined.stakeAmountStroops,
            stakeDeadlineAt: joined.stakeDeadlineAt,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to join room" },
            { status: 500 }
        );
    }
}
