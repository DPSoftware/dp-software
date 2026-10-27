// Node integration test: runs the REAL generic `WasmReader` and the built `reader.worker.js` against the
// sphere.pts fixture and the two-scan E57 fixture owned by the private Rust repo (never copied here).
// Run via `nx test-integration point-cloud-wasm`. Override the E57 fixture with E57_FIXTURE=/path/to/file.e57.
import {describe, it, before} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const e57Path = process.env.E57_FIXTURE
    ?? path.join(repoRoot, 'external/pointcloud-processor-rs/crates/point-cloud-wasm-core/tests/data/two_scans.e57');
const e57Exists = existsSync(e57Path);
const skipE57 = e57Exists ? false : `E57 fixture not found at ${e57Path} (set E57_FIXTURE to run)`;

const distLib = path.join(repoRoot, 'dist/libs/point-cloud-wasm/src/lib');
const wasmDir = path.join(distLib, 'wasm');
const wasm = await import(pathToFileURL(path.join(wasmDir, 'point_cloud_wasm_core.js')).href);
const {initSync, WasmReader, detectFormat, formatKind, formats} = wasm;
// The worker's own `init()` returns early once the module is instantiated here.
initSync({module: readFileSync(path.join(wasmDir, 'point_cloud_wasm_core_bg.wasm'))});

const VOXEL = 0.05;
const CHUNK = 64 * 1024;
const sphere = readFileSync(path.join(repoRoot, 'libs/point-cloud/tests/data/sphere.pts'));
const e57 = e57Exists ? readFileSync(e57Path) : Buffer.alloc(0);

/** Feeds `bytes` to a stream reader in `chunk`-sized pieces and collects everything it returns. */
function runStream(bytes, {voxelSize = VOXEL, chunk = CHUNK, acceptColorless = false, format = 'pts'} = {}) {
    const reader = WasmReader.openStream(format, {voxelSize, acceptColorless, defaultColor: [128, 128, 128]});
    const out = {positions: [], colors: [], errors: [], errorCount: 0, records: 0, batches: []};
    const collect = (batch) => {
        try {
            out.batches.push({cloud: batch.cloud, recordsRead: batch.recordsRead, intensities: batch.takeIntensities()});
            out.records += batch.records;
            out.positions.push(...batch.takePositions());
            out.colors.push(...batch.takeColors());
            out.errors.push(...batch.takeErrors());
            out.errorCount += batch.errorCount;
        } finally {
            batch.free();
        }
    };
    try {
        assert.equal(reader.format, format);
        assert.equal(reader.kind, 'stream');
        for (let i = 0; i < bytes.length; i += chunk) {
            collect(reader.push(new Uint8Array(bytes.subarray(i, i + chunk))));
        }
        collect(reader.finish());
        return {
            ...out,
            total: reader.totalPoints(),
            kept: reader.keptPoints(),
            recordsRead: reader.recordsRead(),
            bytesRead: reader.bytesRead(),
            cloudCount: reader.cloudCount(),
        };
    } finally {
        reader.free();
    }
}

/** sphere.pts converted to PLY (x y z double, red green blue uchar) in `encoding`. */
function spherePly(encoding) {
    const rows = sphere.toString('utf8').split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.split(' ').map(Number));
    const header = Buffer.from(`ply\nformat ${encoding} 1.0\ncomment from sphere.pts\nelement vertex ${rows.length}\n`
        + 'property double x\nproperty double y\nproperty double z\n'
        + 'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n');
    if (encoding === 'ascii') {
        return Buffer.concat([header, Buffer.from(rows.map((r) => [r[0], r[1], r[2], r[4], r[5], r[6]].join(' ')).join('\n') + '\n')]);
    }
    const body = Buffer.alloc(rows.length * 27);
    rows.forEach((r, i) => {
        for (let k = 0; k < 3; k++) body.writeDoubleLE(r[k], i * 27 + k * 8);
        for (let k = 0; k < 3; k++) body.writeUInt8(r[4 + k], i * 27 + 24 + k);
    });
    return Buffer.concat([header, body]);
}
const sphereBinaryPly = spherePly('binary_little_endian');

