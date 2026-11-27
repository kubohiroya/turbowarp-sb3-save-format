/**
 * The vocabulary for "save in a chosen format".
 *
 * Extensions, source data and assets each already had their own words for where their bytes
 * live, in three different packages. This package gives the three one set of names so a save or a
 * conversion can state a choice per payload.
 *
 * What each implementation can actually write differs, so this package does not decide that. A
 * CLI that rewrites a built SB3, a save dialog in the GUI and a per-payload converter each pass
 * their own {@link Sb3SaveCapabilities}. Sharing one table instead would make a save dialog refuse
 * a format with a command-line flag as the reason.
 *
 * The package has no dependencies and no runtime of its own.
 */
/** What a saved SB3 carries, each of which can be stored in its own form. */
export type Sb3SavePayload = 'extensions' | 'source' | 'assets';
/**
 * Where the bytes of one payload live in a saved SB3, as the author of the work decided.
 *
 * - `remote-non-cacheable`: only an HTTPS reference is stored, and the bytes are fetched every
 *   time. Nothing is kept in the browser either: the author forbids a copy, because a copy hides
 *   a URL that stopped serving the pinned bytes until the copy runs out, and a work handed to a
 *   shared machine should leave no code behind.
 * - `remote-cacheable`: only an HTTPS reference is stored, and a verified copy may be kept in the
 *   browser. Whether one actually is kept is the opener's to decline.
 * - `embedded-file`: the bytes are a file inside the SB3 ZIP, named by a relative path.
 * - `embedded-data`: the bytes are inside `project.json`, as a `data:` URL. This is also the one
 *   form a standard TurboWarp host opens on its own, because it reads `extensionURLs` and knows
 *   nothing of the Plus Manifest.
 *
 * The last two are siblings: both make a work that runs offline, anywhere, on its own. They
 * differ in the carrier, and the carrier decides who else can read it.
 *
 * These are the Loader's four Manifest source types, spelled identically. One vocabulary, so a
 * choice made in a save screen reaches the Manifest without being translated — every cross-layer
 * defect this family has had came from a translation.
 *
 * This refines where the bytes are, not how a payload is represented. A document source kind of
 * `@kubohiroya/turbowarp-document-source` also spells one of its values `embedded-file`, but that
 * is a reference kind and its representation (text, YAML blocks, schema blocks) is independent.
 * The two are deliberately separate types, and neither is an alias of the other.
 */
export type Sb3SaveFormat = 'remote-non-cacheable' | 'remote-cacheable' | 'embedded-file' | 'embedded-data';
export declare const sb3SavePayloads: readonly Sb3SavePayload[];
export declare const sb3SaveFormats: readonly Sb3SaveFormat[];
/** A payload left unset is kept exactly as the project already stores it. */
export interface Sb3SaveSelection {
    readonly extensions?: Sb3SaveFormat | undefined;
    readonly source?: Sb3SaveFormat | undefined;
    readonly assets?: Sb3SaveFormat | undefined;
    /** Also store each asset as an SB3 project asset: a costume, a backdrop or a sound. */
    readonly assetsAsProjectAssets: boolean;
}
export interface Sb3SaveFormatSupport {
    readonly supported: boolean;
    /** Present when the choice cannot be written, saying what is missing. */
    readonly reason?: string;
}
/** A `payload:format` pair, the key a refusal is recorded under. */
export type Sb3SaveFormatKey = `${Sb3SavePayload}:${Sb3SaveFormat}`;
/**
 * What one implementation can write. Every method answers for that implementation alone, and a
 * refusal has to say what is missing so a caller can repeat it to a person.
 */
export interface Sb3SaveCapabilities {
    /** Whether this implementation can write this payload in this format. */
    readonly format: (payload: Sb3SavePayload, format: Sb3SaveFormat) => Sb3SaveFormatSupport;
    /** Whether it can also store each asset as a costume, a backdrop or a sound. */
    readonly projectAssets: () => Sb3SaveFormatSupport;
}
/** Refusals by `payload:format`, plus the one for storing assets as project assets. */
export interface Sb3SaveRefusals {
    readonly formats?: Readonly<Partial<Record<Sb3SaveFormatKey, string>>> | undefined;
    readonly projectAssets?: string | undefined;
}
export declare const sb3SaveFormatKey: (payload: Sb3SavePayload, format: Sb3SaveFormat) => Sb3SaveFormatKey;
/**
 * Build capabilities from the refusals an implementation already keeps, so a converter that
 * records "this pair cannot be written, and here is what is missing" does not also have to write
 * the lookup. Anything not named is supported.
 */
export declare function sb3SaveCapabilities(refusals?: Sb3SaveRefusals): Sb3SaveCapabilities;
/**
 * Whether this payload can be written in this format by these capabilities, and what is missing
 * when it cannot. A capability that refuses without a reason is a bug in that implementation
 * rather than something to pass on silently.
 */
export declare function sb3SaveFormatSupport(payload: Sb3SavePayload, format: Sb3SaveFormat, capabilities: Sb3SaveCapabilities): Sb3SaveFormatSupport;
/** The formats these capabilities can write for one payload, in declaration order. */
export declare function sb3SupportedSaveFormats(payload: Sb3SavePayload, capabilities: Sb3SaveCapabilities): readonly Sb3SaveFormat[];
/**
 * Validate a selection and refuse one these capabilities cannot honour, naming the payload, the
 * format and what is missing. A payload left unset is kept as it is; a named one is never
 * silently downgraded or ignored.
 */
export declare function normalizeSb3SaveSelection(input: unknown, capabilities: Sb3SaveCapabilities): Sb3SaveSelection;
/** A one-line report of what these capabilities can write, for `--help` and for diagnostics. */
export declare function describeSb3SaveFormats(capabilities: Sb3SaveCapabilities): string;
