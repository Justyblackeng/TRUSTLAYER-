const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { ethers } = require("ethers");

const cfg = require("./config");
const { HttpError } = require("./errors");
const { resolveSubject } = require("./identity");
const model = require("./scoring/model");
const ai = require("./scoring/ai");
const chain = require("./chain");
const drafts = require("./drafts");
const payments = require("./payments");
const debit = require("./debit");
const walletfee = require("./walletfee");
const bankdata = require("./bankdata");

const app = express();
app.set("trust proxy", 1);
// On Netlify the function path is /.netlify/functions/api/...; map it back to /api/...
app.use((req, _res, next) => { req.url = req.url.replace(/^\/\.netlify\/functions\/api/, "/api"); next(); });
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // the page uses inline onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(cors({ origin: cfg.corsOrigin }));
app.use(express.json({ limit: "20kb" }));
app.use("/api", rateLimit({
  windowMs: 60_000, limit: 60,
  keyGenerator: (req) => req.get("x-nf-client-connection-ip") || req.ip || "unknown", // Netlify passes the real client IP
  validate: { ip: false },
}));
app.use(express.static(path.join(__dirname, "..", "public"))); // the website (public/index.html)

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "Invalid request", r.error.flatten());
  return r.data;
};
const safeEq = (a = "", b = "") => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const requireLender = (req, _res, next) => {
  if (cfg.lenderKeys.length && !cfg.lenderKeys.some((k) => safeEq(k, req.get("x-api-key")))) return next(new HttpError(401, "Invalid API key"));
  next();
};
const requireAdmin = (req, _res, next) =>
  cfg.adminKey && safeEq(cfg.adminKey, req.get("x-admin-key")) ? next() : next(new HttpError(401, "Admin only"));

const IdSchema = z.object({
  idType: z.enum(["bank", "wallet"]),
  bankCode: z.string().max(8).optional(),
  accountNumber: z.string().max(16).optional(),
  walletAddress: z.string().max(64).optional(),
});

// Scores are computed server-side and held as drafts (Supabase, or memory for local dev),
// so a client can only mint the score the server calculated.

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, ai: ai.enabled, chain: chain.configured(), chainId: cfg.chainId, contract: cfg.contract || null }));

// Fees: scoring is free. Each on-chain mint and each bank verification costs NGN 200 (about USD 0.13).
app.get("/api/fees", (_req, res) =>
  res.json({
    mode: cfg.feesEnabled ? "on" : "off",
    methods: { bank: "account-debit (one-time code)", wallet: "usdc-signature" },
    providers: { bankData: bankdata.provider(), bank: debit.provider(), wallet: walletfee.provider() }, // "mock" means no real money moves
    ngn: cfg.feeNgn, usd: cfg.feeUsd, fx: cfg.fx, appliesTo: ["mint", "verify"],
  }));
// Debit the account number itself: bank sends a code to the holder, the holder approves, the bank takes the fee.
const DebitInit = z.object({ purpose: z.enum(["mint", "verify", "consent"]), bankCode: z.string().max(8), accountNumber: z.string().max(16) });
app.post("/api/payments/debit/initiate", wrap(async (req, res) => {
  const b = parse(DebitInit, req.body);
  const subject = resolveSubject({ idType: "bank", bankCode: b.bankCode, accountNumber: b.accountNumber }, { requireIssuer: true }); // the fee is paid to the issuing bank
  if (b.purpose !== "consent" && !payments.requiredFor("bank")) return res.json({ demo: true });
  res.json(await payments.beginDebit({ purpose: b.purpose, subject, bankCode: subject.issuerKey, accountNumber: b.accountNumber.replace(/\D/g, "") }));
}));
const DebitConfirm = z.object({ reference: z.string().regex(/^tl_(mint|verify|consent)_[0-9a-f-]{36}$/), otp: z.string().regex(/^\d{4,8}$/) });
app.post("/api/payments/debit/confirm", wrap(async (req, res) => res.json(await payments.confirmDebit(parse(DebitConfirm, req.body)))));
// USD wallets: the holder signs a USDC authorisation for the fee; we relay it. Same idea as the bank code.
const WalletInit = z.object({ purpose: z.enum(["mint", "verify"]), walletAddress: z.string().max(64), bankCode: z.string().max(8).optional() });
app.post("/api/payments/wallet/initiate", wrap(async (req, res) => {
  const b = parse(WalletInit, req.body);
  const subject = resolveSubject({ idType: "wallet", walletAddress: b.walletAddress, bankCode: b.bankCode }, { requireIssuer: true });
  if (!payments.requiredFor("wallet")) return res.json({ demo: true });
  res.json(await payments.beginWallet({ purpose: b.purpose, subject }));
}));
const RefSchema = z.string().regex(/^tl_(mint|verify)_[0-9a-f-]{36}$/);
app.get("/api/payments/wallet/request", wrap(async (req, res) => res.json(await payments.walletRequest(parse(RefSchema, String(req.query.reference || ""))))));
app.post("/api/payments/wallet/confirm", wrap(async (req, res) =>
  res.json(await payments.confirmWallet(parse(z.object({ reference: RefSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }), req.body)))));
