import { agnesKeyLabel, fingerprintAgnesKey } from "./keys.js";

const INDEXED_API_KEY = /^AGNES_API_KEY_(\d+)$/;
const INDEXED_ACCOUNT_ID = /^AGNES_ACCOUNT_ID_(\d+)$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type AgnesEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Configuration for one independently rate-limited Agnes account lane.
 *
 * This object contains the plaintext API secret. Do not log or persist it;
 * persist accountId/keyLabel/keyFingerprint when durable identity is needed.
 */
export interface AgnesAccountConfig {
  accountId: string;
  apiKey: string;
  keyLabel: string;
  keyFingerprint: string;
}

interface IndexedValue {
  envName: string;
  value: string;
}

function indexedValues(
  env: AgnesEnvironment,
  matcher: RegExp,
  kind: "API key" | "account ID",
): Map<number, IndexedValue> {
  const values = new Map<number, IndexedValue>();
  for (const [envName, rawValue] of Object.entries(env)) {
    const match = matcher.exec(envName);
    if (!match || rawValue === undefined) continue;

    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1 || String(index) !== match[1]) {
      throw new Error(`${envName} must use a canonical positive integer suffix`);
    }
    if (values.has(index)) {
      throw new Error(`Multiple Agnes ${kind} variables target account lane ${index}`);
    }
    values.set(index, { envName, value: rawValue });
  }
  return values;
}

function optionalApiKey(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  return value || undefined;
}

function optionalAccountId(rawValue: string | undefined, envName: string): string | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim();
  if (!value) {
    throw new Error(`${envName} must not be empty`);
  }
  if (!ACCOUNT_ID.test(value)) {
    throw new Error(
      `${envName} must be 1-64 characters using only letters, numbers, dot, underscore, or hyphen`,
    );
  }
  return value;
}

function resolvePrimaryAlias(
  kind: "API key" | "account ID",
  unsuffixed: string | undefined,
  suffixed: string | undefined,
): string | undefined {
  if (unsuffixed !== undefined && suffixed !== undefined && unsuffixed !== suffixed) {
    throw new Error(`Conflicting unsuffixed and _1 Agnes ${kind} values`);
  }
  return unsuffixed ?? suffixed;
}

/**
 * Parse Agnes credentials as stable, separately rate-limited account lanes.
 * AGNES_API_KEY and AGNES_ACCOUNT_ID are aliases for their respective _1 vars.
 */
export function loadAgnesAccounts(
  env: AgnesEnvironment = process.env,
): AgnesAccountConfig[] {
  const indexedKeys = indexedValues(env, INDEXED_API_KEY, "API key");
  const indexedIds = indexedValues(env, INDEXED_ACCOUNT_ID, "account ID");

  const primaryKey = resolvePrimaryAlias(
    "API key",
    optionalApiKey(env.AGNES_API_KEY),
    optionalApiKey(indexedKeys.get(1)?.value),
  );
  const primaryId = resolvePrimaryAlias(
    "account ID",
    optionalAccountId(env.AGNES_ACCOUNT_ID, "AGNES_ACCOUNT_ID"),
    optionalAccountId(indexedIds.get(1)?.value, "AGNES_ACCOUNT_ID_1"),
  );

  const laneIndexes = new Set<number>([...indexedKeys.keys(), ...indexedIds.keys()]);
  if (primaryKey !== undefined || primaryId !== undefined) laneIndexes.add(1);

  const accounts: AgnesAccountConfig[] = [];
  const seenKeys = new Map<string, number>();
  const seenIds = new Map<string, number>();

  for (const laneIndex of [...laneIndexes].sort((left, right) => left - right)) {
    const apiKey = laneIndex === 1
      ? primaryKey
      : optionalApiKey(indexedKeys.get(laneIndex)?.value);
    const configuredId = laneIndex === 1
      ? primaryId
      : optionalAccountId(
        indexedIds.get(laneIndex)?.value,
        indexedIds.get(laneIndex)?.envName ?? `AGNES_ACCOUNT_ID_${laneIndex}`,
      );

    if (!apiKey) {
      if (configuredId !== undefined) {
        throw new Error(
          `Agnes account ID for lane ${laneIndex} has no matching AGNES_API_KEY${laneIndex === 1 ? " or AGNES_API_KEY_1" : `_${laneIndex}`}`,
        );
      }
      continue;
    }

    const duplicateKeyLane = seenKeys.get(apiKey);
    if (duplicateKeyLane !== undefined) {
      throw new Error(
        `Duplicate Agnes API key configured for account lanes ${duplicateKeyLane} and ${laneIndex}`,
      );
    }

    const accountId = configuredId ?? `account-${laneIndex}`;
    const duplicateIdLane = seenIds.get(accountId);
    if (duplicateIdLane !== undefined) {
      throw new Error(
        `Duplicate Agnes account ID "${accountId}" configured for lanes ${duplicateIdLane} and ${laneIndex}`,
      );
    }

    seenKeys.set(apiKey, laneIndex);
    seenIds.set(accountId, laneIndex);
    accounts.push({
      accountId,
      apiKey,
      keyLabel: agnesKeyLabel(laneIndex - 1),
      keyFingerprint: fingerprintAgnesKey(apiKey),
    });
  }

  return accounts;
}
