/// <reference lib="webworker" />
import {detectFormat, formatKind, PointBatch, ReadOptions, WasmReader} from './wasm/point_cloud_wasm_core.js';
import {errorCode, errorMessage, initWasm, workerCtx} from "./worker-common.js";
import {isOpenMessage, OpenMessage, PointsMessage, SubCloudInfo} from "./protocol.js";
import {createBlobSource} from "./byte-source.js";

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_BATCH_POINTS = 131072;
const DETECT_BYTES = 64 * 1024;

const ctx = workerCtx();

let busy = false;

ctx.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isOpenMessage(data)) {
        return;
    }
    if (busy) {
        ctx.postMessage({type: 'fatal', jobId: data.jobId, stage: 'run', code: 'BUSY', message: 'Worker busy'});
        return;
    }
    busy = true;
    const release = () => {
        busy = false;
    };
    runJob(data).then(release, release);
};

/** Loads the wasm module, resolves the format and reads `msg.file` with the matching access kind. */
async function runJob(msg: OpenMessage): Promise<void> {
    const {jobId, file} = msg;

    try {
        await initWasm(msg.wasmUrl);
    } catch (e) {
        ctx.postMessage({type: 'fatal', jobId, stage: 'init', code: 'INIT_FAILED', message: errorMessage(e)});
        return;
    }

    let reader: WasmReader | null = null;
    try {
        let format: string = msg.format;
        if (format === 'auto') {
            const head = new Uint8Array(await file.slice(0, DETECT_BYTES).arrayBuffer());
            const detected = detectFormat(head, (file as Partial<File>).name);
            if (detected === undefined) {
                ctx.postMessage({type: 'fatal', jobId, stage: 'run', code: 'UNKNOWN_FORMAT', message: 'Unknown point cloud format'});
                return;
            }
            format = detected;
            ctx.postMessage({type: 'format', jobId, format});
        }

        const kind = formatKind(format);
        if (kind === undefined) {
            ctx.postMessage({
                type: 'fatal', jobId, stage: 'run', code: 'UNSUPPORTED_FORMAT',
                message: `Format ${format} is not supported by this build`,
            });
            return;
        }

        const options: ReadOptions = {
            voxelSize: msg.voxelSize,
            acceptColorless: msg.acceptColorless,
            defaultColor: msg.defaultColor,
            intensities: msg.intensities,
            batchPoints: msg.batchSize && msg.batchSize > 0 ? msg.batchSize : DEFAULT_BATCH_POINTS,
        };
        if (kind === 'random') {
            reader = WasmReader.openRandom(format, createBlobSource(file), options);
            readRandom(msg, reader);
        } else {
            reader = WasmReader.openStream(format, options);
            await readStream(msg, reader);
        }
    } catch (e) {
        ctx.postMessage({type: 'fatal', jobId, stage: 'run', code: errorCode(e), message: errorMessage(e)});
    } finally {
        if (reader) {
            try {
                reader.free();
            } catch {
                // already freed or wasm memory is unusable; nothing left to release
            }
        }
    }
}

/**
 * Feeds the file to a stream reader in `chunkSize` slices; progress is bytes read / file size.
 * Stops early once the reader reports `isComplete()` and then reports progress 1.
 */
async function readStream(msg: OpenMessage, reader: WasmReader): Promise<void> {
    const {jobId, file} = msg;
    const chunkSize = msg.chunkSize && msg.chunkSize > 0 ? msg.chunkSize : DEFAULT_CHUNK_SIZE;

    let headerSent = false;
    let off = 0;
    let complete = false;
    while (off < file.size) {
        const buf = new Uint8Array(await file.slice(off, off + chunkSize).arrayBuffer());
        if (buf.byteLength === 0) {
            break;
        }
        const batch = reader.push(buf);
        if (!headerSent && (reader.totalPoints() !== undefined || reader.recordsRead() > 0)) {
            headerSent = true;
            ctx.postMessage({type: 'header', jobId, total: reader.totalPoints() ?? null});
        }
        emit(jobId, batch, false);
        off += buf.byteLength;
        ctx.postMessage({type: 'progress', jobId, value: off / file.size});
        if (reader.isComplete()) {
            complete = true;
            break;
        }
    }

    emit(jobId, reader.finish(), false);
    if (!headerSent) {
        ctx.postMessage({type: 'header', jobId, total: reader.totalPoints() ?? null});
    }
    if (file.size === 0 || (complete && off < file.size)) {
        ctx.postMessage({type: 'progress', jobId, value: 1});
    }
    ctx.postMessage({type: 'finish', jobId});
}

