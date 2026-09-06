import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const IMAGE_CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const IMAGE_EXTENSIONS_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export type AgnesReferenceImageFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Upload configuration is intentionally provider-neutral. The caller can point
 * uploadBaseUrl at any object gateway that accepts an HTTP PUT and publicBaseUrl
 * at the stable, HTTPS read origin for the same object key.
 */
export interface AgnesReferenceImagePublisherOptions {
  uploadBaseUrl?: string;
  publicBaseUrl?: string;
  bearerToken?: string;
  requestTimeoutMs?: number;
  fetch?: AgnesReferenceImageFetch;
}

export interface PublishAgnesReferenceImageParams {
  /** An existing public HTTPS URL or a path to a local image file. */
  source: string;
  seriesId: number;
  episodeNumber: number;
  sceneNumber: number;
  /** Optional override; otherwise inferred from the local file extension. */
  contentType?: string;
}

interface ResolvedLocalImage {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

class PublisherTimeoutError extends Error {
  constructor(
    readonly operation: "upload" | "public URL verification",
    readonly timeoutMs: number,
  ) {
    super(`Agnes reference image ${operation} timed out after ${timeoutMs}ms`);
    this.name = "PublisherTimeoutError";
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("requestTimeoutMs must be a positive integer.");
  }
  return timeout;
}

function normalizedImageContentType(value: string): string {
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_EXTENSIONS_BY_CONTENT_TYPE[contentType]) {
    throw new Error(
      `Unsupported Agnes reference image content type: ${value}. ` +
      `Supported values are ${Object.keys(IMAGE_EXTENSIONS_BY_CONTENT_TYPE).join(", ")}.`,
    );
  }
  return contentType;
}

function imageTypeForLocalPath(filePath: string, override?: string): {
  contentType: string;
  extension: string;
} {
  if (override !== undefined) {
    const contentType = normalizedImageContentType(override);
    return {
      contentType,
      extension: IMAGE_EXTENSIONS_BY_CONTENT_TYPE[contentType]!,
    };
  }

  const sourceExtension = path.extname(filePath).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES_BY_EXTENSION[sourceExtension];
  if (!contentType) {
    throw new Error(
      `Cannot infer the Agnes reference image content type from ${sourceExtension || "a file without an extension"}. ` +
      "Pass contentType explicitly.",
    );
  }
  return {
    contentType,
    extension: IMAGE_EXTENSIONS_BY_CONTENT_TYPE[contentType]!,
  };
}

function parseRemoteSource(source: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return undefined;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
  throw new Error(
    `Agnes reference image source URLs must use HTTPS; ${parsed.protocol || "unknown:"} is not supported.`,
  );
}

function publicHttpsPassthrough(source: string, parsed: URL): string {
  if (parsed.protocol !== "https:") {
    throw new Error(
      "Agnes requires a publicly reachable HTTPS reference image URL; " +
      "an HTTP URL cannot be passed through safely.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Agnes reference image URLs must not contain embedded credentials.");
  }
  return source;
}

function validatedBaseUrl(
  value: string | undefined,
  name: "uploadBaseUrl" | "publicBaseUrl",
): URL {
  if (!value?.trim()) {
    throw new Error(`${name} is required to publish a local Agnes reference image.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL.`);
  }

  const allowedProtocol = name === "publicBaseUrl"
    ? parsed.protocol === "https:"
    : parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!allowedProtocol) {
    throw new Error(
      name === "publicBaseUrl"
        ? "publicBaseUrl must use HTTPS because Agnes fetches the published image remotely."
        : "uploadBaseUrl must use HTTP or HTTPS.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment.`);
  }
  return parsed;
}

function appendObjectKey(base: URL, objectKey: string): URL {
  const result = new URL(base.toString());
  const basePath = result.pathname.replace(/\/+$/, "");
  const encodedKey = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  result.pathname = `${basePath}/${encodedKey}`;
  return result;
}

/** Stable key shared by the PUT destination and public read URL. */
export function buildAgnesReferenceImageObjectKey(params: {
  seriesId: number;
  episodeNumber: number;
  sceneNumber: number;
  sha256: string;
  extension?: string;
}): string {
  const seriesId = positiveInteger("seriesId", params.seriesId);
  const episodeNumber = positiveInteger("episodeNumber", params.episodeNumber);
  const sceneNumber = positiveInteger("sceneNumber", params.sceneNumber);
  const extension = (params.extension ?? ".png").trim().toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(extension)) {
    throw new Error("extension must begin with a dot and contain only letters or digits.");
  }
  const sha256 = params.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("sha256 must be a 64-character hexadecimal SHA-256 digest.");
  }

  return [
    `series_${seriesId}`,
    `episode_${episodeNumber}`,
    "scenes",
    `scene_${String(sceneNumber).padStart(3, "0")}_${sha256}${extension}`,
  ].join("/");
}

