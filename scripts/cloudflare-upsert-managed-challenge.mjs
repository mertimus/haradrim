#!/usr/bin/env node

const DEFAULT_ZONE = "haradrim.net";
const DEFAULT_RULE_REF = "haradrim_entry_managed_challenge";
const DEFAULT_RULE_DESCRIPTION = "Haradrim entry managed challenge";
const DEFAULT_CHALLENGE_TTL_SECONDS = 45 * 60;
const DEFAULT_MATCH_EXPRESSION = [
  '(http.host eq "haradrim.net")',
  "and",
  '(http.request.method eq "GET")',
  "and",
  "(",
  '  http.request.uri.path eq "/"',
  '  or starts_with(http.request.uri.path, "/trace")',
  '  or starts_with(http.request.uri.path, "/balances")',
  '  or starts_with(http.request.uri.path, "/token")',
  ")",
].join(" ");

function printUsage() {
  console.log(`Usage:
  CLOUDFLARE_API_TOKEN=... node scripts/cloudflare-upsert-managed-challenge.mjs [options]

Options:
  --zone <name>            Zone name. Default: ${DEFAULT_ZONE}
  --zone-id <id>           Zone ID. If omitted, resolved from the zone name.
  --host <host>            Hostname to challenge. Default: same as --zone.
  --ttl <seconds>          Challenge passage TTL in seconds. Default: ${DEFAULT_CHALLENGE_TTL_SECONDS}
  --expression <expr>      Override the Cloudflare rules expression entirely.
  --description <text>     Rule description. Default: ${DEFAULT_RULE_DESCRIPTION}
  --ref <value>            Stable rule ref. Default: ${DEFAULT_RULE_REF}
  --dry-run                Print the planned change without writing anything.
  --delete                 Delete the managed-challenge rule instead of creating/updating it.
  --help                   Show this help.

Environment:
  CLOUDFLARE_API_TOKEN     Required. Needs at least Zone Read, Zone WAF Write, and Zone Settings Write.
`);
}

function parseArgs(argv) {
  const result = {
    zone: DEFAULT_ZONE,
    zoneId: "",
    host: "",
    ttl: DEFAULT_CHALLENGE_TTL_SECONDS,
    expression: "",
    description: DEFAULT_RULE_DESCRIPTION,
    ref: DEFAULT_RULE_REF,
    dryRun: false,
    delete: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--delete") {
      result.delete = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--zone") {
      result.zone = next;
      index += 1;
      continue;
    }
    if (arg === "--zone-id") {
      result.zoneId = next;
      index += 1;
      continue;
    }
    if (arg === "--host") {
      result.host = next;
      index += 1;
      continue;
    }
    if (arg === "--ttl") {
      const ttl = Number(next);
      if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new Error(`Invalid TTL: ${next}`);
      }
      result.ttl = ttl;
      index += 1;
      continue;
    }
    if (arg === "--expression") {
      result.expression = next;
      index += 1;
      continue;
    }
    if (arg === "--description") {
      result.description = next;
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      result.ref = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  result.host = result.host || result.zone;
  if (!result.expression) {
    result.expression = DEFAULT_MATCH_EXPRESSION.replaceAll('"haradrim.net"', `"${result.host}"`);
  }
  return result;
}

async function cfFetch(pathname, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    const detail = json?.errors?.map((entry) => entry?.message).filter(Boolean).join("; ")
      || json?.messages?.map((entry) => entry?.message).filter(Boolean).join("; ")
      || `${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare API ${response.status}: ${detail}`);
  }

  return json.result;
}

async function resolveZoneId(zoneName) {
  const result = await cfFetch(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = Array.isArray(result) ? result.find((entry) => entry?.name === zoneName) : null;
  if (!zone?.id) {
    throw new Error(`Zone not found: ${zoneName}`);
  }
  return zone.id;
}

async function getEntryPointRuleset(zoneId) {
  try {
    return await cfFetch(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

async function createEntryPointRuleset(zoneId, rule) {
  return cfFetch(`/zones/${zoneId}/rulesets`, {
    method: "POST",
    body: JSON.stringify({
      name: "default",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [rule],
    }),
  });
}

async function updateRule(zoneId, rulesetId, ruleId, rule) {
  return cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
    method: "PATCH",
    body: JSON.stringify(rule),
  });
}

async function createRule(zoneId, rulesetId, rule) {
  return cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules`, {
    method: "POST",
    body: JSON.stringify(rule),
  });
}

async function deleteRule(zoneId, rulesetId, ruleId) {
  return cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
    method: "DELETE",
  });
}

async function setChallengePassage(zoneId, ttl) {
  return cfFetch(`/zones/${zoneId}/settings/challenge_ttl`, {
    method: "PATCH",
    body: JSON.stringify({ value: ttl }),
  });
}

function buildRule(config) {
  return {
    ref: config.ref,
    description: config.description,
    expression: config.expression,
    action: "managed_challenge",
    enabled: true,
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const zoneId = config.zoneId || await resolveZoneId(config.zone);
  const rule = buildRule(config);
  const ruleset = await getEntryPointRuleset(zoneId);
  const existingRule = ruleset?.rules?.find((entry) => entry?.ref === config.ref)
    ?? ruleset?.rules?.find((entry) => entry?.description === config.description);

  const plan = {
    zone: config.zone,
    zoneId,
    host: config.host,
    ttl: config.ttl,
    expression: config.expression,
    action: config.delete
      ? (existingRule ? "delete" : "noop")
      : (existingRule ? "update" : (ruleset ? "create-rule" : "create-ruleset")),
    rulesetId: ruleset?.id ?? null,
    existingRuleId: existingRule?.id ?? null,
  };

  console.log(JSON.stringify(plan, null, 2));
  if (config.dryRun) return;

  if (config.delete) {
    if (!ruleset?.id || !existingRule?.id) {
      console.log("No matching rule found. Nothing to delete.");
      return;
    }
    await deleteRule(zoneId, ruleset.id, existingRule.id);
    console.log(`Deleted rule ${existingRule.id} from zone ${config.zone}.`);
    return;
  }

  await setChallengePassage(zoneId, config.ttl);

  if (!ruleset) {
    const created = await createEntryPointRuleset(zoneId, rule);
    const createdRuleId = created?.rules?.find((entry) => entry?.ref === config.ref)?.id ?? "unknown";
    console.log(`Created ruleset ${created.id} with rule ${createdRuleId}.`);
    return;
  }

  if (!existingRule?.id) {
    const created = await createRule(zoneId, ruleset.id, rule);
    console.log(`Created rule ${created.id} in ruleset ${ruleset.id}.`);
    return;
  }

  const updated = await updateRule(zoneId, ruleset.id, existingRule.id, rule);
  console.log(`Updated rule ${existingRule.id} in ruleset ${updated.id}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
