import { getOnChainMatchStateBySession } from "./server/lib/stellar-contract";

async function main() {
  const sessionId = 123456789;
  const result = await getOnChainMatchStateBySession(sessionId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
