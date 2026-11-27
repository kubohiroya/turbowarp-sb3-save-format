/**
 * What a "save in a chosen format" dialog shows, derived from one implementation's capabilities.
 *
 * The model is dependency-free and holds no state: a host keeps a draft and asks for the model
 * again after each change. That keeps every rule about what can be chosen — and why a choice is
 * refused — in one tested place instead of inside a component, and lets a CLI print the same rows
 * a dialog would draw.
 */
import { normalizeSb3SaveSelection, sb3SaveFormats, sb3SaveFormatSupport, sb3SavePayloads, } from './index.js';
const draftFormat = (value) => {
    if (value === undefined || value === null)
        return null;
    if (!sb3SaveFormats.includes(value))
        throw new TypeError(`Unknown save format ${String(value)}`);
    return value;
};
/**
 * Derive the rows, the honourable selection and the refusals from a draft.
 *
 * A draft that names a form these capabilities cannot write is not an error: a project saved by
 * another build, or a remembered choice, can carry one. The payload is kept as built and the
 * reason is reported, so a host can say why instead of writing something else.
 */
export function sb3SaveDialogModel(capabilities, draft = {}) {
    const chosen = new Map();
    for (const payload of sb3SavePayloads)
        chosen.set(payload, draftFormat(draft[payload]));
    const refusals = [];
    const honoured = {};
    const rows = sb3SavePayloads.map((payload) => {
        const pick = chosen.get(payload) ?? null;
        const options = sb3SaveFormats.map((format) => {
            const support = sb3SaveFormatSupport(payload, format, capabilities);
            const selected = pick === format && support.supported;
            return support.supported
                ? Object.freeze({ format, enabled: true, selected })
                : Object.freeze({ format, enabled: false, reason: support.reason, selected: false });
        });
        if (pick !== null) {
            const support = sb3SaveFormatSupport(payload, pick, capabilities);
            if (support.supported)
                honoured[payload] = pick;
            else
                refusals.push(Object.freeze({ payload, format: pick, reason: support.reason ?? '' }));
        }
        return Object.freeze({
            payload,
            options: Object.freeze(options),
            keepSelected: honoured[payload] === undefined,
            writable: options.some((option) => option.enabled),
        });
    });
    const wantsProjectAssets = draft.assetsAsProjectAssets === true;
    const projectAssetSupport = capabilities.projectAssets();
    if (wantsProjectAssets && !projectAssetSupport.supported)
        refusals.push(Object.freeze({
            payload: 'assetsAsProjectAssets',
            reason: projectAssetSupport.reason ?? '',
        }));
    const projectAssets = projectAssetSupport.supported
        ? Object.freeze({ enabled: true, selected: wantsProjectAssets })
        : Object.freeze({ enabled: false, reason: projectAssetSupport.reason, selected: false });
    // Built from the honoured choices only, so it always passes the shared validation.
    const selection = normalizeSb3SaveSelection({ ...honoured, assetsAsProjectAssets: projectAssets.selected }, capabilities);
    const unchanged = !selection.assetsAsProjectAssets &&
        sb3SavePayloads.every((payload) => selection[payload] === undefined);
    return Object.freeze({
        rows: Object.freeze(rows),
        projectAssets,
        selection,
        refusals: Object.freeze(refusals),
        unchanged,
    });
}
/** Choose a form for one payload, or `null` to keep it as built. */
export function chooseSb3SaveFormat(draft, payload, format) {
    if (!sb3SavePayloads.includes(payload))
        throw new TypeError(`Unknown save payload ${payload}`);
    return Object.freeze({ ...draft, [payload]: draftFormat(format) });
}
/** Turn "also store each asset as a costume, a backdrop or a sound" on or off. */
export function chooseSb3ProjectAssets(draft, on) {
    if (typeof on !== 'boolean')
        throw new TypeError('assetsAsProjectAssets must be a boolean');
    return Object.freeze({ ...draft, assetsAsProjectAssets: on });
}
