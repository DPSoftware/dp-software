# point-cloud-wasm

WebAssembly point-cloud readers for [`@dp-software/point-cloud`](../point-cloud). `PointCloudParser` reads PTS, E57
and PLY files; `createWasmEngine` is a `PtsEngine` that makes `PTSParser` use the same reader. Everything parses in a
Web Worker with a Rust reader compiled to WebAssembly, with voxel downsampling. The compiled binary ships inside this
package (`src/lib/wasm/`); the Rust source is not published.

## Install

```bash
npm install @dp-software/point-cloud @dp-software/point-cloud-wasm
```

`@dp-software/point-cloud` >= 0.4.0 is a peer dependency. The package is an ES module; bundler notes are below.

## PointCloudParser

`PointCloudParser` is the single public parser. Points arrive as typed arrays exactly as transferred from the worker,
with no main-thread conversion.

```javascript
import {PointCloudParser, isPointCloudParserSupported} from '@dp-software/point-cloud-wasm';

if (isPointCloudParserSupported()) {
    const parser = new PointCloudParser({voxelSize: 0.05, intensities: true}); // format: 'auto' by default
    parser.onInfo.subscribe(({format, totalPoints}) => console.log(format, totalPoints)); // totalPoints may be null
    parser.onCloud.subscribe(cloud => console.log(cloud.index, cloud.name, cloud.records)); // multi-cloud formats only
    parser.onBatch.subscribe(({positions, colors, intensities, cloud}) => {
        // positions: Float64Array xyz, colors: Uint8Array rgb (0..255), intensities: Float32Array (0..1) when requested
    });
    parser.loadingStatus.subscribe(value => console.log(value)); // 0..1
    parser.onParseError.subscribe(message => console.error(message));
    parser.onError.subscribe(({code, message, fatal, cloud}) => console.error(code, message, fatal, cloud));
    parser.onFinish.subscribe(({status, errorCount}) => console.log(status, errorCount)); // exactly once per parse
    parser.parse(file);
    // parser.cancel() terminates the worker and fires onFinish with status 'CANCELLED'
    // (with the ptsFallback JS engine, events stop at once but the file may be read in the background until it ends)
}
```

Viewer-style use: append each batch straight to a growing buffer (the harness in `apps/dp-software` does this with
three.js `BufferGeometry` attributes) instead of building per-point objects.

```javascript
const parser = new PointCloudParser({voxelSize: 0.02});
let count = 0;
parser.onBatch.subscribe(({positions, colors}) => {
    appendToGeometry(positions, colors); // typed arrays, nothing to convert
    count += positions.length / 3;
});
parser.parse(file);
```

If you need `[x, y, z]` tuples (the `PointCloudData` shape of `@dp-software/point-cloud`), use
`toPointCloudData(batch.positions, batch.colors)`; `fromPointCloudData` goes the other way.

Events:

- `onInfo`: `{format, totalPoints}`, once before any points. `format` is the requested or detected format;
  `totalPoints` is the declared record count before filtering, `null` when the file does not say.
- `onNumberOfPoints`: the same total, `NaN` when unknown.
- `onCloud`: `SubCloudInfo` per sub-cloud, before any points. Only multi-cloud formats (E57) fire it; single-cloud
  formats (PTS, PLY) report no clouds. Fields: `index`, `name`, `guid`, `records`, `translation`, `rotation`
  (quaternion `[w, x, y, z]`; clouds without a pose report the identity), `hasColor`, `hasIntensity`, `hasNormals`.
- `onBatch`: `{positions, colors, intensities?, cloud}`. `cloud` is the sub-cloud index (0 for single-cloud formats).
- `loadingStatus`, `onParseError`, `onFinish`: see Progress and Errors below.

`PointCloudParserOptions`:

| Option | Description |
|---|---|
| `format` | `'auto'` (default), `'pts'`, `'e57'` or `'ply'`. |
| `voxelSize` | Voxel edge length. Default 0.02. A value <= 0 or non-finite keeps every point. |
| `acceptColorless` | Accept records without color (PTS, PLY). Default false. |
| `defaultColor` | Color for points without color. Default grey `[128, 128, 128]`. |
| `intensities` | Emit per-point intensities (0..1) where the format has them. Default false. |
| `batchSize` | Kept points per batch for random-access formats (E57). Default 131072. |
| `chunkSize` | Bytes read per wasm `push` for stream formats (PTS, PLY). Default 4 MiB. |
| `workerFactory` | `() => Worker`. Create the worker yourself if your bundler cannot handle the default. |
| `wasmUrl` | URL of `point_cloud_wasm_core_bg.wasm`, passed to the worker. |
| `ptsFallback` | `PtsEngine` (for example `JsPtsEngine`) used when the worker or wasm fails to load before any points, only for `format: 'pts'` or a `.pts` file name. |

