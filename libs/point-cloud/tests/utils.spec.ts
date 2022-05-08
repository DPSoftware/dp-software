import { containsIndex, interpolateIndices } from '../src/lib/parsers/utils';

describe('Utils', () => {

    it('should interpolate indices from source array to the target array with an integer step', () => {
        const sourceLength = 10;
        const targetArray = 5;

        const res = interpolateIndices(sourceLength, targetArray)

        console.log(res);

        expect(res.length).toBe(5);
        expect(Object.values(res)).toEqual([0, 2, 4, 6, 8]);
    });

    it('should interpolate indices from source array to the target array with a float step', () => {
        const sourceLength = 10;
        const targetArray = 9;

        const res = interpolateIndices(sourceLength, targetArray)

        console.log(res);

        expect(res.length).toBe(9);
        expect(Object.values(res)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
    });

    it('should interpolate indices to the one-to-one indices map', () => {
        const sourceLength = 10;
        const targetArray = 10;

        const res = interpolateIndices(sourceLength, targetArray)

        console.log(res);

        expect(res.length).toBe(10);
        expect(Object.values(res)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('should interpolate indices to the one-to-one indices map when desired length is higher', () => {
        const sourceLength = 10;
        const targetArray = 100;

        const res = interpolateIndices(sourceLength, targetArray)

        console.log(res);

        expect(res.length).toBe(10);
        expect(Object.values(res)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('should find index', () => {
        const data = new Uint32Array(10).map((_, i) => i);

        expect(containsIndex(data, 1)).toBeTruthy();
        expect(containsIndex(data, 0)).toBeTruthy();
        expect(containsIndex(data, 10)).toBeFalsy();
        expect(containsIndex(data, -2)).toBeFalsy();
        expect(containsIndex(data, 100)).toBeFalsy();
    });

});
