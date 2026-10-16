require("dotenv").config();

function json(name, fallback) {
  try { return JSON.parse(process.env[name] || ""); } catch { return fallback; }
}

const prod = process.env.NODE_ENV === "production";
const pepper = process.env.SUBJECT_PEPPER || "";
if (prod && pepper.length < 32) throw new Error("SUBJECT_PEPPER (32+ chars) is required in production");

const fx = Number(process.env.FX_NGN_PER_USD) || 1550;
const feeNgn = Number(process.env.FEE_NGN) || 200; // charged per on-chain mint and per bank verification

module.exports = {
  feeNgn,
  feeUsd: Math.round((feeNgn / fx) * 100) / 100, // 200 / 1550 = $0.13
  // Wallet fee: the holder signs a gasless USDC authorization (EIP-3009) and our relayer pulls the fee to the treasury.
  tokenAddress: process.env.STABLE_TOKEN_ADDRESS || "",
  tokenName: process.env.STABLE_TOKEN_NAME || "USDC",
  tokenVersion: process.env.STABLE_TOKEN_VERSION || "2",
  tokenDecimals: Number(process.env.STABLE_TOKEN_DECIMALS) || 6,
  treasury: process.env.TREASURY_ADDRESS || "",
  relayerKey: process.env.RELAYER_PRIVATE_KEY || "",
  bankDataUrl: process.env.BANK_DATA_URL || "", // bank oracle; empty = demo bank
  bankDataKey: process.env.BANK_DATA_KEY || "",
  requireBankData: process.env.REQUIRE_BANK_DATA !== "false", // bank accounts must be scored from bank-signed data
  platformName: process.env.PLATFORM_NAME || "TrustLayer", // receives every fee
  platformSettlement: json("PLATFORM_SETTLEMENT", null), // { bankCode, accountNumber, accountName } the platform's own NGN account
  feesEnabled: process.env.FEES_ENABLED !== "false",
  debitApiUrl: process.env.DEBIT_API_URL || "", // your bank's debit API; empty = demo provider
  debitApiKey: process.env.DEBIT_API_KEY || "",
  port: Number(process.env.PORT) || 8080,
  corsOrigin: process.env.CORS_ORIGIN || "*",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  rpcUrl: process.env.RPC_URL || "",
  chainId: Number(process.env.CHAIN_ID) || 84532,
  contract: process.env.CONTRACT_ADDRESS || "",
  explorerTxUrl: process.env.EXPLORER_TX_URL || "",
  issuers: json("ISSUER_KEYS", {}), // { "035": { name, key }, wallet: { name, key } }
  pepper: pepper || "dev-only-pepper-change-me-0000000000",
  lenderKeys: (process.env.LENDER_API_KEYS || "").split(",").filter(Boolean),
  adminKey: process.env.ADMIN_KEY || "",
  fx,
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS) || 8000, // serverless functions have short time limits
  confirmWaitMs: Number(process.env.CONFIRM_WAIT_MS) || 7000,
  allowUnverifiedBank: process.env.ALLOW_UNVERIFIED_BANK !== "false",
  strictNuban: process.env.STRICT_NUBAN === "true",
};
