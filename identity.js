const crypto = require("crypto");
const { ethers } = require("ethers");
const cfg = require("./config");
const { HttpError } = require("./errors");

// Official NUBAN check digit (3-digit CBN bank codes only).
function nubanOk(bankCode, acct) {
  if (bankCode.length !== 3) return true;
  const w = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];
  const digits = (bankCode + acct.slice(0, 9)).split("").map(Number);
  const sum = digits.reduce((s, d, i) => s + d * w[i], 0);
  return (10 - (sum % 10)) % 10 === Number(acct[9]);
}

/**
 * Turns a bank account or wallet into an opaque bytes32 subject ID.
 * Bank accounts are HMAC'd with a server-side pepper, so the 10-digit number
 * cannot be brute-forced from the public chain.
 */
function resolveSubject(body, { requireIssuer = true } = {}) {
  let subject;
  if (body.idType === "bank") {
    const acct = (body.accountNumber || "").replace(/\D/g, "");
    const code = (body.bankCode || "").trim();
    if (!/^\d{3,6}$/.test(code)) throw new HttpError(400, "Invalid bank code");
    if (!/^\d{10}$/.test(acct)) throw new HttpError(400, "Account number must be 10 digits");
    if (cfg.strictNuban && !nubanOk(code, acct)) throw new HttpError(400, "Account number failed NUBAN check");
    const subjectId = "0x" + crypto.createHmac("sha256", cfg.pepper).update(`bank:${code}:${acct}`).digest("hex");
    subject = { idType: "bank", subjectId, issuerKey: code };
  } else {
    if (!body.walletAddress || !ethers.isAddress(body.walletAddress)) throw new HttpError(400, "Invalid wallet address");
    const walletAddress = ethers.getAddress(body.walletAddress);
    // A USD wallet can belong to a bank (e.g. Wema). Then that bank issues the credential and receives the fees.
    const code = (body.bankCode || "").trim();
    if (code && !/^\d{3,6}$/.test(code)) throw new HttpError(400, "Invalid bank code");
    const subjectId = code
      ? ethers.solidityPackedKeccak256(["address", "string"], [walletAddress, "wallet:" + code])
      : ethers.zeroPadValue(walletAddress, 32);
    subject = { idType: "wallet", subjectId, issuerKey: code || "wallet", walletAddress };
  }
  if (requireIssuer && !cfg.issuers[subject.issuerKey]) {
    throw new HttpError(400, "This bank is not an onboarded issuer yet");
  }
  return subject;
}

module.exports = { resolveSubject };
