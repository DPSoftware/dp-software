// Node integration test: runs the REAL wasm E57 reader against the two-scan fixture owned by the
// private Rust repo (never copied here). Run via `nx test-integration point-cloud-wasm`.
// Override the fixture with E57_FIXTURE=/path/to/two_scans.e57.
import {describe, it, before} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = process.env.E57_FIXTURE
    ?? path.join(repoRoot, 'external/pointcloud-processor-rs/crates/point-cloud-wasm-core/tests/data/two_scans.e57');
const fixtureExists = existsSync(fixturePath);
const skip = fixtureExists ? false : `E57 fixture not found at ${fixturePath} (set E57_FIXTURE to run)`;

const wasmDir = path.join(repoRoot, 'dist/libs/point-cloud-wasm/src/lib/wasm');
const wasmJs = path.join(wasmDir, 'point_cloud_wasm_core.js');
const wasmBin = path.join(wasmDir, 'point_cloud_wasm_core_bg.wasm');
const {initSync, WasmReader} = await import(pathToFileURL(wasmJs).href);
const {toPointCloudData} = await import(pathToFileURL(
    path.join(repoRoot, 'dist/libs/point-cloud-wasm/src/lib/convert.js')).href);
initSync({module: readFileSync(wasmBin)});

const fixture = fixtureExists ? readFileSync(fixturePath) : Buffer.alloc(0);

/** ByteSource over a Buffer that counts read calls. */
function makeSource(buf = fixture) {
    const src = {
        size: buf.length,
        calls: 0,
        read(offset, length) {
            src.calls++;
            return new Uint8Array(buf.subarray(offset, Math.min(offset + length, buf.length)));
        },
    };
    return src;
}

/** Reference kept count at voxel 0.5, recorded from the old per-format E57 reader class before the port. */
const VOXEL_05_KEPT = 16;

function open(src, {voxel = 0, withIntensity = true, batch = 1000} = {}) {
    return WasmReader.openRandom('e57', src, {
        voxelSize: voxel, defaultColor: [128, 128, 128], intensities: withIntensity, batchPoints: batch,
    });
}

/** Reads both scans, returning the raw batches, per-scan summaries and reader counters. */
function runAll(opts) {
    const src = makeSource();
    const reader = open(src, opts);
    try {
        const batches = [];
        const sink = {
            onBatch: (batch) => {
                try {
                    batches.push({
                        positions: batch.takePositions(),
                        colors: batch.takeColors(),
                        intensities: batch.takeIntensities(),
                        scanIndex: batch.cloud,
                        pointsRead: batch.recordsRead,
                        records: batch.records,
                    });
                } finally {
                    batch.free();
                }
            },
        };
        const summaries = [];
        for (let i = 0; i < reader.cloudCount(); i++) {
            const s = reader.readCloud(i, sink);
            summaries.push({read: s.read, kept: s.kept, invalid: s.invalid});
            s.free();
        }
        return {batches, summaries, kept: reader.keptPoints(), failed: reader.failed(), calls: src.calls};
    } finally {
        reader.free();
    }
}

