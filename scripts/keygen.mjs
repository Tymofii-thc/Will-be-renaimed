// Generates a throwaway Solana keypair for CI and tries a devnet airdrop.
// Usage: node scripts/keygen.mjs
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const kp = Keypair.generate();
const pub = kp.publicKey.toBase58();
const secret = JSON.stringify(Array.from(kp.secretKey));

console.log("PUBLIC KEY (paste into the verifier page):");
console.log(pub);
console.log("\nSECRET KEY -> GitHub repo secret named SOLANA_SECRET_KEY (keep it private):");
console.log(secret);

try {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("\nAirdrop OK: 1 SOL on devnet.");
} catch (e) {
  console.log("\nAirdrop failed (devnet faucet is often rate-limited): " + e.message);
  console.log("Fund the public key manually at https://faucet.solana.com (choose devnet).");
}