async function readValidatedLocalImage(
  source: string,
  contentTypeOverride?: string,
): Promise<ResolvedLocalImage> {
  const filePath = path.resolve(source);
  let details;
  try {
    details = await stat(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agnes reference image does not exist or is not accessible: ${filePath}. ${message}`);
  }
  if (!details.isFile()) {
    throw new Error(`Agnes reference image must be a file: ${filePath}.`);
  }
  if (details.size <= 0) {
    throw new Error(`Agnes reference image file is empty: ${filePath}.`);
  }

  const imageType = imageTypeForLocalPath(filePath, contentTypeOverride);
  const bytes = await readFile(filePath);
  if (bytes.length === 0) {
    throw new Error(`Agnes reference image file is empty: ${filePath}.`);
  }
  return { bytes, ...imageType };
}

function redactPublisherSecrets(value: unknown, secrets: readonly string[] = []): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text.replace(/(bearer\s+)[^\s,"'}]+/gi, "$1[redacted]");
}

async function readErrorBody(
  response: Response,
  secrets: readonly string[] = [],
): Promise<string> {
  try {
    return redactPublisherSecrets(await response.text(), secrets)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  } catch {
    return "";
  }
}

async function fetchWithTimeout(params: {
  fetch: AgnesReferenceImageFetch;
  input: string | URL;
  init: RequestInit;
  timeoutMs: number;
  operation: "upload" | "public URL verification";
  secrets?: readonly string[];
}): Promise<Response> {
  const controller = new AbortController();
  const timeoutError = new PublisherTimeoutError(params.operation, params.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = params.fetch(params.input, {
    ...params.init,
    signal: controller.signal,
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, params.timeoutMs);
  });

  try {
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof PublisherTimeoutError || controller.signal.aborted) {
      throw timeoutError;
    }
    const message = redactPublisherSecrets(error, params.secrets);
    throw new Error(`Agnes reference image ${params.operation} failed: ${message}`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validatePublicImageResponse(response: Response): string | undefined {
  if (!response.ok) return `HTTP ${response.status}`;

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && !contentType.startsWith("image/")) {
    return `unexpected Content-Type ${contentType}`;
  }
  if (response.headers.get("content-length")?.trim() === "0") {
    return "the public object is empty";
  }
  return undefined;
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The response headers are enough for verification; cancellation is best effort.
  }
}

async function verifyPublicImageUrl(params: {
  fetch: AgnesReferenceImageFetch;
  publicUrl: URL;
  timeoutMs: number;
}): Promise<void> {
  const headResponse = await fetchWithTimeout({
    fetch: params.fetch,
    input: params.publicUrl,
    init: {
      method: "HEAD",
      headers: { accept: "image/*" },
    },
    timeoutMs: params.timeoutMs,
    operation: "public URL verification",
  });
  const headFailure = validatePublicImageResponse(headResponse);
  await discardResponseBody(headResponse);
  if (!headFailure) return;

  // Some otherwise-public object gateways reject HEAD. A one-byte anonymous
  // GET verifies the exact URL without downloading the whole image.
  const getResponse = await fetchWithTimeout({
    fetch: params.fetch,
    input: params.publicUrl,
    init: {
      method: "GET",
      headers: {
        accept: "image/*",
        range: "bytes=0-0",
      },
    },
    timeoutMs: params.timeoutMs,
    operation: "public URL verification",
  });
  const getFailure = validatePublicImageResponse(getResponse);
  await discardResponseBody(getResponse);
  if (getFailure) {
    throw new Error(
      `Published Agnes reference image is not anonymously readable at ${params.publicUrl.toString()} ` +
      `(HEAD: ${headFailure}; GET: ${getFailure}).`,
    );
  }
}

/**
 * Resolves an Agnes-compatible image reference. Existing HTTPS URLs are
 * returned unchanged. Local files are PUT under a content-addressed object key,
 * then the corresponding stable HTTPS read URL is checked anonymously before
 * it is returned.
 */
export async function publishAgnesReferenceImage(
  params: PublishAgnesReferenceImageParams,
  options: AgnesReferenceImagePublisherOptions = {},
): Promise<string> {
  const source = params.source.trim();
  if (!source) throw new Error("Agnes reference image source must not be empty.");

  const remote = parseRemoteSource(source);
  if (remote) return publicHttpsPassthrough(source, remote);

  const uploadBaseUrl = validatedBaseUrl(options.uploadBaseUrl, "uploadBaseUrl");
  const publicBaseUrl = validatedBaseUrl(options.publicBaseUrl, "publicBaseUrl");
  const timeoutMs = positiveTimeout(options.requestTimeoutMs);
  const localImage = await readValidatedLocalImage(source, params.contentType);
  const objectKey = buildAgnesReferenceImageObjectKey({
    seriesId: params.seriesId,
    episodeNumber: params.episodeNumber,
    sceneNumber: params.sceneNumber,
    sha256: createHash("sha256").update(localImage.bytes).digest("hex"),
    extension: localImage.extension,
  });
  const uploadUrl = appendObjectKey(uploadBaseUrl, objectKey);
  const publicUrl = appendObjectKey(publicBaseUrl, objectKey);

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": localImage.contentType,
    "content-length": String(localImage.bytes.length),
  };
  const token = options.bearerToken?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchWithTimeout({
    fetch: fetchImpl,
    input: uploadUrl,
    init: {
      method: "PUT",
      headers,
      body: localImage.bytes,
    },
    timeoutMs,
    operation: "upload",
    secrets: token ? [token] : [],
  });

  if (!response.ok) {
    const body = await readErrorBody(response, token ? [token] : []);
    throw new Error(
      `Failed to publish Agnes reference image (HTTP ${response.status})${body ? `: ${body}` : "."}`,
    );
  }

  await discardResponseBody(response);
  await verifyPublicImageUrl({ fetch: fetchImpl, publicUrl, timeoutMs });
  return publicUrl.toString();
}
