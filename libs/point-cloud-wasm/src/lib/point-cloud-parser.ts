import {DEFAULT_COLOR, Observable} from "@dp-software/point-cloud";
import type {ErrorCode, ParseResult, ParseStatus, PointCloudError, PtsEngine, PtsEngineSink, ResolvedPtsOptions, RGB} from "@dp-software/point-cloud";
import type {OpenMessage, PointCloudFormat, SubCloudInfo, WorkerMessage} from "./protocol.js";
import {fromPointCloudData} from "./convert.js";
import {createReaderWorker} from "./reader-worker-factory.js";
import {errorMessage, startWorkerJob, WorkerJob} from "./worker-job.js";

/** A batch of kept points as interleaved typed arrays, exactly as transferred from the worker. */
export interface PointBatch {
    /** Interleaved xyz positions. */
    positions: Float64Array;
    /** Interleaved rgb colors, 0..255. */
    colors: Uint8Array;
    /** Per-point intensities in 0..1, only when requested and provided by the format. */
    intensities?: Float32Array;
    /** Sub-cloud the points belong to; 0 for single-cloud formats. */
    cloud: number;
}

/** File-level information, emitted once before any points. */
export interface CloudInfo {
    /** Format being read, as requested or as detected for `'auto'`. */
    format: PointCloudFormat | string;
    /** Point records declared by the file before filtering, `null` when unknown. */
    totalPoints: number | null;
}

/** Options for `PointCloudParser`. */
export interface PointCloudParserOptions {
    /** Format of the file. `'auto'` (the default) detects it from the first bytes and the file name. */
    format?: PointCloudFormat | 'auto';
    /** Edge length of the voxel cell used for downsampling. Defaults to 0.02. */
    voxelSize?: number;
    /** Accept rows without color (PTS). Defaults to false. */
    acceptColorless?: boolean;
    /** Color assigned to points without color. Defaults to grey. */
    defaultColor?: RGB;
    /** Emit per-point intensities (0..1) where the format has them. Defaults to false. */
    intensities?: boolean;
    /** Kept points per batch for random-access formats such as E57. Defaults to the wasm reader's batch size. */
    batchSize?: number;
    /** Bytes read per wasm `push` for stream formats such as PTS. Defaults to 4 MiB. */
    chunkSize?: number;
    /** Creates the parsing worker. Defaults to the bundled `reader.worker.js` module worker. */
    workerFactory?: () => Worker;
    /** URL of `point_cloud_wasm_core_bg.wasm`. Defaults to the URL bundled with this package (`wasm/point_cloud_wasm_core_bg.wasm`). */
    wasmUrl?: string | URL;
    /**
     * PTS engine used when the worker or the wasm module fails to load before any points are emitted.
     * Only used for `format: 'pts'`, or for `'auto'` with a file name ending in `.pts`.
     */
    ptsFallback?: PtsEngine;
}

