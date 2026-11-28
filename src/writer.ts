/**
 * Writing the chosen form into an SB3 that is already unpacked, in place.
 *
 * This is the Node convenience over `./extension-format`, which holds the one implementation of
 * the conversion and runs in a browser too. This entry rewrites one archive and project document
 * in place, converts every extension to one form, and keeps the synchronous reader older callers
 * use; its synchronous digest is why it imports `node:crypto` and stays out of the root export.
 * It never touches a ZIP: unpacking and re-serialising belong to the caller.
 *
 * Like the shared conversion it has no cache port, so its only byte source for a reference is the
 * network — it can write which form a work records, never the copy a viewer's browser holds.
 */

import {createHash} from 'node:crypto';

import {discoverManifest, isRemoteSource, type ExtensionSpec} from '@kubohiroya/turbowarp-extension-loader';

import {
  convertSb3ExtensionFormats,
  maxExtensionBytes,
  readSb3ExtensionPayloadsUnhashed,
  Sb3ExtensionFormatError,
  sb3PlusExtensionPath,
  type Sb3ExtensionFormatChange,
  type Sb3ExtensionPayload,
} from './extension-format.js';
import {sb3SaveFormatSupport, type Sb3SaveCapabilities, type Sb3SaveFormat} from './index.js';

export {sb3PlusExtensionPath, type Sb3ExtensionPayload};

/** Raised for every refusal here, so a caller can tell this writer's failures apart. */
export class Sb3WriterError extends Error {
  readonly code: string;
  constructor(message: string, options: {code: string; cause?: unknown}) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause});
    this.name = 'Sb3WriterError';
    this.code = options.code;
  }
}

const retainedURL = (spec: ExtensionSpec): string | undefined =>
  'url' in spec.source ? spec.source.url : undefined;

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3WriterError(message, {code, cause});
}

/** The shared conversion's refusals, under this entry's own error class. */
async function asWriterError<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Sb3ExtensionFormatError) fail(error.message, error.code, error);
    throw error;
  }
}

/** Allows callers that also support older writers to detect the opt-in. */
export const supportsRemoteCompatibilityCarriers = true;

/**
 * Read every extension this project carries, whichever form holds it.
 *
 * A Plus Manifest wins over a `data:` carrier for the same ID, because that is the order a Plus
 * host resolves them in. A `data:` URL counts only when its ID is declared in `extensions`: an
 * undeclared leftover is not loaded today, and reading it here would bring it back. The browser
 * equivalent, which hashes asynchronously, is `readSb3Extensions` in `./extension-format`.
 */
export function readSb3ExtensionPayloads(
  archive: Readonly<Record<string, Uint8Array>>,
  project: Readonly<Record<string, unknown>>,
): readonly Sb3ExtensionPayload[] {
  let payloads: readonly Sb3ExtensionPayload[];
  try {
    payloads = readSb3ExtensionPayloadsUnhashed(archive, project);
  } catch (error) {
    if (error instanceof Sb3ExtensionFormatError) fail(error.message, error.code, error);
    throw error;
  }
  return Object.freeze(
    payloads.map((payload) =>
      payload.sha256 !== undefined || !payload.bytes
        ? payload
        : Object.freeze({...payload, sha256: sha256(payload.bytes)}),
    ),
  );
}

