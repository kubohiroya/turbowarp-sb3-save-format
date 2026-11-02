/**
 * What a "save in a chosen format" dialog shows, derived from one implementation's capabilities.
 *
 * The model is dependency-free and holds no state: a host keeps a draft and asks for the model
 * again after each change. That keeps every rule about what can be chosen — and why a choice is
 * refused — in one tested place instead of inside a component, and lets a CLI print the same rows
 * a dialog would draw.
 */

import {
  normalizeSb3SaveSelection,
  sb3SaveFormats,
  sb3SaveFormatSupport,
  sb3SavePayloads,
  type Sb3SaveCapabilities,
  type Sb3SaveFormat,
  type Sb3SavePayload,
  type Sb3SaveSelection,
} from './index.js';

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

const draftFormat = (value: Sb3SaveDraftFormat | undefined): Sb3SaveFormat | null => {
  if (value === undefined || value === null) return null;
  if (!sb3SaveFormats.includes(value)) throw new TypeError(`Unknown save format ${String(value)}`);
  return value;
};

/**
 * Derive the rows, the honourable selection and the refusals from a draft.
 *
 * A draft that names a form these capabilities cannot write is not an error: a project saved by
 * another build, or a remembered choice, can carry one. The payload is kept as built and the
 * reason is reported, so a host can say why instead of writing something else.
 */
export function sb3SaveDialogModel(
  capabilities: Sb3SaveCapabilities,
  draft: Sb3SaveDraft = {},
): Sb3SaveDialogModel {
  const chosen = new Map<Sb3SavePayload, Sb3SaveFormat | null>();
  for (const payload of sb3SavePayloads) chosen.set(payload, draftFormat(draft[payload]));

  const refusals: Sb3SaveDialogRefusal[] = [];
  const honoured: Partial<Record<Sb3SavePayload, Sb3SaveFormat>> = {};

  const rows = sb3SavePayloads.map((payload): Sb3SaveDialogRow => {
    const pick = chosen.get(payload) ?? null;
    const options = sb3SaveFormats.map((format): Sb3SaveDialogOption => {
      const support = sb3SaveFormatSupport(payload, format, capabilities);
      const selected = pick === format && support.supported;
      return support.supported
        ? Object.freeze({format, enabled: true, selected})
        : Object.freeze({format, enabled: false, reason: support.reason, selected: false});
    });
    if (pick !== null) {
      const support = sb3SaveFormatSupport(payload, pick, capabilities);
      if (support.supported) honoured[payload] = pick;
      else refusals.push(Object.freeze({payload, format: pick, reason: support.reason ?? ''}));
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
    refusals.push(
      Object.freeze({
        payload: 'assetsAsProjectAssets' as const,
        reason: projectAssetSupport.reason ?? '',
      }),
    );
  const projectAssets: Sb3SaveDialogToggle = projectAssetSupport.supported
    ? Object.freeze({enabled: true, selected: wantsProjectAssets})
    : Object.freeze({enabled: false, reason: projectAssetSupport.reason, selected: false});

  // Built from the honoured choices only, so it always passes the shared validation.
  const selection = normalizeSb3SaveSelection(
    {...honoured, assetsAsProjectAssets: projectAssets.selected},
    capabilities,
  );
  const unchanged =
    !selection.assetsAsProjectAssets &&
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
export function chooseSb3SaveFormat(
  draft: Sb3SaveDraft,
  payload: Sb3SavePayload,
  format: Sb3SaveDraftFormat,
): Sb3SaveDraft {
  if (!sb3SavePayloads.includes(payload)) throw new TypeError(`Unknown save payload ${payload}`);
  return Object.freeze({...draft, [payload]: draftFormat(format)});
}

/** Turn "also store each asset as a costume, a backdrop or a sound" on or off. */
export function chooseSb3ProjectAssets(draft: Sb3SaveDraft, on: boolean): Sb3SaveDraft {
  if (typeof on !== 'boolean') throw new TypeError('assetsAsProjectAssets must be a boolean');
  return Object.freeze({...draft, assetsAsProjectAssets: on});
}
