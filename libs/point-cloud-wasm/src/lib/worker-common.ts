import init from './wasm/point_cloud_wasm_core.js';
import type {ErrorCode} from "@dp-software/point-cloud";
import type {WorkerMessage} from "./protocol.js";

/** The parts of the dedicated worker global scope the workers use. */
export interface WorkerCtx {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
}

/** Returns the worker global scope typed as `WorkerCtx`. */
export function workerCtx(): WorkerCtx {
    return self as unknown as WorkerCtx;
}

/** Turns any thrown value into a message string. */
export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
    'NO_COLOR', 'INVALID_ROW', 'INVALID_HEADER', 'UNKNOWN_FORMAT', 'UNSUPPORTED_FORMAT',
    'CLOUD_ERROR', 'READ_ERROR', 'INIT_FAILED', 'BUSY', 'UNKNOWN',
]);

/** Returns the `code` property of a thrown value when it is a known error code, else `UNKNOWN`. */
export function errorCode(e: unknown): ErrorCode {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    return typeof code === 'string' && ERROR_CODES.has(code) ? code as ErrorCode : 'UNKNOWN';
}

/** Loads the wasm module, from `wasmUrl` when given, else from the URL resolved by the wasm package. */
export async function initWasm(wasmUrl?: string): Promise<void> {
    if (wasmUrl) {
        await init({module_or_path: wasmUrl});
    } else {
        await init();
    }
}
