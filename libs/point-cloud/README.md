# point-cloud

The library reads big point clouds in browser as a stream, without allocating
too much memory. It allows to load point clouds bigger that 512MB.
The library allows to read the point cloud partially by using point limitations.

Usage:
```javascript:
/**
 * reads 1000 points from the provided pointcloud,
 * the points will be taken with an interpolated steps or randomly
 */
const ptsParser = new PTSParser(1000);

/**
 * The parser will return Float32Array with points and
 * UInt8Array with colors. Pay an attention if you need float values
 * for colors, you need to divide color values by 256
 */
const { points, colors } = parser.parse(file);
```

## Building

Run `nx build point-cloud` to build the library.

## Running unit tests

Run `nx test point-cloud` to execute the unit tests via [Jest](https://jestjs.io).
