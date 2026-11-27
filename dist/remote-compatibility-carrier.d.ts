export declare const remoteCarrierMarker = "// TurboWarp Plus remote compatibility carrier v1\n";
interface RemoteCarrierSource {
    readonly id: string;
    readonly url: string;
    readonly sha256: string;
    readonly version?: string | undefined;
}
export declare function remoteCompatibilityCarrier(source: RemoteCarrierSource, limits: {
    maxBytes: number;
    timeoutMs: number;
}): string;
export {};
