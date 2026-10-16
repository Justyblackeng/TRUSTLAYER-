require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    chain: {
      url: process.env.RPC_URL || "",
      chainId: Number(process.env.CHAIN_ID || 84532),
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