/** Returns true when the environment has both `WebAssembly` and `Worker`, which `PointCloudParser` requires. */
export function isPointCloudParserSupported(): boolean {
    return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

function canFallBack(format: PointCloudFormat | 'auto', file: Blob): boolean {
    if (format === 'pts') {
        return true;
    }
    const name = (file as Partial<File>).name;
    return format === 'auto' && typeof name === 'string' && name.toLowerCase().endsWith('.pts');
}

/**
 * Parses point cloud files (PTS, E57, ...) in a Web Worker with the Rust/WASM reader, with voxel downsampling.
 * Points arrive on `onBatch` as typed arrays without any main-thread conversion; use `toPointCloudData` for tuples.
 * One file at a time per instance.
 */
export class PointCloudParser {

    /** Format and declared point count, emitted once before any points. */
    public readonly onInfo = new Observable<CloudInfo>();
    /** Declared point records before filtering, `NaN` when unknown. */
    public readonly onNumberOfPoints = new Observable<number>();
    /** Metadata of each sub-cloud, before any points; only for multi-cloud formats such as E57. */
    public readonly onCloud = new Observable<SubCloudInfo>();
    /** Batches of kept points. */
    public readonly onBatch = new Observable<PointBatch>();
    /** Loading progress in the range 0..1. */
    public readonly loadingStatus = new Observable<number>();
    /** Fatal, per-cloud and record errors as messages; also receives the aggregated "N more errors" line. */
    public readonly onParseError = new Observable<string>();
    /** Fatal, per-cloud and record errors with their code. Dropped errors only count towards `errorCount`. */
    public readonly onError = new Observable<PointCloudError>();
    /** Parsing ended, successfully, with a fatal error, or by `cancel`. Fires exactly once per `parse`. */
    public readonly onFinish = new Observable<ParseResult>();

    private readonly options: PointCloudParserOptions;
    private running = false;
    private stop: (() => void) | null = null;

    /** @param options see `PointCloudParserOptions` */
    public constructor(options: PointCloudParserOptions = {}) {
        this.options = options;
        this.loadingStatus.notify(0);
    }

    /** Parses `file` in a fresh worker. Does nothing while a previous `parse` is still running. */
    public parse(file: Blob): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.loadingStatus.notify(0);

        const options = this.options;
        const format = options.format ?? 'auto';
        const voxelSize = options.voxelSize ?? 0.02;
        const acceptColorless = options.acceptColorless ?? false;
        const defaultColor = options.defaultColor ?? DEFAULT_COLOR;
        let job: WorkerJob | null = null;
        let finished = false;
        let batchEmitted = false;
        let detected: string = format;
        let errorCount = 0;
        let status: ParseStatus = 'OK';

        const report = (error: PointCloudError) => {
            errorCount++;
            if (error.fatal && status === 'OK') {
                status = error.code;
            }
            this.onParseError.notify(error.message);
            this.onError.notify(error);
        };

        const done = () => {
            if (finished) {
                return;
            }
            finished = true;
            job?.stop();
            this.stop = null;
            this.running = false;
            this.onFinish.notify({status, errorCount});
        };

        const cancel = () => {
            if (!finished && status === 'OK') {
                status = 'CANCELLED';
            }
            done();
        };

        const runFallback = (engine: PtsEngine) => {
            job?.stop();
            const resolved: ResolvedPtsOptions = {voxelSize, acceptColorless, defaultColor};
            const sink: PtsEngineSink = {
                header: total => {
                    if (!finished) {
                        this.onInfo.notify({format: 'pts', totalPoints: Number.isNaN(total) ? null : total});
                        this.onNumberOfPoints.notify(total);
                    }
                },
                points: data => {
                    if (!finished) {
                        this.onBatch.notify(fromPointCloudData(data));
                    }
                },
                progress: value => {
                    if (!finished) {
                        this.loadingStatus.notify(value);
                    }
                },
                error: (message, code = 'UNKNOWN', fatal = false) => {
                    if (!finished) {
                        report({code, message, fatal});
                    }
                },
                finish: done,
            };
            try {
                engine.run(file, resolved, sink);
            } catch (e) {
                if (!finished) {
                    report({code: 'UNKNOWN', message: errorMessage(e), fatal: true});
                }
                done();
            }
        };

        const fail = (stage: 'init' | 'run', message: string, code: ErrorCode) => {
            if (finished) {
                return;
            }
            const fallback = options.ptsFallback;
            if (stage === 'init' && !batchEmitted && fallback && canFallBack(format, file)) {
                runFallback(fallback);
                return;
            }
            report({code, message, fatal: true});
            done();
        };

        const handle = (msg: WorkerMessage) => {
            switch (msg.type) {
                case 'format':
                    detected = msg.format;
                    break;
                case 'header':
                    this.onInfo.notify({format: detected, totalPoints: msg.total});
                    this.onNumberOfPoints.notify(msg.total ?? NaN);
                    break;
                case 'cloud':
                    this.onCloud.notify(msg.cloud);
                    break;
                case 'points': {
                    batchEmitted = true;
                    const batch: PointBatch = {positions: msg.positions, colors: msg.colors, cloud: msg.cloud ?? 0};
                    if (msg.intensities !== undefined) {
                        batch.intensities = msg.intensities;
                    }
                    this.onBatch.notify(batch);
                    break;
                }
                case 'progress':
                    this.loadingStatus.notify(msg.value);
                    break;
                case 'error':
                    for (const m of msg.messages) {
                        const error: PointCloudError = {code: msg.code, message: m, fatal: false};
                        if (msg.cloud !== undefined) {
                            error.cloud = msg.cloud;
                        }
                        report(error);
                    }
                    if (msg.dropped > 0) {
                        errorCount += msg.dropped;
                        this.onParseError.notify(`${msg.dropped} more errors`);
                    }
                    break;
                case 'finish':
                    done();
                    break;
                case 'fatal':
                    fail(msg.stage, msg.message, msg.code);
                    break;
            }
        };

        this.stop = cancel;

        if (!options.workerFactory && !isPointCloudParserSupported()) {
            fail('init', 'Point cloud parsing requires WebAssembly and Web Workers', 'INIT_FAILED');
            return;
        }

        const open = (jobId: number): OpenMessage => {
            const msg: OpenMessage = {
                type: 'open',
                jobId,
                file,
                format,
                voxelSize,
                acceptColorless,
                defaultColor,
                intensities: options.intensities ?? false,
            };
            if (options.batchSize !== undefined) {
                msg.batchSize = options.batchSize;
            }
            if (options.chunkSize !== undefined) {
                msg.chunkSize = options.chunkSize;
            }
            if (options.wasmUrl !== undefined) {
                msg.wasmUrl = String(options.wasmUrl);
            }
            return msg;
        };

        job = startWorkerJob(
            options.workerFactory ?? createReaderWorker,
            open,
            {message: handle, fail},
            {loadError: 'Failed to load the point cloud worker'},
        );
    }

    /**
     * Stops the current run by terminating its worker, then fires `onFinish` with status `CANCELLED`. No-op when idle.
     * Events stop immediately, but during the `ptsFallback` JS engine (`PtsEngine` has no cancel) the file may keep
     * being read in the background until it ends.
     */
    public cancel(): void {
        this.stop?.();
    }
}
