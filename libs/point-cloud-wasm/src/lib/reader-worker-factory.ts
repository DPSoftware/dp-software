/** Creates the bundled reader worker as a module worker. Kept tiny so bundlers emit a single worker entry. */
export function createReaderWorker(): Worker {
    return new Worker(new URL('./reader.worker.js', import.meta.url), { type: 'module' });
}