One file at a time per instance: `parse()` does nothing while a run is in progress.

## PTSParser with the wasm engine

```javascript
import {PTSParser, JsPtsEngine} from '@dp-software/point-cloud';
import {createWasmEngine} from '@dp-software/point-cloud-wasm';

// createWasmEngine returns null when WebAssembly or Worker is unavailable
const engine = createWasmEngine({fallback: new JsPtsEngine()}) ?? new JsPtsEngine();
const parser = new PTSParser(0.05, {engine});
```

The fallback is used only if the worker fails to initialise before any points were emitted. This engine converts
batches to tuples for `onNewPoints`, as `PTSParser` expects.

`WasmEngineOptions`:

| Option | Description |
|---|---|
| `workerFactory` | `() => Worker`. Create the worker yourself if your bundler cannot handle the default. |
| `wasmUrl` | URL of `point_cloud_wasm_core_bg.wasm`, passed to the worker. |
| `fallback` | `PtsEngine` used when the wasm worker fails to initialise before emitting points. |
| `chunkSize` | Bytes read per slice. Default 4 MiB. |

## Formats

| Format | Access | Notes |
|---|---|---|
| PTS | stream | Rows `x y z [intensity] [r g b]`. 7 fields have color; 3 or 4 are colorless. A leading UTF-8 BOM is ignored. |
| E57 | random access | ASTM E2807 (Leica, FARO and other scanner exports). Multi-cloud (one cloud per scan). |
| PLY | stream | ascii, binary little endian, binary big endian. The `vertex` element only. |

Stream formats are fed 4 MiB slices of the file. Random-access formats read through a 4 MiB read-ahead window over
`FileReaderSync`, so multi-GB files do not have to fit in memory. All formats use one voxel filter per file.

### PTS

Colorless rows (3 or 4 fields) are a fatal `NO_COLOR` error (`Row has no color data`) unless `acceptColorless` is set,
in which case they get `defaultColor`. The first such row stops the run (see Errors). Colors must be integers in
0..255. Any other bad row is skipped (`INVALID_ROW`) and parsing continues.

### E57

- Points are in world space (the per-cloud pose is applied first). Points flagged invalid or direction-only are
  skipped silently.
- Colors are normalised to 0..255 using the file's colour limits. A cloud without color gets grey from intensity;
  `defaultColor` applies only when it has neither. Intensities are normalised to 0..1.
- Limitations (from the `e57` crate): no point grouping, index packets are ignored, no images or blobs, the XML
  section is capped at 50 MB. Selecting a subset of scans and `applyPose: false` are not supported yet.

### PLY

- Required: `x`, `y`, `z` of any scalar type.
- Color from `red/green/blue`, `r/g/b` or `diffuse_red/diffuse_green/diffuse_blue` (first complete set wins).
  Integer types are scaled from `0..type max` to `0..255` (`uchar` as is, negatives clamp to 0); float types are
  taken as `0..1`, clamped and scaled.
- Without a complete color set the file is colorless: with `acceptColorless` every vertex gets `defaultColor`,
  otherwise reading fails with `PLY file has no color properties; enable acceptColorless`.
- `intensity` or `scalar_intensity` is emitted when `intensities` is set: integers are normalised by the type max,
  floats clamped to 0..1.
- Other vertex properties are skipped by size; elements after `vertex` (faces) are ignored.
- Unsupported (fatal at open): a list property inside `vertex`, and in binary files any element before `vertex` that
  has a list property. A bad ascii row or a non-finite coordinate is a record error and reading continues.

## Auto-detection

With `format: 'auto'` the worker reads the first 64 KiB and decides by, in order: magic bytes (`ASTM-E57` for E57,
`ply` for PLY), then the file extension (`.pts`, `.e57`, `.ply`), then a PTS heuristic (an integer line followed by a
row of 3, 4 or 7 numbers). `onInfo.format` reports the result. If nothing matches, the run ends with
`Unknown point cloud format`. A format the build does not contain fails with `Format <name> is not supported by this build`.

