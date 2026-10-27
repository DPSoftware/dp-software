import type {ErrorCode, RGB} from "@dp-software/point-cloud";

/** Point cloud formats the worker can be asked for by name. */
export type PointCloudFormat = 'pts' | 'e57' | 'ply';

/** Starts reading `file` in the worker. */
export interface OpenMessage {
    type: 'open';
    jobId: number;
    file: Blob;
    /** Format to read, or `'auto'` to detect it from the first bytes and the file name. */
    format: PointCloudFormat | 'auto';
    voxelSize: number;
    /** Whether rows without color are accepted (stream formats such as PTS). */
    acceptColorless: boolean;
    /** Color assigned to points that carry no color. */
    defaultColor: RGB;
    /** Whether per-point intensities are sent with each `points` message, where the format has them. */
    intensities: boolean;
    /** Kept points per `points` message for random-access formats. Defaults to the wasm reader's batch size. */
    batchSize?: number;
    /** Bytes read from the file per `push` for stream formats. Defaults to 4 MiB. */
    chunkSize?: number;
    /** URL of `point_cloud_wasm_core_bg.wasm`. Defaults to the URL resolved by the wasm package. */
    wasmUrl?: string;
}

/** Messages the main thread sends to the worker. */
export type MainMessage = OpenMessage;

/** Metadata of one sub-cloud (for example an E57 scan). */
export interface SubCloudInfo {
    /** Zero-based position of the sub-cloud in the file. */
    index: number;
    name: string | null;
    guid: string | null;
    /** Number of point records stored for the sub-cloud before filtering, `null` when unknown. */
    records: number | null;
    /** Pose translation. Sub-clouds without a pose report the identity (`[0, 0, 0]`); `null` when the reader has no pose data. */
    translation: [number, number, number] | null;
    /** Pose rotation quaternion as `[w, x, y, z]`. Sub-clouds without a pose report the identity (`[1, 0, 0, 0]`); `null` when the reader has no pose data. */
    rotation: [number, number, number, number] | null;
    hasColor: boolean;
    hasIntensity: boolean;
    hasNormals: boolean;
}

/** Point count declared in the file header, `null` when absent. */
export interface HeaderMessage {
    type: 'header';
    jobId: number;
    total: number | null;
}

/** Detected format, sent before `header` only when the request was `format: 'auto'`. */
export interface FormatMessage {
    type: 'format';
    jobId: number;
    format: string;
}

/** Metadata of one sub-cloud, sent once per sub-cloud before any points, only for multi-cloud formats. */
export interface CloudMessage {
    type: 'cloud';
    jobId: number;
    cloud: SubCloudInfo;
}

/** A batch of kept points as interleaved xyz positions and rgb colors. */
export interface PointsMessage {
    type: 'points';
    jobId: number;
    positions: Float64Array;
    colors: Uint8Array;
    /** Per-point intensities in 0..1, only when requested and provided by the format. */
    intensities?: Float32Array;
    /** Sub-cloud the batch came from, only for multi-cloud formats. */
    cloud?: number;
}

/** Loading progress in the range 0..1. */
export interface ProgressMessage {
    type: 'progress';
    jobId: number;
    value: number;
}

/**
 * Non-fatal errors: record errors of one batch (`INVALID_ROW`) or a failed sub-cloud (`CLOUD_ERROR`, with `cloud`).
 * `dropped` counts errors not included in `messages`.
 */
export interface ErrorMessage {
    type: 'error';
    jobId: number;
    code: ErrorCode;
    messages: string[];
    dropped: number;
    /** Index of the failed sub-cloud, for `CLOUD_ERROR`. */
    cloud?: number;
}

/** Parsing ended successfully. */
export interface FinishMessage {
    type: 'finish';
    jobId: number;
}

/** Parsing aborted, either while loading the wasm module or while reading. No `finish` follows. */
export interface FatalMessage {
    type: 'fatal';
    jobId: number;
    stage: 'init' | 'run';
    code: ErrorCode;
    message: string;
}

/** Messages the worker sends to the main thread. */
export type WorkerMessage =
    | HeaderMessage
    | FormatMessage
    | CloudMessage
    | PointsMessage
    | ProgressMessage
    | ErrorMessage
    | FinishMessage
    | FatalMessage;

const WORKER_MESSAGE_TYPES: ReadonlyArray<WorkerMessage['type']> = [
    'header', 'format', 'cloud', 'points', 'progress', 'error', 'finish', 'fatal',
];

/** Checks that `data` looks like a `WorkerMessage`. */
export function isWorkerMessage(data: unknown): data is WorkerMessage {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const msg = data as { type?: unknown; jobId?: unknown };
    return typeof msg.jobId === 'number'
        && WORKER_MESSAGE_TYPES.includes(msg.type as WorkerMessage['type']);
}

/** Checks that `data` is an `OpenMessage`. */
export function isOpenMessage(data: unknown): data is OpenMessage {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const msg = data as { type?: unknown; jobId?: unknown; format?: unknown };
    return msg.type === 'open' && typeof msg.jobId === 'number' && typeof msg.format === 'string';
}
