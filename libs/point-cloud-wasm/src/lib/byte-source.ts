/** Synchronous blob reader, the subset of `FileReaderSync` used by `createBlobSource`. */
export interface SyncArrayBufferReader {
    readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

/**
 * Random-access byte source consumed by the wasm `WasmReader.openRandom`.
 * Re-entrancy rule: `read` is called from inside wasm and must never call back into the reader.
 */
export interface ByteSource {
    /** Total number of bytes. */
    readonly size: number;
    /** Returns up to `length` bytes starting at `offset`; an empty array at or after the end. */
    read(offset: number, length: number): Uint8Array;
}

/**
 * Wraps `blob` as a synchronous `ByteSource`.
 * Defaults to `FileReaderSync`, so it only works in a dedicated worker unless `reader` is given.
 */
export function createBlobSource(blob: Blob, reader?: SyncArrayBufferReader): ByteSource {
    const syncReader = reader ?? defaultReader();
    const size = blob.size;
    return {
        size,
        read(offset: number, length: number): Uint8Array {
            const start = Math.max(0, offset);
            const end = Math.min(start + Math.max(0, length), size);
            if (start >= size || end <= start) {
                return new Uint8Array(0);
            }
            return new Uint8Array(syncReader.readAsArrayBuffer(blob.slice(start, end)));
        },
    };
}

function defaultReader(): SyncArrayBufferReader {
    const ctor = (globalThis as { FileReaderSync?: new () => SyncArrayBufferReader }).FileReaderSync;
    if (!ctor) {
        throw new Error('FileReaderSync is not available; E57 parsing must run in a dedicated worker');
    }
    return new ctor();
}
