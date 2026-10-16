// Bank oracle: after the customer consents, fetch a 12-month activity SUMMARY straight from their bank.
// The bank signs it, we verify the signature, so the numbers cannot be typed in or altered by the customer.
//  - mock (BANK_DATA_URL empty): a demo bank derives activity from the account number and signs it.
//  - bank-api: POST {BANK_DATA_URL}/accounts/summary -> { features, at, exp, signature }  (placeholder contract:
//    map it to your bank's real API). Put the bank's data-signing address in ISSUER_KEYS[code].dataSigner.
const { ethers } = require("ethers");
const cfg = require("./config");
const { HttpError } = require("./errors");

const provider = () => (cfg.bankDataUrl ? "bank-api" : "mock");
const demoWallet = () => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("demo-bank-oracle:" + cfg.pepper)));
const canon = (p) => JSON.stringify({ ref: p.ref, f: p.features, at: p.at, exp: p.exp }); // bound to this consent

function demoFeatures(seed) {
  const n = (i) => parseInt(seed.slice(2 + i * 4, 6 + i * 4), 16) / 65535;
  return {
    txn_frequency_monthly: Math.round(5 + n(0) * 45), avg_monthly_volume_ngn: Math.round((40000 + n(1) * 900000) / 1000) * 1000,
    avg_balance_stability: +(0.3 + n(2) * 0.65).toFixed(2), airtime_topup_regularity: +(0.3 + n(3) * 0.7).toFixed(2),
    bill_payment_consistency: +(0.3 + n(4) * 0.7).toFixed(2), savings_ratio: +(n(5) * 0.4).toFixed(2),
    txn_volume_growth_3m: +(-0.1 + n(6) * 0.6).toFixed(2), months_of_history: Math.round(3 + n(7) * 30),
  };
}

async function fetchSummary({ ref, subject, bankCode, accountNumber }) {
  let p, sig, expected;
  if (provider() === "mock") {
    const w = demoWallet();
    p = { ref, features: demoFeatures(subject.subjectId), at: Date.now(), exp: Date.now() + 300000 };
    sig = await w.signMessage(canon(p));
    expected = w.address;
  } else {
    const r = await fetch(cfg.bankDataUrl + "/accounts/summary", {
      method: "POST", headers: { Authorization: "Bearer " + cfg.bankDataKey, "Content-Type": "application/json" },
      body: JSON.stringify({ ref, bankCode, accountNumber, months: 12 }),
    }).catch(() => null);
    if (!r || !r.ok) throw new HttpError(502, "Bank data service unavailable");
    const j = await r.json();
    p = { ref, features: j.features, at: j.at, exp: j.exp };
    sig = j.signature;
    expected = (cfg.issuers[bankCode] || {}).dataSigner;
  }
  let rec;
  try { rec = ethers.verifyMessage(canon(p), sig); } catch { throw new HttpError(502, "Bank data failed signature check"); }
  if (!expected || rec.toLowerCase() !== expected.toLowerCase()) throw new HttpError(502, "Bank data failed signature check");
  if (Date.now() > p.exp) throw new HttpError(502, "Bank data expired");
  return { features: p.features, signedBy: (cfg.issuers[bankCode] || {}).name || "Your bank" };
}

module.exports = { provider, fetchSummary };