app.get("/api/payments/status", wrap(async (req, res) => {
  const ref = String(req.query.reference || "");
  if (!/^tl_(mint|verify)_[0-9a-f-]{36}$/.test(ref)) throw new HttpError(400, "Bad reference");
  res.json(await payments.status(ref));
}));

// 1) AI score (no blockchain write yet, free)
app.post("/api/score", wrap(async (req, res) => {
  const body = parse(IdSchema.extend({ features: model.FeatureSchema.optional(), consentRef: z.string().max(80).optional() }), req.body);
  const subject = resolveSubject(body);
  let f = body.features, source = "self-reported", signedBy = null;
  if (body.idType === "bank" && (cfg.requireBankData || body.consentRef)) {
    // The customer approved sharing (bank code), the bank sends signed data, the bank later issues the credential.
    if (!body.consentRef) throw new HttpError(403, "Customer consent is required to fetch bank data");
    await payments.consume(body.consentRef, "consent", subject.subjectId);
    try {
      const d = await bankdata.fetchSummary({ ref: body.consentRef, subject, bankCode: subject.issuerKey, accountNumber: (body.accountNumber || "").replace(/\D/g, "") });
      f = parse(model.FeatureSchema, d.features);
      source = "bank"; signedBy = d.signedBy;
    } catch (e) { await payments.release(body.consentRef); throw e; }
  }
  if (!f) throw new HttpError(400, "Activity data is required");

  const base = model.baseScore(f);
  const flags = model.ruleFlags(f);
  const top = model.drivers(f);
  const analysis = await ai.analyse({ features: f, base, top, flags }); // anonymous features only

  const score = model.clamp(base + analysis.adjustment);
  const loan = model.loanLimit(score, f.avg_monthly_volume_ngn);
  const scoreHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ v: model.VERSION, s: subject.subjectId, score, f, t: Date.now() })));

  const draftId = await drafts.create({ subject, score, loan, scoreHash });

  res.json({
    draftId, score, band: model.band(score),
    loanEligibilityNgn: loan,
    loanEligibilityUsd: Number((loan / cfg.fx).toFixed(2)),
    explanations: analysis.explanations, tips: analysis.tips,
    flags: [...flags, ...analysis.flags],
    credentialHash: scoreHash, modelVersion: model.VERSION,
    dataSource: source, dataSignedBy: signedBy, activity: f, analysisSource: analysis.source, aiAdjustment: analysis.adjustment,
  });
}));