export interface Sb3ExtensionFormatOptions {
  /** Required for either reference form unless the project already names the URL. */
  readonly urls?: Readonly<Record<string, string>> | undefined;
  /** Recorded in the Manifest for provenance only; it is never an execution permission. */
  readonly version?: string | undefined;
  /**
   * The only legacy `data:` extensions that may be requested unsandboxed. Which IDs those are is
   * the caller's knowledge: this writer promotes nothing on its own.
   */
  readonly unsandboxed?: readonly string[] | undefined;
  /**
   * What the caller can write. Required, because "writable" is a property of the build doing the
   * writing, not of the vocabulary: the same form is writable from a CLI that can fetch and not
   * from one that cannot. Passing it keeps the refusal, and its reason, with whoever owns it.
   */
  readonly capabilities: Sb3SaveCapabilities;
  /**
   * Also keep the `data:` carrier beside a form that is not already it, so one SB3 loads in both
   * kinds of host. A Plus host does not load it twice: it resolves the Manifest's own carrier.
   */
  readonly keepEmbeddedData?: boolean | undefined;
  /** Explicit IDs for a small standard-host carrier beside a remote Manifest entry. */
  readonly remoteCompatibilityCarriers?: readonly string[] | undefined;
  /** Injected for tests; defaults to the global `fetch`. Used to materialise a reference. */
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface Sb3ExtensionFormatResult {
  readonly converted: readonly string[];
  readonly format: Sb3SaveFormat;
}

/**
 * Rewrite every extension of this project into one form, in place. Running it again on its own
 * output is a no-op, so a rewritten SB3 can be rewritten or rebuilt like any other.
 *
 * All four forms keep the Manifest. `embedded-data` is the one a standard TurboWarp host loads on
 * its own, because it reads `extensionURLs` and knows nothing of the Manifest beside it — but the
 * Manifest still records that the bytes are there, so a Plus host keeps the digest to verify
 * against, the declared execution mode and the dependencies. `keepEmbeddedData` adds that carrier
 * to a form that is not already it, so a Plus host prefers the Manifest's own copy.
 *
 * Going from a reference to a carried form is a fetch of the pinned bytes. The conversion itself
 * is `convertSb3ExtensionFormats`; nothing is written into the archive or the project unless it
 * succeeds for every extension.
 */
export async function writeSb3ExtensionFormat(
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  format: Sb3SaveFormat,
  {
    capabilities,
    urls = {},
    version,
    unsandboxed = [],
    keepEmbeddedData = false,
    remoteCompatibilityCarriers = [],
    fetch: fetchBytes = fetch,
    timeoutMs = 30_000,
  }: Sb3ExtensionFormatOptions,
): Promise<Sb3ExtensionFormatResult> {
  const support = sb3SaveFormatSupport('extensions', format, capabilities);
  if (!support.supported)
    fail(`Cannot save extensions as ${format}: ${support.reason}`, 'K4-EXT-FORMAT-003');
  const payloads = readSb3ExtensionPayloads(archive, project);
  const compatibilityIds = new Set(remoteCompatibilityCarriers);
  if (compatibilityIds.size && (keepEmbeddedData || !['remote-cacheable', 'remote-non-cacheable'].includes(format)))
    fail(
      'Remote compatibility carriers require a remote format and cannot be combined with keepEmbeddedData.',
      'K4-EXT-FORMAT-010',
    );
  for (const id of compatibilityIds) {
    const payload = payloads.find(item => item.id === id);
    if (!payload || (payload.spec ? payload.spec.execution !== 'unsandboxed' : !unsandboxed.includes(id)))
      fail(
        `Remote compatibility carrier ${id} requires an explicitly unsandboxed extension.`,
        'K4-EXT-FORMAT-010',
      );
  }
  if (!payloads.length) return Object.freeze({converted: Object.freeze([]), format});

  // Only the IDs the caller names may be requested unsandboxed: a rewrite never promotes an
  // extension on its own, and an existing Manifest entry keeps the mode it already requested.
  const unsandboxedIds = new Set(unsandboxed);
  const changes: Record<string, Sb3ExtensionFormatChange> = {};
  for (const {id} of payloads)
    changes[id] = {
      format,
      ...(urls[id] === undefined ? {} : {url: urls[id]}),
      ...(version === undefined ? {} : {version}),
      unsandboxed: unsandboxedIds.has(id),
      keepEmbeddedData,
      remoteCompatibilityCarrier: compatibilityIds.has(id),
    };
  const result = await asWriterError(() =>
    convertSb3ExtensionFormats(archive, project, changes, {capabilities, fetch: fetchBytes, timeoutMs}),
  );
  for (const path of Object.keys(archive)) if (!Object.hasOwn(result.archive, path)) delete archive[path];
  Object.assign(archive, result.archive);
  for (const key of Object.keys(project)) if (!Object.hasOwn(result.project, key)) delete project[key];
  Object.assign(project, result.project);
  return Object.freeze({
    converted: Object.freeze(result.changes.map((change) => change.id)),
    format,
  });
}

export interface Sb3ExtensionUrlCheckOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Fetch every URL this project's Manifest names, and refuse the project unless each URL returns
 * exactly the bytes its digest pins.
 *
 * The writer pins the digest of the bytes it has in hand, but a host loads the URL: a URL serving
 * other bytes makes an SB3 that a Plus host rejects with `DIGEST_MISMATCH` (a cached copy only
 * hides that until the host falls back to the URL). Like the Loader, this refuses redirects.
 */
export async function verifySb3ExtensionUrls(
  project: Record<string, unknown>,
  {fetch: fetchBytes = fetch, timeoutMs = 30_000}: Sb3ExtensionUrlCheckOptions = {},
): Promise<readonly string[]> {
  const checked: string[] = [];
  for (const spec of discoverManifest(project)?.extensions ?? []) {
    // Every source that names a URL has one to verify, whichever form it is stored in.
    const url = isRemoteSource(spec.source) ? spec.source.url : retainedURL(spec);
    if (url === undefined) continue;
    let bytes: Uint8Array;
    try {
      const response = await fetchBytes(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      if (length > maxExtensionBytes) throw new Error(`${length} bytes is too large`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxExtensionBytes)
        throw new Error(`${bytes.byteLength} bytes is too large`);
    } catch (error) {
      fail(
        `Could not fetch ${url} for extension ${spec.id}: ${(error as Error).message}. ` +
          'Pass --skip-url-check only if the URL will serve the pinned bytes later.',
        'K4-EXT-FORMAT-008',
        error,
      );
    }
    const actual = sha256(bytes);
    if (actual !== spec.sha256)
      fail(
        `${url} does not serve the bytes extension ${spec.id} pins ` +
          `(expected sha256 ${spec.sha256}, got ${actual}); a Plus host would reject it.`,
        'K4-EXT-FORMAT-009',
      );
    checked.push(spec.id);
  }
  return Object.freeze(checked);
}
