import { GTFA_TOKEN_ACCOUNTS_MODE } from "./config.mjs";
import {
  fetchTransactions,
  fetchRecentTransactions,
  getAccountTypesParallel,
  getBatchIdentity,
  getTokenMetadataBatch,
} from "./providers.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000;
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
export const NATIVE_SOL_ASSET_ID = "native:sol";

const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJBfCR6MNLc4u1mfLsJgGT2ciczyG5hXVfHi",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg",
  "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
]);

const IGNORED_TX_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ...TOKEN_PROGRAM_IDS,
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJBfCR6MNLc4u1mfLsJgGT2ciczyG5hXVfHi",
]);

const PROGRAM_LABELS = new Map([
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter V6"],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpool"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
  ["srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", "OpenBook"],
  ["auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg", "Squads V4"],
  ["metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "Metaplex"],
  ["namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX", "SNS"],
]);

function resolveKey(key) {
  return typeof key === "string" ? key : key.pubkey;
}

function flattenInstructions(tx) {
  const topLevel = tx.transaction?.message?.instructions ?? [];
  const inner = tx.meta?.innerInstructions?.flatMap((entry) => entry.instructions ?? []) ?? [];
  return [...topLevel, ...inner];
}

function getInstructionInfoString(instruction, key) {
  const value = instruction.parsed?.info?.[key];
  return typeof value === "string" ? value : undefined;
}

function getInstructionInfoObject(instruction, key) {
  const value = instruction.parsed?.info?.[key];
  return value && typeof value === "object" ? value : undefined;
}

function getInstructionInfoBigInt(instruction, key) {
  const value = instruction.parsed?.info?.[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function bigintToUiAmount(rawAmount, decimals) {
  if (decimals <= 0) return Number(rawAmount);
  const negative = rawAmount < 0n;
  const value = negative ? -rawAmount : rawAmount;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const normalized = fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
  const parsed = Number(negative ? `-${normalized}` : normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rememberTokenAccountInfo(map, account, next) {
  if (!account) return;
  const current = map.get(account) ?? {};
  map.set(account, {
    owner: current.owner ?? next.owner,
    mint: current.mint ?? next.mint,
    decimals: current.decimals ?? next.decimals,
  });
}

export function buildTokenAccountInfo(tx) {
  const infoMap = new Map();
  const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map(resolveKey);

  for (const tb of tx.meta?.preTokenBalances ?? []) {
    rememberTokenAccountInfo(infoMap, accountKeys[tb.accountIndex], {
      owner: tb.owner,
      mint: tb.mint,
      decimals: tb.uiTokenAmount.decimals,
    });
  }

  for (const tb of tx.meta?.postTokenBalances ?? []) {
    rememberTokenAccountInfo(infoMap, accountKeys[tb.accountIndex], {
      owner: tb.owner,
      mint: tb.mint,
      decimals: tb.uiTokenAmount.decimals,
    });
  }

  for (const instruction of flattenInstructions(tx)) {
    if (
      instruction.program === "spl-associated-token-account"
      || instruction.programId === ASSOCIATED_TOKEN_PROGRAM_ID
    ) {
      const account = getInstructionInfoString(instruction, "account");
      const wallet = getInstructionInfoString(instruction, "wallet");
      const mint = getInstructionInfoString(instruction, "mint");
      rememberTokenAccountInfo(infoMap, account, { owner: wallet, mint });
      continue;
    }

    if (
      instruction.program !== "spl-token"
      && !TOKEN_PROGRAM_IDS.has(instruction.programId ?? "")
    ) {
      continue;
    }

    const source = getInstructionInfoString(instruction, "source");
    const destination = getInstructionInfoString(instruction, "destination");
    const mint = getInstructionInfoString(instruction, "mint");
    const tokenAmount = getInstructionInfoObject(instruction, "tokenAmount");
    const decimals = typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : undefined;

    const authority =
      getInstructionInfoString(instruction, "owner")
      ?? getInstructionInfoString(instruction, "authority")
      ?? getInstructionInfoString(instruction, "wallet");

    if (source) rememberTokenAccountInfo(infoMap, source, { owner: authority, mint, decimals });
    if (destination) rememberTokenAccountInfo(infoMap, destination, { mint, decimals });
  }

  return infoMap;
}

function collectWalletMints(walletMints, tx, walletAddress) {
  for (const tb of tx.meta?.preTokenBalances ?? []) {
    if (tb.owner === walletAddress && (tb.uiTokenAmount.uiAmount ?? 0) > 0) {
      walletMints.add(tb.mint);
    }
  }
  for (const tb of tx.meta?.postTokenBalances ?? []) {
    if (tb.owner === walletAddress && (tb.uiTokenAmount.uiAmount ?? 0) > 0) {
      walletMints.add(tb.mint);
    }
  }
}

function walletSolChange(tx, walletAddress) {
  const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map(resolveKey);
  const walletIndex = accountKeys.indexOf(walletAddress);
  if (walletIndex < 0 || !tx.meta) return 0;
  const pre = tx.meta.preBalances[walletIndex] ?? 0;
  const post = tx.meta.postBalances[walletIndex] ?? 0;
  return (post - pre) / LAMPORTS_PER_SOL;
}

function walletPostBalance(tx, walletAddress) {
  const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map(resolveKey);
  const walletIndex = accountKeys.indexOf(walletAddress);
  if (walletIndex < 0 || !tx.meta) return 0;
  const post = tx.meta.postBalances[walletIndex] ?? 0;
  return post / LAMPORTS_PER_SOL;
}

function prettifyProgramName(name) {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function collectTransactionPrograms(tx) {
  const programs = new Map();

  for (const instruction of flattenInstructions(tx)) {
    const programId = instruction.programId ?? "";
    const programName = typeof instruction.program === "string" ? instruction.program : "";
    if (programId && IGNORED_TX_PROGRAM_IDS.has(programId)) continue;
    if (!programId && (!programName || programName === "system")) continue;

    const label =
      (programId ? PROGRAM_LABELS.get(programId) : undefined)
      ?? (programName && !["system", "spl-token", "spl-associated-token-account"].includes(programName)
        ? prettifyProgramName(programName)
        : "")
      ?? "";

    const key = programId || programName;
    if (!key || programs.has(key)) continue;
    programs.set(key, {
      id: key,
      label: label || `${key.slice(0, 4)}...${key.slice(-4)}`,
    });
  }

  return [...programs.values()];
}

export function parseTraceTransferEvents(txs, walletAddress) {
  const events = [];

  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const timestamp = tx.blockTime ?? 0;
    const signature = tx.transaction?.signatures?.[0] ?? "";
    const tokenAccountInfo = buildTokenAccountInfo(tx);

    for (const instruction of flattenInstructions(tx)) {
      let direction = null;
      let counterparty;
      let assetId;
      let kind;
      let mint;
      let decimals = 0;
      let amountRaw;

      if (
        (instruction.program === "system" || instruction.programId === SYSTEM_PROGRAM_ID)
        && instruction.parsed?.type
      ) {
        if (instruction.parsed.type !== "transfer" && instruction.parsed.type !== "transferWithSeed") continue;
        const source = getInstructionInfoString(instruction, "source");
        const destination = getInstructionInfoString(instruction, "destination");
        const lamports = getInstructionInfoBigInt(instruction, "lamports");
        if (!source || !destination || !lamports || lamports <= 0n) continue;
        if (source === walletAddress && destination !== walletAddress) {
          direction = "outflow";
          counterparty = destination;
        } else if (destination === walletAddress && source !== walletAddress) {
          direction = "inflow";
          counterparty = source;
        } else {
          continue;
        }
        assetId = NATIVE_SOL_ASSET_ID;
        kind = "native";
        decimals = 9;
        amountRaw = lamports;
      } else if (
        (instruction.program === "spl-token" || TOKEN_PROGRAM_IDS.has(instruction.programId ?? ""))
        && instruction.parsed?.type
      ) {
        if (
          instruction.parsed.type !== "transfer"
          && instruction.parsed.type !== "transferChecked"
          && instruction.parsed.type !== "transferCheckedWithFee"
        ) {
          continue;
        }

        const source = getInstructionInfoString(instruction, "source");
        const destination = getInstructionInfoString(instruction, "destination");
        if (!source || !destination) continue;

        const tokenAmountInfo = getInstructionInfoObject(instruction, "tokenAmount");
        amountRaw =
          (tokenAmountInfo?.amount != null
            ? (() => {
                try {
                  return BigInt(String(tokenAmountInfo.amount));
                } catch {
                  return undefined;
                }
              })()
            : undefined)
          ?? getInstructionInfoBigInt(instruction, "amount");
        if (!amountRaw || amountRaw <= 0n) continue;

        const sourceInfo = tokenAccountInfo.get(source);
        const destinationInfo = tokenAccountInfo.get(destination);
        const sourceOwner = sourceInfo?.owner;
        const destinationOwner = destinationInfo?.owner;
        mint = getInstructionInfoString(instruction, "mint") ?? sourceInfo?.mint ?? destinationInfo?.mint;
        decimals =
          typeof tokenAmountInfo?.decimals === "number"
            ? tokenAmountInfo.decimals
            : sourceInfo?.decimals ?? destinationInfo?.decimals ?? 0;

        if (sourceOwner === walletAddress && destinationOwner && destinationOwner !== walletAddress) {
          direction = "outflow";
          counterparty = destinationOwner;
        } else if (destinationOwner === walletAddress && sourceOwner && sourceOwner !== walletAddress) {
          direction = "inflow";
          counterparty = sourceOwner;
        } else {
          continue;
        }

        if (!mint) continue;
        assetId = mint;
        kind = "token";
      } else {
        continue;
      }

      if (!direction || !counterparty || !assetId || !kind || !amountRaw) continue;
      events.push({
        signature,
        timestamp,
        direction,
        counterparty,
        assetId,
        kind,
        mint,
        decimals,
        rawAmount: amountRaw.toString(),
        uiAmount: bigintToUiAmount(amountRaw, decimals),
      });
    }
  }

  return events;
}

function finalizeTokenFlows(tokenFlows) {
  if (!tokenFlows || tokenFlows.size === 0) return undefined;
  return Array.from(tokenFlows.values())
    .map((tf) => ({
      mint: tf.mint,
      decimals: tf.decimals,
      sent: tf.sent,
      received: tf.received,
      net: tf.received - tf.sent,
      txCount: tf.signatures.size,
    }))
    .sort((a, b) => (b.sent + b.received) - (a.sent + a.received));
}

function finalizeCounterparties(counterpartyMap) {
  return Array.from(counterpartyMap.entries())
    .map(([address, data]) => {
      const base = {
        address,
        txCount: data.txCount,
        solSent: data.solSent,
        solReceived: data.solReceived,
        solNet: data.solReceived - data.solSent,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
      };
      const tokenTransfers = finalizeTokenFlows(data.tokenFlows);
      if (tokenTransfers) base.tokenTransfers = tokenTransfers;
      return base;
    })
    .sort((a, b) => b.txCount - a.txCount || (b.solSent + b.solReceived) - (a.solSent + a.solReceived));
}

function parseTransactions(txs, walletAddress) {
  const counterparties = new Map();
  const transactions = new Map();
  const historicalMints = new Set();
  const seenSignatures = new Set();
  const freshTxs = [];

  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const signature = tx.transaction?.signatures?.[0];
    if (!signature || seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    collectWalletMints(historicalMints, tx, walletAddress);
    transactions.set(signature, {
      signature,
      timestamp: tx.blockTime ?? 0,
      solChange: walletSolChange(tx, walletAddress),
      walletBalanceAfter: walletPostBalance(tx, walletAddress),
      counterparties: new Set(),
      transfers: [],
      programs: collectTransactionPrograms(tx),
      fee: (tx.meta?.fee ?? 0) / LAMPORTS_PER_SOL,
    });
    freshTxs.push(tx);
  }

  const events = parseTraceTransferEvents(freshTxs, walletAddress);
  for (const event of events) {
    const entry = counterparties.get(event.counterparty) ?? {
      txCount: 0,
      solSent: 0,
      solReceived: 0,
      firstSeen: event.timestamp,
      lastSeen: event.timestamp,
      signatures: new Set(),
      tokenFlows: new Map(),
    };

    entry.firstSeen = Math.min(entry.firstSeen, event.timestamp);
    entry.lastSeen = Math.max(entry.lastSeen, event.timestamp);
    if (!entry.signatures.has(event.signature)) {
      entry.signatures.add(event.signature);
      entry.txCount += 1;
    }
    if (event.kind === "native") {
      if (event.direction === "outflow") entry.solSent += event.uiAmount;
      else entry.solReceived += event.uiAmount;
    } else if (event.kind === "token" && event.mint) {
      const tf = entry.tokenFlows.get(event.mint) ?? {
        mint: event.mint,
        decimals: event.decimals,
        sent: 0,
        received: 0,
        signatures: new Set(),
      };
      if (event.direction === "outflow") tf.sent += event.uiAmount;
      else tf.received += event.uiAmount;
      tf.signatures.add(event.signature);
      entry.tokenFlows.set(event.mint, tf);
    }
    counterparties.set(event.counterparty, entry);

    const txEntry = transactions.get(event.signature);
    txEntry?.counterparties.add(event.counterparty);
    txEntry?.transfers.push({
      counterparty: event.counterparty,
      direction: event.direction,
      kind: event.kind,
      assetId: event.assetId,
      mint: event.mint,
      decimals: event.decimals,
      uiAmount: event.uiAmount,
    });
  }

  return {
    counterparties: finalizeCounterparties(counterparties),
    transactions: Array.from(transactions.values())
      .map((tx) => ({
        signature: tx.signature,
        timestamp: tx.timestamp,
        solChange: tx.solChange,
        walletBalanceAfter: tx.walletBalanceAfter,
        counterparties: [...tx.counterparties],
        transfers: tx.transfers,
        programs: tx.programs,
        fee: tx.fee,
      }))
      .sort((a, b) => b.timestamp - a.timestamp),
    historicalMints: [...historicalMints],
  };
}

async function enrichCounterparties(counterparties) {
  const topIdentityAddresses = counterparties.slice(0, 50).map((cp) => cp.address);
  const allAddresses = [...new Set(counterparties.map((cp) => cp.address))];
  const [identityMap, accountTypeMap] = await Promise.all([
    getBatchIdentity(topIdentityAddresses).catch(() => new Map()),
    getAccountTypesParallel(allAddresses).catch(() => new Map()),
  ]);

  const mints = new Set();
  for (const cp of counterparties.slice(0, 200)) {
    const info = accountTypeMap.get(cp.address);
    if (info?.type === "token" && info.mint) {
      mints.add(info.mint);
    }
    if (cp.tokenTransfers) {
      for (const tf of cp.tokenTransfers) {
        mints.add(tf.mint);
      }
    }
  }

  const tokenMetaMap = mints.size > 0
    ? await getTokenMetadataBatch([...mints]).catch(() => new Map())
    : new Map();

  return counterparties
    .map((cp) => {
      const identity = identityMap.get(cp.address);
      const accountType = accountTypeMap.get(cp.address);
      const tokenMeta = accountType?.mint ? tokenMetaMap.get(accountType.mint) : undefined;
      const enriched = {
        ...cp,
        label: identity?.label ?? identity?.name,
        category: identity?.category,
        accountType: accountType?.type,
        mint: accountType?.mint,
        tokenName: tokenMeta?.name,
        tokenSymbol: tokenMeta?.symbol,
        tokenLogoUri: tokenMeta?.logoUri,
      };
      if (enriched.tokenTransfers) {
        enriched.tokenTransfers = enriched.tokenTransfers.map((tf) => {
          const meta = tokenMetaMap.get(tf.mint);
          if (!meta) return tf;
          return { ...tf, symbol: meta.symbol, name: meta.name, logoUri: meta.logoUri };
        });
      }
      return enriched;
    })
    .filter((cp) => {
      const label = (cp.label ?? "").toLowerCase();
      if (label.includes("spam") || label.includes("dusting")) return false;
      const totalVol = cp.solSent + cp.solReceived;
      if (cp.txCount >= 3 && totalVol < 0.001) return false;
      return true;
    });
}

async function enrichWalletTransactions(transactions) {
  const mints = [...new Set(
    transactions.flatMap((tx) => tx.transfers.map((transfer) => transfer.mint).filter(Boolean)),
  )].slice(0, 400);
  const tokenMetaMap = mints.length > 0
    ? await getTokenMetadataBatch(mints).catch(() => new Map())
    : new Map();

  return transactions.map((tx) => ({
    ...tx,
    transfers: tx.transfers.map((transfer) => {
      const meta = transfer.assetId === NATIVE_SOL_ASSET_ID
        ? { symbol: "SOL", name: "Native SOL" }
        : (transfer.mint ? tokenMetaMap.get(transfer.mint) : undefined);
      return {
        ...transfer,
        symbol: meta?.symbol ?? transfer.symbol,
        name: meta?.name ?? transfer.name,
        logoUri: meta?.logoUri ?? transfer.logoUri,
      };
    }),
  }));
}

function collectTraceAssetOptions(events) {
  const assetMap = new Map();
  const seenAssetTx = new Set();

  for (const event of events) {
    const amountRaw = BigInt(event.rawAmount);
    const key = `${event.assetId}:${event.signature}`;
    const existing = assetMap.get(event.assetId) ?? {
      assetId: event.assetId,
      kind: event.kind,
      mint: event.mint,
      symbol: event.symbol,
      name: event.name,
      logoUri: event.logoUri,
      decimals: event.decimals,
      rawAmount: 0n,
      uiAmount: 0,
      transferCount: 0,
      txCount: 0,
    };
    existing.rawAmount += amountRaw;
    existing.uiAmount = bigintToUiAmount(existing.rawAmount, existing.decimals);
    existing.transferCount += 1;
    if (!seenAssetTx.has(key)) {
      seenAssetTx.add(key);
      existing.txCount += 1;
    }
    existing.symbol = existing.symbol ?? event.symbol;
    existing.name = existing.name ?? event.name;
    existing.logoUri = existing.logoUri ?? event.logoUri;
    assetMap.set(event.assetId, existing);
  }

  return Array.from(assetMap.values())
    .map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      mint: asset.mint,
      symbol: asset.symbol,
      name: asset.name,
      logoUri: asset.logoUri,
      decimals: asset.decimals,
      transferCount: asset.transferCount,
      txCount: asset.txCount,
      uiAmount: asset.uiAmount,
    }))
    .sort((a, b) => b.txCount - a.txCount || b.transferCount - a.transferCount || b.uiAmount - a.uiAmount);
}

function summarizeTraceCounterparties(events) {
  const map = new Map();
  for (const event of events) {
    const entry = map.get(event.counterparty) ?? {
      txSignatures: new Set(),
      transferCount: 0,
      lastSeen: event.timestamp,
    };
    entry.txSignatures.add(event.signature);
    entry.transferCount += 1;
    entry.lastSeen = Math.max(entry.lastSeen, event.timestamp);
    map.set(event.counterparty, entry);
  }
  return Array.from(map.entries())
    .map(([address, entry]) => ({
      address,
      txCount: entry.txSignatures.size,
      transferCount: entry.transferCount,
      lastSeen: entry.lastSeen,
    }))
    .sort((a, b) => b.txCount - a.txCount || b.transferCount - a.transferCount || b.lastSeen - a.lastSeen);
}

function buildTraceNodeFlows(address, events) {
  const timestamps = events.map((event) => event.timestamp).filter((value) => value > 0);
  return {
    address,
    events,
    assets: collectTraceAssetOptions(events),
    firstSeen: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    lastSeen: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    metadataPending: false,
  };
}

function enrichEvents(walletEvents, identityMap, tokenMetaMap, accountTypeMap) {
  return walletEvents
    .map((event) => {
      const identity = identityMap.get(event.counterparty);
      const meta = event.assetId === NATIVE_SOL_ASSET_ID
        ? { symbol: "SOL", name: "Native SOL" }
        : (event.mint ? tokenMetaMap.get(event.mint) : undefined);

      return {
        ...event,
        counterpartyLabel: identity?.label ?? identity?.name ?? event.counterpartyLabel,
        counterpartyCategory: identity?.category ?? event.counterpartyCategory,
        counterpartyAccountType: accountTypeMap.get(event.counterparty)?.type ?? event.counterpartyAccountType,
        symbol: meta?.symbol ?? event.symbol,
        name: meta?.name ?? event.name,
        logoUri: meta?.logoUri ?? event.logoUri,
      };
    })
    .filter((event) => {
      const label = (event.counterpartyLabel ?? "").toLowerCase();
      return !label.includes("spam") && !label.includes("dusting");
    });
}

async function analyzeTraceEvents(address, txs, onEnriched) {
  const rawEvents = parseTraceTransferEvents(txs, address)
    .filter((event) => !KNOWN_PROGRAMS.has(event.counterparty));

  if (rawEvents.length === 0) {
    return buildTraceNodeFlows(address, []);
  }

  const uniqueCounterparties = [...new Set(rawEvents.map((event) => event.counterparty))];
  const accountTypeMap = await getAccountTypesParallel(uniqueCounterparties).catch(() => new Map());
  const walletEvents = rawEvents.filter((event) => {
    const info = accountTypeMap.get(event.counterparty);
    return !info || info.type === "wallet" || info.type === "unknown";
  });

  if (walletEvents.length === 0) {
    return buildTraceNodeFlows(address, []);
  }

  // Phase 1: return raw events immediately with SOL labeled
  const solLabeledEvents = walletEvents.map((event) => {
    if (event.assetId === NATIVE_SOL_ASSET_ID) {
      return { ...event, symbol: "SOL", name: "Native SOL" };
    }
    return event;
  });
  const fastResult = {
    ...buildTraceNodeFlows(address, solLabeledEvents),
    metadataPending: true,
  };

  // Phase 2: everything else in background (account types, identity, token meta)
  const enrichInBackground = async () => {
    const ranked = summarizeTraceCounterparties(walletEvents);
    const [identityMap, tokenMetaMap] = await Promise.all([
      getBatchIdentity(ranked.slice(0, 500).map((entry) => entry.address)).catch(() => new Map()),
      getTokenMetadataBatch(
        [...new Set(walletEvents.map((event) => event.mint).filter(Boolean))].slice(0, 400),
      ).catch(() => new Map()),
    ]);

    const enrichedEvents = enrichEvents(walletEvents, identityMap, tokenMetaMap, accountTypeMap);
    return buildTraceNodeFlows(address, enrichedEvents);
  };

  enrichInBackground().then((enriched) => {
    if (onEnriched) onEnriched(enriched);
  }).catch(() => {});

  return fastResult;
}

export async function analyzeWallet(address, range = {}) {
  const txs = await fetchTransactions(address, range);
  const parsed = parseTransactions(txs, address);
  const [counterparties, transactions] = await Promise.all([
    enrichCounterparties(parsed.counterparties),
    enrichWalletTransactions(parsed.transactions),
  ]);
  const lastBlockTime = txs.reduce((max, tx) => Math.max(max, tx.blockTime ?? 0), 0);

  return {
    address,
    counterparties,
    transactions,
    txCount: txs.length,
    lastBlockTime,
  };
}

export async function analyzeTrace(address, range = {}, onEnriched, options = {}) {
  const txLimit = Number(options.limit);
  const txs = Number.isFinite(txLimit) && txLimit > 0
    ? await fetchRecentTransactions(address, { limit: txLimit })
    : await fetchTransactions(address, range);
  return analyzeTraceEvents(address, txs, onEnriched);
}

export const analysisInternals = {
  parseTransactions,
  parseTraceTransferEvents,
  buildTraceNodeFlows,
};
