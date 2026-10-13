// Sends one Memo transaction signed by the given key (used by `oath revoke`). Needs @solana/web3.js (installed with npm ci).
export async function sendMemo({ text, secretKey, rpcUrl }) {
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const ix = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(text, "utf8"),
  });
  const conn = new Connection(String(rpcUrl).split(",")[0].trim(), "confirmed");
  const signature = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  return { signature, signer: payer.publicKey.toBase58() };
}