## Errors

Every error is reported on `onError` as `{code, message, fatal, cloud?}`; its `message` also goes to `onParseError`
(string). `onFinish` delivers `{status, errorCount}`: `status` is `'OK'`, `'CANCELLED'` (after `cancel()`), or the code
of the first fatal error. `errorCount` counts every reported error, including the ones dropped from the per-batch
message cap. `PTSParser` with the wasm engine gets the same codes through `onError` and `onFinish`.

| Code | Fatal | Meaning |
|---|---|---|
| `NO_COLOR` | yes | PTS row without color while `acceptColorless` is off |
| `INVALID_ROW` | no | Malformed record, skipped |
| `INVALID_HEADER` | yes | Unusable header (for example `E57 open failed: ...`) |
| `UNKNOWN_FORMAT` | yes | `format: 'auto'` could not detect the format |
| `UNSUPPORTED_FORMAT` | yes | Format name unknown or not compiled into this build |
| `CLOUD_ERROR` | no | One sub-cloud (E57 scan) failed to decode, the next one continues; carries `cloud` |
| `READ_ERROR` | yes | I/O, file slice or worker message failure |
| `INIT_FAILED` | yes | Worker or wasm failed to load, or no WebAssembly/Worker support |
| `BUSY` | yes | Worker or engine already running a job |
| `UNKNOWN` | yes | Anything without a more specific code |

Fatal errors end the run: the error goes to `onError` and `onParseError`, then `onFinish` fires with the code as status.
Only `INIT_FAILED` before any points can trigger `ptsFallback` / `fallback`.

- Fail-fast `NO_COLOR`: the first colorless PTS row with `acceptColorless` off stops the run. Points of that chunk and
  later ones are not emitted, one `NO_COLOR` error is reported, then `onFinish`. Both engines behave the same.
- Open (random-access formats, i.e. E57): `E57 open failed: ...` (`INVALID_HEADER`).
- PLY is a stream format, so its header is parsed while reading and its errors carry no `open failed:` prefix:
  `Invalid PLY header: ...`, `Unsupported PLY: ...`, `Not a PLY file: missing 'ply' magic`,
  `PLY file has no color properties; enable acceptColorless`.
- `Failed to read file: ...` applies to random-access formats only. For stream formats (PTS, PLY) a failed
  `file.slice().arrayBuffer()` is reported with the browser's own error message.

Non-fatal errors let the run continue:

- Per record (a bad PTS row, a bad ascii PLY row, a non-finite coordinate): `INVALID_ROW`, at most 100 messages per
  batch. On `onParseError` the rest is summarised as `<n> more errors`; on `onError` they only add to `errorCount`.
  (`PTSParser` with the wasm engine reports the summary as one extra non-fatal `INVALID_ROW` error,
  `<n> more row errors`, which counts once.)
- Per cloud: `CLOUD_ERROR` with `Scan <i>: ...` when one E57 scan cannot be decoded; the next scan continues and the
  final status stays `'OK'`.

`onFinish` fires exactly once per `parse`.

## Progress

`loadingStatus` goes from 0 to 1 and ends with 1 on success.

| Access | Progress |
|---|---|
| Stream (PTS, PLY) | Bytes read / file size. |
| Random access (E57) | Records read / total records of all clouds. Also reported while a coarse voxel size rejects long runs of points. |

## Differences from the JS engine

| Topic | JS engine | Wasm engine |
|---|---|---|
| Voxel keys | Hash has no separator, so distinct voxels can collide | Collision-free; may keep more points (4459 vs 4444 on the bundled sphere fixture) |
| Bad row | Aborts the rest of the current chunk | Row is skipped, parsing continues |
| Colorless row (`acceptColorless` off) | Fatal `NO_COLOR`, run stops | Fatal `NO_COLOR`, run stops |
| Blank lines | Reported as errors | Skipped |
| Non-numeric fields | Yields NaN | Error |
| Colors | Not range-checked | Must be integers in 0..255 |
| Progress | Rows read / point count from the header | Bytes read / file size (stream formats) |
| Voxel size <= 0 | Not special-cased | Keeps every point |
| Error volume | One message per failing chunk | At most 100 messages per batch plus a "<n> more errors" summary |
| Formats | PTS only | PTS, E57, PLY (through `PointCloudParser`) |

