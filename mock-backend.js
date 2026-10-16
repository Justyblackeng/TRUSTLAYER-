// In-browser stand-in for the TrustLayer API, so the REAL page can run with no server (demos, pitches).
// scripts/build-mock.js injects this into a copy of public/index.html: same UI, same code, simulated backend.
(function () {
  const K = window.__MOCK_FAST ? 0 : 1, delay = (ms) => new Promise((r) => setTimeout(r, ms * K));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
  const hex = (n) => "0x" + Array.from({ length: n }, () => "0123456789abcdef"[Math.random() * 16 | 0]).join("");
  class Err extends Error { constructor(status, message) { super(message); this.status = status; } }
  const bankName = (c) => ((typeof BANKS !== "undefined" && BANKS.find((b) => b[0] === c)) || [0, c === "wallet" || !c ? "Independent Wallet" : "Your bank"])[1];
  const FEE = { ngn: 200, usd: 0.13, fx: 1550 };
  const refs = {}, drafts = {}, creds = {};
  const seed = (key, score, loan, issuerCode, days, h) => (creds[key] = { score, loan, code: issuerCode, at: Date.now() - days * 864e5, hash: "0x" + h.padEnd(64, "0") });
  seed("b:035:0123456789", 681, 443000, "035", 3, "61552f5681c7968c03c88f7e77d204b71a7108e7");
  seed("b:058:0987654321", 598, 210000, "058", 1, "3f8a1c9d2e5b7a4f6c8d0e2a4b6c8d0e2a4b6c8d");
  seed("w:0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678:035", 715, 620000, "035", 6, "7b3e29a0e11f4c7d5a9b3f1c8e2d6a4b0f9c1e3d");

  // --- same scoring formula as the backend ---
  const F = [["txn_frequency_monthly", "Monthly transactions", 0, 60], ["avg_monthly_volume_ngn", "Average monthly volume", 5000, 2000000], ["avg_balance_stability", "Balance stability", 0, 1], ["airtime_topup_regularity", "Airtime top-up regularity", 0, 1], ["bill_payment_consistency", "Bill payment consistency", 0, 1], ["savings_ratio", "Savings ratio", 0, 1], ["txn_volume_growth_3m", "Transaction growth (3 months)", -0.9, 2], ["months_of_history", "Months of history", 1, 36]];
  const clamp = (n) => Math.max(300, Math.min(850, Math.round(n)));
  const base = (f) => clamp(300 + ((f.txn_frequency_monthly * 3.5 + Math.log1p(f.avg_monthly_volume_ngn) * 14 + f.avg_balance_stability * 180 + f.airtime_topup_regularity * 120 + f.bill_payment_consistency * 220 + f.savings_ratio * 150 + f.txn_volume_growth_3m * 60 + f.months_of_history * 2.5) / 1050) * 550);
  const band = (s) => (s >= 740 ? "Excellent" : s >= 670 ? "Good" : s >= 580 ? "Fair" : "Building");
  const loanOf = (s, v) => Math.round((v * (1 + 2 * ((s - 300) / 550))) / 1000) * 1000;
  function bankFeatures(key) { // what the demo bank "sends" (deterministic per account)
    let h = 7; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const n = (i) => (((h >>> ((i * 3) % 24)) ^ (h >>> (i + 5))) & 255) / 255;
    return { txn_frequency_monthly: Math.round(5 + n(0) * 45), avg_monthly_volume_ngn: Math.round((40000 + n(1) * 900000) / 1000) * 1000, avg_balance_stability: +(0.3 + n(2) * 0.65).toFixed(2), airtime_topup_regularity: +(0.3 + n(3) * 0.7).toFixed(2), bill_payment_consistency: +(0.3 + n(4) * 0.7).toFixed(2), savings_ratio: +(n(5) * 0.4).toFixed(2), txn_volume_growth_3m: +(-0.1 + n(6) * 0.6).toFixed(2), months_of_history: Math.round(3 + n(7) * 30) };
  }
  const keyOf = (b) => b.idType === "wallet" ? `w:${String(b.walletAddress || "").toLowerCase()}:${b.bankCode || ""}` : `b:${b.bankCode}:${String(b.accountNumber || "").replace(/\D/g, "")}`;
  const validId = (b) => {
    if (b.idType === "wallet") { if (!/^0x[0-9a-fA-F]{40}$/.test(b.walletAddress || "")) throw new Err(400, "Invalid wallet address"); }
    else if (!/^\d{10}$/.test(String(b.accountNumber || "").replace(/\D/g, ""))) throw new Err(400, "Account number must be 10 digits");
  };
  // one approval buys one action, for that one account only (same rules as the real backend)
  function consume(ref, purpose, key) {
    const r = refs[ref];
    if (!ref) throw new Err(402, `Payment required: ${FEE.ngn} NGN (about ${FEE.usd} USD)`);
    if (!r || r.purpose !== purpose) throw new Err(402, "Invalid payment reference");
    if (r.key !== key) throw new Err(402, "This payment belongs to a different account");
    if (r.used) throw new Err(402, "This payment was already used");
    if (!r.paid) throw new Err(402, "Payment not completed");
    r.used = true; return r.bank;
  }

  function route(method, path, q, b) {
    if (path === "/api/fees") return [200, { mode: "on", methods: { bank: "account-debit (one-time code)", wallet: "usdc-signature" }, providers: { bankData: "mock", bank: "mock", wallet: "mock" }, ngn: FEE.ngn, usd: FEE.usd, fx: FEE.fx, appliesTo: ["mint", "verify"] }];
    if (path === "/api/payments/debit/initiate") {
      validId({ idType: "bank", ...b }); const ref = `tl_${b.purpose}_${uuid()}`;
      refs[ref] = { purpose: b.purpose, key: keyOf({ idType: "bank", ...b }), paid: false, used: false, tries: 0, bank: b.bankCode };
      return [200, { reference: ref, demoOtp: "123456" }];
    }
    if (path === "/api/payments/debit/confirm") {
      const r = refs[b.reference]; if (!r) throw new Err(400, "Nothing to confirm");
      if (r.tries >= 3) throw new Err(429, "Too many wrong codes. Start again.");
      r.tries++; if (b.otp !== "123456") throw new Err(402, "Wrong code");
      r.paid = true; return [200, { paid: true }];
    }
    if (path === "/api/payments/wallet/initiate") {
      validId({ idType: "wallet", ...b }); const ref = `tl_${b.purpose}_${uuid()}`;
      refs[ref] = { purpose: b.purpose, key: keyOf({ idType: "wallet", ...b }), paid: false, used: false, bank: b.bankCode || "wallet" };
      return [200, { reference: ref, provider: "mock", typedData: { domain: {}, types: { EIP712Domain: [], TransferWithAuthorization: [] }, primaryType: "TransferWithAuthorization", message: {} } }];
    }
    if (path === "/api/payments/wallet/confirm") { const r = refs[b.reference]; if (!r) throw new Err(400, "Nothing to approve"); r.paid = true; return [200, { paid: true }]; }
    if (path === "/api/payments/status") return [200, { paid: !!(refs[q.get("reference")] || {}).paid }];

    if (path === "/api/score") {
      validId(b); const key = keyOf(b); let f = b.features, signedBy = null, source = "self-reported";
      if (b.idType === "bank") {
        if (!b.consentRef) throw new Err(403, "Customer consent is required to fetch bank data");
        consume(b.consentRef, "consent", key); f = bankFeatures(key); source = "bank"; signedBy = bankName(b.bankCode);
      }
      if (!f) throw new Err(400, "Activity data is required");
      const score = base(f), loan = loanOf(score, f.avg_monthly_volume_ngn), draftId = uuid(), hash = hex(64);
      const top = F.map(([k, label, lo, hi]) => { const p = (f[k] - lo) / (hi - lo); return { feature: label, percentile: Math.round(p * 100), direction: p > 0.5 ? "helped" : "hurt", s: Math.abs(p - 0.5) }; }).sort((x, y) => y.s - x.s).slice(0, 3);
      drafts[draftId] = { key, score, loan, hash, code: b.idType === "bank" ? b.bankCode : b.bankCode || "wallet" };
      return [200, { draftId, score, band: band(score), loanEligibilityNgn: loan, loanEligibilityUsd: +(loan / FEE.fx).toFixed(2),
        explanations: top.map((d) => ({ feature: d.feature, direction: d.direction, reason: `${d.feature} is in the ${d.percentile}th percentile of the expected range.` })),
        tips: top.filter((d) => d.direction === "hurt").map((d) => `Improve ${d.feature.toLowerCase()} over the next few months.`), flags: [],
        credentialHash: hash, modelVersion: "tl-linear-1.0", dataSource: source, dataSignedBy: signedBy, activity: f, analysisSource: "rules", aiAdjustment: 0 }];
    }
    if (path === "/api/credentials/mint") {
      const d = drafts[b.draftId]; if (!d) throw new Err(404, "Draft expired. Generate the score again.");
      const code = consume(b.paymentRef, "mint", d.key);
      creds[d.key] = { score: d.score, loan: d.loan, code: d.code, at: Date.now(), hash: d.hash }; delete drafts[b.draftId];
      return [201, { txHash: hex(64), blockNumber: 1000000 + (Math.random() * 9e5 | 0), pending: false, issuer: bankName(d.code), score: d.score, feeNgn: FEE.ngn, feeUsd: FEE.usd, feeTo: "TrustLayer", explorerUrl: null }];
    }
    if (path === "/api/credentials/verify") {
      const id = Object.fromEntries(q.entries()); validId(id); const key = keyOf(id);
      const code = consume(q.get("paymentRef") || "", "verify", key); const c = creds[key];
      if (!c) return [200, { found: false }];
      return [200, { found: true, valid: true, revoked: false, score: c.score, band: band(c.score), issuer: bankName(c.code), issuedAt: new Date(c.at).toISOString(), expiresAt: new Date(c.at + 180 * 864e5).toISOString(), loanEligibilityNgn: c.loan, loanEligibilityUsd: +(c.loan / FEE.fx).toFixed(2), scoreHash: c.hash, feeTo: "TrustLayer" }];
    }
    if (path === "/api/chat") throw new Err(503, "offline"); // the page then uses its built-in answers
    throw new Err(404, "Not found");
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (u, opt = {}) => {
    const url = new URL(String(u), location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(u, opt);
    await delay(url.pathname === "/api/score" ? 1200 : 350 + Math.random() * 400);
    const reply = (st, data) => new Response(JSON.stringify(data), { status: st, headers: { "Content-Type": "application/json" } });
    try { const [st, data] = route(opt.method || "GET", url.pathname, url.searchParams, opt.body ? JSON.parse(opt.body) : {}); return reply(st, data); }
    catch (e) { return reply(e.status || 500, { error: e.message }); }
  };
  // a wallet that approves everything, so the wallet-signature step behaves like MetaMask
  window.ethereum = window.ethereum || { request: async ({ method }) => { await delay(500); return method === "eth_requestAccounts" ? ["0x0000000000000000000000000000000000000001"] : "0x" + "ab".repeat(65); } };
})();
