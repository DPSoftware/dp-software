import type {PointCloudData, RGB} from "@dp-software/point-cloud";
import type {PointBatch} from "./point-cloud-parser.js";

/** Converts interleaved typed arrays into the public `PointCloudData` shape; `cloud` becomes `scanIndex`. */
export function toPointCloudData(
    positions: Float64Array,
    colors: Uint8Array,
    intensities?: Float32Array,
    cloud?: number,
): PointCloudData {
    const count = Math.floor(positions.length / 3);
    const points: [number, number, number][] = new Array(count);
    const rgb: RGB[] = new Array(count);

    for (let i = 0, j = 0; i < count; i++, j += 3) {
        points[i] = [positions[j], positions[j + 1], positions[j + 2]];
        rgb[i] = [colors[j], colors[j + 1], colors[j + 2]];
    }

    const data: PointCloudData = {
        points: points,
        colors: rgb,
    };
    if (intensities !== undefined) {
        data.intensities = Array.from(intensities);
    }
    if (cloud !== undefined) {
        data.scanIndex = cloud;
    }
    return data;
}

/** Packs `PointCloudData` tuples into a typed-array `PointBatch`; colorless points get black. */
export function fromPointCloudData(data: PointCloudData, cloud = 0): PointBatch {
    const count = data.points.length;
    const positions = new Float64Array(count * 3);
    const colors = new Uint8Array(count * 3);
    for (let i = 0, j = 0; i < count; i++, j += 3) {
        const p = data.points[i];
        positions[j] = p[0];
        positions[j + 1] = p[1];
        positions[j + 2] = p[2];
        const c = data.colors?.[i];
        if (c) {
            colors[j] = c[0];
            colors[j + 1] = c[1];
            colors[j + 2] = c[2];
        }
    }
    const batch: PointBatch = {positions, colors, cloud};
    if (data.intensities !== undefined) {
        batch.intensities = Float32Array.from(data.intensities);
    }
    return batch;
}
