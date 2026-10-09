import { createHash } from "node:crypto";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_RETRY_BASE_DELAY_MS = 500;
const MAX_PORTRAIT_BYTES = 25 * 1024 * 1024;

export type ConvexCharacterReferenceFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ConvexCharacterReferenceStoreOptions {
  convexUrl?: string;
  projectUrl?: string; // Alias for convexUrl for flexibility
  bucket?: string;
  deployKey?: string;
  serviceRoleKey?: string; // Alias for deployKey
  objectPrefix?: string;
  requestTimeoutMs?: number;
  fetch?: ConvexCharacterReferenceFetch;
}

export interface ConvexCharacterReferenceIdentity {
  seriesId: number;
  characterName: string;
}

export interface ConvexCharacterReferenceObject {
  objectKey: string;
  publicUrl: string;
  storageId?: string;
}

export interface DownloadedConvexCharacterReference
  extends ConvexCharacterReferenceObject {
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

type ValidatedStoreOptions = {
  convexUrl: URL;
  bucket: string;
  deployKey?: string;
  objectPrefix: string;
  requestTimeoutMs: number;
  fetch: ConvexCharacterReferenceFetch;
};

export class ConvexCharacterReferenceTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Convex character-reference request timed out after ${timeoutMs}ms.`);
    this.name = "ConvexCharacterReferenceTimeoutError";
  }
}

function positiveSeriesId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("seriesId must be a positive integer.");
  }
  return value;
}

function nonEmptyCharacterName(value: string): string {
  const name = value.replace(/\s+/gu, " ").trim();
  if (!name) throw new Error("characterName must not be empty.");
  return name;
}

/** Stable filename used in both Convex and Agnes identity-map prompts. */
export function canonicalCharacterImageName(characterName: string): string {
  const normalized = nonEmptyCharacterName(characterName)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "unnamed_character";
}

function validateObjectPrefix(value: string | undefined): string {
  const prefix = value?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  if (!prefix) return "";
  const segments = prefix.split("/");
  if (segments.some((segment) => !/^[a-zA-Z0-9._-]+$/u.test(segment))) {
    throw new Error(
      "CONVEX_CHARACTER_REFERENCE_PREFIX may contain only letters, digits, dots, underscores, hyphens, and slashes.",
    );
  }
  return segments.join("/");
}

function validateStoreOptions(
  options: ConvexCharacterReferenceStoreOptions,
  _requireWriteAccess = false,
): ValidatedStoreOptions {
  const rawUrl = (options.convexUrl || options.projectUrl)?.trim();
  if (!rawUrl) throw new Error("CONVEX_URL is required for character references.");
  let convexUrl: URL;
  try {
    convexUrl = new URL(rawUrl);
  } catch {
    throw new Error("CONVEX_URL must be an absolute HTTPS URL.");
  }
  if (
    convexUrl.protocol !== "https:"
    || convexUrl.username
    || convexUrl.password
    || convexUrl.search
    || convexUrl.hash
  ) {
    throw new Error("CONVEX_URL must be a credential-free absolute HTTPS URL without a query or fragment.");
  }
  convexUrl.pathname = convexUrl.pathname.replace(/\/+$/gu, "");

  const bucket = options.bucket?.trim() ?? "";
  if (!bucket || !/^[a-zA-Z0-9._-]+$/u.test(bucket)) {
    throw new Error(
      "CONVEX_STORAGE_BUCKET is required and may contain only letters, digits, dots, underscores, and hyphens.",
    );
  }
  const deployKey = (options.deployKey || options.serviceRoleKey)?.trim();
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Convex character-reference requestTimeoutMs must be a positive integer.");
  }

  return {
    convexUrl,
    bucket,
    ...(deployKey ? { deployKey } : {}),
    objectPrefix: validateObjectPrefix(options.objectPrefix),
    requestTimeoutMs,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

export function buildConvexCharacterReferenceObjectKey(
  identity: ConvexCharacterReferenceIdentity,
  objectPrefix = "",
): string {
  const seriesId = positiveSeriesId(identity.seriesId);
  const characterName = canonicalCharacterImageName(identity.characterName);
  return [
    validateObjectPrefix(objectPrefix),
    `series_${seriesId}`,
    "characters",
    `${characterName}.png`,
  ].filter(Boolean).join("/");
}

async function fetchWithTimeout(
  options: ValidatedStoreOptions,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutError = new ConvexCharacterReferenceTimeoutError(
      options.requestTimeoutMs,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.fetch(input, { ...init, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(timeoutError);
          }, options.requestTimeoutMs);
        }),
      ]);
    } catch (error) {
      lastError = error instanceof ConvexCharacterReferenceTimeoutError || controller.signal.aborted
        ? timeoutError
        : error;
      const reason = describeTransportError(lastError);
      if (isRetryableTransportError(lastError) && attempt < MAX_TRANSPORT_ATTEMPTS) {
        const retryDelayMs = TRANSPORT_RETRY_BASE_DELAY_MS * attempt;
        console.warn("[ConvexCharacterReference] transport_retry", {
          method: init.method ?? "GET",
          attempt,
          nextAttempt: attempt + 1,
          retryDelayMs,
          reason,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new Error(
        `Convex character-reference request failed${attempt > 1 ? ` after ${attempt} attempts` : ""}: ${reason}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw new Error(
    `Convex character-reference request failed: ${describeTransportError(lastError)}`,
  );
}

