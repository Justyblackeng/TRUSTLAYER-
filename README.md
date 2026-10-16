# TrustLayer (website + backend in one folder)

`public/index.html` is the website. `src/` is the API that serves it. One command runs both.

AI credit scoring + an onchain credential registry.

```
Frontend ──POST /api/score ──baseline model + Claude analyst ──draft (held server-side)
         ──POST /api/credentials/mint ──customer's bank key signs ──TrustLayerRegistry (EVM)
Lender   ──GET  /api/credentials/verify ──reads chain ──score, issuer, expiry, loan limit
```

## How AI and blockchain are used
- **AI:** a transparent baseline model sets the score. Claude then reviews the anonymous features, adds plain-English
  reasons and tips, flags inconsistencies, and can nudge the score by at most ±30. No names or account numbers are sent
  to the model. With no `ANTHROPIC_API_KEY` the API falls back to rule-based explanations. Claude also powers `/api/chat`.
- **Blockchain:** `contracts/TrustLayerRegistry.sol` stores only an opaque subject ID, the score, loan limit, expiry and a
  hash. Each bank is an issuer with its own key and can only refresh or revoke its own credentials. Anyone can verify.
- **Privacy:** bank accounts are HMAC'd with `SUBJECT_PEPPER` before going onchain, so the 10-digit number can't be brute-forced.

## Setup
```bash
npm install
cp .env.example .env        # fill in keys
npm run compile
npm run deploy              # deploys the contract, onboards issuers from ISSUER_KEYS
# put the printed address in CONTRACT_ADDRESS, fund each issuer address with a little gas
npm start            # open http://localhost:8080
```

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/health | none | status of AI and chain |
| POST | /api/score | none | AI score + explanations, returns `draftId` |
| POST | /api/credentials/mint | wallet signature (wallets) | writes the credential onchain |
| GET | /api/credentials/verify | `x-api-key` | lender lookup |
| POST | /api/credentials/revoke | `x-admin-key` | revoke a credential |
| POST | /api/chat | none | customer care assistant |

Score request body:
```json
{ "idType": "bank", "bankCode": "035", "accountNumber": "0123456789",
  "features": { "txn_frequency_monthly": 22, "avg_monthly_volume_ngn": 180000, "avg_balance_stability": 0.71,
  "airtime_topup_regularity": 0.85, "bill_payment_consistency": 0.93, "savings_ratio": 0.18,
  "txn_volume_growth_3m": 0.22, "months_of_history": 14 } }
```
Wallet users send `{ "idType": "wallet", "walletAddress": "0x..." }` and, when minting, `signature` from
`personal_sign("TrustLayer mint <draftId>")`.

## Before going live
- **Features are self-reported in the demo.** In production compute them server-side from a real data source
  (mobile money, open banking, or the bank's own records), otherwise anyone can type a good score.
- **Bank ownership:** set `ALLOW_UNVERIFIED_BANK=false` and add your bank's OTP/BVN check in the mint route.
- Keep issuer keys in a secrets manager or HSM, not `.env`. Replace the in-memory draft store with Redis if you run several instances.
- Set `NODE_ENV=production` and a strong `SUBJECT_PEPPER`. Changing the pepper later orphans existing credentials.
- Get legal review for NDPR/CBN requirements and add a customer consent step before scoring.

## Frontend
`public/index.html` is already wired to the API and is served by the same server at `http://localhost:8080`,
so there is no URL to change and no CORS to set up. If the API is unreachable the page falls back to demo data.
Open the site from the server (not by double-clicking the file) so wallet signing and the API calls work.

## Customer-approved, bank-signed data (no typed-in numbers)
Flow for a bank account: **enter account number -> customer approves data sharing with a code from their bank -> the bank sends a signed
12-month summary -> AI scores it -> the bank issues the credential on-chain (customer approves the NGN 200 fee with a second code).**
- Consent reuses the bank-code approval (`purpose: "consent"`, no money taken). It is bound to that one account and works once.
- `src/bankdata.js` fetches the summary and **verifies the bank's signature**. With `BANK_DATA_URL` empty a demo bank is used.
  For a real bank, map `/accounts/summary` to its API and put its signing address in `ISSUER_KEYS[code].dataSigner`.
- With `REQUIRE_BANK_DATA=true` (default) a bank account cannot be scored from typed-in figures. USD wallets still use the demo inputs.
- **Mock for demos:** `npm run build:mock` writes `public/mock.html`: the real page plus an in-browser fake API (same UI, same flows, same rules, demo code 123456, no server). It is rebuilt from `public/index.html`, so it can never drift from the real app.
- Run the updated `supabase/schema.sql` (payments now accepts `consent`).

## Fees: NGN 200 (about USD 0.13), taken from the account or wallet in question
- **What is charged:** every on-chain mint and every bank verification costs `FEE_NGN` (default 200). Scoring is free.
  The dollar figure is `FEE_NGN / FX_NGN_PER_USD` (200 / 1550 = $0.13).
- **Same pattern for both, nothing is taken without the holder's approval** (knowing an account number or wallet address must
  never be enough to take money):

