// Stores score drafts between "get score" and "save on-chain".
// Uses Supabase when configured (required on Netlify, where functions keep no memory),
// otherwise an in-memory Map for local development.
const crypto = require("crypto");
const cfg = require("./config");

const TTL = 15 * 60_000;
const sb = require("./db");
const mem = new Map();
const fail = (error) => { if (error) throw new Error("Supabase: " + error.message); };

async function create(d) {
  if (!sb) {
    const id = crypto.randomUUID();
    mem.set(id, { ...d, at: Date.now(), minting: false });
    return id;
  }
  const { data, error } = await sb.from("score_drafts").insert({
    subject_id: d.subject.subjectId, id_type: d.subject.idType, issuer_key: d.subject.issuerKey,
    wallet_address: d.subject.walletAddress || null, score: d.score, loan_ngn: d.loan, score_hash: d.scoreHash,
  }).select("id").single();
  fail(error);
  return data.id;
}

async function get(id) {
  if (!sb) {
    const d = mem.get(id);
    return d && Date.now() - d.at <= TTL ? d : null;
  }
  const { data, error } = await sb.from("score_drafts").select("*").eq("id", id).eq("minted", false)
    .gte("created_at", new Date(Date.now() - TTL).toISOString()).maybeSingle();
  fail(error);
  if (!data) return null;
  return {
    subject: { subjectId: data.subject_id, idType: data.id_type, issuerKey: data.issuer_key, walletAddress: data.wallet_address || undefined },
    score: data.score, loan: Number(data.loan_ngn), scoreHash: data.score_hash,
  };
}

// Atomic lock so two clicks can't mint the same draft twice.
async function lock(id) {
  if (!sb) {
    const d = mem.get(id);
    if (!d || d.minting) return false;
    d.minting = true;
    return true;
  }
  const { data, error } = await sb.from("score_drafts").update({ minting: true })
    .eq("id", id).eq("minting", false).eq("minted", false).select("id");
  fail(error);
  return !!(data && data.length);
}

async function unlock(id) {
  if (!sb) { const d = mem.get(id); if (d) d.minting = false; return; }
  await sb.from("score_drafts").update({ minting: false }).eq("id", id);
}

async function done(id, d, txHash) {
  if (!sb) { mem.delete(id); return; }
  fail((await sb.from("score_drafts").update({ minted: true, minting: false, tx_hash: txHash }).eq("id", id)).error);
  fail((await sb.from("credential_events").insert({ subject_id: d.subject.subjectId, issuer_key: d.subject.issuerKey, score: d.score, tx_hash: txHash })).error);
}

module.exports = { create, get, lock, unlock, done };
