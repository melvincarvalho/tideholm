// Tidegate committer (#140) — anchor a player's signed trail tip to Bitcoin
// (testnet4) as a BlockTrails state advance.
//
// The peg already produced the signed, off-chain trail (tidegate/<did>.json);
// this commits it ON-chain: spending the output at P(i-1) to create P(i) IS the
// commitment, so a later divergent history for the same (did, seq) is refuted
// by Bitcoin itself.
//
// Division of labour (deliberate):
//   * crypto  — the `blocktrails` reference LIBRARY (scalar tweak, chained key
//     derivation, taproot sighash + Schnorr). Never hand-rolled, so a
//     BlockTrails verifier accepts what we write.
//   * network — mempool.space/testnet4 (UTXO fetch, fee rates, broadcast). The
//     CLI's built-in host (mempool.guide) is dead, which is why we drive the
//     library instead of `blocktrails mark`.
//
// Modes:
//   PREVIEW (default, keyless) — derive the destination trail address and lay
//     out the exact unsigned spend: input, destination, amount, fee. Needs only
//     the pubkey already stored in the trail entries. Nothing signed, nothing
//     broadcast, no key anywhere.
//   SIGN (--broadcast, ANCHOR_KEY in env) — sign with the reference library
//     and print the final raw tx + txid. Still does NOT push.
//   PUSH (--broadcast --yes) — actually broadcast. Signing is deterministic
//     (aux = 0), so the hex you inspected without --yes is byte-identical to
//     the hex that gets pushed.
//
//   node tools/tidegate-anchor.js <did:nostr:…|hex> [--tidegate <dir>] [--fee-rate <n>]
//
// Key convention (nostr trails): the chain is derived from the EVEN-Y point of
// the x-only nostr pubkey (BIP340's implicit-even-Y, applied at the base). The
// base private key is parity-normalized to match before chaining — mirroring
// the reference `transition()` recipe, with the base pinned to 02||x so that
// the whole trail is derivable (and verifiable) from the npub alone.
//
// State string (git-mark convention, matching the suite's anchor.js: literal
// key order, hashed as-is):
//   {"app":"tideholm","did":"<did>","seq":<n>,"tip":"sha256:<hex>"}
// seq = number of signed transitions, tip = sha256 of the canonical trail doc.
// A verifier re-hashes the presented trail and walks the on-chain outputs.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const NETWORK = 'tbtc4';
const API = 'https://mempool.space/testnet4/api';

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const wantBroadcast = args.includes('--broadcast');
const feeRateArg = flag('--fee-rate');
const didArg = args.find((a) => !a.startsWith('--') && a !== feeRateArg && a !== flag('--tidegate'));

