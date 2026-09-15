import { createHash } from "node:crypto";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_RETRY_BASE_DELAY_MS = 500;
const MAX_PORTRAIT_BYTES = 25 * 1024 * 1024;

export type SupabaseCharacterReferenceFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SupabaseCharacterReferenceStoreOptions {
  projectUrl?: string;
  bucket?: string;
  serviceRoleKey?: string;
  objectPrefix?: string;
  requestTimeoutMs?: number;
  fetch?: SupabaseCharacterReferenceFetch;
}

export interface SupabaseCharacterReferenceIdentity {
  seriesId: number;
  characterName: string;
}

export interface SupabaseCharacterReferenceObject {
  objectKey: string;
  publicUrl: string;
}

export interface DownloadedSupabaseCharacterReference
  extends SupabaseCharacterReferenceObject {
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

type ValidatedStoreOptions = {
  projectUrl: URL;
  bucket: string;
  serviceRoleKey?: string;
  objectPrefix: string;
  requestTimeoutMs: number;
  fetch: SupabaseCharacterReferenceFetch;
};

class SupabaseCharacterReferenceTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Supabase character-reference request timed out after ${timeoutMs}ms.`);
    this.name = "SupabaseCharacterReferenceTimeoutError";
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

/** Stable filename used in both Supabase and Agnes identity-map prompts. */
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
      "SUPABASE_CHARACTER_REFERENCE_PREFIX may contain only letters, digits, dots, underscores, hyphens, and slashes.",
    );
  }
  return segments.join("/");
}

function validateStoreOptions(
  options: SupabaseCharacterReferenceStoreOptions,
  requireWriteAccess: boolean,
): ValidatedStoreOptions {
  const rawProjectUrl = options.projectUrl?.trim();
  if (!rawProjectUrl) throw new Error("SUPABASE_URL is required for character references.");
  let projectUrl: URL;
  try {
    projectUrl = new URL(rawProjectUrl);
  } catch {
    throw new Error("SUPABASE_URL must be an absolute HTTPS URL.");
  }
  if (
    projectUrl.protocol !== "https:"
    || projectUrl.username
    || projectUrl.password
    || projectUrl.search
    || projectUrl.hash
  ) {
    throw new Error("SUPABASE_URL must be a credential-free absolute HTTPS URL without a query or fragment.");
  }
  projectUrl.pathname = projectUrl.pathname.replace(/\/+$/gu, "");

  const bucket = options.bucket?.trim() ?? "";
  if (!bucket || !/^[a-zA-Z0-9._-]+$/u.test(bucket)) {
    throw new Error(
      "SUPABASE_STORAGE_BUCKET is required and may contain only letters, digits, dots, underscores, and hyphens.",
    );
  }
  const serviceRoleKey = options.serviceRoleKey?.trim();
  if (requireWriteAccess && !serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to upload or delete character references.");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Supabase character-reference requestTimeoutMs must be a positive integer.");
  }

  return {
    projectUrl,
    bucket,
    ...(serviceRoleKey ? { serviceRoleKey } : {}),
    objectPrefix: validateObjectPrefix(options.objectPrefix),
    requestTimeoutMs,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

function encodedPath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildSupabaseCharacterReferenceObjectKey(
  identity: SupabaseCharacterReferenceIdentity,
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

function resolveObject(
  identity: SupabaseCharacterReferenceIdentity,
  options: ValidatedStoreOptions,
): SupabaseCharacterReferenceObject {
  const objectKey = buildSupabaseCharacterReferenceObjectKey(
    identity,
    options.objectPrefix,
  );
  const root = options.projectUrl.toString().replace(/\/+$/gu, "");
  return {
    objectKey,
    publicUrl:
      `${root}/storage/v1/object/public/${encodeURIComponent(options.bucket)}/${encodedPath(objectKey)}`,
  };
}

async function fetchWithTimeout(
  options: ValidatedStoreOptions,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutError = new SupabaseCharacterReferenceTimeoutError(
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
      lastError = error instanceof SupabaseCharacterReferenceTimeoutError || controller.signal.aborted
        ? timeoutError
        : error;
      const reason = describeTransportError(lastError);
      if (isRetryableTransportError(lastError) && attempt < MAX_TRANSPORT_ATTEMPTS) {
        const retryDelayMs = TRANSPORT_RETRY_BASE_DELAY_MS * attempt;
        console.warn("[SupabaseCharacterReference] transport_retry", {
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
        `Supabase character-reference request failed${attempt > 1 ? ` after ${attempt} attempts` : ""}: ${reason}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw new Error(
    `Supabase character-reference request failed: ${describeTransportError(lastError)}`,
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

/**
 * Supabase Storage normally uses HTTP 404 for a missing public object, but its
 * S3-compatible error path can return HTTP 400 while the JSON payload still
 * identifies the condition as a 404/NoSuchKey. Keep this deliberately narrow:
 * policy, authentication, missing-bucket, and other 4xx responses must remain
 * hard failures.
 */
function isMissingObjectResponse(status: number, detail: string): boolean {
  if (status === 404) return true;
  if (status !== 400 || !detail) return false;

  try {
    const payload = JSON.parse(detail) as Record<string, unknown>;
    const embeddedStatus = String(payload.statusCode ?? "").trim();
    const code = String(payload.code ?? "").trim().toLocaleLowerCase();
    const error = String(payload.error ?? "").trim().toLocaleLowerCase();
    const message = String(payload.message ?? "").trim().toLocaleLowerCase();

    return code === "nosuchkey"
      || (
        embeddedStatus === "404"
        && error === "not_found"
        && message.includes("object not found")
      );
  } catch {
    return false;
  }
}

function validateImageContentType(response: Response): string {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Supabase character reference returned unexpected Content-Type ${contentType || "<missing>"}.`,
    );
  }
  return contentType;
}

/**
 * Reads the deterministic anonymous public object. A definite missing-object
 * response means the portrait is absent; authentication, bucket-policy,
 * missing-bucket, network, and 5xx failures remain hard errors so a transient
 * lookup can never create a second character identity.
 */
export async function downloadSupabaseCharacterReference(
  identity: SupabaseCharacterReferenceIdentity,
  storeOptions: SupabaseCharacterReferenceStoreOptions,
): Promise<DownloadedSupabaseCharacterReference | null> {
  const options = validateStoreOptions(storeOptions, false);
  const object = resolveObject(identity, options);
  const response = await fetchWithTimeout(options, object.publicUrl, {
    method: "GET",
    headers: { accept: "image/*" },
  });
  if (!response.ok) {
    const detail = await safeResponseText(response);
    if (isMissingObjectResponse(response.status, detail)) return null;
    throw new Error(
      `Cannot read public Supabase character reference (HTTP ${response.status})` +
      `${detail ? `: ${detail}` : "."} Confirm that the configured bucket is public.`,
    );
  }
  const contentType = validateImageContentType(response);
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PORTRAIT_BYTES) {
    throw new Error(`Supabase character reference exceeds ${MAX_PORTRAIT_BYTES} bytes.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_PORTRAIT_BYTES) {
    throw new Error(
      `Supabase character reference must contain 1-${MAX_PORTRAIT_BYTES} bytes; received ${bytes.length}.`,
    );
  }
  return {
    ...object,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

/** Uploads one PNG to its stable, human-readable object name and verifies public access. */
export async function uploadSupabaseCharacterReference(
  identity: SupabaseCharacterReferenceIdentity,
  bytes: Buffer,
  storeOptions: SupabaseCharacterReferenceStoreOptions,
): Promise<DownloadedSupabaseCharacterReference> {
  if (bytes.length < 1 || bytes.length > MAX_PORTRAIT_BYTES) {
    throw new Error(
      `Character portrait must contain 1-${MAX_PORTRAIT_BYTES} bytes; received ${bytes.length}.`,
    );
  }
  const options = validateStoreOptions(storeOptions, true);
  const object = resolveObject(identity, options);
  const root = options.projectUrl.toString().replace(/\/+$/gu, "");
  const uploadUrl =
    `${root}/storage/v1/object/${encodeURIComponent(options.bucket)}/${encodedPath(object.objectKey)}`;
  const response = await fetchWithTimeout(options, uploadUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      apikey: options.serviceRoleKey!,
      authorization: `Bearer ${options.serviceRoleKey!}`,
      "cache-control": "3600",
      "content-type": "image/png",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new Error(
      `Failed to upload Supabase character reference (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  if (response.body) {
    try { await response.body.cancel(); } catch { /* best effort */ }
  }

  const downloaded = await downloadSupabaseCharacterReference(identity, storeOptions);
  if (!downloaded) {
    throw new Error("Supabase accepted the portrait upload but its public URL still returns 404.");
  }
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (downloaded.sha256 !== expectedSha256) {
    throw new Error(
      "Supabase public character portrait does not match the uploaded bytes; refusing to bind Agnes to stale CDN content.",
    );
  }
  return downloaded;
}

/** Deletes only the exact <=5 canonical portrait objects owned by one completed series. */
export async function deleteSupabaseSeriesCharacterReferences(
  params: { seriesId: number; characterNames: readonly string[] },
  storeOptions: SupabaseCharacterReferenceStoreOptions,
): Promise<{ deletedObjectKeys: string[] }> {
  positiveSeriesId(params.seriesId);
  const names = [...new Set(params.characterNames.map(nonEmptyCharacterName))];
  if (names.length > 5) {
    throw new Error("A series may have at most 5 main-character references.");
  }
  const options = validateStoreOptions(storeOptions, true);
  const deletedObjectKeys = names.map((characterName) =>
    buildSupabaseCharacterReferenceObjectKey(
      { seriesId: params.seriesId, characterName },
      options.objectPrefix,
    )
  );
  if (deletedObjectKeys.length === 0) return { deletedObjectKeys };

  const root = options.projectUrl.toString().replace(/\/+$/gu, "");
  const response = await fetchWithTimeout(
    options,
    `${root}/storage/v1/object/${encodeURIComponent(options.bucket)}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/json",
        apikey: options.serviceRoleKey!,
        authorization: `Bearer ${options.serviceRoleKey!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prefixes: deletedObjectKeys }),
    },
  );
  if (!response.ok && response.status !== 404) {
    const detail = await safeResponseText(response);
    throw new Error(
      `Failed to delete Supabase series character references (HTTP ${response.status})` +
      `${detail ? `: ${detail}` : "."}`,
    );
  }
  if (response.body) {
    try { await response.body.cancel(); } catch { /* best effort */ }
  }
  return { deletedObjectKeys };
}
