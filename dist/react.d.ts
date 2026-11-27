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
import React from 'react';
import { type Sb3SaveDraft } from './dialog-model.js';
import type { Sb3SaveCapabilities, Sb3SaveSelection } from './index.js';
export type Sb3SaveDialogLanguage = 'en' | 'ja';
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
export declare function Sb3SaveFormatDialog({ capabilities, draft, onDraftChange, onSave, onCancel, language, title, }: Sb3SaveFormatDialogProps): React.JSX.Element;
