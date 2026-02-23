import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROUND_PLAN_CIRCUIT_DIR = (process.env.ZK_GROTH16_ROUND_CIRCUIT_DIR || "").trim()
  || resolve(process.cwd(), "zk_circuits", "veilstar_round_plan_groth16");

const BETTING_SETTLE_CIRCUIT_DIR = (process.env.ZK_BETTING_SETTLE_CIRCUIT_DIR || "").trim()
  || resolve(process.cwd(), "zk_circuits", "zk_betting_settle_groth16");

function resolveFirstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

const ARTIFACT_FILES: Record<string, { absPath: string; contentType: string; cacheControl: string }> = {
  "round_plan.wasm": {
    absPath: resolveFirstExistingPath([
      resolve(ROUND_PLAN_CIRCUIT_DIR, "artifacts", "round_plan.wasm"),
      resolve(ROUND_PLAN_CIRCUIT_DIR, "artifacts", "round_plan_js", "round_plan.wasm"),
    ]),
    contentType: "application/wasm",
    cacheControl: "public, max-age=600",
  },
  "round_plan_final.zkey": {
    absPath: resolve(ROUND_PLAN_CIRCUIT_DIR, "artifacts", "round_plan_final.zkey"),
    contentType: "application/octet-stream",
    cacheControl: "public, max-age=600",
  },
  "verification_key.json": {
    absPath: resolve(ROUND_PLAN_CIRCUIT_DIR, "artifacts", "verification_key.json"),
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=60",
  },
};

const BETTING_ARTIFACT_FILES: Record<string, { absPath: string; contentType: string; cacheControl: string }> = {
  "betting_settle.wasm": {
    absPath: resolveFirstExistingPath([
      resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle.wasm"),
      resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle_js", "betting_settle.wasm"),
    ]),
    contentType: "application/wasm",
    cacheControl: "public, max-age=600",
  },
  "betting_settle_final.zkey": {
    absPath: resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "betting_settle_final.zkey"),
    contentType: "application/octet-stream",
    cacheControl: "public, max-age=600",
  },
  "verification_key.json": {
    absPath: resolve(BETTING_SETTLE_CIRCUIT_DIR, "artifacts", "verification_key.json"),
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=60",
  },
};

export async function handleGetRoundPlanArtifact(fileName: string): Promise<Response> {
  const spec = ARTIFACT_FILES[fileName];
  if (!spec) {
    return Response.json({ error: "Artifact not found" }, { status: 404 });
  }

  if (!existsSync(spec.absPath)) {
    return Response.json(
      {
        error: "Artifact missing on server",
        file: fileName,
        path: spec.absPath,
      },
      { status: 404 },
    );
  }

  const bytes = await readFile(spec.absPath);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": spec.contentType,
      "Cache-Control": spec.cacheControl,
    },
  });
}

export async function handleGetBettingSettleArtifact(fileName: string): Promise<Response> {
  const spec = BETTING_ARTIFACT_FILES[fileName];
  if (!spec) {
    return Response.json({ error: "Artifact not found" }, { status: 404 });
  }

  if (!existsSync(spec.absPath)) {
    return Response.json(
      {
        error: "Artifact missing on server",
        file: fileName,
        path: spec.absPath,
      },
      { status: 404 },
    );
  }

  const bytes = await readFile(spec.absPath);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": spec.contentType,
      "Cache-Control": spec.cacheControl,
    },
  });
}
