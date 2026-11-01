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
 * Where the bytes of one payload live in a saved SB3.
 *
 * - `remote`: only an HTTPS reference is stored, and the bytes are read at load or run time.
 * - `cached`: an HTTPS reference is stored and verified bytes are kept beside it for offline use.
 * - `embedded-file`: the bytes are a file inside the SB3 ZIP, named by a relative path.
 * - `embedded-data`: the bytes are inside `project.json`, as a `data:` URL or a base64 field.
 *
 * This refines where the bytes are, not how a payload is represented. A document source kind of
 * `@kubohiroya/turbowarp-document-source` also spells one of its values `embedded-file`, but that
 * is a reference kind and its representation (text, YAML blocks, schema blocks) is independent.
 * The two are deliberately separate types, and neither is an alias of the other.
 */
export type Sb3SaveFormat = 'remote' | 'cached' | 'embedded-file' | 'embedded-data';

export const sb3SavePayloads: readonly Sb3SavePayload[] = Object.freeze([
  'extensions',
  'source',
  'assets',
]);

export const sb3SaveFormats: readonly Sb3SaveFormat[] = Object.freeze([
  'remote',
  'cached',
  'embedded-file',
  'embedded-data',
]);

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

const supported: Sb3SaveFormatSupport = Object.freeze({supported: true});

const refused = (reason: string): Sb3SaveFormatSupport => Object.freeze({supported: false, reason});

export const sb3SaveFormatKey = (
  payload: Sb3SavePayload,
  format: Sb3SaveFormat,
): Sb3SaveFormatKey => `${payload}:${format}`;

function assertPayload(payload: Sb3SavePayload): void {
  if (!sb3SavePayloads.includes(payload)) throw new TypeError(`Unknown save payload ${payload}`);
}

function assertFormat(format: Sb3SaveFormat): void {
  if (!sb3SaveFormats.includes(format)) throw new TypeError(`Unknown save format ${format}`);
}

/**
 * Build capabilities from the refusals an implementation already keeps, so a converter that
 * records "this pair cannot be written, and here is what is missing" does not also have to write
 * the lookup. Anything not named is supported.
 */
export function sb3SaveCapabilities(refusals: Sb3SaveRefusals = {}): Sb3SaveCapabilities {
  const formats = refusals.formats ?? {};
  for (const key of Object.keys(formats)) {
    const [payload, format] = key.split(':') as [Sb3SavePayload, Sb3SaveFormat];
    assertPayload(payload);
    assertFormat(format);
    if (!formats[key as Sb3SaveFormatKey])
      throw new TypeError(`The refusal for ${key} must say what is missing`);
  }
  if (refusals.projectAssets !== undefined && !refusals.projectAssets)
    throw new TypeError('The refusal for project assets must say what is missing');
  const projectAssets = refusals.projectAssets;
  const capabilities: Sb3SaveCapabilities = {
    format(payload, format) {
      assertPayload(payload);
      assertFormat(format);
      const reason = formats[sb3SaveFormatKey(payload, format)];
      return reason === undefined ? supported : refused(reason);
    },
    projectAssets() {
      return projectAssets === undefined ? supported : refused(projectAssets);
    },
  };
  return Object.freeze(capabilities);
}

/**
 * Whether this payload can be written in this format by these capabilities, and what is missing
 * when it cannot. A capability that refuses without a reason is a bug in that implementation
 * rather than something to pass on silently.
 */
export function sb3SaveFormatSupport(
  payload: Sb3SavePayload,
  format: Sb3SaveFormat,
  capabilities: Sb3SaveCapabilities,
): Sb3SaveFormatSupport {
  assertPayload(payload);
  assertFormat(format);
  const support = capabilities.format(payload, format);
  if (!support.supported && !support.reason)
    throw new TypeError(
      `The capabilities refused ${sb3SaveFormatKey(payload, format)} without saying what is missing`,
    );
  return support;
}

/** The formats these capabilities can write for one payload, in declaration order. */
export function sb3SupportedSaveFormats(
  payload: Sb3SavePayload,
  capabilities: Sb3SaveCapabilities,
): readonly Sb3SaveFormat[] {
  return Object.freeze(
    sb3SaveFormats.filter((format) => sb3SaveFormatSupport(payload, format, capabilities).supported),
  );
}

function optionalFormat(value: unknown, payload: Sb3SavePayload): Sb3SaveFormat | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !sb3SaveFormats.includes(value as Sb3SaveFormat))
    throw new TypeError(
      `The ${payload} format must be one of ${sb3SaveFormats.join(', ')}, received ${String(value)}`,
    );
  return value as Sb3SaveFormat;
}

/**
 * Validate a selection and refuse one these capabilities cannot honour, naming the payload, the
 * format and what is missing. A payload left unset is kept as it is; a named one is never
 * silently downgraded or ignored.
 */
export function normalizeSb3SaveSelection(
  input: unknown,
  capabilities: Sb3SaveCapabilities,
): Sb3SaveSelection {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('A save selection object is required');
  const record = input as Record<string, unknown>;
  const allowed = new Set<string>([...sb3SavePayloads, 'assetsAsProjectAssets']);
  for (const name of Object.keys(record))
    if (!allowed.has(name)) throw new TypeError(`Unknown save option ${name}`);
  if (
    record.assetsAsProjectAssets !== undefined &&
    typeof record.assetsAsProjectAssets !== 'boolean'
  )
    throw new TypeError('assetsAsProjectAssets must be a boolean');
  const selection: Sb3SaveSelection = Object.freeze({
    extensions: optionalFormat(record.extensions, 'extensions'),
    source: optionalFormat(record.source, 'source'),
    assets: optionalFormat(record.assets, 'assets'),
    assetsAsProjectAssets: record.assetsAsProjectAssets === true,
  });
  for (const payload of sb3SavePayloads) {
    const format = selection[payload];
    if (format === undefined) continue;
    const support = sb3SaveFormatSupport(payload, format, capabilities);
    if (!support.supported)
      throw new TypeError(`Cannot save ${payload} as ${format}: ${support.reason}`);
  }
  if (selection.assetsAsProjectAssets) {
    const support = capabilities.projectAssets();
    if (!support.supported) {
      if (!support.reason)
        throw new TypeError(
          'The capabilities refused project assets without saying what is missing',
        );
      throw new TypeError(`Cannot store assets as project assets: ${support.reason}`);
    }
  }
  return selection;
}

/** A one-line report of what these capabilities can write, for `--help` and for diagnostics. */
export function describeSb3SaveFormats(capabilities: Sb3SaveCapabilities): string {
  return sb3SavePayloads
    .map((payload) => {
      const formats = sb3SupportedSaveFormats(payload, capabilities);
      return `${payload}: ${formats.length ? formats.join('|') : 'kept as built'}`;
    })
    .join('; ');
}
