/**
 * Writing the chosen form into an SB3 that is already unpacked.
 *
 * This is the Node side of the vocabulary. It takes an unpacked archive and a parsed project, so
 * it never touches a ZIP: unpacking and re-serialising belong to the caller. It is a separate
 * entry point because it hashes with `node:crypto`, which a browser bundle must not pull in; the
 * root export stays dependency-free.
 *
 * A browser does not need this. Converting a form whose bytes may come from the cached copy is the
 * loader's `prepareExtensionAddition`, which has a cache port and verifies with `crypto.subtle`.
 * This writer has no cache port, so its only byte source is the network — it can write which form
 * a work records, never the copy a viewer's browser holds.
 */
import { createHash } from 'node:crypto';
import { discoverManifest, isRemoteSource, validateManifest, } from '@kubohiroya/turbowarp-extension-loader';
import { sb3SaveFormatSupport } from './index.js';
import { remoteCarrierMarker, remoteCompatibilityCarrier } from './remote-compatibility-carrier.js';
/** Raised for every refusal here, so a caller can tell this writer's failures apart. */
export class Sb3WriterError extends Error {
    code;
    constructor(message, options) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'Sb3WriterError';
        this.code = options.code;
    }
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** The address an embedded source records, when it records one. */
const retainedURL = (spec) => 'url' in spec.source ? spec.source.url : undefined;
const legacyDataUrlPrefix = 'data:text/javascript;base64,';
const maxExtensionBytes = 16 * 1024 * 1024;
const isCompatibilityCarrier = (url) => Buffer.from(url.slice(legacyDataUrlPrefix.length, legacyDataUrlPrefix.length + 100), 'base64')
    .toString('utf8')
    .startsWith(remoteCarrierMarker);
