# point-cloud

The library reads big point clouds in the browser as a stream without allocating too much memory.
In addition, it allows loading point clouds bigger than 512MB.
The library allows partially reading the point cloud by using point number limitations.

Usage:
```javascript:
/**
 * reads 1000 points from the provided point cloud,
 * the points will be taken with an interpolated steps or randomly
 */
const ptsParser = new PTSParser(1000);

/**
 * The parser will return Float32Array with points and UInt8Array with colors.
 * Pay attention if you need float values for colors then you have to divide color values by 256
 */
const { points, colors } = parser.parse(file);
```

## Building

Run `yarn build point-cloud` to build the library.

## Running unit tests

Run `yarn test point-cloud` to execute the unit tests via [Jest](https://jestjs.io).