function describeTransportError(error: unknown): string {
  const primary = error instanceof Error ? error.message : String(error);
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  if (!cause || typeof cause !== "object") return primary;
  const causeMessage = "message" in cause ? String(cause.message) : "";
  const causeCode = "code" in cause ? String(cause.code) : "";
  const detail = [causeCode, causeMessage].filter(Boolean).join(": ");
  return detail && detail !== primary ? `${primary} (${detail})` : primary;
}

function transportErrorCode(error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  return cause && typeof cause === "object" && "code" in cause
    ? String(cause.code)
    : "";
}

function isRetryableTransportError(error: unknown): boolean {
  return !new Set([
    "UND_ERR_INVALID_ARG",
    "ERR_INVALID_ARG_TYPE",
    "ERR_INVALID_ARG_VALUE",
  ]).has(transportErrorCode(error));
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/gu, " ").trim().slice(0, 400);
  } catch {
    return "";
  }
}

function validateImageContentType(response: Response): string {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Convex character reference returned unexpected Content-Type ${contentType || "<missing>"}.`,
    );
  }
  return contentType;
}

function formatAuthHeader(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("Bearer ") || trimmed.startsWith("Convex ")) {
    return trimmed;
  }
  if (trimmed.startsWith("dev:") || trimmed.startsWith("prod:") || trimmed.includes("|")) {
    return `Convex ${trimmed}`;
  }
  return `Bearer ${trimmed}`;
}

/**
 * Executes a Convex mutation via the Convex Functions HTTP API.
 */
async function callConvexMutation<T>(
  options: ValidatedStoreOptions,
  path: string,
  args: Record<string, unknown>,
): Promise<T> {
  const root = options.convexUrl.toString().replace(/\/+$/gu, "");
  const mutationUrl = `${root}/api/mutation`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.deployKey) {
    headers.authorization = formatAuthHeader(options.deployKey);
  }

  const response = await fetchWithTimeout(options, mutationUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      path,
      args,
      format: "json",
    }),
  });

  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new Error(
      `Convex mutation ${path} failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }

  const result = await response.json() as {
    status?: string;
    value?: T;
    errorMessage?: string;
  };
  if (result.status === "error") {
    throw new Error(`Convex mutation ${path} error: ${result.errorMessage || "Unknown error"}`);
  }
  return result.value as T;
}

/**
 * Executes a Convex query via the Convex Functions HTTP API.
 */
