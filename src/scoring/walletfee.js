// Fee for USD wallets: same idea as the bank-account code, but the approval is a wallet signature.
// A blockchain only moves tokens the owner authorised, so the holder signs an EIP-3009 "transfer with authorization"
// for the fee in USDC. We relay it (we pay the gas) and the fee lands in the treasury.
//  - mock provider (token/treasury/relayer not configured): signature is checked, no money moves.
//  - onchain provider: the USDC is really transferred.
const { ethers } = require("ethers");
const cfg = require("./config");
const chain = require("./chain");

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
const live = () => !!(cfg.tokenAddress && cfg.relayerKey && cfg.rpcUrl);
const provider = () => (live() ? "onchain" : "mock");
const units = () => BigInt(Math.round(cfg.feeUsd * 10 ** cfg.tokenDecimals)); // $0.13 -> 130000 (6 decimals)

function build(wallet, treasury) {
  let to = ethers.ZeroAddress;
  if (treasury) {
    try { to = ethers.getAddress(treasury.toLowerCase()); } // tolerate any capitalisation
    catch { throw new Error("A configured treasury address is not a valid address"); }
  }
  return {
    domain: { name: cfg.tokenName, version: cfg.tokenVersion, chainId: cfg.chainId, verifyingContract: cfg.tokenAddress || ethers.ZeroAddress },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: wallet,
      to, // the issuing bank's USD wallet
      value: units().toString(),
      validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 900), nonce: ethers.hexlify(ethers.randomBytes(32)),
    },
  };
}
// Format MetaMask expects for eth_signTypedData_v4
const forWallet = (t) => ({
  ...t,
  types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    ...t.types,
  },
});
const signer = (t, sig) => ethers.verifyTypedData(t.domain, t.types, t.message, sig);
const pull = async (t, sig) => (live() ? chain.pullFee(t.message, sig) : { txHash: null });

module.exports = { provider, build, forWallet, signer, pull };