## Bundler notes

Both entry points create the worker with
`new Worker(new URL('./reader.worker.js', import.meta.url), { type: 'module' })` from one small module, so bundlers
emit a single `reader.worker.js` entry. The wasm glue resolves `point_cloud_wasm_core_bg.wasm` the same way
(`new URL(..., import.meta.url)`); override it with `wasmUrl` if you host the file elsewhere. Webpack 5 and Vite handle
this from the published package. The worker needs a dedicated module worker with `FileReaderSync` (Chrome, Firefox,
Safari).

Webpack specifics:

- When webpack emits an ESM output (`output.scriptType = 'module'`, which Nx sets), the worker chunk
  ends up with `import.meta` inside and fails at runtime with "Cannot use 'import.meta' outside a
  module". Set `output.scriptType = undefined` (or a static `publicPath`).
- If you compile the library from TypeScript source rather than dist (monorepo path aliases), also set
  `resolve.extensionAlias = { '.js': ['.ts', '.js'] }`.
- `apps/dp-software/webpack.config.js` shows both settings.

If your bundler cannot handle it, pass `workerFactory` and/or `wasmUrl`. Vite consumers may need
`optimizeDeps.exclude` (unverified).

Bundle: the wasm asset is about 320 KB because it carries all readers. A smaller wasm can be built from the Rust
repo with `--no-default-features` (PTS only).

## Adding a format

1. Rust (private repo): add a crate `crates/pointcloud-<fmt>` implementing `StreamReader` (fed chunks) or
   `RandomAccessReader` (pulls bytes, one sub-cloud per call) from `pointcloud-core`; make sure `Format` and `detect`
   know the format.
2. Register it in `crates/point-cloud-wasm-core`: optional dependency, a cargo feature (add it to `default` to ship
   it), and an arm in `is_compiled` plus `open_stream` or `open_random` in `src/reader.rs`.
3. Rust tests: unit tests in the crate, a case in `crates/point-cloud-wasm-core/tests/reader-smoke.mjs`; run
   `cargo test --workspace`, `scripts/build-wasm.sh`, `scripts/test-wasm.sh`.
4. TypeScript: add the name to the `PointCloudFormat` union in `src/lib/protocol.ts` and add cases to
   `tests/point-cloud-parser.spec.ts`, `tests/reader-worker.spec.ts` and `tests/reader-node-integration.mjs`.
5. Update this README (Formats table and the format's rules).

The worker, the protocol and `PointCloudParser` need no other change.

## Testing

```bash
npx nx test point-cloud-wasm              # Jest with mocked wasm, a fake Worker and a fake FileReaderSync
npx nx test-integration point-cloud-wasm  # Node against the real wasm (PTS, E57 and the generic reader worker)
```

The E57 parts of the integration tests read a fixture (`two_scans.e57`) from the private Rust repo and are skipped
when it is absent; set `E57_FIXTURE` to point at another file.

Jest cannot load the ESM wasm package, so the unit tests use a fake Worker. `reader-worker-factory.ts` uses
`import.meta`, which ts-jest (CommonJS) rejects; `tests/import-meta-transformer.cjs` is a ts-jest AST
transformer that stubs it.

## Development

The WebAssembly binary is built from a private Rust repository (`scripts/build-wasm.sh` there; needs the rustup
toolchain on `PATH`, `wasm-pack`, and the `wasm32-unknown-unknown` target).
`tools/scripts/link-wasm.sh` symlinks its output (`external/pointcloud-processor-rs/crates/point-cloud-wasm-core/pkg`)
to `libs/point-cloud-wasm/src/lib/wasm` (git-ignored); the sources import `./wasm/point_cloud_wasm_core.js`.
`nx build point-cloud-wasm` copies the glue, the `.wasm`, the `.d.ts` files and `THIRD_PARTY_LICENSES.md` into
`dist/libs/point-cloud-wasm` and fails with a clear message when the link is missing.

```bash
cd external/pointcloud-processor-rs && export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace && scripts/build-wasm.sh && scripts/test-wasm.sh
cd ../.. && tools/scripts/link-wasm.sh
```

## License

Apache License 2.0, see `LICENSE` and `NOTICE`. Keep both files when you redistribute the package.
The WebAssembly binary is compiled from a private Rust codebase whose source is not published. The
open-source components compiled into it are listed with their licenses in `THIRD_PARTY_LICENSES.md`.
