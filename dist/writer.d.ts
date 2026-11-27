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
import { type ExtensionSpec } from '@kubohiroya/turbowarp-extension-loader';
import { type Sb3SaveCapabilities, type Sb3SaveFormat } from './index.js';
/** Raised for every refusal here, so a caller can tell this writer's failures apart. */
export declare class Sb3WriterError extends Error {
    readonly code: string;
    constructor(message: string, options: {
        code: string;
        cause?: unknown;
    });
}
/** Allows callers that also support older writers to detect the opt-in. */
export declare const supportsRemoteCompatibilityCarriers = true;
/** The archive entry this writer gives an extension it stores as a file. */
export declare const sb3PlusExtensionPath: (id: string) => string;
export interface Sb3ExtensionPayload {
    readonly id: string;
    /** The current form this extension is stored in. */
    readonly format: Sb3SaveFormat;
    /** Absent for a remote extension, whose bytes are not in the SB3. */
    readonly bytes?: Uint8Array | undefined;
    readonly sha256?: string | undefined;
    readonly url?: string | undefined;
    /** The archive entry this extension occupies now, which a rewrite must release. */
    readonly path?: string | undefined;
    /** The Manifest entry it came from, whose execution mode and metadata a rewrite keeps. */
    readonly spec?: ExtensionSpec | undefined;
}
/**
 * Read every extension this project carries, whichever form holds it.
 *
 * A Plus Manifest wins over a `data:` carrier for the same ID, because that is the order a Plus
 * host resolves them in. A `data:` URL counts only when its ID is declared in `extensions`: an
 * undeclared leftover is not loaded today, and reading it here would bring it back.
 */
export declare function readSb3ExtensionPayloads(archive: Readonly<Record<string, Uint8Array>>, project: Readonly<Record<string, unknown>>): readonly Sb3ExtensionPayload[];
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
 * against, the declared execution mode and the dependencies. Dropping it would have been a loss
 * that only standard hosts were ever paid for. `keepEmbeddedData` adds that carrier to a form
 * that is not already it, so a Plus host prefers the Manifest's own copy.
 *
 * Going from a reference to a carried form is a fetch: the reference names a URL and pins a
 * digest, so the bytes are obtainable and verifiable, and refusing would have made a conversion
 * impossible for no reason other than that this function could not reach the network.
 */
export declare function writeSb3ExtensionFormat(archive: Record<string, Uint8Array>, project: Record<string, unknown>, format: Sb3SaveFormat, { capabilities, urls, version, unsandboxed, keepEmbeddedData, remoteCompatibilityCarriers, fetch: fetchBytes, timeoutMs, }: Sb3ExtensionFormatOptions): Promise<Sb3ExtensionFormatResult>;
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
export declare function verifySb3ExtensionUrls(project: Record<string, unknown>, { fetch: fetchBytes, timeoutMs }?: Sb3ExtensionUrlCheckOptions): Promise<readonly string[]>;
