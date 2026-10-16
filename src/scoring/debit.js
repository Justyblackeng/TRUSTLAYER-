// Debits the customer's own bank account (the account number they entered) after they approve with a one-time code.
//
//  - Demo provider (default when DEBIT_API_URL is empty): no money moves, the code is always 123456.
//  - bank-api provider: calls YOUR bank's / licensed partner's debit API. The two endpoints below are a
//    placeholder contract. Map them to the real API you are given (NIBSS Direct Debit/e-Mandate, the bank's
//    core-banking API, or a licensed aggregator).
const cfg = require("./config");
const { HttpError } = require("./errors");

const MOCK_OTP = "123456";
const provider = () => (cfg.debitApiUrl ? "bank-api" : "mock");

async function call(path, body) {
  let r;
  try {
    r = await fetch(cfg.debitApiUrl + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.debitApiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch { throw new HttpError(502, "Bank debit service unreachable"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status >= 500 ? 502 : 402, j.message || "The bank declined the debit");
  return j;
}

// Step 1: the bank sends a code to the phone linked to the account.
// `beneficiary` is the issuing bank's own account that receives the fee (set per bank in ISSUER_KEYS).
async function initiate({ reference, bankCode, accountNumber, amountKobo, beneficiary }) {
  if (provider() === "mock") return { challengeId: "mock-" + reference, demoOtp: MOCK_OTP };
  const j = await call("/debits/initiate", { reference, bankCode, accountNumber, amountKobo, currency: "NGN", beneficiary, narration: "TrustLayer fee" });
  return { challengeId: j.challengeId };
}

// Step 2: the account holder enters the code and the bank takes the money.
async function confirm({ reference, challengeId, otp }) {
  if (provider() === "mock") {
    if (otp !== MOCK_OTP) throw new HttpError(402, "Wrong code");
    return true;
  }
  const j = await call("/debits/confirm", { reference, challengeId, otp });
  if (!j.success) throw new HttpError(402, "Debit was not approved");
  return true;
}

module.exports = { provider, initiate, confirm };
