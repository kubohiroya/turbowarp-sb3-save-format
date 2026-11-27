import type { createProjectPayloadCodec } from './project-payloads.js';
export declare function createNativeAssetConversion({ bundleMaterials }: Pick<ReturnType<typeof createProjectPayloadCodec>, 'bundleMaterials'>): {
    nativeAssetConversion: (vm: any, vmModules: any, guard: any) => {
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
};
