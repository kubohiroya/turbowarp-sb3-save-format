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
import React, { useMemo, useState } from 'react';
import { chooseSb3ProjectAssets, chooseSb3SaveFormat, sb3SaveDialogModel, } from './dialog-model.js';
const TEXT = {
    en: {
        title: 'Save in a chosen format',
        keep: 'Keep as built',
        projectAssets: 'Also store each asset as a costume, a backdrop or a sound',
        save: 'Save',
        cancel: 'Cancel',
        unwritable: 'This build cannot write any form for this part.',
        refused: 'Kept as built, because this build cannot write the form it was set to:',
        payloads: { extensions: 'Extensions', source: 'Source data', assets: 'Assets' },
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
        payloads: { extensions: '機能拡張', source: 'ソースデータ', assets: 'アセット' },
        formats: {
            'remote-non-cacheable': '参照のみ、控えを持たない',
            'remote-cacheable': '参照のみ、控えを持ってよい',
            'embedded-file': '作品の中のファイル',
            'embedded-data': '作品の文書の中',
        },
    },
};
export function Sb3SaveFormatDialog({ capabilities, draft, onDraftChange, onSave, onCancel, language = 'en', title, }) {
    const text = TEXT[language] ?? TEXT.en;
    const [ownDraft, setOwnDraft] = useState({});
    const current = draft ?? ownDraft;
    const model = useMemo(() => sb3SaveDialogModel(capabilities, current), [capabilities, current]);
    const update = (next) => {
        if (draft === undefined)
            setOwnDraft(next);
        onDraftChange?.(next);
    };
    const describe = (payload, format) => `${text.payloads[payload]}: ${text.formats[format]}`;
    return (React.createElement("div", { className: "twp-save-format", role: "dialog", "aria-label": title ?? text.title },
        React.createElement("h2", { className: "twp-save-format__title" }, title ?? text.title),
        model.refusals.length > 0 && (React.createElement("div", { className: "twp-save-format__refusals", role: "status" },
            React.createElement("p", null, text.refused),
            React.createElement("ul", null, model.refusals.map((refusal) => (React.createElement("li", { key: `${refusal.payload}:${refusal.format ?? 'project-assets'}` }, refusal.reason)))))),
        model.rows.map((row) => (React.createElement("fieldset", { className: "twp-save-format__row", key: row.payload },
            React.createElement("legend", null, text.payloads[row.payload]),
            !row.writable && React.createElement("p", { className: "twp-save-format__note" }, text.unwritable),
            React.createElement("label", { className: "twp-save-format__option" },
                React.createElement("input", { type: "radio", name: `twp-save-format-${row.payload}`, checked: row.keepSelected, onChange: () => update(chooseSb3SaveFormat(current, row.payload, null)) }),
                React.createElement("span", null, text.keep)),
            row.options.map((option) => (React.createElement("label", { className: option.enabled
                    ? 'twp-save-format__option'
                    : 'twp-save-format__option twp-save-format__option--disabled', key: option.format, title: option.reason },
                React.createElement("input", { type: "radio", name: `twp-save-format-${row.payload}`, checked: option.selected, disabled: !option.enabled, onChange: () => update(chooseSb3SaveFormat(current, row.payload, option.format)), "aria-label": describe(row.payload, option.format) }),
                React.createElement("span", null, text.formats[option.format]),
                !option.enabled && option.reason && (React.createElement("small", { className: "twp-save-format__reason" }, option.reason)))))))),
        React.createElement("label", { className: model.projectAssets.enabled
                ? 'twp-save-format__option'
                : 'twp-save-format__option twp-save-format__option--disabled', title: model.projectAssets.reason },
            React.createElement("input", { type: "checkbox", checked: model.projectAssets.selected, disabled: !model.projectAssets.enabled, onChange: (event) => update(chooseSb3ProjectAssets(current, event.target.checked)) }),
            React.createElement("span", null, text.projectAssets),
            !model.projectAssets.enabled && model.projectAssets.reason && (React.createElement("small", { className: "twp-save-format__reason" }, model.projectAssets.reason))),
        React.createElement("div", { className: "twp-save-format__actions" },
            React.createElement("button", { type: "button", onClick: onCancel }, text.cancel),
            React.createElement("button", { type: "button", onClick: () => onSave(model.selection) }, text.save))));
}
