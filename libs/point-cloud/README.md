# point-cloud

The library reads big point clouds in the browser as a stream without allocating too much memory.
In addition, it allows loading point clouds bigger than 512MB.
You can specify a voxel size to which the point cloud will be reduced.

Usage:
```javascript:
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
parser.onNewPoints.subscribe(data => {
    points = points.concat(data.points);
});
```
