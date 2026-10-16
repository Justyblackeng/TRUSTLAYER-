// Fee collection: NGN 200 (about USD 0.13) per on-chain mint and per bank verification,
// taken from the account in question after its holder approves:
//   bank account -> one-time code sent by the bank (src/debit.js)
//   USD wallet   -> wallet signature authorising a USDC transfer (src/walletfee.js)
const crypto = require("crypto");
const cfg = require("./config");
const sb = require("./db");
const { HttpError } = require("./errors");
const debit = require("./debit");
const wf = require("./walletfee");
const chain = require("./chain");

const mem = new Map();
const requiredFor = () => cfg.feesEnabled;
const fail = (error) => { if (error) throw new Error("Supabase: " + error.message); };

async function getRow(ref) {
  if (!sb) return mem.get(ref) || null;
  const { data, error } = await sb.from("payments").select("*").eq("reference", ref).maybeSingle();
  fail(error);
  return data;
}
async function setRow(ref, patch) {
  if (!sb) { Object.assign(mem.get(ref) || {}, patch); return; }
  fail((await sb.from("payments").update(patch).eq("reference", ref)).error);
}
// Atomic status change, so two requests can never both proceed.
async function claim(ref, from, to, extra = {}) {
  if (!sb) {
    const r = mem.get(ref);
    if (!r || r.status !== from) return false;
    Object.assign(r, { status: to, ...extra });
    return true;
  }
  const { data, error } = await sb.from("payments").update({ status: to, ...extra }).eq("reference", ref).eq("status", from).select("reference");
  fail(error);
  return !!(data && data.length);
}
async function insertRow(row) { if (!sb) mem.set(row.reference, row); else fail((await sb.from("payments").insert(row)).error); }

// Stops anyone spamming codes / signature requests at a stranger's account.
async function tooMany(subjectId) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  let n;
  if (!sb) n = [...mem.values()].filter((r) => r.subject_id === subjectId && r.created_at > since).length;
  else {
    const { count, error } = await sb.from("payments").select("reference", { count: "exact", head: true }).eq("subject_id", subjectId).gte("created_at", since);
    fail(error);
    n = count || 0;
  }
  if (n >= 5) throw new HttpError(429, "Too many attempts for this account. Try again in an hour.");
}
const newRef = (purpose) => `tl_${purpose}_${crypto.randomUUID()}`;

// ---------- Bank account: debit with a one-time code ----------
async function beginDebit({ purpose, subject, bankCode, accountNumber }) {
  await tooMany(subject.subjectId);
  if (debit.provider() === "bank-api" && !cfg.platformSettlement) throw new HttpError(503, "Platform settlement account is not configured");
  const reference = newRef(purpose);
  const amount = purpose === "consent" ? 0 : cfg.feeNgn * 100; // consent takes no money
  const c = await debit.initiate({ reference, bankCode, accountNumber, amountKobo: amount, beneficiary: cfg.platformSettlement }); // the platform's own account
  await insertRow({ reference, purpose, currency: "NGN", amount_minor: amount, status: "otp_sent", used: false, payee_key: "platform", bank_key: subject.issuerKey, subject_id: subject.subjectId, challenge_id: c.challengeId, attempts: 0, created_at: new Date().toISOString() });
  return { reference, demoOtp: c.demoOtp }; // demoOtp only exists with the demo provider
}

async function confirmDebit({ reference, otp }) {
  const row = await getRow(reference);
  if (!row || row.status !== "otp_sent") throw new HttpError(400, "Nothing to confirm");
  if (row.attempts >= 3) throw new HttpError(429, "Too many wrong codes. Start again.");
  if (!(await claim(reference, "otp_sent", "confirming", { attempts: row.attempts + 1 }))) throw new HttpError(409, "Already being confirmed");
  try { await debit.confirm({ reference, challengeId: row.challenge_id, otp }); }
  catch (e) { await setRow(reference, { status: "otp_sent" }); throw e; }
  await setRow(reference, { status: "success" });
  return { paid: true };
}

// ---------- USD wallet: debit with a signature ----------
async function beginWallet({ purpose, subject }) {
  await tooMany(subject.subjectId);
  const reference = newRef(purpose);
  const treasury = cfg.treasury; // the platform's own USD wallet
  if (wf.provider() === "onchain" && !treasury) throw new HttpError(503, "Platform USD fee wallet is not configured");
  const typed = wf.build(subject.walletAddress, treasury);
  await insertRow({ reference, purpose, currency: "USD", amount_minor: Math.round(cfg.feeUsd * 100), status: "awaiting_signature", used: false, payee_key: "platform", bank_key: subject.issuerKey, subject_id: subject.subjectId, attempts: 0, meta: typed, created_at: new Date().toISOString() });
  return { reference, typedData: wf.forWallet(typed), provider: wf.provider() };
}

