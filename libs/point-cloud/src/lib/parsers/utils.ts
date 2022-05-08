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