describe('wasm E57 random-access reader against two_scans.e57', {skip}, () => {
    let voxel0;
    before(() => {
        voxel0 = runAll({voxel: 0, withIntensity: true, batch: 1000});
    });

    it('reports scan metadata and poses', () => {
        const reader = open(makeSource());
        try {
            assert.equal(reader.cloudCount(), 2);
            assert.equal(reader.totalPoints(), 4000);
            const info0 = reader.cloudInfo(0);
            const info1 = reader.cloudInfo(1);
            try {
                assert.equal(info0.records, 2000);
                assert.equal(info1.records, 2000);
                assert.equal(info0.hasColor, true);
                assert.equal(info0.hasIntensity, true);
                assert.deepEqual(Array.from(info0.translation()), [1.5, -2.25, 0.5]);
                assert.deepEqual(Array.from(info1.translation()), [10, 0, 0]);
                // Quaternion [w, x, y, z]: 90 degrees about Z.
                const q = Array.from(info1.rotation());
                assert.ok(Math.abs(q[0] - Math.SQRT1_2) < 1e-9, `w=${q[0]}`);
                assert.ok(Math.abs(q[1]) < 1e-9, `x=${q[1]}`);
                assert.ok(Math.abs(q[2]) < 1e-9, `y=${q[2]}`);
                assert.ok(Math.abs(q[3] - Math.SQRT1_2) < 1e-9, `z=${q[3]}`);
            } finally {
                info0.free();
                info1.free();
            }
        } finally {
            reader.free();
        }
    });

    it('keeps all 4000 points at voxel 0 with valid colours and intensities', () => {
        const clouds = voxel0.batches.map((b) => ({
            scanIndex: b.scanIndex,
            data: toPointCloudData(b.positions, b.colors, b.intensities, b.scanIndex),
        }));
        const total = clouds.reduce((n, c) => n + c.data.points.length, 0);
        assert.equal(total, 4000);
        for (const {data} of clouds) {
            assert.equal(data.colors.length, data.points.length);
            for (const c of data.colors) {
                for (const v of c) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `colour ${v}`);
            }
            assert.ok(data.intensities, 'intensities present');
            assert.equal(data.intensities.length, data.points.length);
            for (const v of data.intensities) assert.ok(v >= 0 && v <= 1, `intensity ${v}`);
        }
        const perScan = [0, 1].map((i) => clouds.filter((c) => c.scanIndex === i).length);
        assert.ok(perScan[0] > 0 && perScan[1] > 0);
        const order = voxel0.batches.map((b) => b.scanIndex);
        assert.deepEqual(order, [...order].sort((a, b) => a - b), 'scan 0 batches precede scan 1 batches');
        assert.equal(voxel0.batches.at(-1).pointsRead, 4000);
        assert.equal(voxel0.batches.reduce((n, b) => n + b.records, 0), 4000);
        assert.equal(voxel0.kept, 4000);
        assert.equal(voxel0.failed, false);
        assert.deepEqual(voxel0.summaries, [
            {read: 2000, kept: 2000, invalid: 0},
            {read: 2000, kept: 2000, invalid: 0},
        ]);
    });

    it('matches a reference voxel count at voxel 0.5', () => {
        const size = 0.5;
        const seen = new Set();
        for (const b of voxel0.batches) {
            for (let i = 0; i < b.positions.length; i += 3) {
                seen.add(`${Math.floor(b.positions[i] / size)}|${Math.floor(b.positions[i + 1] / size)}|${Math.floor(b.positions[i + 2] / size)}`);
            }
        }
        const run = runAll({voxel: size, withIntensity: true, batch: 1000});
        console.log(`voxel 0.5 kept: ${run.kept} (reference ${seen.size})`);
        assert.equal(run.kept, seen.size);
        assert.equal(run.kept, VOXEL_05_KEPT);
        const emitted = run.batches.reduce((n, b) => n + b.positions.length, 0);
        assert.equal(emitted, 3 * run.kept);
    });

    it('omits intensities when withIntensity is false', () => {
        const run = runAll({voxel: 0, withIntensity: false, batch: 1000});
        assert.ok(run.batches.length > 0);
        for (const b of run.batches) {
            assert.equal(b.intensities, undefined);
            const data = toPointCloudData(b.positions, b.colors, b.intensities, b.scanIndex);
            assert.equal('intensities' in data, false);
        }
    });

    it('reads a small file in at most two byte-source calls', () => {
        assert.ok(voxel0.calls <= 2, `read calls: ${voxel0.calls}`);
    });

    it('throws "Failed to read file" when the byte source throws', () => {
        const src = {
            size: fixture.length,
            read: () => {
                throw new Error('boom');
            },
        };
        assert.throws(() => open(src), (e) => e instanceof Error && e.message.includes('Failed to read file'));
    });

    it('throws from readCloud and marks the reader failed when the sink throws', () => {
        const reader = open(makeSource());
        try {
            const sink = {
                onBatch: () => {
                    throw new Error('sink boom');
                },
            };
            assert.throws(() => reader.readCloud(0, sink), /sink:/);
            assert.equal(reader.failed(), true);
        } finally {
            reader.free();
        }
    });
});
