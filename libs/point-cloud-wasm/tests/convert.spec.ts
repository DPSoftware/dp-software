import { fromPointCloudData, toPointCloudData } from '../src/lib/convert';

describe('toPointCloudData', () => {
    it('should convert positions and colors without optional keys', () => {
        const result = toPointCloudData(
            new Float64Array([1, 2, 3, 4, 5, 6]),
            new Uint8Array([7, 8, 9, 10, 11, 12]),
        );

        expect(result).toEqual({ points: [[1, 2, 3], [4, 5, 6]], colors: [[7, 8, 9], [10, 11, 12]] });
        expect('intensities' in result).toBe(false);
        expect('scanIndex' in result).toBe(false);
    });

    it('should include intensities and map the cloud index to scanIndex when given', () => {
        const result = toPointCloudData(
            new Float64Array([1, 2, 3, 4, 5, 6]),
            new Uint8Array([7, 8, 9, 10, 11, 12]),
            new Float32Array([0.5, 1]),
            3,
        );

        expect(result.intensities).toEqual([0.5, 1]);
        expect(result.scanIndex).toBe(3);
    });

    it('should return an empty result for empty arrays', () => {
        const result = toPointCloudData(new Float64Array(0), new Uint8Array(0));

        expect(result).toEqual({ points: [], colors: [] });
    });
});

describe('fromPointCloudData', () => {
    it('should round-trip with toPointCloudData', () => {
        const data = toPointCloudData(
            new Float64Array([1.5, 2, 3, 4, 5, 6]),
            new Uint8Array([7, 8, 9, 10, 11, 12]),
            new Float32Array([0.5, 1]),
        );
        const batch = fromPointCloudData(data, 2);

        expect(batch.positions).toBeInstanceOf(Float64Array);
        expect(Array.from(batch.positions)).toEqual([1.5, 2, 3, 4, 5, 6]);
        expect(batch.colors).toBeInstanceOf(Uint8Array);
        expect(Array.from(batch.colors)).toEqual([7, 8, 9, 10, 11, 12]);
        expect(Array.from(batch.intensities ?? [])).toEqual([0.5, 1]);
        expect(batch.cloud).toBe(2);
        expect(toPointCloudData(batch.positions, batch.colors, batch.intensities)).toEqual(data);
    });

    it('should default the cloud to 0, omit intensities and zero missing colors', () => {
        const batch = fromPointCloudData({ points: [[1, 2, 3]] });

        expect(batch.cloud).toBe(0);
        expect('intensities' in batch).toBe(false);
        expect(Array.from(batch.colors)).toEqual([0, 0, 0]);
    });

    it('should return empty arrays for no points', () => {
        const batch = fromPointCloudData({ points: [], colors: [] });

        expect(batch.positions.length).toBe(0);
        expect(batch.colors.length).toBe(0);
    });
});
