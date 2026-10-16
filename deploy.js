const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with", deployer.address);

  const Registry = await ethers.getContractFactory("TrustLayerRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  console.log("TrustLayerRegistry deployed:", address);

  // Onboard issuers (banks) from ISSUER_KEYS
  const issuers = JSON.parse(process.env.ISSUER_KEYS || "{}");
  for (const [code, { name, key }] of Object.entries(issuers)) {
    const issuerAddress = new ethers.Wallet(key).address;
    const tx = await registry.addIssuer(issuerAddress, name);
    await tx.wait();
    console.log(`Issuer added: ${name} (${code}) -> ${issuerAddress}`);
  }
  console.log(`\nNext: set CONTRACT_ADDRESS=${address} in .env and fund each issuer address with gas.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