if (!didArg) {
  console.error('usage: node tools/tidegate-anchor.js <did:nostr:…|hex> [--tidegate <dir>] [--fee-rate <n>] [--broadcast]');
  process.exit(1);
}
const hex = String(didArg).replace(/^did:nostr:/, '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(hex)) { console.error('did must be did:nostr:<64hex> or a bare 64-hex pubkey'); process.exit(1); }
const did = `did:nostr:${hex}`;

const tidegateDir = flag('--tidegate')
  || process.env.TIDEGATE_DIR
  || (process.env.DATA_DIR && path.join(process.env.DATA_DIR, 'tidegate'))
  || path.join(os.homedir(), 'tideholm/jss-plugin/data/game/tidegate');

// ---------------------------------------------------------------- the trail

const trailFile = path.join(tidegateDir, `${hex}.json`);
let trail;
try { trail = JSON.parse(fs.readFileSync(trailFile, 'utf8')); }
catch { console.error(`no trail for ${did} at ${trailFile} — has this player sealed anything?`); process.exit(1); }
if (!Array.isArray(trail) || trail.length === 0) { console.error('empty trail — nothing to anchor'); process.exit(1); }

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
// The tip hashes a CANONICAL, commitment-free view: exactly the signed fields,
// in fixed key order. The push step stamps `commitment` onto the stored trail —
// operator metadata that must not change the tip it anchored, or every anchor
// would invalidate itself and verifiers re-hashing /api/tidegate/trail would
// never match.
const canonicalTrail = (t) => JSON.stringify(t.map((e) => ({
  did: e.did, prev: e.prev, delta: e.delta, next: e.next, sig: e.sig, pubkey: e.pubkey, at: e.at,
})));
const tip = 'sha256:' + sha256hex(canonicalTrail(trail));
const seq = trail.length;
const state = JSON.stringify({ app: 'tideholm', did, seq, tip });

// The chain of already-anchored states lives beside the seals — needed so the
// n-th anchor derives P(n) from the SUM of all prior tweaks, and so we know
// which address currently holds the trail funds.
const anchorDir = path.join(tidegateDir, 'anchor');
fs.mkdirSync(anchorDir, { recursive: true });
const chainFile = path.join(anchorDir, `${hex}.chain.json`);
let chain = { pubkey: hex, network: NETWORK, states: [] };
try { chain = JSON.parse(fs.readFileSync(chainFile, 'utf8')); } catch { /* first anchor */ }
if (chain.states.some((s) => s.state === state)) {
  console.log('already anchored this exact (did, seq, tip) — nothing to do');
  process.exit(0);
}

// ---------------------------------------------------------- reference crypto

// The blocktrails LIBRARY (not its CLI): resolve the local install, then the
// global one. Zero-dependency repo stays zero-dependency — this is an operator
// tool and the reference implementation is required equipment for it.
async function loadBlocktrails() {
  for (const root of [
    path.join(process.cwd(), 'node_modules'),
    (() => { try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
  ]) {
    if (!root) continue;
    const p = path.join(root, 'blocktrails', 'src', 'index.js');
    if (fs.existsSync(p)) return import(pathToFileURL(p).href);
  }
  console.error('blocktrails library not found — install it: npm i -g blocktrails@0.0.11');
  process.exit(1);
}
const bt = await loadBlocktrails();

// bech32m address encoding (BIP-350). blocktrails keeps its encoder internal,
// so this is inlined — and self-tested below against a pair we verified against
// both blocktrails and the suite's beacon, so drift fails loudly, never silently.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32mEncode(hrp, program) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values) => {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  };
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  // 8-bit → 5-bit
  const words = [];
  let acc = 0, bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const data = [1, ...words]; // witness v1
  const check = polymod([...hrpExpand, ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (check >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => CHARSET[d]).join('');
}
// Self-test: throwaway pubkey → base address, verified earlier against BOTH
// blocktrails' own output and our btc.js/beacon derivation.
{
  const probe = bech32mEncode('tb', bt.hexToBytes('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'));
  if (probe !== 'tb1pfu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4quvla6g') {
    console.error('bech32m self-test FAILED — refusing to derive addresses'); process.exit(1);
  }
}
const toAddress = (xonly32) => bech32mEncode('tb', xonly32);

// x-only nostr pubkey → 33-byte compressed with even Y (BIP340 convention).
const pubkeyBase = bt.hexToBytes('02' + hex);

// Where the funds are NOW: base address if never anchored, else the last state
// address. Where they GO: the chained derivation over all states + this one.
const priorStates = chain.states.map((s) => s.state);
const fromXonly = priorStates.length === 0
  ? bt.hexToBytes(hex)
  : bt.p2trXonly(bt.deriveChainedPublicKey(pubkeyBase, priorStates));
const fromAddress = toAddress(fromXonly);
const nextPub = bt.deriveChainedPublicKey(pubkeyBase, [...priorStates, state]);
const nextXonly = bt.p2trXonly(nextPub);
const nextAddress = toAddress(nextXonly);

// ----------------------------------------------------------------- network

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const utxos = await getJson(`${API}/address/${fromAddress}/utxo`);
// Deterministic input order: the API doesn't guarantee one, and SIGN and PUSH
// are separate runs — sorting is what makes "pushed hex ≡ inspected hex" true.
const confirmed = utxos.filter((u) => u.status && u.status.confirmed)
  .sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
if (confirmed.length === 0) {
  console.error(`no confirmed funds at ${fromAddress} — the trail has no fuel to advance.`);
  console.error(`fund the base address and retry. (pending UTXOs: ${utxos.length - confirmed.length})`);
  process.exit(1);
}
const inputValue = confirmed.reduce((a, u) => a + u.value, 0);

let feeRate = Number(feeRateArg);
if (!feeRate) {
  try { feeRate = Math.max(1, Math.ceil((await getJson(`${API}/v1/fees/recommended`)).halfHourFee)); }
  catch { feeRate = 1; }
}

// The float convention: an anchor that spends the BASE address carves only a
// small float into the trail (default 10k sat, --float <n> to change, --all
// for whole-balance-forward) and returns the rest to base as change. Amounts
// are irrelevant to BlockTrails — verify() walks witness programs, not values —
// so a small float anchors just as hard, while (a) the treasury stays at the
// recognizable base address the DID doc and fuel gauge point at, (b) custody
// exposure on the tweaked-address chain is capped at the float, and (c) faucet
// refills land where the money already is. Tip-to-tip anchors forward the
// whole float (it just rides).
const DUST = 546;
const wantAll = args.includes('--all');
const floatSats = Math.max(1000, Math.trunc(Number(flag('--float')) || 10000));
let carving = priorStates.length === 0 && !wantAll;

let vsize, fee, outputsPlan;
if (carving) {
  vsize = bt.estimateVsize(confirmed.length, 2);
  fee = Math.ceil(vsize * feeRate);
  const change = inputValue - fee - floatSats;
  if (change > DUST) {
    outputsPlan = [
      { xonly: nextXonly, address: nextAddress, value: floatSats, label: 'trail float' },
      { xonly: bt.hexToBytes(hex), address: fromAddress, value: change, label: 'change → base' },
    ];
  } else {
    carving = false; // not enough room for a change output — forward everything
  }
}
if (!carving) {
  vsize = bt.estimateVsize(confirmed.length, 1);
  fee = Math.ceil(vsize * feeRate);
  const forward = inputValue - fee;
  if (forward <= DUST) {
    console.error(`fee ${fee} sat would leave ${forward} sat (dust) — not enough fuel to advance.`);
    process.exit(1);
  }
  outputsPlan = [{ xonly: nextXonly, address: nextAddress, value: forward, label: 'whole balance forward' }];
}

// ----------------------------------------------------------------- report

console.log(`Tidegate anchor — ${wantBroadcast ? 'BROADCAST' : 'PREVIEW (keyless, nothing signed or sent)'}\n`);
console.log(`  did       ${did}`);
console.log(`  trail     seq ${seq} · sealed balance ${trail[trail.length - 1].next} 🪙 · tip ${tip}`);
console.log(`  state     ${state}`);
console.log(`  anchor #  ${priorStates.length + 1}${priorStates.length === 0 ? ' (genesis spend — first anchor of this trail)' : ''}`);
console.log('');
console.log(`  from      ${fromAddress}${priorStates.length === 0 ? '   (base = the fuel-gauge address)' : ''}`);
console.log(`  inputs    ${confirmed.map((u) => `${u.txid}:${u.vout} (${u.value} sat)`).join('\n            ')}`);
for (const o of outputsPlan) {
  const mark = bt.bytesToHex(o.xonly) === bt.bytesToHex(nextXonly) ? `   ← P(${priorStates.length + 1}) = P_base + Σtweaks·G` : '';
  console.log(`  out       ${o.value} sat → ${o.address}  (${o.label})${mark}`);
}
console.log(`  fee       ${fee} sat  (${feeRate} sat/vB × ~${vsize} vB)`);

if (!wantBroadcast) {
  console.log('\npreview only — run with --broadcast and ANCHOR_KEY in the env to sign (and add --yes to push).');
  process.exit(0);
}

// ------------------------------------------------------------- sign + send

const keyHex = process.env.ANCHOR_KEY;
if (!keyHex || !/^[0-9a-f]{64}$/.test(keyHex)) {
  console.error('\nANCHOR_KEY (64-hex privkey) required in the environment for --broadcast — never on the command line.');
  process.exit(1);
}
const priv = bt.hexToBytes(keyHex);

// Real compressed pubkey of the key (genesis() wraps secp.getPublicKey), then
// parity-normalize the base so d'·G = 02||x — the even-Y convention above.
const realPub = bt.hexToBytes(bt.genesis(priv, 'parity-probe').pubkeyBase);
const basePriv = bt.adjustPrivateKeyForSigning(priv, realPub);

// GUARD 1: the key must BE this identity. x-only(d'·G) === the trail's pubkey.
if (bt.bytesToHex(bt.p2trXonly(realPub)) !== hex) {
  console.error('\nANCHOR_KEY does not match this did — refusing to sign.');
  process.exit(1);
}

// The reference transition() recipe, base pinned to even-Y:
//   spend key for P(prev) = adjust(chain(d', priorStates), P(prev))
const chainedPriv = priorStates.length === 0 ? basePriv : bt.deriveChainedPrivateKey(basePriv, priorStates);
const prevP = priorStates.length === 0 ? pubkeyBase : bt.deriveChainedPublicKey(pubkeyBase, priorStates);
const signingKey = bt.adjustPrivateKeyForSigning(chainedPriv, prevP);

// GUARD 2: the signing key's point must sit exactly on the input's witness
// program — a mismatch here is the burn-the-funds bug, so it is fatal.
const signingPub = bt.hexToBytes(bt.genesis(signingKey, 'parity-probe').pubkeyBase);
if (bt.bytesToHex(bt.p2trXonly(signingPub)) !== bt.bytesToHex(fromXonly)) {
  console.error('\nderived signing key does not match the funded output — refusing to sign.');
  process.exit(1);
}

const tx = bt.buildTransaction({
  inputs: confirmed.map((u) => ({ txid: u.txid, vout: u.vout, witnessProgram: fromXonly, amount: u.value })),
  outputs: outputsPlan.map((o) => ({ witnessProgram: o.xonly, value: o.value })),
});
const prevouts = confirmed.map((u) => ({ txid: u.txid, vout: u.vout, witnessProgram: fromXonly, amount: BigInt(u.value) }));
const signed = bt.signTransaction(tx, confirmed.map(() => signingKey), prevouts);
const rawHex = bt.bytesToHex(bt.serializeTransaction(signed));
const txid = bt.computeTxid(signed);

console.log('\n  signed tx');
console.log(`  txid      ${txid}`);
console.log(`  raw       ${rawHex}`);

if (!args.includes('--yes')) {
  console.log('\nsigned but NOT pushed. Inspect the raw tx (e.g. mempool.space testnet4 → Recent txs → Push TX decodes it),');
  console.log('then re-run the same command with --yes to broadcast this exact hex (signing is deterministic).');
  process.exit(0);
}

const resp = await fetch(`${API}/tx`, { method: 'POST', body: rawHex });
const body = await resp.text();
if (!resp.ok) {
  console.error(`\nbroadcast FAILED (${resp.status}): ${body}`);
  process.exit(1);
}
console.log(`\nbroadcast accepted: ${body.trim()}`);
console.log(`explorer: https://mempool.space/testnet4/tx/${txid}`);

// Record the advance and stamp the commitment onto the trail tip.
const commitment = { network: NETWORK, seq, address: nextAddress, txid, explorer: `https://mempool.space/testnet4/tx/${txid}`, at: new Date().toISOString() };
chain.states.push({ state, ...commitment });
fs.writeFileSync(chainFile, JSON.stringify(chain, null, 2));
try {
  const fresh = JSON.parse(fs.readFileSync(trailFile, 'utf8'));
  if (Array.isArray(fresh) && fresh.length) {
    fresh[fresh.length - 1].commitment = commitment;
    fs.writeFileSync(trailFile, JSON.stringify(fresh, null, 2));
  }
} catch { /* the chain file is the anchor record of truth */ }
console.log(`recorded → ${chainFile}`);
