/* oath approve: a second signature (or a revocation) from a browser wallet. Vanilla ES2020; needs only the vendored @solana/web3.js.
   The page builds one Memo transaction and asks the wallet to sign it. Text from inputs goes through textContent only. */
(() => {
  'use strict';
  const NETS = {
    devnet: { rpc: 'https://api.devnet.solana.com', cluster: 'devnet' },
    mainnet: { rpc: 'https://solana-rpc.publicnode.com', cluster: 'mainnet-beta' },
  };
  const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
  const $ = (id) => document.getElementById(id);
  let provider = null;
  let wallet = null; // PublicKey

  // web3.js wants its own Buffer type for instruction data but does not export it; an instance of it is available from any PublicKey.
  const bufferFrom = (bytes) => wallet.toBuffer().constructor.from(bytes);
  const clean = (s) => String(s || '').replace(/[|\r\n]+/g, ' ').trim();

  // Returns { text, error }. `text` is the memo to sign (time is filled in when signing).
  function build(now) {
    const mode = $('a-mode').value;
    const digest = $('a-digest').value.trim().toLowerCase();
    if (!DIGEST_RE.test(digest)) return { error: 'The digest must look like sha256:<64 hex characters>.' };
    const iso = (now || new Date()).toISOString();
    if (mode === 'revoke') return { text: `pod1r|${digest}|${clean($('a-reason').value).slice(0, 100)}|${iso}` };
    const image = clean($('a-image').value);
    const commit = $('a-commit').value.trim().toLowerCase();
    if (!image) return { error: 'Enter the image name (for example ghcr.io/owner/app).' };
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return { error: 'The commit must be 7-40 hex characters.' };
    return { text: `pod1|${image}|${commit.slice(0, 12)}|${digest}|${iso}` };
  }

  function refresh() {
    const isRevoke = $('a-mode').value === 'revoke';
    $('f-image').hidden = isRevoke; $('f-commit').hidden = isRevoke; $('f-reason').hidden = !isRevoke;
    const b = build(new Date(0));
    const pre = $('a-preview');
    if (b.error) { pre.textContent = '(fill in the fields)'; $('a-err').hidden = true; }
    else { pre.textContent = b.text.replace(/\|1970-01-01T00:00:00\.000Z$/, '|<time of signing>'); $('a-err').hidden = true; }
    $('a-sign').disabled = !wallet || !!b.error;
  }

  function findProvider() {
    return (window.phantom && window.phantom.solana) || window.solflare || window.backpack || window.solana || null;
  }

  async function connect() {
    provider = findProvider();
    if (!provider) { show('bad', ['No Solana wallet found in this browser. Install Phantom or Solflare and reload.']); return; }
    try {
      const res = await provider.connect();
      const pk = (res && res.publicKey) || provider.publicKey;
      wallet = new solanaWeb3.PublicKey(pk.toString());
      $('a-wallet').textContent = wallet.toBase58();
      refresh();
    } catch (e) {
      show('bad', ['Wallet connection was refused: ' + (e && e.message ? e.message : e)]);
    }
  }

  function show(kind, lines, link) {
    const out = $('out');
    out.replaceChildren();
    for (const l of lines) {
      const d = document.createElement('div');
      d.textContent = l;
      if (kind === 'bad') d.className = 'badc';
      if (kind === 'ok') d.className = 'good';
      out.appendChild(d);
    }
    if (link) {
      const d = document.createElement('div');
      const a = document.createElement('a');
      a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View the transaction in Solana Explorer';
      d.appendChild(a); out.appendChild(d);
    }
  }

  async function sign(ev) {
    ev.preventDefault();
    const b = build(new Date());
    if (b.error) { $('a-err').textContent = b.error; $('a-err').hidden = false; return; }
    if (!wallet || !provider) return;
    const net = NETS[$('a-net').value] || NETS.devnet;
    const { Connection, Transaction, TransactionInstruction, PublicKey } = solanaWeb3;
    $('a-sign').disabled = true;
    show('', ['Waiting for your wallet to sign…']);
    try {
      const conn = new Connection(net.rpc, 'confirmed');
      const ix = new TransactionInstruction({
        programId: new PublicKey(MEMO_PROGRAM),
        keys: [{ pubkey: wallet, isSigner: true, isWritable: false }],
        data: bufferFrom(new TextEncoder().encode(b.text)),
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = wallet;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      const signed = await provider.signTransaction(tx);
      show('', ['Sending…']);
      const signature = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      const verb = $('a-mode').value === 'revoke' ? 'Revoked' : 'Approved';
      const ci = new URLSearchParams(location.search).get('ci') || '<ci key>';
      show('ok', [
        `${verb}. Signed by ${wallet.toBase58()}`,
        b.text,
        '',
        $('a-mode').value === 'revoke'
          ? 'oath verify now reports this digest as REVOKED.'
          : `Verify with both signers: oath verify --signer ${ci},${wallet.toBase58()} --quorum 2 --digest ${$('a-digest').value.trim()}`,
      ], `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${net.cluster}`);
    } catch (e) {
      show('bad', ['Not signed or not sent: ' + (e && e.message ? e.message : e)]);
    } finally {
      refresh();
    }
  }

  function init() {
    const q = new URLSearchParams(location.search);
    const set = (id, v) => { if (v) $(id).value = v; };
    set('a-image', q.get('image')); set('a-commit', q.get('commit')); set('a-digest', q.get('digest')); set('a-reason', q.get('reason'));
    if (q.get('net') && NETS[q.get('net')]) $('a-net').value = q.get('net');
    if (q.get('mode') === 'revoke') $('a-mode').value = 'revoke';
    for (const id of ['a-mode', 'a-image', 'a-commit', 'a-digest', 'a-reason', 'a-net']) $(id).addEventListener('input', refresh);
    $('a-connect').addEventListener('click', connect);
    $('aform').addEventListener('submit', sign);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
