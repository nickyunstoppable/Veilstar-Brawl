/**
 * Cron route: sweep protocol fees from contract to treasury.
 * POST /api/cron/sweep-fees
 */

import { sweepTreasuryFeesOnChain } from "../../lib/stellar-contract";

const CRON_TOKEN = process.env.CRON_SECRET || "";

function isAuthorized(req: Request): boolean {
  if (!CRON_TOKEN) return true;
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return bearer === CRON_TOKEN;
}

export async function handleSweepFeesCron(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sweepTreasuryFeesOnChain();
  if (!result.success) {
    return Response.json(
      {
        success: false,
        error: result.error || "Sweep failed",
      },
      { status: 500 }
    );
  }

  return Response.json({
    success: true,
    txHash: result.txHash,
    sweptAmountStroops: result.sweptAmountStroops,
  });
}
