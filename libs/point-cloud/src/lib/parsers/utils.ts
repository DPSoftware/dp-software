/**
 * Mutates a given typed array
 * Example:
 * addValuesToBuffer(array, 7, [1,2,3]) - starting from 7th element values 1, 2 and 3 will be added to the typed array
 *
 * @param buffer Float32Array | Uint8Array
 * @param offset Index after which the data will be written
 * @param values
 */
export function addValuesToBuffer(buffer: Float32Array | Uint8Array, offset: number, values: number[]): void {
    for (let i = 0; i < values.length; i++) {
        buffer[offset + i] = values[i];
    }
}

/**
 * Generates an array for the indices which should be taken from the source array
 * and written to the target array
 *
 *    0, 1, 2, 3, 4, 5, 6, 7, 8, 9 <- source array
 *    take 6 -> step = 10 / 9 = 1.11 <- getting a step for a 9 values target
 *    [0, 0, 0, 0, 0, 0]
 *    0 * 1.11 = 0
 *    1 * 1.11 = 1
 *    2 * 1.11 = 2
 *    3 * 1.11 = 3
 *    4 * 1.11 = 4
 *    5 * 1.11 = 6
 *    6 * 1.11 = 7
 *    7 * 1.11 = 8
 *    8 * 1.11 = 9
 *
 * @param commonLength The length of the source array
 * @param desiredLength
 * @returns
 */
export function interpolateIndices(commonLength: number, desiredLength: number): Uint32Array {
    if (desiredLength > commonLength || commonLength === desiredLength) {
        return new Uint32Array(commonLength).map((_, i) => i);
    }

    const desiredArray = new Uint32Array(desiredLength);
    const step = commonLength / desiredLength;
    for (let i = 0; i < desiredLength; i++) {
        desiredArray[i] = Math.round(i * step);
    }

    return desiredArray;
}

export function containsIndex(indices: Uint32Array, value: number): boolean {
    return binarySearch(indices, 0, indices.length - 1, value) !== -1;
}

/**
 * Binary search, thus data array should be sorted
 *
 * @param data
 * @param left
 * @param right
 * @param value
 * @returns index of the found element
 */
function binarySearch(data: Uint32Array, left: number, right: number, value: number): number {
    if (right >= left) {
        const midIndex = left + Math.floor((right - left) / 2);
        if (data[midIndex] == value) {
            return midIndex;
        } else if (data[midIndex] > value) {
            return binarySearch(data, left, midIndex - 1, value);
        }

        return binarySearch(data, midIndex + 1, right, value);
    }

    return -1;
}