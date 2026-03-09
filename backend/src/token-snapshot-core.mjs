import { rpcJson } from "./providers.mjs";
import { labelOwnerProgram } from "./address-taxonomy.mjs";

const MAX_OWNER_LIMIT = 10_000;
const DEFAULT_ACCOUNT_LIMIT = 10_000;
const MIN_ACCOUNT_LIMIT = 100;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ACCOUNT_INFO_CHUNK_SIZE = 100;

function clampPositiveInt(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function rawToUiAmount(rawAmount, decimals) {
  if (decimals <= 0) return Number(rawAmount);
  const base = 10n ** BigInt(decimals);
  const whole = rawAmount / base;
  const fraction = rawAmount % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const normalized = fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchTokenSupply(mint, rpc = rpcJson) {
  const json = await rpc("getTokenSupply", [mint]);
  const rawAmount = json?.result?.value?.amount;
  const decimals = Number(json?.result?.value?.decimals ?? 0);
  let rawSupply = 0n;
  try {
    rawSupply = BigInt(rawAmount ?? "0");
  } catch {
    rawSupply = 0n;
  }

  const safeDecimals = Number.isFinite(decimals) ? decimals : 0;
  return {
    rawAmount: rawSupply,
    decimals: safeDecimals,
    uiAmount: rawToUiAmount(rawSupply, safeDecimals),
  };
}

function deriveAccountLimit(ownerLimit) {
  if (ownerLimit == null) return DEFAULT_ACCOUNT_LIMIT;
  return Math.max(
    MIN_ACCOUNT_LIMIT,
    Math.min(MAX_OWNER_LIMIT, ownerLimit * 4),
  );
}

function parseLargestAccount(entry) {
  const owner = entry?.owner ?? "";
  const amount = entry?.amount;
  const decimals = Number(entry?.decimals ?? 0);

  if (!owner || typeof amount !== "string" || !Number.isFinite(decimals)) {
    return null;
  }

  try {
    return {
      owner,
      rawAmount: BigInt(amount),
      decimals,
    };
  } catch {
    return null;
  }
}

async function fetchLargestAccounts(mint, accountLimit, rpc = rpcJson) {
  const json = await rpc("getTokenLargestAccountsV2", [
    mint,
    {
      commitment: "confirmed",
      limit: accountLimit,
    },
  ]);

  const accounts = Array.isArray(json?.result?.value?.accounts)
    ? json.result.value.accounts
    : [];

  return accounts;
}

function classifyOwnerAccount(info) {
  if (!info) return { ownerAccountType: "unknown" };
  if (info.executable) return { ownerAccountType: "program" };

  const ownerProgram = info.owner;
  if (ownerProgram === SYSTEM_PROGRAM) {
    return { ownerAccountType: "wallet" };
  }
  if (ownerProgram === TOKEN_PROGRAM || ownerProgram === TOKEN_2022_PROGRAM) {
    return { ownerAccountType: "token", ownerProgram };
  }

  return {
    ownerAccountType: "other",
    ownerProgram,
    ownerProgramLabel: ownerProgram ? labelOwnerProgram(ownerProgram) : undefined,
  };
}

async function fetchOwnerAccountMetadata(addresses, rpc = rpcJson) {
  const unique = [...new Set(addresses)].filter(Boolean);
  const metadata = new Map();

  for (let index = 0; index < unique.length; index += ACCOUNT_INFO_CHUNK_SIZE) {
    const chunk = unique.slice(index, index + ACCOUNT_INFO_CHUNK_SIZE);
    const json = await rpc("getMultipleAccounts", [
      chunk,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const accounts = Array.isArray(json?.result?.value) ? json.result.value : [];

    for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex += 1) {
      const address = chunk[chunkIndex];
      metadata.set(address, classifyOwnerAccount(accounts[chunkIndex]));
    }
  }

  return metadata;
}

export async function buildTokenHolderSnapshot(
  mint,
  options = {},
  deps = {},
) {
  const rpc = deps.rpcJson ?? rpcJson;
  const ownerLimit = clampPositiveInt(options.limit);
  const accountLimit = deriveAccountLimit(ownerLimit);
  const supply = await fetchTokenSupply(mint, rpc);
  if (supply.rawAmount <= 0n || supply.uiAmount <= 0) {
    throw new Error("Unable to fetch token supply.");
  }

  const accounts = await fetchLargestAccounts(mint, accountLimit, rpc);
  const ownerTotals = new Map();

  for (const entry of accounts) {
    const parsed = parseLargestAccount(entry);
    if (!parsed || parsed.rawAmount <= 0n) continue;
    ownerTotals.set(parsed.owner, (ownerTotals.get(parsed.owner) ?? 0n) + parsed.rawAmount);
  }

  const holders = [...ownerTotals.entries()]
    .map(([owner, rawAmount]) => {
      const uiAmount = rawToUiAmount(rawAmount, supply.decimals);
      return {
        owner,
        uiAmount,
        percentage: Number((Number(rawAmount) / Number(supply.rawAmount)) * 100),
      };
    })
    .sort((a, b) => b.uiAmount - a.uiAmount);

  const snapshotHolders = ownerLimit != null ? holders.slice(0, ownerLimit) : holders;
  const ownerMetadata = await fetchOwnerAccountMetadata(
    snapshotHolders.map((holder) => holder.owner),
    rpc,
  );

  const enrichedHolders = snapshotHolders.map((holder) => {
    const metadata = ownerMetadata.get(holder.owner);
    const ownerProgramLabel = metadata?.ownerProgramLabel;
    return {
      ...holder,
      ...(metadata ?? { ownerAccountType: "unknown" }),
      ...(ownerProgramLabel ? { label: ownerProgramLabel } : {}),
    };
  });

  return {
    mint,
    supply: supply.uiAmount,
    holderCount: ownerLimit != null ? Math.min(holders.length, ownerLimit) : holders.length,
    holders: enrichedHolders,
    snapshotAt: Date.now(),
    source: "helius:getTokenLargestAccountsV2",
    accountLimit,
    ownerLimit,
    partial: accounts.length >= accountLimit,
    tokenAccountCount: accounts.length,
  };
}
