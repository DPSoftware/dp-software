import type {ErrorCode} from "@dp-software/point-cloud";
import {isWorkerMessage, MainMessage, WorkerMessage} from "./protocol.js";

/** Callbacks of a running worker job. */
export interface WorkerJobHandlers {
    /** A protocol message of this job. Not called after `stop()` or a failure. */
    message(msg: WorkerMessage): void;
    /** The worker could not be created, loaded or reached, or a message could not be deserialized. The job is already stopped. */
    fail(stage: 'init' | 'run', message: string, code: ErrorCode): void;
}

/** A started worker job. */
export interface WorkerJob {
    readonly jobId: number;
    /** Detaches the handlers and terminates the worker. Idempotent. */
    stop(): void;
}

let nextJobId = 1;

/** Turns any thrown value into a message string. */
export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Creates a worker with `factory`, posts `start(jobId)` and forwards the worker's messages of this job to `handlers`.
 * Creation, load, post and deserialization failures stop the job and are reported through `handlers.fail`.
 */
export function startWorkerJob(
    factory: () => Worker,
    start: (jobId: number) => MainMessage,
    handlers: WorkerJobHandlers,
    labels: { loadError: string },
): WorkerJob {
    const jobId = nextJobId++;
    let worker: Worker | null = null;
    let stopped = false;

    const stop = () => {
        stopped = true;
        if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
            worker = null;
        }
    };

    const fail = (stage: 'init' | 'run', message: string, code: ErrorCode) => {
        if (stopped) {
            return;
        }
        stop();
        handlers.fail(stage, message, code);
    };

    const job: WorkerJob = {jobId, stop};

    try {
        worker = factory();
    } catch (e) {
        fail('init', errorMessage(e), 'INIT_FAILED');
        return job;
    }

    worker.onmessage = (event: MessageEvent) => {
        const msg: unknown = event.data;
        if (stopped || !isWorkerMessage(msg) || msg.jobId !== jobId) {
            return;
        }
        handlers.message(msg);
    };
    worker.onerror = (event: ErrorEvent) => {
        event.preventDefault?.();
        fail('init', event.message || labels.loadError, 'INIT_FAILED');
    };
    worker.onmessageerror = () => {
        fail('run', 'Worker message could not be deserialized', 'READ_ERROR');
    };

    try {
        worker.postMessage(start(jobId));
    } catch (e) {
        fail('init', errorMessage(e), 'INIT_FAILED');
    }
    return job;
}