/** Blob-like file over a Buffer whose slices can also be read synchronously by the FileReaderSync shim. */
function fakeFile(buf, name) {
    const make = (bytes) => ({
        size: bytes.length,
        bytes,
        slice: (a = 0, b = bytes.length) => make(bytes.subarray(a, b)),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    return Object.assign(make(buf), {name});
}

/** Loads the built worker into this process with a fake dedicated-worker scope; returns a job runner. */
async function loadWorker() {
    let listener = null;
    globalThis.self = globalThis;
    globalThis.postMessage = (msg) => listener?.(msg);
    globalThis.FileReaderSync = class {
        readAsArrayBuffer(blob) {
            const b = blob.bytes;
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
    };
    await import(pathToFileURL(path.join(distLib, 'reader.worker.js')).href);
    let nextJob = 1;
    return (file, extra = {}) => new Promise((resolve) => {
        const jobId = nextJob++;
        const messages = [];
        listener = (msg) => {
            messages.push(msg);
            if (msg.type === 'finish' || msg.type === 'fatal') {
                listener = null;
                resolve(messages);
            }
        };
        globalThis.onmessage({
            data: {
                type: 'open', jobId, file, format: 'auto', voxelSize: VOXEL, acceptColorless: false,
                defaultColor: [128, 128, 128], intensities: false, ...extra,
            },
        });
    });
}

const keptIn = (messages) => messages.filter((m) => m.type === 'points').reduce((n, m) => n + m.positions.length / 3, 0);

describe('WasmReader registry', () => {
    it('lists the compiled-in formats and their access kinds', () => {
        const names = formats();
        assert.ok(names.includes('pts'), `formats: ${names}`);
        assert.ok(names.includes('e57'), `formats: ${names}`);
        assert.ok(names.includes('ply'), `formats: ${names}`);
        assert.equal(formatKind('pts'), 'stream');
        assert.equal(formatKind('e57'), 'random');
        assert.equal(formatKind('ply'), 'stream');
        assert.equal(formatKind('las'), undefined);
    });

    it('detects PTS by content and E57 by magic or by name', () => {
        assert.equal(detectFormat(new Uint8Array(sphere.subarray(0, 65536))), 'pts');
        assert.equal(detectFormat(new Uint8Array(0), 'two_scans.e57'), 'e57');
        assert.equal(detectFormat(new Uint8Array(sphereBinaryPly.subarray(0, 65536)), 'renamed.pts'), 'ply');
        assert.equal(detectFormat(new TextEncoder().encode('no point cloud here')), undefined);
    });

    it('detects the E57 fixture by its magic bytes even with a .pts name', {skip: skipE57}, () => {
        assert.equal(detectFormat(new Uint8Array(e57.subarray(0, 65536)), 'wrong.pts'), 'e57');
    });

    it('rejects unknown formats and the wrong access kind', () => {
        const opts = {voxelSize: VOXEL};
        assert.throws(() => WasmReader.openStream('nope', opts), /Unknown point cloud format/);
        assert.throws(() => WasmReader.openStream('e57', opts), /openRandom/);
        const src = {size: 0, read: () => new Uint8Array(0)};
        assert.throws(() => WasmReader.openRandom('pts', src, opts), /openStream/);
    });
});

describe('WasmReader stream (pts) against sphere.pts', () => {
    let base;
    before(() => {
        base = runStream(sphere);
    });

    it('keeps 4459 points of 10000 with no errors and counts records and bytes', () => {
        assert.equal(base.total, 10000);
        assert.equal(base.kept, 4459);
        assert.equal(base.positions.length, 4459 * 3);
        assert.equal(base.errorCount, 0);
        assert.equal(base.recordsRead, 10000);
        assert.equal(base.records, 10000);
        assert.equal(base.bytesRead, sphere.length);
        assert.equal(base.cloudCount, 0);
        assert.equal(base.batches.at(-1).recordsRead, 10000);
        for (const b of base.batches) {
            assert.equal(b.cloud, 0);
            assert.equal(b.intensities, undefined);
        }
    });

    it('returns identical points for 7-byte chunks', () => {
        const small = runStream(sphere, {chunk: 7});
        assert.deepEqual(small.positions, base.positions);
        assert.deepEqual(small.colors, base.colors);
    });

    it('reports bad rows in order without aborting the stream', () => {
        const text = '4\n1 2 3 0 1 2 3\nbad row\n4 5 6 0 1 2 3\nalso bad\n';
        const r = runStream(Buffer.from(text), {voxelSize: 0});
        assert.equal(r.kept, 2);
        assert.equal(r.errorCount, 2);
        assert.match(r.errors[0], /Invalid row/);
        assert.match(r.errors[0], /bad row/);
        assert.match(r.errors[1], /also bad/);
    });

    it('throws a NO_COLOR error from push or finish for a colorless row and keeps throwing it', () => {
        const text = '3\n1 2 3 0 1 2 3\n7 8 9\n4 5 6 0 1 2 3\n';
        assert.throws(() => runStream(Buffer.from(text), {voxelSize: 0}), (e) => {
            assert.ok(e instanceof Error);
            assert.equal(e.code, 'NO_COLOR');
            assert.match(e.message, /color/i);
            return true;
        });
        const reader = WasmReader.openStream('pts', {voxelSize: 0, acceptColorless: false, defaultColor: [128, 128, 128]});
        try {
            const bytes = new Uint8Array(Buffer.from(text));
            assert.throws(() => reader.push(bytes), (e) => e.code === 'NO_COLOR');
            assert.throws(() => reader.push(bytes), (e) => e.code === 'NO_COLOR');
            assert.throws(() => reader.finish(), (e) => e.code === 'NO_COLOR');
        } finally {
            reader.free();
        }
        assert.equal(runStream(Buffer.from(text), {voxelSize: 0, acceptColorless: true}).kept, 3);
    });

    it('throws UNSUPPORTED_FORMAT for an unknown format name', () => {
        assert.throws(() => WasmReader.openStream('nope', {voxelSize: 0, acceptColorless: false, defaultColor: [1, 2, 3]}),
            (e) => e.code === 'UNSUPPORTED_FORMAT');
    });
});

describe('WasmReader random access (e57) against two_scans.e57', {skip: skipE57}, () => {
    it('reads both clouds through a sink that takes the arrays inside onBatch', () => {
        const reader = WasmReader.openRandom('e57', {
            size: e57.length,
            read: (o, l) => new Uint8Array(e57.subarray(o, Math.min(o + l, e57.length))),
        }, {voxelSize: 0, intensities: true, batchPoints: 1000});
        try {
            assert.equal(reader.format, 'e57');
            assert.equal(reader.kind, 'random');
            assert.throws(() => reader.push(new Uint8Array(1)), /stream formats/);
            let kept = 0;
            let records = 0;
            const clouds = new Set();
            const sink = {
                onBatch(batch) {
                    try {
                        const positions = batch.takePositions();
                        const intensities = batch.takeIntensities();
                        assert.equal(intensities.length, positions.length / 3);
                        assert.equal(batch.takeErrors().length, 0);
                        kept += positions.length / 3;
                        records += batch.records;
                        clouds.add(batch.cloud);
                    } finally {
                        batch.free();
                    }
                },
            };
            for (let i = 0; i < reader.cloudCount(); i++) {
                reader.readCloud(i, sink).free();
            }
            assert.equal(kept, 4000);
            assert.equal(records, 4000);
            assert.equal(reader.recordsRead(), 4000);
            assert.equal(reader.keptPoints(), 4000);
            assert.equal(reader.bytesRead(), 0);
            assert.deepEqual([...clouds], [0, 1]);
            assert.equal(reader.failed(), false);
        } finally {
            reader.free();
        }
    });

    it('reports a per-cloud error for an out-of-range cloud without failing the reader', () => {
        const reader = WasmReader.openRandom('e57', {
            size: e57.length,
            read: (o, l) => new Uint8Array(e57.subarray(o, Math.min(o + l, e57.length))),
        }, {voxelSize: 0});
        try {
            assert.throws(() => reader.cloudInfo(5), /out of range/);
            assert.throws(() => reader.readCloud(5, {onBatch: () => undefined}), (e) => /Scan 5/.test(e.message) && e.code === 'CLOUD_ERROR');
            assert.equal(reader.failed(), false);
        } finally {
            reader.free();
        }
    });

    it('throws "E57 open failed" for bytes that are not E57', () => {
        const bytes = new Uint8Array(4096);
        assert.throws(() => WasmReader.openRandom('e57', {size: bytes.length, read: (o, l) => bytes.slice(o, o + l)}, {voxelSize: 0}),
            /E57 open failed/);
    });
});

describe('reader.worker end to end', () => {
    let runJob;
    before(async () => {
        runJob = await loadWorker();
    });

    it('detects and reads sphere.pts: format, header, 4459 points, progress 1, finish', async () => {
        const messages = await runJob(fakeFile(sphere, 'sphere.pts'));
        const types = messages.map((m) => m.type);
        assert.equal(types[0], 'format');
        assert.equal(messages[0].format, 'pts');
        assert.equal(types[1], 'header');
        assert.equal(messages[1].total, 10000);
        assert.ok(!types.includes('cloud'));
        assert.ok(!types.includes('error'));
        assert.equal(keptIn(messages), 4459);
        assert.ok(messages.filter((m) => m.type === 'points').every((m) => !('cloud' in m) && !('intensities' in m)));
        assert.equal(messages.filter((m) => m.type === 'progress').at(-1).value, 1);
        assert.equal(types.at(-1), 'finish');
    });

    it('reads an explicit pts job without a format message', async () => {
        const messages = await runJob(fakeFile(sphere), {format: 'pts', chunkSize: 100000});
        assert.equal(messages[0].type, 'header');
        assert.equal(keptIn(messages), 4459);
        assert.equal(messages.filter((m) => m.type === 'progress').length, Math.ceil(sphere.length / 100000));
    });

    it('detects and reads the E57 fixture: two clouds, 4000 points with intensities', {skip: skipE57}, async () => {
        const messages = await runJob(fakeFile(e57, 'two_scans.e57'), {voxelSize: 0, intensities: true, batchSize: 1000});
        const types = messages.map((m) => m.type);
        assert.deepEqual(types.slice(0, 4), ['format', 'header', 'cloud', 'cloud']);
        assert.equal(messages[0].format, 'e57');
        assert.equal(messages[1].total, 4000);
        assert.deepEqual(messages[2].cloud.translation, [1.5, -2.25, 0.5]);
        assert.equal(messages[3].cloud.records, 2000);
        const points = messages.filter((m) => m.type === 'points');
        assert.equal(keptIn(messages), 4000);
        assert.ok(points.every((m) => m.intensities.length === m.positions.length / 3));
        assert.deepEqual([...new Set(points.map((m) => m.cloud))], [0, 1]);
        assert.equal(types.at(-2), 'progress');
        assert.equal(types.at(-1), 'finish');
    });

    it('posts a fatal NO_COLOR with zero points and no finish for a colorless PTS', async () => {
        const text = '3\n1 2 3 0 1 2 3\n7 8 9\n4 5 6 0 1 2 3\n';
        const messages = await runJob(fakeFile(Buffer.from(text), 'colorless.pts'), {format: 'pts', voxelSize: 0});
        const types = messages.map((m) => m.type);
        assert.equal(keptIn(messages), 0);
        assert.ok(!types.includes('finish'));
        assert.ok(!types.includes('error'));
        assert.equal(types.at(-1), 'fatal');
        assert.equal(messages.at(-1).code, 'NO_COLOR');
        assert.equal(messages.at(-1).stage, 'run');
        assert.match(messages.at(-1).message, /color/i);
    });

    it('accepts a colorless PTS when acceptColorless is set', async () => {
        const text = '2\n1 2 3\n4 5 6\n';
        const messages = await runJob(fakeFile(Buffer.from(text), 'colorless.pts'), {format: 'pts', voxelSize: 0, acceptColorless: true});
        assert.equal(keptIn(messages), 2);
        assert.equal(messages.at(-1).type, 'finish');
    });

    it('posts INVALID_ROW errors for malformed rows and still finishes', async () => {
        const text = '3\n1 2 3 0 1 2 3\nbad row\n4 5 6 0 1 2 3\n';
        const messages = await runJob(fakeFile(Buffer.from(text), 'bad.pts'), {format: 'pts', voxelSize: 0});
        const errors = messages.filter((m) => m.type === 'error');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 'INVALID_ROW');
        assert.equal(keptIn(messages), 2);
        assert.equal(messages.at(-1).type, 'finish');
    });

    it('posts a run fatal for an undetectable file', async () => {
        const messages = await runJob(fakeFile(Buffer.from('hello world'), 'notes.txt'));
        assert.deepEqual(messages, [{
            type: 'fatal', jobId: messages[0].jobId, stage: 'run', code: 'UNKNOWN_FORMAT', message: 'Unknown point cloud format',
        }]);
    });

    it('posts a run fatal for a detected format that is not compiled in', {skip: formatKind('las') ? 'las is compiled in' : false}, async () => {
        const messages = await runJob(fakeFile(Buffer.concat([Buffer.from('LASF'), Buffer.alloc(256)]), 'scan.las'));
        assert.equal(messages[0].type, 'format');
        assert.equal(messages[0].format, 'las');
        assert.equal(messages[1].type, 'fatal');
        assert.equal(messages[1].code, 'UNSUPPORTED_FORMAT');
        assert.equal(messages[1].message, 'Format las is not supported by this build');
    });

    it('auto-detects a binary PLY by magic and keeps 4459 points like PTS', async () => {
        const messages = await runJob(fakeFile(sphereBinaryPly, 'sphere.dat'), {chunkSize: 100000});
        const types = messages.map((m) => m.type);
        assert.deepEqual(types.slice(0, 2), ['format', 'header']);
        assert.equal(messages[0].format, 'ply');
        assert.equal(messages[1].total, 10000);
        assert.ok(!types.includes('cloud'));
        assert.ok(!types.includes('error'));
        assert.equal(keptIn(messages), 4459);
        assert.equal(messages.filter((m) => m.type === 'progress').at(-1).value, 1);
        assert.equal(types.at(-1), 'finish');
    });

    it('stops reading a PLY once the vertices are done, ignoring a large face element after them', async () => {
        const marker = Buffer.from('end_header\n');
        const at = sphereBinaryPly.indexOf(marker);
        const faces = Buffer.alloc(2 * 1024 * 1024);
        const big = Buffer.concat([
            sphereBinaryPly.subarray(0, at),
            Buffer.from('element face 100000\nproperty list uchar int vertex_indices\n'),
            sphereBinaryPly.subarray(at),
            faces,
        ]);
        const file = fakeFile(big, 'sphere.ply');
        let bytesSliced = 0;
        const slice = file.slice;
        file.slice = (a, b) => {
            const part = slice(a, b);
            const read = part.arrayBuffer;
            part.arrayBuffer = async () => {
                const buf = await read();
                bytesSliced += buf.byteLength;
                return buf;
            };
            return part;
        };
        const messages = await runJob(file, {chunkSize: 65536});
        const types = messages.map((m) => m.type);
        assert.ok(!types.includes('error'));
        assert.equal(keptIn(messages), 4459);
        assert.equal(messages.filter((m) => m.type === 'progress').at(-1).value, 1);
        assert.equal(types.at(-1), 'finish');
        assert.ok(bytesSliced < big.length / 2, `read ${bytesSliced} of ${big.length} bytes`);
    });
});

describe('WasmReader stream (ply) against sphere.pts converted in-test', () => {
    it('binary little endian keeps 4459 of 10000 with the same points as PTS', () => {
        const ply = runStream(sphereBinaryPly, {format: 'ply'});
        const pts = runStream(sphere);
        assert.equal(ply.total, 10000);
        assert.equal(ply.kept, 4459);
        assert.equal(ply.recordsRead, 10000);
        assert.equal(ply.bytesRead, sphereBinaryPly.length);
        assert.equal(ply.cloudCount, 0);
        assert.equal(ply.errorCount, 0);
        assert.deepEqual(ply.positions, pts.positions);
        assert.deepEqual(ply.colors, pts.colors);
    });

    it('ascii in 7-byte chunks gives the same positions as binary', () => {
        const ascii = runStream(spherePly('ascii'), {format: 'ply', chunk: 7});
        const binary = runStream(sphereBinaryPly, {format: 'ply'});
        assert.equal(ascii.kept, 4459);
        assert.deepEqual(ascii.positions, binary.positions);
    });
});
