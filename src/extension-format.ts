// SPDX-License-Identifier: MPL-2.0
/**
 * Changing the stored form of chosen extensions, in any host.
 *
 * This is the one implementation of the conversion. It runs in a browser and in Node alike: it
 * hashes with `crypto.subtle`, encodes base64 without `Buffer`, and reaches the network only
 * through the `fetch` it is given. `./writer` is the Node convenience over it that rewrites an
 * unpacked archive in place.
 *
 * It never changes its input. It reads every byte it needs, fetches and verifies what it must, and
 * only then builds a new archive and project document, so a failure or a cancellation leaves the
 * caller holding exactly what it passed in. Choosing which extensions to convert, and to which
 * version, is the caller's knowledge: this module converts the bytes a project already pins and
 * never selects, resolves or replaces a version.
 *
 * It has no cache port. Embedding a `remote-non-cacheable` extension fetches it once, with
 * `cache: 'no-store'`, and never reads or writes a persistent copy: embedding is an author editing
 * a work, not permission to keep the bytes in a browser.
 */

import {
  discoverManifest,
  validateManifest,
  type ExecutionMode,
  type ExtensionSpec,
} from '@kubohiroya/turbowarp-extension-loader';

import {decodeBase64, encodeBase64, sha256Hex} from './bytes.js';
import {sb3SaveFormatSupport, type Sb3SaveCapabilities, type Sb3SaveFormat} from './index.js';
import {
  remoteCarrierMarker,
  remoteCompatibilityCarrier,
} from './remote-compatibility-carrier.js';

/** Raised for every refusal here, so a caller can tell these failures apart. */
export class Sb3ExtensionFormatError extends Error {
  readonly code: string;
  constructor(message: string, options: {code: string; cause?: unknown}) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause});
    this.name = 'Sb3ExtensionFormatError';
    this.code = options.code;
  }
}

/** The archive entry an extension stored as a file is given. */
export const sb3PlusExtensionPath = (id: string) => `extensions/${id}.js`;

/** The prefix this package writes. Reading accepts every form {@link isExtensionDataUrl} does. */
export const legacyDataUrlPrefix = 'data:text/javascript;base64,';
export const maxExtensionBytes = 16 * 1024 * 1024;

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3ExtensionFormatError(message, {code, cause});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export {decodeBase64, encodeBase64, sha256Hex};

export const extensionDataUrl = (bytes: Uint8Array) =>
  `${legacyDataUrlPrefix}${encodeBase64(bytes)}`;

/**
 * The media types a host runs as a classic script. A `data:` extension may carry any of them:
 * the Plus carrier writes `text/javascript`, while an extension loaded from a file in TurboWarp
 * keeps whatever type the browser read it as, often `application/javascript`.
 */