/** Reads every sub-cloud of a random-access reader; progress is records read / total records. */
function readRandom(msg: OpenMessage, reader: WasmReader): void {
    const {jobId} = msg;
    const total = reader.totalPoints() ?? null;
    ctx.postMessage({type: 'header', jobId, total});

    const cloudCount = reader.cloudCount();
    for (let i = 0; i < cloudCount; i++) {
        ctx.postMessage({type: 'cloud', jobId, cloud: readCloudInfo(reader, i)});
    }

    // The sink runs inside readCloud; calling back into the reader from here is a
    // wasm-bindgen re-entrancy error that turns into a sink failure.
    const sink = {
        onBatch(batch: PointBatch): void {
            const recordsRead = batch.recordsRead;
            emit(jobId, batch, true);
            ctx.postMessage({type: 'progress', jobId, value: total ? Math.min(1, recordsRead / total) : 1});
        },
    };

    for (let i = 0; i < cloudCount; i++) {
        try {
            const summary = reader.readCloud(i, sink);
            summary.free();
        } catch (e) {
            if (reader.failed()) {
                ctx.postMessage({type: 'fatal', jobId, stage: 'run', code: errorCode(e), message: errorMessage(e)});
                return;
            }
            const code = errorCode(e);
            ctx.postMessage({
                type: 'error', jobId, code: code === 'UNKNOWN' ? 'CLOUD_ERROR' : code,
                messages: [errorMessage(e)], dropped: 0, cloud: i,
            });
        }
    }

    ctx.postMessage({type: 'progress', jobId, value: 1});
    ctx.postMessage({type: 'finish', jobId});
}

/** Posts the points and errors of `batch` with its buffers transferred, then frees it. */
function emit(jobId: number, batch: PointBatch, withCloud: boolean): void {
    try {
        const positions = batch.takePositions();
        const colors = batch.takeColors();
        const intensities = batch.takeIntensities();
        const errors = batch.takeErrors();
        const dropped = Math.max(0, batch.errorCount - errors.length);

        if (positions.length) {
            const msg: PointsMessage = {type: 'points', jobId, positions, colors};
            const transfer: Transferable[] = [positions.buffer, colors.buffer];
            if (intensities) {
                msg.intensities = intensities;
                transfer.push(intensities.buffer);
            }
            if (withCloud) {
                msg.cloud = batch.cloud;
            }
            ctx.postMessage(msg, transfer);
        }
        if (errors.length || dropped) {
            ctx.postMessage({type: 'error', jobId, code: 'INVALID_ROW', messages: errors, dropped});
        }
    } finally {
        batch.free();
    }
}

/** Copies the metadata of sub-cloud `index` into a plain protocol object and frees the wasm handle. */
function readCloudInfo(reader: WasmReader, index: number): SubCloudInfo {
    const info = reader.cloudInfo(index);
    try {
        const translation = Array.from(info.translation());
        const rotation = Array.from(info.rotation());
        return {
            index,
            name: info.name ?? null,
            guid: info.guid || null,
            records: info.records ?? null,
            translation: translation.length === 3 ? translation as [number, number, number] : null,
            rotation: rotation.length === 4 ? rotation as [number, number, number, number] : null,
            hasColor: info.hasColor,
            hasIntensity: info.hasIntensity,
            hasNormals: info.hasNormals,
        };
    } finally {
        info.free();
    }
}
