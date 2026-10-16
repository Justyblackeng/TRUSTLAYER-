const { ethers } = require("ethers");
const cfg = require("./config");
const { HttpError } = require("./errors");

const ABI = [
  "function issue(bytes32 subjectId,uint16 score,uint64 loanLimitNgn,bytes32 scoreHash)",
  "function revoke(bytes32 subjectId)",
  "function verify(bytes32 subjectId) view returns (bool valid,uint16 score,uint64 loanLimitNgn,uint40 issuedAt,uint40 expiresAt,bool revoked,address issuer,string issuerName,bytes32 scoreHash)",
];

const provider = cfg.rpcUrl ? new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true }) : null;
const signers = new Map();

function need() {
  if (!provider || !cfg.contract) throw new HttpError(503, "Blockchain is not configured (RPC_URL / CONTRACT_ADDRESS)");
}

// Each bank signs with its own key, so issuers stay independent.
function writer(issuerKey) {
  need();
  let signer = signers.get(issuerKey);
  if (!signer) {
    const issuer = cfg.issuers[issuerKey];
    if (!issuer) throw new HttpError(400, "Unknown issuer");
    signer = new ethers.NonceManager(new ethers.Wallet(issuer.key, provider));
    signers.set(issuerKey, signer);
  }
  return new ethers.Contract(cfg.contract, ABI, signer);
}

async function issue(issuerKey, subjectId, score, loanLimitNgn, scoreHash) {
  const tx = await writer(issuerKey).issue(subjectId, score, BigInt(loanLimitNgn), scoreHash);
  // Serverless functions time out quickly, so wait only briefly for the confirmation.
  const receipt = await Promise.race([tx.wait(1), new Promise((r) => setTimeout(() => r(null), cfg.confirmWaitMs))]);
  return { txHash: tx.hash, blockNumber: receipt ? receipt.blockNumber : null, pending: !receipt, issuer: cfg.issuers[issuerKey].name };
}

async function revoke(issuerKey, subjectId) {
  const tx = await writer(issuerKey).revoke(subjectId);
  const receipt = await tx.wait(1);
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

async function verify(subjectId) {
  need();
  const r = await new ethers.Contract(cfg.contract, ABI, provider).verify(subjectId);
  if (r.issuer === ethers.ZeroAddress) return null; // nothing issued for this subject
  return {
    valid: r.valid,
    revoked: r.revoked,
    score: Number(r.score),
    loanLimitNgn: Number(r.loanLimitNgn),
    issuedAt: Number(r.issuedAt),
    expiresAt: Number(r.expiresAt),
    issuer: r.issuerName,
    scoreHash: r.scoreHash,
  };
}

const TOKEN_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function balanceOf(address) view returns (uint256)",
];
let relayer;

// The wallet holder signed an authorization; the relayer submits it and pays the gas.
async function pullFee(m, sig) {
  if (!provider || !cfg.tokenAddress || !cfg.relayerKey) throw new HttpError(503, "Wallet fee collection is not configured");
  relayer = relayer || new ethers.NonceManager(new ethers.Wallet(cfg.relayerKey, provider));
  const token = new ethers.Contract(cfg.tokenAddress, TOKEN_ABI, relayer);
  if ((await token.balanceOf(m.from)) < BigInt(m.value)) throw new HttpError(402, "Not enough USDC in this wallet for the fee");
  const { v, r, s } = ethers.Signature.from(sig);
  try {
    const tx = await token.transferWithAuthorization(m.from, m.to, BigInt(m.value), BigInt(m.validAfter), BigInt(m.validBefore), m.nonce, v, r, s);
    return { txHash: tx.hash };
  } catch (e) { throw new HttpError(402, "The wallet could not be debited: " + (e.shortMessage || e.message)); }
}
async function receiptStatus(hash) {
  need();
  const r = await provider.getTransactionReceipt(hash);
  return r ? (r.status === 1 ? "success" : "failed") : "pending";
}

module.exports = { pullFee, receiptStatus, issue, revoke, verify, configured: () => !!(provider && cfg.contract) };
