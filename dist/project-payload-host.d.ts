import type { createProjectPayloadCodec, PayloadProjectArchive as ProjectArchive } from './project-payloads.js';
export declare function createProjectPayloadService(codec: ReturnType<typeof createProjectPayloadCodec>): {
    saveProjectForPackager: (vm: any) => any;
    createProjectPayloadHost: (vm: any, { fetch, cache, approve, validate, canEdit, vmModules }: any) => {
        canEdit: any;
        canConvert: any;
        convert(): {
            materials: {
                key: string;
                label: string;
                kinds: string[];
            }[];
            targets: {
                id: string;
                name: string;
                stage: boolean;
            }[];
            add({ key, kind, targetId }: any, signal: any): Promise<string>;
        } | null;
        readonly active: boolean;
        loadStarted(): void;
        clear(): void;
        dispose(): void;
        read(input: any, signal: any, archive?: ProjectArchive): Promise<{
            input: any;
            settings: Map<any, any>;
            claims?: never;
        } | {
            input: string | Uint8Array<ArrayBufferLike>;
            settings: Map<string, import("./project-payloads.js").PayloadEntry>;
            claims: (string | Uint8Array<ArrayBufferLike>)[][];
        }>;
        loaded(result: any, signal: any): Promise<void>;
        edit(): {
            items: {
                id: string;
                kind: "source" | "assets";
                label: string;
                key: string;
                format: any;
                url: any;
            }[];
            apply(choices: any, signal: any): Promise<void>;
        };
        writeZip(zip: any): any;
        withEmbedded<T>(run: () => T): T;
        embedOnSave(): () => void;
    };
};
