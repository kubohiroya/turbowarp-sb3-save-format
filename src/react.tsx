/**
 * The "save in a chosen format" dialog.
 *
 * Every rule about what can be chosen lives in {@link sb3SaveDialogModel}; this component only
 * draws the rows it returns. A form this build cannot write is shown disabled with the reason
 * beside it, rather than hidden: a person who came looking for it should learn what is missing.
 *
 * The host supplies the capabilities, so the same dialog refuses different things in a CLI-backed
 * build and in the editor.
 */

import React, {useMemo, useState} from 'react';

import {
  chooseSb3ProjectAssets,
  chooseSb3SaveFormat,
  sb3SaveDialogModel,
  type Sb3SaveDraft,
} from './dialog-model.js';
import type {
  Sb3SaveCapabilities,
  Sb3SaveFormat,
  Sb3SavePayload,
  Sb3SaveSelection,
} from './index.js';

export type Sb3SaveDialogLanguage = 'en' | 'ja';

const TEXT = {
  en: {
    title: 'Save in a chosen format',
    keep: 'Keep as built',
    projectAssets: 'Also store each asset as a costume, a backdrop or a sound',
    save: 'Save',
    cancel: 'Cancel',
    unwritable: 'This build cannot write any form for this part.',
    refused: 'Kept as built, because this build cannot write the form it was set to:',
    payloads: {extensions: 'Extensions', source: 'Source data', assets: 'Assets'},
    formats: {
      'remote-non-cacheable': 'Reference only, no copy kept',
      'remote-cacheable': 'Reference, a copy may be kept',
      'embedded-file': 'A file inside the project',
      'embedded-data': 'Inside the project document',
    },
  },
  ja: {
    title: '形式を指定して保存',
    keep: 'そのまま保持',
    projectAssets: 'アセットをコスチューム・背景・音としても格納する',
    save: '保存',
    cancel: 'キャンセル',
    unwritable: 'このビルドはこの部分をどの形式でも書けません。',
    refused: '設定されていた形式をこのビルドが書けないため、そのまま保持します:',
    payloads: {extensions: '機能拡張', source: 'ソースデータ', assets: 'アセット'},
    formats: {
      'remote-non-cacheable': '参照のみ、控えを持たない',
      'remote-cacheable': '参照のみ、控えを持ってよい',
      'embedded-file': '作品の中のファイル',
      'embedded-data': '作品の文書の中',
    },
  },
} as const;

export interface Sb3SaveFormatDialogProps {
  /** What this build can write. The dialog shows the rest disabled, with the reason. */
  readonly capabilities: Sb3SaveCapabilities;
  /** Supply it to control the dialog; leave it out and the dialog keeps its own draft. */
  readonly draft?: Sb3SaveDraft;
  readonly onDraftChange?: (draft: Sb3SaveDraft) => void;
  readonly onSave: (selection: Sb3SaveSelection) => void;
  readonly onCancel: () => void;
  readonly language?: Sb3SaveDialogLanguage;
  readonly title?: string;
}

export function Sb3SaveFormatDialog({
  capabilities,
  draft,
  onDraftChange,
  onSave,
  onCancel,
  language = 'en',
  title,
}: Sb3SaveFormatDialogProps) {
  const text = TEXT[language] ?? TEXT.en;
  const [ownDraft, setOwnDraft] = useState<Sb3SaveDraft>({});
  const current = draft ?? ownDraft;
  const model = useMemo(() => sb3SaveDialogModel(capabilities, current), [capabilities, current]);

  const update = (next: Sb3SaveDraft) => {
    if (draft === undefined) setOwnDraft(next);
    onDraftChange?.(next);
  };

  const describe = (payload: Sb3SavePayload, format: Sb3SaveFormat) =>
    `${text.payloads[payload]}: ${text.formats[format]}`;

  return (
    <div className="twp-save-format" role="dialog" aria-label={title ?? text.title}>
      <h2 className="twp-save-format__title">{title ?? text.title}</h2>

      {model.refusals.length > 0 && (
        <div className="twp-save-format__refusals" role="status">
          <p>{text.refused}</p>
          <ul>
            {model.refusals.map((refusal) => (
              <li key={`${refusal.payload}:${refusal.format ?? 'project-assets'}`}>
                {refusal.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {model.rows.map((row) => (
        <fieldset className="twp-save-format__row" key={row.payload}>
          <legend>{text.payloads[row.payload]}</legend>
          {!row.writable && <p className="twp-save-format__note">{text.unwritable}</p>}
          <label className="twp-save-format__option">
            <input
              type="radio"
              name={`twp-save-format-${row.payload}`}
              checked={row.keepSelected}
              onChange={() => update(chooseSb3SaveFormat(current, row.payload, null))}
            />
            <span>{text.keep}</span>
          </label>
          {row.options.map((option) => (
            <label
              className={
                option.enabled
                  ? 'twp-save-format__option'
                  : 'twp-save-format__option twp-save-format__option--disabled'
              }
              key={option.format}
              title={option.reason}
            >
              <input
                type="radio"
                name={`twp-save-format-${row.payload}`}
                checked={option.selected}
                disabled={!option.enabled}
                onChange={() => update(chooseSb3SaveFormat(current, row.payload, option.format))}
                aria-label={describe(row.payload, option.format)}
              />
              <span>{text.formats[option.format]}</span>
              {!option.enabled && option.reason && (
                <small className="twp-save-format__reason">{option.reason}</small>
              )}
            </label>
          ))}
        </fieldset>
      ))}

      <label
        className={
          model.projectAssets.enabled
            ? 'twp-save-format__option'
            : 'twp-save-format__option twp-save-format__option--disabled'
        }
        title={model.projectAssets.reason}
      >
        <input
          type="checkbox"
          checked={model.projectAssets.selected}
          disabled={!model.projectAssets.enabled}
          onChange={(event) => update(chooseSb3ProjectAssets(current, event.target.checked))}
        />
        <span>{text.projectAssets}</span>
        {!model.projectAssets.enabled && model.projectAssets.reason && (
          <small className="twp-save-format__reason">{model.projectAssets.reason}</small>
        )}
      </label>

      <div className="twp-save-format__actions">
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
        <button type="button" onClick={() => onSave(model.selection)}>
          {text.save}
        </button>
      </div>
    </div>
  );
}
