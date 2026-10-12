// Anchors a build record (commit + image digest) on Solana devnet via the Memo program.
// Usage: node scripts/anchor.mjs --image ghcr.io/me/app --digest sha256:abc... --commit <sha>
// Env:   SOLANA_SECRET_KEY = JSON array of the CI keypair secret key
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const image = arg("image");
const digest = arg("digest");
const commit = arg("commit");

if (!image || !digest || !commit) {
  console.error("Usage: node scripts/anchor.mjs --image <name> --digest sha256:<hex> --commit <sha>");
  process.exit(1);
}
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
  console.error(`Bad digest format: ${digest}`);
  process.exit(1);
}
if (!process.env.SOLANA_SECRET_KEY) {
  console.error("SOLANA_SECRET_KEY is not set (add it as a GitHub repo secret).");
  process.exit(1);
}

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY)));

// Compact, parseable record. Keep it well under the ~566 byte memo limit.
const record = `pod1|${image}|${commit.slice(0, 12)}|${digest}|${new Date().toISOString()}`;

const ix = new TransactionInstruction({
  programId: MEMO_PROGRAM_ID,
  keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
  data: Buffer.from(record, "utf8"),
});

const conn = new Connection(RPC, "confirmed");
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], {
  commitment: "confirmed",
});

console.log("Anchored:", record);
console.log("Signer  :", payer.publicKey.toBase58());
console.log("Tx      :", sig);
console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