const javaScriptMediaTypes = new Set([
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

interface ExtensionDataUrlParts {
  readonly base64: boolean;
  readonly payload: string;
}

function splitExtensionDataUrl(url: string): ExtensionDataUrlParts | undefined {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma < 0) return undefined;
  const [mediaType = '', ...parameters] = url.slice('data:'.length, comma).split(';');
  if (!javaScriptMediaTypes.has(mediaType.trim().toLowerCase())) return undefined;
  const base64 = parameters.some((parameter) => parameter.trim().toLowerCase() === 'base64');
  return {base64, payload: url.slice(comma + 1)};
}

/** Whether a URL is a `data:` URL holding JavaScript, in any of the forms a host runs. */
export function isExtensionDataUrl(url: string): boolean {
  return splitExtensionDataUrl(url) !== undefined;
}

function decodeParts(parts: ExtensionDataUrlParts, length?: number): Uint8Array {
  if (parts.base64)
    return decodeBase64(length === undefined ? parts.payload : parts.payload.slice(0, length));
  return new TextEncoder().encode(decodeURIComponent(parts.payload));
}

/** Whether a `data:` URL is the small standard-host carrier beside a remote entry. */
export function isRemoteCompatibilityCarrier(url: string): boolean {
  const parts = splitExtensionDataUrl(url);
  if (!parts) return false;
  try {
    // 100 base64 characters are whole 3-byte groups, enough to hold the marker.
    const head = decodeParts(parts, 100);
    return new TextDecoder().decode(head).startsWith(remoteCarrierMarker);
  } catch {
    return false;
  }
}

/** Decode a `data:` carrier and refuse anything that is not plausible UTF-8 JavaScript. */
export function decodeExtensionDataUrl(id: string, url: string): Uint8Array {
  const parts = splitExtensionDataUrl(url);
  if (!parts) fail(`Extension ${id} is not a JavaScript data URL.`, 'K4-EXT-FORMAT-001');
  let bytes: Uint8Array;
  try {
    bytes = decodeParts(parts);
  } catch (cause) {
    fail(`Extension ${id} has an undecodable data URL.`, 'K4-EXT-FORMAT-001', cause);
  }
  if (!bytes.byteLength || bytes.byteLength > maxExtensionBytes)
    fail(`Extension ${id} is empty or too large.`, 'K4-EXT-FORMAT-001');
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (cause) {
    fail(`Extension ${id} is not UTF-8 JavaScript.`, 'K4-EXT-FORMAT-001', cause);
  }
  return bytes;
}

export interface Sb3ExtensionPayload {
  readonly id: string;
  /** The current form this extension is stored in. */
  readonly format: Sb3SaveFormat;
  /** Absent for a remote extension, whose bytes are not in the SB3. */
  readonly bytes?: Uint8Array | undefined;
  /**
   * The digest the Manifest pins, or for a legacy `data:` extension the digest of its bytes.
   * Absent only from {@link readSb3ExtensionPayloadsUnhashed}, for a legacy extension.
   */
  readonly sha256?: string | undefined;
  /** The address the project records for it, if any. Absent means the origin is unknown. */
  readonly url?: string | undefined;
  /** The archive entry this extension occupies now, which a rewrite must release. */
  readonly path?: string | undefined;
  /** The Manifest entry it came from, whose execution mode and metadata a rewrite keeps. */
  readonly spec?: ExtensionSpec | undefined;
}

const retainedURL = (spec: ExtensionSpec): string | undefined =>
  'url' in spec.source ? spec.source.url : undefined;

/**
 * Read every extension this project carries, without hashing anything.
 *
 * A Plus Manifest wins over a `data:` carrier for the same ID, because that is the order a Plus
 * host resolves them in. A `data:` URL counts only when its ID is declared in `extensions`: an
 * undeclared leftover is not loaded today, and reading it here would bring it back. A legacy
 * extension has no pinned digest, so its `sha256` is left for the caller's own hash function.
 */
export function readSb3ExtensionPayloadsUnhashed(
  archive: Readonly<Record<string, Uint8Array>>,
  project: Readonly<Record<string, unknown>>,
): readonly Sb3ExtensionPayload[] {
  const result: Sb3ExtensionPayload[] = [];
  const seen = new Set<string>();
  const manifest = project.turboWarpPlus === undefined ? null : discoverManifest(project);
  for (const spec of manifest?.extensions ?? []) {
    seen.add(spec.id);
    if (spec.source.type === 'remote-non-cacheable' || spec.source.type === 'remote-cacheable') {
      result.push(
        Object.freeze({
          id: spec.id,
          format: spec.source.type,
          url: spec.source.url,
          sha256: spec.sha256,
          spec,
        }),
      );
      continue;
    }
    const url = retainedURL(spec);
    if (spec.source.type === 'embedded-file') {
      const bytes = archive[spec.source.path];
      if (!bytes) fail(`The archive is missing ${spec.source.path}.`, 'K4-EXT-FORMAT-002');
      result.push(
        Object.freeze({
          id: spec.id,
          format: 'embedded-file',
          bytes: new Uint8Array(bytes),
          sha256: spec.sha256,
          path: spec.source.path,
          ...(url === undefined ? {} : {url}),
          spec,
        }),
      );
      continue;
    }
    // The data carrier lives in the project document under the extension's own ID, which is also
    // where a standard host looks for it. The Manifest records that it is there, not the bytes.
    const carrier = isRecord(project.extensionURLs) ? project.extensionURLs[spec.id] : undefined;
    if (typeof carrier !== 'string' || !isExtensionDataUrl(carrier))
      fail(
        `The project document is missing the data: carrier for ${spec.id}.`,
        'K4-EXT-FORMAT-002',
      );
    result.push(
      Object.freeze({
        id: spec.id,
        format: 'embedded-data',
        bytes: decodeExtensionDataUrl(spec.id, carrier),
        sha256: spec.sha256,
        ...(url === undefined ? {} : {url}),
        spec,
      }),
    );
  }
  const declared = new Set(
    Array.isArray(project.extensions)
      ? project.extensions.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const urls = isRecord(project.extensionURLs) ? project.extensionURLs : {};
  for (const [id, url] of Object.entries(urls)) {
    if (seen.has(id) || !declared.has(id)) continue;
    if (typeof url !== 'string' || !isExtensionDataUrl(url)) continue;
    if (isRemoteCompatibilityCarrier(url))
      fail(
        `Extension ${id} is a remote compatibility carrier without a Plus Manifest.`,
        'K4-EXT-FORMAT-010',
      );
    result.push(Object.freeze({id, format: 'embedded-data', bytes: decodeExtensionDataUrl(id, url)}));
  }
  return Object.freeze(result);
}

/** Read every extension this project carries, whichever form holds it, with its digest. */
export async function readSb3Extensions(
  archive: Readonly<Record<string, Uint8Array>>,
  project: Readonly<Record<string, unknown>>,
): Promise<readonly Sb3ExtensionPayload[]> {
  const payloads = readSb3ExtensionPayloadsUnhashed(archive, project);
  return Object.freeze(
    await Promise.all(
      payloads.map(async (payload) =>
        payload.sha256 !== undefined || !payload.bytes
          ? payload
          : Object.freeze({...payload, sha256: await sha256Hex(payload.bytes)}),
      ),
    ),
  );
}

/** What to do with one extension. Extensions not named are left exactly as they are. */
export interface Sb3ExtensionFormatChange {
  readonly format: Sb3SaveFormat;
  /** Required for either reference form unless the project already names the URL. */
  readonly url?: string | undefined;
  /** Recorded in the Manifest for provenance only; it is never an execution permission. */
  readonly version?: string | undefined;
  /**
   * Request an unsandboxed host for a legacy `data:` extension, which records no mode. An
   * existing Manifest entry keeps the mode it already requested; nothing here promotes one.
   */
  readonly unsandboxed?: boolean | undefined;
  /** Also keep the `data:` carrier beside a form that is not already it, for standard hosts. */
  readonly keepEmbeddedData?: boolean | undefined;
  /** Write a small standard-host carrier beside a remote entry. Requires unsandboxed execution. */
  readonly remoteCompatibilityCarrier?: boolean | undefined;
}

export interface Sb3ExtensionFormatOptions {
  /**
   * What the caller can write. Required, because "writable" is a property of the build doing the
   * writing, not of the vocabulary.
   */
  readonly capabilities: Sb3SaveCapabilities;
  /** Used only to materialise a reference. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Cancels the conversion. Nothing is returned, and the input is untouched. */
  readonly signal?: AbortSignal | undefined;
}

export interface Sb3ExtensionFormatChangeReport {
  readonly id: string;
  readonly from: Sb3SaveFormat;
  readonly to: Sb3SaveFormat;
  /** The digest of the code, which a form change never alters. */
  readonly sha256: string;
  readonly url?: string | undefined;
  readonly version?: string | undefined;
  /** Whether the bytes had to be fetched from {@link url}. */
  readonly fetched: boolean;
}

export interface Sb3ExtensionFormatConversion {
  /** A new archive. Entries other than the converted extensions' are the same objects. */
  readonly archive: Readonly<Record<string, Uint8Array>>;
  /** A new project document; the input is not modified. */
  readonly project: Record<string, unknown>;
  readonly changes: readonly Sb3ExtensionFormatChangeReport[];
}

async function fetchPinned(
  id: string,
  url: string,
  pinned: string | undefined,
  fetchBytes: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    // Redirects are refused for the same reason the Loader refuses them: the address that answered
    // is the one the project claims, or the project is wrong about it.
    const response = await fetchBytes(url, {
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (length > maxExtensionBytes) throw new Error(`${length} bytes is too large`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    if (signal?.aborted) fail(`Converting extension ${id} was cancelled.`, 'K4-EXT-FORMAT-012', cause);
    fail(`Extension ${id} could not be fetched from ${url}: ${String(cause)}`, 'K4-EXT-FORMAT-005', cause);
  }
  if (bytes.byteLength < 1 || bytes.byteLength > maxExtensionBytes)
    fail(`Extension ${id} is empty or exceeds the byte limit.`, 'K4-EXT-FORMAT-005');
  if (pinned !== undefined && (await sha256Hex(bytes)) !== pinned)
    fail(`${url} does not serve the bytes extension ${id} pins.`, 'K4-EXT-FORMAT-008');
  return bytes;
}

const versionHeader = /^\/\/ Version:[ \t]+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?)[ \t]*$/m;
const isReference = (format: Sb3SaveFormat) =>
  format === 'remote-cacheable' || format === 'remote-non-cacheable';

/**
 * Change the stored form of the named extensions and return the new archive and project.
 *
 * A form change keeps the code: the converted extension pins the same bytes and digest it pinned
 * before, keeps its execution mode, publisher, capabilities and dependencies, and keeps the
 * address and version it came from, so a later conversion can go back to the same reference.
 * Every other extension, archive entry and project field is left as it was, including the
 * Manifest's own fields beside `extensions`.
 *
 * Going from a reference to a carried form is a fetch of the pinned bytes, refused unless they
 * match the digest. Going to a reference needs an address: the one the project records, or the
 * one the change names. Running it again on its own output is a no-op.
 */
export async function convertSb3ExtensionFormats(
  archive: Readonly<Record<string, Uint8Array>>,
  project: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, Sb3ExtensionFormatChange>>,
  {capabilities, fetch: fetchBytes = fetch, timeoutMs = 30_000, signal}: Sb3ExtensionFormatOptions,
): Promise<Sb3ExtensionFormatConversion> {
  for (const [id, change] of Object.entries(changes)) {
    const support = sb3SaveFormatSupport('extensions', change.format, capabilities);
    if (!support.supported)
      fail(`Cannot save extensions as ${change.format}: ${support.reason}`, 'K4-EXT-FORMAT-003');
    if (change.remoteCompatibilityCarrier && (change.keepEmbeddedData || !isReference(change.format)))
      fail(
        `Remote compatibility carrier ${id} requires a remote format and cannot be combined with keepEmbeddedData.`,
        'K4-EXT-FORMAT-010',
      );
  }
  const payloads = await readSb3Extensions(archive, project);
  const byId = new Map(payloads.map((payload) => [payload.id, payload]));
  for (const [id, change] of Object.entries(changes)) {
    const payload = byId.get(id);
    if (!payload) fail(`Extension ${id} is not used by this project.`, 'K4-EXT-FORMAT-011');
    if (
      change.remoteCompatibilityCarrier &&
      (payload.spec ? payload.spec.execution !== 'unsandboxed' : !change.unsandboxed)
    )
      fail(
        `Remote compatibility carrier ${id} requires an explicitly unsandboxed extension.`,
        'K4-EXT-FORMAT-010',
      );
  }
  signal?.throwIfAborted();

  const nextURLs: Record<string, unknown> = isRecord(project.extensionURLs)
    ? {...project.extensionURLs}
    : {};
  // A rewrite can reuse a carrier that is already beside a reference instead of fetching bytes
  // that are here, which is what a rewrite of `keepEmbeddedData` output finds.
  const carriers = new Map<string, string>();
  const releasedPaths = new Set<string>();
  const keptPaths = new Set<string>();
  for (const payload of payloads) {
    if (!Object.hasOwn(changes, payload.id)) {
      if (payload.path !== undefined) keptPaths.add(payload.path);
      continue;
    }
    const held = nextURLs[payload.id];
    if (typeof held === 'string' && isExtensionDataUrl(held) && !isRemoteCompatibilityCarrier(held))
      carriers.set(payload.id, held);
    delete nextURLs[payload.id];
    if (payload.path !== undefined) releasedPaths.add(payload.path);
  }

  const specs: unknown[] = [];
  const reports: Sb3ExtensionFormatChangeReport[] = [];
  const newArchiveEntries = new Map<string, Uint8Array>();
  for (const payload of payloads) {
    const {id, spec} = payload;
    const change = changes[id];
    if (!Object.hasOwn(changes, id) || !change) {
      if (spec) specs.push(spec);
      continue;
    }
    const {format} = change;
    let content = payload.bytes;
    const headerVersion =
      content && change.version === undefined && spec?.version === undefined
        ? versionHeader.exec(new TextDecoder().decode(content.subarray(0, 2048)))?.[1]
        : undefined;
    // A legacy `data:` extension records no version; its header is the only record it has. It is
    // provenance for a later reference, never a permission.
    const recordedVersion =
      change.version ?? spec?.version ?? (change.remoteCompatibilityCarrier ? headerVersion : undefined);
    const metadata = {
      execution: (spec?.execution ?? (change.unsandboxed ? 'unsandboxed' : 'sandboxed')) as ExecutionMode,
      ...(recordedVersion === undefined ? {} : {version: recordedVersion}),
      ...(spec?.publisher === undefined ? {} : {publisher: spec.publisher}),
      capabilities: [...(spec?.capabilities ?? [])],
      dependencies: [...(spec?.dependencies ?? [])],
    };
    const url = change.url ?? payload.url;
    const carried = !isReference(format);
    let fetched = false;
    if ((carried || change.keepEmbeddedData) && !content) {
      const beside = carriers.get(id);
      if (beside !== undefined) {
        content = decodeExtensionDataUrl(id, beside);
        if (payload.sha256 !== undefined && (await sha256Hex(content)) !== payload.sha256)
          fail(`The data: carrier beside extension ${id} is not the bytes it pins.`, 'K4-EXT-FORMAT-008');
      } else {
        if (typeof url !== 'string' || !url)
          fail(`Extension ${id} carries no bytes and names no URL to fetch them from.`, 'K4-EXT-FORMAT-005');
        content = await fetchPinned(id, url, payload.sha256, fetchBytes, timeoutMs, signal);
        fetched = true;
      }
    }
    const digest = content ? await sha256Hex(content) : payload.sha256;
    if (!digest) fail(`Extension ${id} has no digest to pin.`, 'K4-EXT-FORMAT-004');
    // The bytes in hand must be the bytes the project pins, or this would replace the extension.
    if (payload.sha256 !== undefined && digest !== payload.sha256)
      fail(`The bytes stored for extension ${id} are not the bytes it pins.`, 'K4-EXT-FORMAT-008');
    if (!carried && (typeof url !== 'string' || !url))
      fail(`Extension ${id} needs an HTTPS URL to be saved as ${format}.`, 'K4-EXT-FORMAT-004');
    if (change.keepEmbeddedData && format !== 'embedded-data') nextURLs[id] = extensionDataUrl(content!);
    reports.push(
      Object.freeze({
        id,
        from: payload.format,
        to: format,
        sha256: digest,
        ...(url ? {url} : {}),
        ...(recordedVersion === undefined ? {} : {version: recordedVersion}),
        fetched,
      }),
    );
    if (!carried) {
      if (change.remoteCompatibilityCarrier)
        nextURLs[id] = remoteCompatibilityCarrier(
          {id, url: url!, sha256: digest, version: recordedVersion},
          {maxBytes: maxExtensionBytes, timeoutMs},
        );
      // validateManifest enforces the HTTPS and digest policy.
      specs.push({id, source: {type: format, url}, sha256: digest, ...metadata});
      continue;
    }
    // Either carrier records the address the bytes came from, when one is known. It is the only
    // thing that keeps a path back to a reference form open.
    const origin = typeof url === 'string' && url ? {url} : {};
    if (format === 'embedded-data') {
      nextURLs[id] = extensionDataUrl(content!);
      specs.push({id, source: {type: 'embedded-data', ...origin}, sha256: digest, ...metadata});
      continue;
    }
    const path = sb3PlusExtensionPath(id);
    if ((Object.hasOwn(archive, path) && !releasedPaths.has(path)) || keptPaths.has(path))
      fail(`The archive already contains unrelated content at ${path}.`, 'K4-EXT-FORMAT-007');
    newArchiveEntries.set(path, content!);
    specs.push({id, source: {type: 'embedded-file', ...origin, path}, sha256: digest, ...metadata});
  }
  signal?.throwIfAborted();

  const original = isRecord(project.turboWarpPlus) ? project.turboWarpPlus : {};
  const manifest = specs.length
    ? validateManifest({...original, schemaVersion: 1, extensions: specs})
    : undefined;
  const nextArchive: Record<string, Uint8Array> = {...archive};
  for (const path of releasedPaths) delete nextArchive[path];
  for (const [path, bytes] of newArchiveEntries) nextArchive[path] = bytes;
  const declared = Array.isArray(project.extensions)
    ? project.extensions.filter((id): id is string => typeof id === 'string')
    : [];
  const nextProject: Record<string, unknown> = {
    ...project,
    extensionURLs: nextURLs,
    extensions: [...new Set([...declared, ...reports.map((report) => report.id)])],
  };
  if (manifest) nextProject.turboWarpPlus = manifest;
  return Object.freeze({
    archive: Object.freeze(nextArchive),
    project: nextProject,
    changes: Object.freeze(reports),
  });
}
