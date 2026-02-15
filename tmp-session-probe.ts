import { getOnChainMatchStateBySession } from "./server/lib/stellar-contract";
import { getSupabase } from "./server/lib/supabase";

const supabase = getSupabase();

function randomU32(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

async function main() {
  for (let i = 0; i < 8; i++) {
    const sessionId = randomU32();
    const { data, error } = await supabase
      .from("matches")
      .select("id")
      .eq("onchain_session_id", sessionId)
      .limit(1);

    const onChain = await getOnChainMatchStateBySession(sessionId);

    console.log({
      sessionId,
      dbCount: (data || []).length,
      dbError: error?.message || null,
      onChainFound: !!onChain,
    });
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