async function callConvexQuery<T>(
  options: ValidatedStoreOptions,
  path: string,
  args: Record<string, unknown>,
): Promise<T> {
  const root = options.convexUrl.toString().replace(/\/+$/gu, "");
  const queryUrl = `${root}/api/query`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.deployKey) {
    headers.authorization = formatAuthHeader(options.deployKey);
  }

  const response = await fetchWithTimeout(options, queryUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      path,
      args,
      format: "json",
    }),
  });

  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new Error(
      `Convex query ${path} failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }

  const result = await response.json() as {
    status?: string;
    value?: T;
    errorMessage?: string;
  };
  if (result.status === "error") {
    throw new Error(`Convex query ${path} error: ${result.errorMessage || "Unknown error"}`);
  }
  return result.value as T;
}

interface StoredFileRecord {
  storageId: string;
  bucket: string;
  path: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256?: string;
  url?: string;
  metadata?: unknown;
}

/**
 * Reads the deterministic public object from Convex file storage using the database index.
 * A missing database entry or missing storage object returns null.
 */
export async function downloadConvexCharacterReference(
  identity: ConvexCharacterReferenceIdentity,
  storeOptions: ConvexCharacterReferenceStoreOptions,
  fetchOptions?: { cacheBust?: boolean },
): Promise<DownloadedConvexCharacterReference | null> {
  const options = validateStoreOptions(storeOptions, false);
  const objectKey = buildConvexCharacterReferenceObjectKey(
    identity,
    options.objectPrefix,
  );

  const fileRecord = await callConvexQuery<StoredFileRecord | null>(
    options,
    "files:getFile",
    {
      bucket: options.bucket,
      path: objectKey,
    },
  );

  if (!fileRecord || !fileRecord.url) {
    return null;
  }

  const fetchUrl = fetchOptions?.cacheBust
    ? `${fileRecord.url}${fileRecord.url.includes("?") ? "&" : "?"}t=${Date.now()}`
    : fileRecord.url;

  const response = await fetchWithTimeout(options, fetchUrl, {
    method: "GET",
    headers: {
      accept: "image/*",
      ...(fetchOptions?.cacheBust ? { "cache-control": "no-cache", pragma: "no-cache" } : {}),
    },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    const detail = await safeResponseText(response);
    throw new Error(
      `Cannot read public Convex character reference (HTTP ${response.status})` +
      `${detail ? `: ${detail}` : "."}`,
    );
  }

  const contentType = validateImageContentType(response);
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PORTRAIT_BYTES) {
    throw new Error(`Convex character reference exceeds ${MAX_PORTRAIT_BYTES} bytes.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_PORTRAIT_BYTES) {
    throw new Error(
      `Convex character reference must contain 1-${MAX_PORTRAIT_BYTES} bytes; received ${bytes.length}.`,
    );
  }

  return {
    objectKey,
    publicUrl: fileRecord.url,
    storageId: fileRecord.storageId,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

/**
 * Uploads one PNG to Convex File Storage, indexes it in the Convex database
 * under its virtual path and bucket, and verifies public accessibility.
 */
export async function uploadConvexCharacterReference(
  identity: ConvexCharacterReferenceIdentity,
  bytes: Buffer,
  storeOptions: ConvexCharacterReferenceStoreOptions,
): Promise<DownloadedConvexCharacterReference> {
  if (bytes.length < 1 || bytes.length > MAX_PORTRAIT_BYTES) {
    throw new Error(
      `Character portrait must contain 1-${MAX_PORTRAIT_BYTES} bytes; received ${bytes.length}.`,
    );
  }

  const options = validateStoreOptions(storeOptions, true);
  const objectKey = buildConvexCharacterReferenceObjectKey(
    identity,
    options.objectPrefix,
  );
  const canonicalName = canonicalCharacterImageName(identity.characterName);
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

  // Step 1: Generate Convex upload URL
  const uploadUrl = await callConvexMutation<string>(
    options,
    "files:generateUploadUrl",
    {},
  );
  if (!uploadUrl) {
    throw new Error("Convex did not return an upload URL.");
  }

  // Step 2: Upload raw file bytes to Convex upload URL
  const uploadResponse = await fetchWithTimeout(options, uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "image/png",
    },
    body: bytes,
  });

  if (!uploadResponse.ok) {
    const detail = await safeResponseText(uploadResponse);
    throw new Error(
      `Failed to upload portrait bytes to Convex (HTTP ${uploadResponse.status})${detail ? `: ${detail}` : "."}`,
    );
  }

  const uploadResult = await uploadResponse.json() as { storageId?: string };
  const storageId = uploadResult.storageId;
  if (!storageId) {
    throw new Error("Convex upload succeeded but no storageId was returned.");
  }

  // Step 3: Save metadata & virtual path in Convex database
  const savedRecord = await callConvexMutation<StoredFileRecord>(
    options,
    "files:saveFile",
    {
      storageId,
      bucket: options.bucket,
      path: objectKey,
      fileName: `${canonicalName}.png`,
      contentType: "image/png",
      size: bytes.length,
      sha256: expectedSha256,
      metadata: {
        seriesId: identity.seriesId,
        characterName: identity.characterName,
      },
    },
  );

  if (!savedRecord || !savedRecord.url) {
    throw new Error("Convex saved file record did not include a public serve URL.");
  }

  // Step 4: Verify public read & integrity
  const downloaded = await downloadConvexCharacterReference(identity, storeOptions, { cacheBust: true });
  if (!downloaded) {
    throw new Error("Convex accepted the portrait upload but its public URL returned 404.");
  }
  if (downloaded.sha256 !== expectedSha256) {
    throw new Error(
      "Convex public character portrait does not match the uploaded bytes; refusing to bind Agnes to stale CDN content.",
    );
  }

  return downloaded;
}

/**
 * Deletes canonical portrait objects and database records owned by one completed series.
 */
export async function deleteConvexSeriesCharacterReferences(
  params: { seriesId: number; characterNames: readonly string[] },
  storeOptions: ConvexCharacterReferenceStoreOptions,
): Promise<{ deletedObjectKeys: string[] }> {
  positiveSeriesId(params.seriesId);
  const names = [...new Set(params.characterNames.map(nonEmptyCharacterName))];
  if (names.length > 5) {
    throw new Error("A series may have at most 5 main-character references.");
  }
  const options = validateStoreOptions(storeOptions, true);
  const deletedObjectKeys: string[] = [];

  for (const characterName of names) {
    const objectKey = buildConvexCharacterReferenceObjectKey(
      { seriesId: params.seriesId, characterName },
      options.objectPrefix,
    );
    try {
      await callConvexMutation<{ deleted: boolean }>(
        options,
        "files:deleteFile",
        {
          bucket: options.bucket,
          path: objectKey,
        },
      );
      deletedObjectKeys.push(objectKey);
    } catch (err) {
      console.warn(`[ConvexCharacterReference] Could not delete ${objectKey}:`, err);
    }
  }

  return { deletedObjectKeys };
}