/** Allows callers that also support older writers to detect the opt-in. */
export const supportsRemoteCompatibilityCarriers = true;
/** The archive entry this writer gives an extension it stores as a file. */
export const sb3PlusExtensionPath = (id) => `extensions/${id}.js`;
function fail(message, code, cause) {
    throw new Sb3WriterError(message, { code, cause });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decode(id, encoded) {
    let bytes;
    try {
        bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
    }
    catch (cause) {
        fail(`Extension ${id} has an undecodable data URL.`, 'K4-EXT-FORMAT-001', cause);
    }
    if (!bytes.byteLength || bytes.byteLength > maxExtensionBytes)
        fail(`Extension ${id} is empty or too large.`, 'K4-EXT-FORMAT-001');
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch (cause) {
        fail(`Extension ${id} is not UTF-8 JavaScript.`, 'K4-EXT-FORMAT-001', cause);
    }
    return bytes;
}
/**
 * Read every extension this project carries, whichever form holds it.
 *
 * A Plus Manifest wins over a `data:` carrier for the same ID, because that is the order a Plus
 * host resolves them in. A `data:` URL counts only when its ID is declared in `extensions`: an
 * undeclared leftover is not loaded today, and reading it here would bring it back.
 */
export function readSb3ExtensionPayloads(archive, project) {
    const result = [];
    const seen = new Set();
    const manifest = project.turboWarpPlus === undefined ? null : discoverManifest(project);
    for (const spec of manifest?.extensions ?? []) {
        seen.add(spec.id);
        if (spec.source.type === 'remote-non-cacheable' || spec.source.type === 'remote-cacheable') {
            // A reference carries no bytes. Materialising one is a fetch, which belongs to the writer.
            result.push(Object.freeze({
                id: spec.id,
                format: spec.source.type,
                url: spec.source.url,
                sha256: spec.sha256,
                spec,
            }));
            continue;
        }
        const url = retainedURL(spec);
        if (spec.source.type === 'embedded-file') {
            const bytes = archive[spec.source.path];
            if (!bytes)
                fail(`The archive is missing ${spec.source.path}.`, 'K4-EXT-FORMAT-002');
            result.push(Object.freeze({
                id: spec.id,
                format: 'embedded-file',
                bytes: new Uint8Array(bytes),
                sha256: spec.sha256,
                path: spec.source.path,
                ...(url === undefined ? {} : { url }),
                spec,
            }));
            continue;
        }
        // The data carrier lives in the project document under the extension's own ID, which is also
        // where a standard host looks for it. The Manifest records that it is there, not the bytes.
        const carrier = isRecord(project.extensionURLs) ? project.extensionURLs[spec.id] : undefined;
        if (typeof carrier !== 'string' || !carrier.startsWith(legacyDataUrlPrefix))
            fail(`The project document is missing the data: carrier for ${spec.id}.`, 'K4-EXT-FORMAT-002');
        result.push(Object.freeze({
            id: spec.id,
            format: 'embedded-data',
            bytes: decode(spec.id, carrier.slice(legacyDataUrlPrefix.length)),
            sha256: spec.sha256,
            ...(url === undefined ? {} : { url }),
            spec,
        }));
    }
    const declared = new Set(Array.isArray(project.extensions)
        ? project.extensions.filter((id) => typeof id === 'string')
        : []);
    const urls = isRecord(project.extensionURLs) ? project.extensionURLs : {};
    for (const [id, url] of Object.entries(urls)) {
        if (seen.has(id) || !declared.has(id))
            continue;
        if (typeof url !== 'string' || !url.startsWith(legacyDataUrlPrefix))
            continue;
        if (isCompatibilityCarrier(url))
            fail(`Extension ${id} is a remote compatibility carrier without a Plus Manifest.`, 'K4-EXT-FORMAT-010');
        const bytes = decode(id, url.slice(legacyDataUrlPrefix.length));
        result.push(Object.freeze({ id, format: 'embedded-data', bytes, sha256: sha256(bytes) }));
    }
    return Object.freeze(result);
}
/**
 * Fetch the bytes a reference names and refuse anything but the digest it pins.
 *
 * Embedding unverified bytes would turn a conversion into a way to replace an extension, so the
 * pin is checked here rather than left to the host that eventually loads it. Redirects are
 * refused for the same reason the Loader refuses them: the address that answered is the one the
 * project claims, or the project is wrong about it.
 */
async function fetchPinned(id, url, pinned, fetchBytes, timeoutMs) {
    let bytes;
    try {
        const response = await fetchBytes(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
    }
    catch (cause) {
        fail(`Extension ${id} could not be fetched from ${url}: ${String(cause)}`, 'K4-EXT-FORMAT-005');
    }
    if (bytes.byteLength < 1 || bytes.byteLength > maxExtensionBytes)
        fail(`Extension ${id} is empty or exceeds the byte limit.`, 'K4-EXT-FORMAT-005');
    if (pinned !== undefined && sha256(bytes) !== pinned)
        fail(`${url} does not serve the bytes extension ${id} pins.`, 'K4-EXT-FORMAT-008');
    return bytes;
}
const dataUrl = (bytes) => `${legacyDataUrlPrefix}${Buffer.from(bytes).toString('base64')}`;
/**
 * Rewrite every extension of this project into one form, in place. Running it again on its own
 * output is a no-op, so a rewritten SB3 can be rewritten or rebuilt like any other.
 *
 * All four forms keep the Manifest. `embedded-data` is the one a standard TurboWarp host loads on
 * its own, because it reads `extensionURLs` and knows nothing of the Manifest beside it — but the
 * Manifest still records that the bytes are there, so a Plus host keeps the digest to verify
 * against, the declared execution mode and the dependencies. Dropping it would have been a loss
 * that only standard hosts were ever paid for. `keepEmbeddedData` adds that carrier to a form
 * that is not already it, so a Plus host prefers the Manifest's own copy.
 *
 * Going from a reference to a carried form is a fetch: the reference names a URL and pins a
 * digest, so the bytes are obtainable and verifiable, and refusing would have made a conversion
 * impossible for no reason other than that this function could not reach the network.
 */
export async function writeSb3ExtensionFormat(archive, project, format, { capabilities, urls = {}, version, unsandboxed = [], keepEmbeddedData = false, remoteCompatibilityCarriers = [], fetch: fetchBytes = fetch, timeoutMs = 30_000, }) {
    const support = sb3SaveFormatSupport('extensions', format, capabilities);
    if (!support.supported)
        fail(`Cannot save extensions as ${format}: ${support.reason}`, 'K4-EXT-FORMAT-003');
    const payloads = readSb3ExtensionPayloads(archive, project);
    const compatibilityIds = new Set(remoteCompatibilityCarriers);
    if (compatibilityIds.size && (keepEmbeddedData || !['remote-cacheable', 'remote-non-cacheable'].includes(format)))
        fail('Remote compatibility carriers require a remote format and cannot be combined with keepEmbeddedData.', 'K4-EXT-FORMAT-010');
    for (const id of compatibilityIds) {
        const payload = payloads.find(item => item.id === id);
        if (!payload || (payload.spec ? payload.spec.execution !== 'unsandboxed' : !unsandboxed.includes(id)))
            fail(`Remote compatibility carrier ${id} requires an explicitly unsandboxed extension.`, 'K4-EXT-FORMAT-010');
    }
    if (!payloads.length)
        return Object.freeze({ converted: Object.freeze([]), format });
    // Only the IDs the caller names may be requested unsandboxed. A legacy `data:` URL records no
    // execution mode, so everything else is requested sandboxed: a rewrite never promotes an
    // extension on its own. An existing Manifest entry keeps the mode it already requested, and
    // nothing in an SB3 grants it — a Plus host asks its `trustProvider`, a standard host asks the
    // person. Which IDs may ask for an unsandboxed host is the caller's knowledge, not this
    // writer's.
    const unsandboxedIds = new Set(unsandboxed);
    const declared = Array.isArray(project.extensions)
        ? project.extensions.filter((id) => typeof id === 'string')
        : [];
    const nextURLs = isRecord(project.extensionURLs)
        ? { ...project.extensionURLs }
        : {};
    // What the project carried for each of these before the release below, so a rewrite can reuse
    // a carrier instead of fetching bytes that are already here.
    const carriers = new Map();
    const releasedPaths = new Set();
    const newArchiveEntries = new Map();
    // Release only what these extensions own now, then write back only the chosen form.
    for (const payload of payloads) {
        const held = nextURLs[payload.id];
        if (typeof held === 'string' && held.startsWith(legacyDataUrlPrefix) && !isCompatibilityCarrier(held))
            carriers.set(payload.id, held);
        delete nextURLs[payload.id];
        if (payload.path !== undefined)
            releasedPaths.add(payload.path);
    }
    const specs = [];
    const converted = [];
    for (const payload of payloads) {
        const { id, bytes, spec } = payload;
        const useCompatibilityCarrier = compatibilityIds.has(id);
        const headerVersion = useCompatibilityCarrier && bytes && version === undefined && spec?.version === undefined
            ? /^\/\/ Version:[ \t]+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?)[ \t]*$/m.exec(new TextDecoder().decode(bytes.subarray(0, 2048)))?.[1]
            : undefined;
        const recordedVersion = version ?? spec?.version ?? headerVersion;
        // A rewrite keeps what the existing entry declared, rather than resetting it.
        const metadata = {
            execution: (spec?.execution ??
                (unsandboxedIds.has(id) ? 'unsandboxed' : 'sandboxed')),
            ...(recordedVersion === undefined ? {} : { version: recordedVersion }),
            ...(spec?.publisher === undefined ? {} : { publisher: spec.publisher }),
            capabilities: [...(spec?.capabilities ?? [])],
            dependencies: [...(spec?.dependencies ?? [])],
        };
        const url = urls[id] ?? payload.url;
        const carried = format === 'embedded-file' || format === 'embedded-data';
        // A reference pins a digest and names a URL, so its bytes are obtainable and verifiable.
        // Fetching here is the whole conversion; the alternative was refusing it.
        let content = bytes;
        if ((carried || keepEmbeddedData) && !content) {
            // A `data:` carrier beside a reference holds the bytes already, which is what a rewrite of
            // this writer's own `--keep-embedded-data` output finds. Reaching for the network when they
            // are sitting in the project would make the same operation need one the second time.
            const beside = carriers.get(id);
            if (beside !== undefined) {
                content = decode(id, beside.slice(legacyDataUrlPrefix.length));
                if (payload.sha256 !== undefined && sha256(content) !== payload.sha256)
                    fail(`The data: carrier beside extension ${id} is not the bytes it pins.`, 'K4-EXT-FORMAT-008');
            }
            else {
                if (typeof url !== 'string' || !url)
                    fail(`Extension ${id} carries no bytes and names no URL to fetch them from.`, 'K4-EXT-FORMAT-005');
                content = await fetchPinned(id, url, payload.sha256, fetchBytes, timeoutMs);
            }
        }
        if (!carried && (typeof url !== 'string' || !url))
            fail(`Extension ${id} needs an HTTPS URL to be saved as ${format}.`, 'K4-EXT-FORMAT-004');
        // The carrier a standard host reads, kept beside a form that is not already it.
        if (keepEmbeddedData && format !== 'embedded-data')
            nextURLs[id] = dataUrl(content);
        if (!carried) {
            const digest = payload.sha256 ?? (content && sha256(content));
            if (!digest)
                fail(`Extension ${id} has no digest to pin for a reference.`, 'K4-EXT-FORMAT-004');
            if (useCompatibilityCarrier)
                nextURLs[id] = remoteCompatibilityCarrier({ id, url: url, sha256: digest, version: recordedVersion }, { maxBytes: maxExtensionBytes, timeoutMs });
            // validateManifest enforces the HTTPS and digest policy for us.
            specs.push({ id, source: { type: format, url }, sha256: digest, ...metadata });
            converted.push(id);
            continue;
        }
        // Either carrier records the address the bytes came from, when one is known. It is the only
        // thing that keeps a path back to a reference form open.
        const origin = typeof url === 'string' && url ? { url } : {};
        if (format === 'embedded-data') {
            nextURLs[id] = dataUrl(content);
            specs.push({
                id,
                source: { type: 'embedded-data', ...origin },
                sha256: sha256(content),
                ...metadata,
            });
            converted.push(id);
            continue;
        }
        const path = sb3PlusExtensionPath(id);
        if (Object.hasOwn(archive, path) && !releasedPaths.has(path))
            fail(`The archive already contains unrelated content at ${path}.`, 'K4-EXT-FORMAT-007');
        newArchiveEntries.set(path, content);
        specs.push({
            id,
            source: { type: 'embedded-file', ...origin, path },
            sha256: sha256(content),
            ...metadata,
        });
        converted.push(id);
    }
    // Every form keeps the Manifest, including the data carrier: a standard host ignores it, and a
    // Plus host would otherwise lose the digest, the execution mode and the dependencies.
    const manifest = specs.length ? validateManifest({ schemaVersion: 1, extensions: specs }) : undefined;
    for (const path of releasedPaths)
        delete archive[path];
    for (const [path, bytes] of newArchiveEntries)
        archive[path] = bytes;
    if (manifest)
        project.turboWarpPlus = manifest;
    else
        delete project.turboWarpPlus;
    project.extensionURLs = nextURLs;
    project.extensions = [...new Set([...declared, ...payloads.map((payload) => payload.id)])];
    return Object.freeze({ converted: Object.freeze(converted), format });
}
/**
 * Fetch every URL this project's Manifest names, and refuse the project unless each URL returns
 * exactly the bytes its digest pins.
 *
 * The writer pins the digest of the bytes it has in hand, but a host loads the URL: a URL serving
 * other bytes makes an SB3 that a Plus host rejects with `DIGEST_MISMATCH` (a cached copy only
 * hides that until the host falls back to the URL). Like the Loader, this refuses redirects.
 */
export async function verifySb3ExtensionUrls(project, { fetch: fetchBytes = fetch, timeoutMs = 30_000 } = {}) {
    const checked = [];
    for (const spec of discoverManifest(project)?.extensions ?? []) {
        // Every source that names a URL has one to verify, whichever form it is stored in.
        const url = isRemoteSource(spec.source) ? spec.source.url : retainedURL(spec);
        if (url === undefined)
            continue;
        let bytes;
        try {
            const response = await fetchBytes(url, {
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const length = Number(response.headers.get('content-length'));
            if (length > maxExtensionBytes)
                throw new Error(`${length} bytes is too large`);
            bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > maxExtensionBytes)
                throw new Error(`${bytes.byteLength} bytes is too large`);
        }
        catch (error) {
            fail(`Could not fetch ${url} for extension ${spec.id}: ${error.message}. ` +
                'Pass --skip-url-check only if the URL will serve the pinned bytes later.', 'K4-EXT-FORMAT-008', error);
        }
        const actual = sha256(bytes);
        if (actual !== spec.sha256)
            fail(`${url} does not serve the bytes extension ${spec.id} pins ` +
                `(expected sha256 ${spec.sha256}, got ${actual}); a Plus host would reject it.`, 'K4-EXT-FORMAT-009');
        checked.push(spec.id);
    }
    return Object.freeze(checked);
}
