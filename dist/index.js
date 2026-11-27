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
export const sb3SavePayloads = Object.freeze([
    'extensions',
    'source',
    'assets',
]);
export const sb3SaveFormats = Object.freeze([
    'remote-non-cacheable',
    'remote-cacheable',
    'embedded-file',
    'embedded-data',
]);
const supported = Object.freeze({ supported: true });
const refused = (reason) => Object.freeze({ supported: false, reason });
export const sb3SaveFormatKey = (payload, format) => `${payload}:${format}`;
function assertPayload(payload) {
    if (!sb3SavePayloads.includes(payload))
        throw new TypeError(`Unknown save payload ${payload}`);
}
function assertFormat(format) {
    if (!sb3SaveFormats.includes(format))
        throw new TypeError(`Unknown save format ${format}`);
}
/**
 * Build capabilities from the refusals an implementation already keeps, so a converter that
 * records "this pair cannot be written, and here is what is missing" does not also have to write
 * the lookup. Anything not named is supported.
 */
export function sb3SaveCapabilities(refusals = {}) {
    const formats = refusals.formats ?? {};
    for (const key of Object.keys(formats)) {
        const [payload, format] = key.split(':');
        assertPayload(payload);
        assertFormat(format);
        if (!formats[key])
            throw new TypeError(`The refusal for ${key} must say what is missing`);
    }
    if (refusals.projectAssets !== undefined && !refusals.projectAssets)
        throw new TypeError('The refusal for project assets must say what is missing');
    const projectAssets = refusals.projectAssets;
    const capabilities = {
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
export function sb3SaveFormatSupport(payload, format, capabilities) {
    assertPayload(payload);
    assertFormat(format);
    const support = capabilities.format(payload, format);
    if (!support.supported && !support.reason)
        throw new TypeError(`The capabilities refused ${sb3SaveFormatKey(payload, format)} without saying what is missing`);
    return support;
}
/** The formats these capabilities can write for one payload, in declaration order. */
export function sb3SupportedSaveFormats(payload, capabilities) {
    return Object.freeze(sb3SaveFormats.filter((format) => sb3SaveFormatSupport(payload, format, capabilities).supported));
}
function optionalFormat(value, payload) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !sb3SaveFormats.includes(value))
        throw new TypeError(`The ${payload} format must be one of ${sb3SaveFormats.join(', ')}, received ${String(value)}`);
    return value;
}
/**
 * Validate a selection and refuse one these capabilities cannot honour, naming the payload, the
 * format and what is missing. A payload left unset is kept as it is; a named one is never
 * silently downgraded or ignored.
 */
export function normalizeSb3SaveSelection(input, capabilities) {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new TypeError('A save selection object is required');
    const record = input;
    const allowed = new Set([...sb3SavePayloads, 'assetsAsProjectAssets']);
    for (const name of Object.keys(record))
        if (!allowed.has(name))
            throw new TypeError(`Unknown save option ${name}`);
    if (record.assetsAsProjectAssets !== undefined &&
        typeof record.assetsAsProjectAssets !== 'boolean')
        throw new TypeError('assetsAsProjectAssets must be a boolean');
    const selection = Object.freeze({
        extensions: optionalFormat(record.extensions, 'extensions'),
        source: optionalFormat(record.source, 'source'),
        assets: optionalFormat(record.assets, 'assets'),
        assetsAsProjectAssets: record.assetsAsProjectAssets === true,
    });
    for (const payload of sb3SavePayloads) {
        const format = selection[payload];
        if (format === undefined)
            continue;
        const support = sb3SaveFormatSupport(payload, format, capabilities);
        if (!support.supported)
            throw new TypeError(`Cannot save ${payload} as ${format}: ${support.reason}`);
    }
    if (selection.assetsAsProjectAssets) {
        const support = capabilities.projectAssets();
        if (!support.supported) {
            if (!support.reason)
                throw new TypeError('The capabilities refused project assets without saying what is missing');
            throw new TypeError(`Cannot store assets as project assets: ${support.reason}`);
        }
    }
    return selection;
}
/** A one-line report of what these capabilities can write, for `--help` and for diagnostics. */
export function describeSb3SaveFormats(capabilities) {
    return sb3SavePayloads
        .map((payload) => {
        const formats = sb3SupportedSaveFormats(payload, capabilities);
        return `${payload}: ${formats.length ? formats.join('|') : 'kept as built'}`;
    })
        .join('; ');
}
