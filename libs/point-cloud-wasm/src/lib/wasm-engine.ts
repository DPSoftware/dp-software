import type {ErrorCode, PtsEngine, PtsEngineSink, ResolvedPtsOptions} from "@dp-software/point-cloud";
import type {OpenMessage, WorkerMessage} from "./protocol.js";
import {toPointCloudData} from "./convert.js";
import {createReaderWorker} from "./reader-worker-factory.js";
import {errorMessage, startWorkerJob, WorkerJob} from "./worker-job.js";

/** Options for the WebAssembly PTS engine. */
export interface WasmEngineOptions {
    /** Creates the parsing worker. Defaults to the bundled `reader.worker.js` module worker. */
    workerFactory?: () => Worker;
    /** URL of `point_cloud_wasm_core_bg.wasm`. Defaults to the URL bundled with this package (`wasm/point_cloud_wasm_core_bg.wasm`). */
    wasmUrl?: string | URL;
    /** Engine used when the worker or the wasm module fails to load before any points are emitted. */
    fallback?: PtsEngine;
    /** Bytes read from the file per wasm `push`. Defaults to 4 MiB. */
    chunkSize?: number;
}

/** Returns true when the environment has both `WebAssembly` and `Worker`. */
export function isWasmEngineSupported(): boolean {
    return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

/**
 * Creates a WebAssembly PTS engine for `PTSParser`.
 * Returns null when the environment is unsupported and no `workerFactory` is given.
 */
export function createWasmEngine(options: WasmEngineOptions = {}): PtsEngine | null {
    if (!options.workerFactory && !isWasmEngineSupported()) {
        return null;
    }
    return new WasmWorkerPtsEngine(options);
}

/** PTS engine that parses in a Web Worker with the Rust/WASM reader. One run at a time. */
export class WasmWorkerPtsEngine implements PtsEngine {

    private readonly options: WasmEngineOptions;
    private running = false;

    /** @param options see `WasmEngineOptions` */
    public constructor(options: WasmEngineOptions = {}) {
        this.options = options;
    }

    /** Parses `file` in a fresh worker, reporting everything through `sink`. */
    public run(file: Blob, opts: ResolvedPtsOptions, sink: PtsEngineSink): void {
        if (this.running) {
            sink.error('WasmWorkerPtsEngine is already running', 'BUSY', true);
            sink.finish();
            return;
        }
        this.running = true;

        let job: WorkerJob | null = null;
        let done = false;
        let pointsEmitted = false;

        const release = () => {
            this.running = false;
            job?.stop();
        };

        const finish = () => {
            if (done) {
                return;
            }
            done = true;
            release();
            sink.finish();
        };

        const fail = (stage: 'init' | 'run', message: string, code: ErrorCode) => {
            if (done) {
                return;
            }
            const fallback = this.options.fallback;
            if (stage === 'init' && !pointsEmitted && fallback) {
                done = true;
                release();
                try {
                    fallback.run(file, opts, sink);
                } catch (e) {
                    sink.error(errorMessage(e), 'UNKNOWN', true);
                    sink.finish();
                }
                return;
            }
            sink.error(message, code, true);
            finish();
        };

        const handle = (msg: WorkerMessage) => {
            switch (msg.type) {
                case 'header':
                    sink.header(msg.total ?? NaN);
                    break;
                case 'points':
                    pointsEmitted = true;
                    sink.points(toPointCloudData(msg.positions, msg.colors));
                    break;
                case 'progress':
                    sink.progress(msg.value);
                    break;
                case 'error':
                    for (const m of msg.messages) {
                        sink.error(m, msg.code, false);
                    }
                    if (msg.dropped > 0) {
                        sink.error(`${msg.dropped} more row errors`, 'INVALID_ROW', false);
                    }
                    break;
                case 'finish':
                    finish();
                    break;
                case 'fatal':
                    fail(msg.stage, msg.message, msg.code);
                    break;
            }
        };

        const open = (jobId: number): OpenMessage => {
            const msg: OpenMessage = {
                type: 'open',
                jobId,
                file,
                format: 'pts',
                voxelSize: opts.voxelSize,
                acceptColorless: opts.acceptColorless,
                defaultColor: opts.defaultColor,
                intensities: false,
            };
            if (this.options.wasmUrl !== undefined) {
                msg.wasmUrl = String(this.options.wasmUrl);
            }
            if (this.options.chunkSize !== undefined) {
                msg.chunkSize = this.options.chunkSize;
            }
            return msg;
        };

        job = startWorkerJob(
            this.options.workerFactory ?? createReaderWorker,
            open,
            {message: handle, fail},
            {loadError: 'Failed to load the PTS worker'},
        );
    }
}
