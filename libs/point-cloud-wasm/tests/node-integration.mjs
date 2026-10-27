// Node integration test: runs the REAL wasm package against the sphere fixture
// and cross-checks it with the JS row parser. Run via `nx test-integration point-cloud-wasm`.
// Not a Jest test: ts-jest cannot load the ESM wasm package.
import {describe, it, before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const wasmDir = path.join(repoRoot, 'dist/libs/point-cloud-wasm/src/lib/wasm');
const wasmJs = path.join(wasmDir, 'point_cloud_wasm_core.js');
const wasmBin = path.join(wasmDir, 'point_cloud_wasm_core_bg.wasm');
const {initSync, WasmReader} = await import(pathToFileURL(wasmJs).href);
const {parsePtsRow} = await import(pathToFileURL(
    path.join(repoRoot, 'dist/libs/point-cloud/src/lib/parsers/engines/js-engine.js')).href);

initSync({module: readFileSync(wasmBin)});

const VOXEL = 0.05;
const CHUNK = 64 * 1024;
const DEFAULT_COLOR = [128, 128, 128];
const fixture = readFileSync(path.join(repoRoot, 'libs/point-cloud/tests/data/sphere.pts'));

/** Feeds the fixture in chunks and returns concatenated positions/colors plus counters. */
function runWasm(voxelSize) {
    const reader = WasmReader.openStream('pts', {voxelSize, acceptColorless: false, defaultColor: DEFAULT_COLOR});
    const positions = [];
    const colors = [];
    let errors = 0;
    const collect = (batch) => {
        positions.push(...batch.takePositions());
        colors.push(...batch.takeColors());
        errors += batch.errorCount;
        batch.free();
    };
    try {
        for (let i = 0; i < fixture.length; i += CHUNK) {
            collect(reader.push(new Uint8Array(fixture.subarray(i, i + CHUNK))));
        }
        collect(reader.finish());
        return {positions, colors, errors, total: reader.totalPoints(), kept: reader.keptPoints()};
    } finally {
        reader.free();
    }
}

/** Parses every data row (skipping the header line) with the JS row parser. */
function parseRowsWithJs() {
    const lines = fixture.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
    return lines.slice(1).map((row) => parsePtsRow(row, {
        voxelSize: VOXEL, acceptColorless: false, defaultColor: DEFAULT_COLOR,
    }));
}

describe('wasm PTS stream reader against sphere.pts', () => {
    let rows;
    before(() => {
        rows = parseRowsWithJs();
    });

    it('reads the header and keeps the expected voxel-filtered points', () => {
        const r = runWasm(VOXEL);
        assert.equal(r.total, 10000);
        assert.equal(r.kept, 4459);
        assert.equal(r.positions.length, 13377);
        assert.equal(r.colors.length, 13377);
        assert.equal(r.errors, 0);
    });

    it('returns only points and colors that the JS row parser produces', () => {
        assert.equal(rows.length, 10000);
        const byKey = new Map();
        for (const [[x, y, z], c] of rows) byKey.set(`${x},${y},${z}`, c);

        const r = runWasm(VOXEL);
        for (let i = 0; i < r.positions.length; i += 3) {
            const key = `${r.positions[i]},${r.positions[i + 1]},${r.positions[i + 2]}`;
            const expected = byKey.get(key);
            assert.ok(expected, `wasm point ${key} not produced by JS parser`);
            assert.deepEqual([r.colors[i], r.colors[i + 1], r.colors[i + 2]], expected, `colour mismatch at ${key}`);
        }
    });

    it('matches the collision-free voxel reference count', () => {
        const safe = new Set();
        const jsStyle = new Set();
        for (const [[x, y, z]] of rows) {
            const vx = Math.floor(x / VOXEL), vy = Math.floor(y / VOXEL), vz = Math.floor(z / VOXEL);
            safe.add(`${vx}|${vy}|${vz}`);
            jsStyle.add(`${vx}${vy}${vz}`); // known collision bug in the JS engine
        }
        console.log(`collision-free voxel count: ${safe.size}; JS-engine string-key count: ${jsStyle.size}`);
        assert.equal(safe.size, 4459);
        assert.equal(runWasm(VOXEL).kept, safe.size);
    });

    it('keeps every point in input order when voxel size is 0', () => {
        const r = runWasm(0);
        assert.equal(r.kept, 10000);
        assert.equal(r.errors, 0);
        assert.equal(r.positions.length, 30000);
        const expected = rows.flatMap(([p]) => p);
        assert.deepEqual(r.positions, expected);
    });
});
