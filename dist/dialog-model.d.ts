/**
 * What a "save in a chosen format" dialog shows, derived from one implementation's capabilities.
 *
 * The model is dependency-free and holds no state: a host keeps a draft and asks for the model
 * again after each change. That keeps every rule about what can be chosen — and why a choice is
 * refused — in one tested place instead of inside a component, and lets a CLI print the same rows
 * a dialog would draw.
 */
import { type Sb3SaveCapabilities, type Sb3SaveFormat, type Sb3SavePayload, type Sb3SaveSelection } from './index.js';
/** A payload's choice, or `null` for "keep it exactly as the project already stores it". */
export type Sb3SaveDraftFormat = Sb3SaveFormat | null;
export interface Sb3SaveDraft {
    readonly extensions?: Sb3SaveDraftFormat | undefined;
    readonly source?: Sb3SaveDraftFormat | undefined;
    readonly assets?: Sb3SaveDraftFormat | undefined;
    readonly assetsAsProjectAssets?: boolean | undefined;
}
export interface Sb3SaveDialogOption {
    readonly format: Sb3SaveFormat;
    readonly enabled: boolean;
    /** Present when the option is disabled, saying what is missing. */
    readonly reason?: string | undefined;
    readonly selected: boolean;
}
export interface Sb3SaveDialogRow {
    readonly payload: Sb3SavePayload;
    readonly options: readonly Sb3SaveDialogOption[];
    /** True when nothing is chosen for this payload, so it is kept as built. */
    readonly keepSelected: boolean;
    /** False when this implementation can write no form at all for this payload. */
    readonly writable: boolean;
}
export interface Sb3SaveDialogToggle {
    readonly enabled: boolean;
    readonly reason?: string | undefined;
    readonly selected: boolean;
}
/** A draft choice these capabilities cannot honour, so the model left it out of the selection. */
export interface Sb3SaveDialogRefusal {
    readonly payload: Sb3SavePayload | 'assetsAsProjectAssets';
    readonly format?: Sb3SaveFormat;
    readonly reason: string;
}
export interface Sb3SaveDialogModel {
    readonly rows: readonly Sb3SaveDialogRow[];
    readonly projectAssets: Sb3SaveDialogToggle;
    /**
     * The selection a save would use: only choices these capabilities can honour, so a host can
     * pass it on without a second validation. A refused draft choice is reported in `refusals`
     * and the payload stays as built rather than being silently downgraded.
     */
    readonly selection: Sb3SaveSelection;
    readonly refusals: readonly Sb3SaveDialogRefusal[];
    /** True when the selection would change nothing. */
    readonly unchanged: boolean;
}
/**
 * Derive the rows, the honourable selection and the refusals from a draft.
 *
 * A draft that names a form these capabilities cannot write is not an error: a project saved by
 * another build, or a remembered choice, can carry one. The payload is kept as built and the
 * reason is reported, so a host can say why instead of writing something else.
 */
export declare function sb3SaveDialogModel(capabilities: Sb3SaveCapabilities, draft?: Sb3SaveDraft): Sb3SaveDialogModel;
/** Choose a form for one payload, or `null` to keep it as built. */
export declare function chooseSb3SaveFormat(draft: Sb3SaveDraft, payload: Sb3SavePayload, format: Sb3SaveDraftFormat): Sb3SaveDraft;
/** Turn "also store each asset as a costume, a backdrop or a sound" on or off. */
export declare function chooseSb3ProjectAssets(draft: Sb3SaveDraft, on: boolean): Sb3SaveDraft;