// Used by approve.html, so the wallet holder can approve from their own device.
async function walletRequest(reference) {
  const row = await getRow(reference);
  if (!row || !row.meta || row.currency !== "USD") throw new HttpError(404, "Approval request not found");
  return { purpose: row.purpose, status: row.status, from: row.meta.message.from, feeUsd: cfg.feeUsd, feeNgn: cfg.feeNgn, typedData: wf.forWallet(row.meta) };
}

async function waitReceipt(hash, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = await chain.receiptStatus(hash);
    if (st !== "pending") return st;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "pending";
}

async function confirmWallet({ reference, signature }) {
  const row = await getRow(reference);
  if (!row || row.status !== "awaiting_signature") throw new HttpError(400, "Nothing to approve");
  if (row.attempts >= 3) throw new HttpError(429, "Too many failed approvals. Start again.");
  const typed = row.meta;
  if (!(await claim(reference, "awaiting_signature", "confirming", { attempts: row.attempts + 1 }))) throw new HttpError(409, "Already being approved");
  const back = async (e) => { await setRow(reference, { status: "awaiting_signature" }); throw e; };

  let who;
  try { who = wf.signer(typed, signature); } catch { return back(new HttpError(402, "Invalid signature")); }
  if (who.toLowerCase() !== typed.message.from.toLowerCase()) return back(new HttpError(402, "Signature does not match this wallet"));
  if (Date.now() / 1000 > Number(typed.message.validBefore)) return back(new HttpError(402, "Approval expired. Start again."));

  let r;
  try { r = await wf.pull(typed, signature); } catch (e) { return back(e); }
  if (!r.txHash) { await setRow(reference, { status: "success" }); return { paid: true }; } // mock provider
  await setRow(reference, { meta: { ...typed, txHash: r.txHash } });
  const st = await waitReceipt(r.txHash, cfg.confirmWaitMs);
  if (st === "success") { await setRow(reference, { status: "success" }); return { paid: true, txHash: r.txHash }; }
  if (st === "failed") { await setRow(reference, { status: "failed" }); throw new HttpError(402, "The wallet transfer failed"); }
  return { paid: false, pending: true, txHash: r.txHash }; // still confirming; the status endpoint keeps checking
}

// ---------- Shared ----------
async function isPaid(ref) {
  const row = await getRow(ref);
  if (!row) return false;
  if (row.status === "success") return true;
  if (row.status === "confirming" && row.meta && row.meta.txHash) {
    const st = await chain.receiptStatus(row.meta.txHash);
    if (st === "success") { await setRow(ref, { status: "success" }); return true; }
    if (st === "failed") await setRow(ref, { status: "failed" });
  }
  return false;
}

// Spend a confirmed payment on exactly one mint or verification, and only for the same account.
async function consume(ref, purpose, subjectId) {
  if (!ref) throw new HttpError(402, `Payment required: ${cfg.feeNgn} NGN (about ${cfg.feeUsd} USD)`);
  const row = await getRow(ref);
  if (!row || row.purpose !== purpose) throw new HttpError(402, "Invalid payment reference");
  if (row.subject_id !== subjectId) throw new HttpError(402, "This payment belongs to a different account");
  if (row.used) throw new HttpError(402, "This payment was already used");
  if (!(await isPaid(ref))) throw new HttpError(402, "Payment not completed");
  if (!sb) {
    if (mem.get(ref).used) throw new HttpError(402, "This payment was already used");
    mem.get(ref).used = true;
    return row.payee_key;
  }
  const { data, error } = await sb.from("payments").update({ used: true }).eq("reference", ref).eq("used", false).eq("status", "success").select("reference");
  fail(error);
  if (!data || !data.length) throw new HttpError(402, "This payment was already used");
  return row.payee_key; // the bank that receives this fee
}

// If our side fails after taking the payment, hand it back so the customer can retry for free.
const release = (ref) => setRow(ref, { used: false }).catch(() => {});
const status = async (ref) => ({ paid: await isPaid(ref) });

// What the platform has collected (minor units: kobo / cents), with a breakdown by the customer's bank.
async function settlements() {
  let rows;
  if (!sb) rows = [...mem.values()].filter((r) => r.status === "success");
  else {
    const { data, error } = await sb.from("payments").select("bank_key,purpose,currency,amount_minor").eq("status", "success");
    fail(error);
    rows = data;
  }
  const out = { name: cfg.platformName, mint: 0, verify: 0, totals: {}, byBank: {} };
  for (const r of rows) {
    if (r.purpose === "consent") continue; // consent takes no money
    out[r.purpose] += 1;
    out.totals[r.currency] = (out.totals[r.currency] || 0) + Number(r.amount_minor);
    const b = r.bank_key || "none";
    out.byBank[b] = out.byBank[b] || { bank: (cfg.issuers[b] || {}).name || b, count: 0, totals: {} };
    out.byBank[b].count += 1;
    out.byBank[b].totals[r.currency] = (out.byBank[b].totals[r.currency] || 0) + Number(r.amount_minor);
  }
  return out;
}

module.exports = { settlements, requiredFor, beginDebit, confirmDebit, beginWallet, walletRequest, confirmWallet, status, consume, release };