// 2) Mint the credential onchain (issued by the customer's own bank key)
const MintSchema = z.object({ draftId: z.string().uuid(), signature: z.string().max(200).optional(), paymentRef: z.string().max(80).optional() });
app.post("/api/credentials/mint", wrap(async (req, res) => {
  const { draftId, signature, paymentRef } = parse(MintSchema, req.body);
  const d = await drafts.get(draftId);
  if (!d) throw new HttpError(404, "Draft expired. Generate the score again.");

  if (d.subject.idType === "wallet" && !payments.requiredFor("wallet")) {
    // (With fees on, the wallet's fee-approval signature already proves ownership.)
    // Wallet owner proves control by signing the draft ID.
    if (!signature) throw new HttpError(401, `Sign the message "TrustLayer mint ${draftId}" with your wallet`);
    let signer;
    try { signer = ethers.verifyMessage(`TrustLayer mint ${draftId}`, signature); } catch { throw new HttpError(401, "Bad signature"); }
    if (signer !== d.subject.walletAddress) throw new HttpError(401, "Signature does not match wallet");
  } else if (!cfg.allowUnverifiedBank && !payments.requiredFor("bank")) {
    // With fees on, the account holder's code approving the debit also proves they own the account.
    throw new HttpError(501, "Bank ownership check not configured");
  }

  if (!(await drafts.lock(draftId))) throw new HttpError(409, "Already minting or minted");
  let paid = false, feeKey = null;
  try {
    if (payments.requiredFor(d.subject.idType)) {
      // NGN 200 (about USD 0.13), debited from the customer's own account after they approve with a code
      feeKey = await payments.consume(paymentRef, "mint", d.subject.subjectId); // the fee goes to the issuing bank
      paid = true;
    }
    const r = await chain.issue(d.subject.issuerKey, d.subject.subjectId, d.score, d.loan, d.scoreHash);
    try { await drafts.done(draftId, d, r.txHash); } catch (e) { console.error("Could not record mint:", e.message); }
    res.status(201).json({ ...r, score: d.score, feeNgn: cfg.feeNgn, feeUsd: cfg.feeUsd, feeTo: feeKey ? cfg.platformName : null, explorerUrl: cfg.explorerTxUrl ? cfg.explorerTxUrl + r.txHash : null });
  } catch (e) {
    if (paid) await payments.release(paymentRef);
    await drafts.unlock(draftId);
    throw e;
  }
}));

// 3) Lender verification (reads the chain, needs no raw data)
app.get("/api/credentials/verify", requireLender, wrap(async (req, res) => {
  const subject = resolveSubject(parse(IdSchema, req.query), { requireIssuer: false });
  const ref = String(req.query.paymentRef || "");
  const charged = payments.requiredFor(subject.idType);
  let feeKey = null;
  if (charged) feeKey = await payments.consume(ref, "verify", subject.subjectId); // NGN 200 per verification
  let c;
  try { c = await chain.verify(subject.subjectId); } catch (e) { if (charged) await payments.release(ref); throw e; }
  if (!c) return res.json({ found: false });
  res.json({
    found: true, valid: c.valid, revoked: c.revoked,
    score: c.score, band: model.band(c.score),
    issuer: c.issuer, issuedAt: new Date(c.issuedAt * 1000).toISOString(), expiresAt: new Date(c.expiresAt * 1000).toISOString(),
    loanEligibilityNgn: c.loanLimitNgn, loanEligibilityUsd: Number((c.loanLimitNgn / cfg.fx).toFixed(2)),
    scoreHash: c.scoreHash,
    feeTo: feeKey ? cfg.platformName : null,
  });
}));

app.get("/api/admin/settlements", requireAdmin, wrap(async (_req, res) => res.json(await payments.settlements())));

app.post("/api/credentials/revoke", requireAdmin, wrap(async (req, res) => {
  const subject = resolveSubject(parse(IdSchema, req.body));
  res.json(await chain.revoke(subject.issuerKey, subject.subjectId));
}));

// Customer care chat (powers the widget)
const ChatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(500) })).min(1).max(10),
});
app.post("/api/chat", wrap(async (req, res) => {
  const { messages } = parse(ChatSchema, req.body);
  if (messages[0].role !== "user") throw new HttpError(400, "First message must be from the user");
  res.json({ reply: await ai.support(messages) });
}));

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  console.error(err);
  res.status(500).json({ error: "Internal error" });
});

if (require.main === module) {
  app.listen(cfg.port, () => console.log(`TrustLayer on http://localhost:${cfg.port} (site + API) | AI: ${ai.enabled ? "claude" : "rules-only"} | chain: ${chain.configured() ? cfg.chainId : "not configured"}`));
}
module.exports = app;