| | Bank account (naira) | USD wallet (USDC) |
|---|---|---|
| Approval | one-time code the bank sends to the account's phone | signature in the wallet |
| Fee | NGN 200 debited by the bank | $0.13 in USDC sent to your treasury |
| Code | `src/debit.js` | `src/walletfee.js` |
| Endpoints | `POST /api/payments/debit/initiate`, `.../debit/confirm` | `POST /api/payments/wallet/initiate`, `.../wallet/confirm` |

  Then `mint` / `verify` take the `paymentRef`. A payment is bound to that one account, buys exactly one action, and is
  handed back if the on-chain step fails. Approvals are limited to 3 per account per hour and 3 wrong tries each.
- **Where the fee goes: the platform's own accounts.** Every fee (mint and verification, bank account or USD wallet) is paid to
  TrustLayer, not to the customer's bank:
  - NGN fees are debited from the customer's account and paid into `PLATFORM_SETTLEMENT` (your own account).
  - USDC fees go to `TREASURY_ADDRESS` (your own USD wallet).
  - `GET /api/admin/settlements` (`x-admin-key`) shows what the platform has collected, with a breakdown by the customer's bank.
  - The issuing bank still signs the credential and the bank-signed data; it just does not receive the fee.
- **Ownership proof:** the code (bank) or signature (wallet) also proves the person owns the account, so it doubles as the
  ownership check when minting.
- **Bank accounts:** with `DEBIT_API_URL` empty a **demo provider** is used: no money moves and the code is always 123456.
  For real debits point `DEBIT_API_URL` / `DEBIT_API_KEY` at your bank or a licensed partner and map the two calls in
  `src/debit.js` (`/debits/initiate`, `/debits/confirm`; a placeholder contract) to their real API.
- **USD wallets:** the holder signs an EIP-3009 `transferWithAuthorization` for the fee (gasless for them). Our relayer submits
  it, pays the gas, and the USDC lands in `TREASURY_ADDRESS`. Set `STABLE_TOKEN_ADDRESS` (a token that supports EIP-3009, such as
  USDC), `STABLE_TOKEN_NAME` / `STABLE_TOKEN_VERSION` (they must match the token's signing domain), `TREASURY_ADDRESS` and
  `RELAYER_PRIVATE_KEY` (keep a little ETH on it). The wallet must hold USDC. With these empty a demo provider is used
  (the signature is checked, no money moves). Test on a testnet first.
- **No wallet in the browser?** (for example a lender checking a customer's wallet) the page shows a link to `approve.html`.
  The wallet holder opens it in their wallet, signs, and the first page continues by itself.
- Check `GET /api/fees`: `"providers":{"bank":"mock","wallet":"mock"}` means nothing is being charged.
- **Compliance:** debiting accounts and collecting stablecoins can be regulated. Use a licensed partner or your bank's own system
  and get the consent wording reviewed. The app stores only hashes of account numbers, never the raw number.
- Run the `payments` section of `supabase/schema.sql` (it adds `subject_id`, `challenge_id`, `attempts`, `meta`).
- **High-volume banks:** per-lookup approvals do not suit banks calling the API thousands of times; use prepaid credits for them.

## Host on Netlify + Supabase
- **Netlify** serves the website (`public/`) and runs the API as a serverless function (`netlify/functions/api.js`).
- **Supabase** (Postgres) stores score drafts and a mint log. Netlify functions keep no memory between calls, so drafts
  can't live in the server any more. The blockchain still holds the credentials themselves.

**1. Supabase**
1. Create a project at supabase.com. In **SQL Editor**, paste and run `supabase/schema.sql`.
2. In **Project Settings > API**, copy the Project URL and the `service_role` key. Keep that key secret: backend only.

**2. Contract** (once, from your computer): `npm install`, fill `.env`, `npm run deploy`, copy the address.

**3. Netlify**
1. Push this folder to a private GitHub repo (`.env` is ignored).
2. Netlify > Add new site > Import from Git. It reads `netlify.toml`, so no build settings are needed.
3. Site configuration > Environment variables: add everything in `.env.example`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `RPC_URL`, `CHAIN_ID`, `CONTRACT_ADDRESS`,
   `ISSUER_KEYS`, `SUBJECT_PEPPER`, `ADMIN_KEY`, `NODE_ENV=production`, ...).
4. Deploy, then open `https://YOUR-SITE.netlify.app/api/health`: it should show `"ai": true, "chain": true`.

Test locally the same way Netlify runs it: `npx netlify dev`.

**Limits to know**
- Functions time out after a few seconds on the free plan (check your plan). The AI call and the chain wait are capped
  (`AI_TIMEOUT_MS`, `CONFIRM_WAIT_MS`); if the chain is slow, minting returns `pending: true` with the tx hash.
- The rate limiter is per function instance, so it is only a light guard. Add Netlify/Cloudflare rate limiting for real traffic.
- Two simultaneous mints from the same bank key can collide on nonces. Fine for a demo; use a queue for production.
