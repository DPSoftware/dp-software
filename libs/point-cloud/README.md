# point-cloud

The library reads big point clouds in the browser as a stream without allocating too much memory.
In addition, it allows loading point clouds bigger than 512MB.
You can specify a voxel size to which the point cloud will be reduced.

Usage:
```javascript
/**
 * Initialize a point cloud parser and specify a size of voxel
 * Only 1 point per voxel will be read
 */
const ptsParser = new PTSParser(0.05);

/**
 * Subscribe on reading points
 * If you have huge point cloud files, browser will limit the reading buffer.
 * In this case points will be delivered in the next onNewPoints tick.
 */
ptsParser.onNewPoints.subscribe(data => {
    points = points.concat(data.points);
});

ptsParser.onParseError.subscribe(console.error);
ptsParser.onError.subscribe(e => console.error(e.code, e.message, e.fatal));
ptsParser.onFinish.subscribe(({status, errorCount}) => console.log(status, errorCount));
ptsParser.parse(file);
```

Rows are expected as `x y z intensity r g b`. Rows without colors (`x y z` or `x y z intensity`)
are a fatal `NO_COLOR` error by default (see Errors). To accept them, pass the options object:

```javascript
// colorless points get grey [128, 128, 128]
const ptsParser = new PTSParser(0.05, { acceptColorless: true });

// or pick your own default color
const ptsParser = new PTSParser(0.05, { acceptColorless: true, defaultColor: [255, 255, 255] });
```

## Errors

Every error is reported on `onError` as `{code, message, fatal}` and its `message` also goes to
`onParseError` (string). `onFinish` delivers `{status, errorCount}`: `status` is `'OK'` or the code of
the first fatal error (`'CANCELLED'` is used by `PointCloudParser` in the wasm package), `errorCount`
counts all reported errors.

| Code | Fatal | Meaning |
|---|---|---|
| `NO_COLOR` | yes | Row without r g b while `acceptColorless` is off |
| `INVALID_ROW` | no | Malformed row, the rest of that chunk is skipped |
| `INVALID_HEADER` | yes | Unusable header |
| `UNKNOWN_FORMAT` | yes | Format auto-detection failed |
| `UNSUPPORTED_FORMAT` | yes | Format not available in this build |
| `CLOUD_ERROR` | no | One sub-cloud failed to decode, others continue |
| `READ_ERROR` | yes | I/O or stream failure |
| `INIT_FAILED` | yes | Worker or wasm failed to load |
| `BUSY` | yes | Engine already running |
| `UNKNOWN` | depends | Anything else; exceptions thrown by an engine are fatal |

Fail-fast: the first colorless row with `acceptColorless` off stops the run. No further points are
emitted (including the points of the current chunk), one `NO_COLOR` error is reported, then `onFinish`
fires once with status `'NO_COLOR'`.

## Engines

`PTSParser` accepts `engine?: PtsEngine` in its options. The default is the built-in JS streaming
engine (`JsPtsEngine`). For the WebAssembly engine, install `@dp-software/point-cloud-wasm` and pass
`createWasmEngine`. It returns `null` when `WebAssembly` or `Worker` is missing, so fall back to the
JS engine:

```javascript
import {PTSParser, JsPtsEngine} from '@dp-software/point-cloud';
import {createWasmEngine} from '@dp-software/point-cloud-wasm';

const engine = createWasmEngine({fallback: new JsPtsEngine()}) ?? new JsPtsEngine();
const ptsParser = new PTSParser(0.05, {engine});
```

This package itself stays dependency-free; the worker and the wasm binary live in
`@dp-software/point-cloud-wasm`.

Other formats (E57, PLY) are read by `PointCloudParser` in `@dp-software/point-cloud-wasm` (there is no JS implementation).

### Writing your own engine

Implement `PtsEngine` (`run(file, opts, sink)`). `opts` is a `ResolvedPtsOptions`; report results
through the `PtsEngineSink` callbacks (`header`, `points`, `progress`, `error(message, code?, fatal?)`,
and `finish` exactly once, also after a fatal error). `parsePtsRow` is exported to reuse the JS row parser. All of these are exported from
`@dp-software/point-cloud`.

`Observable` is also exported, so custom engines can build parsers with the same type. `PointCloudData` may carry
`intensities` (0..1) and `scanIndex` for formats that provide them (E57 via `@dp-software/point-cloud-wasm`).

## License

Apache License 2.0, see `LICENSE` and `NOTICE`.
