export const KNOWN_EXCHANGES = new Set([
  "5tzFkiKscjHK98Up2w5Np8NErQ47rXiKzcEYTj9LRHGA",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE",
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm",
  "4STBFnYVRCbSEGrcr5raMPH99QkHswD6K9YWfkroJmj2",
  "6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51S3",
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
  "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq",
]);

export const KNOWN_OWNER_PROGRAM_LABELS = new Map([
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "Pump.fun AMM"],
]);

export function labelOwnerProgram(address) {
  return KNOWN_OWNER_PROGRAM_LABELS.get(address) ?? undefined;
}

export function isLikelyExchangeOrCustody(address, category = "", label = "") {
  return (
    KNOWN_EXCHANGES.has(address)
    || /exchange|cex|custody/i.test(category)
    || /binance|coinbase|kraken|okx|bybit|kucoin/i.test(label)
  );
}
