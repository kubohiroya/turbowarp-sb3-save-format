import JSZip from '@turbowarp/jszip';
import { type Sb3SaveFormat } from './index.js';
export interface PayloadProjectArchive {
    readonly project: Record<string, unknown>;
    readonly projectBytes: number;
    openZip(): JSZip;
}
export interface PayloadItem {
    kind: 'source' | 'assets';
    key: string;
    label: string;
    bytes: Uint8Array;
}
export interface PayloadEntry {
    kind: 'source' | 'assets';
    key: string;
    format: Sb3SaveFormat;
    url?: string;
    sha256?: string;
    data?: string;
    bytes?: Uint8Array;
}
type ProjectJSON = Record<string, any>;
export interface PayloadStorageOptions {
    fetch?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
}
export interface PayloadArchiveOptions {
    maxProjectBytes: number;
    maxEntryBytes: number;
}
/** The distribution selects archive limits; conversion and validation belong to this package. */
export declare function createProjectPayloadCodec(extensionProjectArchiveOptions: PayloadArchiveOptions): {
    payloadKey: string;
    bundleMaterials: (project: ProjectJSON) => {
        key: string;
        label: string;
        name: any;
        path: any;
        bytes: Uint8Array<ArrayBuffer>;
    }[];
    inventory: (project: ProjectJSON, assets: Record<string, Uint8Array>) => Map<string, PayloadItem>;
    configurePayloads: (items: ReadonlyMap<string, PayloadItem>, choices: ReadonlyMap<string, {
        format: Sb3SaveFormat;
        url?: string;
    }>, { fetch, signal }?: PayloadStorageOptions) => Promise<Map<string, PayloadEntry>>;
    encodePayloads: (project: ProjectJSON, assets: Record<string, Uint8Array>, settings: ReadonlyMap<string, PayloadEntry>) => {
        files: {
            'project.json': Uint8Array<ArrayBuffer>;
        };
        removed: string[];
    };
    embedPackagedProjectData: (bytes: Uint8Array, project: Record<string, unknown>) => Promise<Uint8Array<ArrayBufferLike>>;
    decodePayloads: (input: any, { fetch, cache, approve, validate, signal, archive }?: PayloadStorageOptions & {
        cache?: import("@kubohiroya/turbowarp-extension-loader").LoaderPorts["cache"];
        approve?: (urls: string[], cacheable: boolean, signal: AbortSignal | undefined) => Promise<boolean | undefined>;
        validate?: (input: unknown, options?: {
            signal?: AbortSignal | undefined;
        }) => Promise<unknown>;
        archive?: PayloadProjectArchive | undefined;
    }) => Promise<{
        input: any;
        settings: Map<any, any>;
        claims?: never;
    } | {
        input: string | Uint8Array<ArrayBufferLike>;
        settings: Map<string, PayloadEntry>;
        claims: (string | Uint8Array<ArrayBufferLike>)[][];
    }>;
};
export {};
