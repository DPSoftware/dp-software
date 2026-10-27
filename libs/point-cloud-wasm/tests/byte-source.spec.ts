import { createBlobSource } from '../src/lib/byte-source';

const data = Uint8Array.from({ length: 256 }, (_, i) => i);

const makeBlob = () => {
    const slice = jest.fn((a: number, b: number) => ({ tag: 'slice', a, b }));
    return { blob: { size: 256, slice } as unknown as Blob, slice };
};

const makeReader = () => ({
    readAsArrayBuffer: jest.fn((b: unknown) => {
        const { a, b: end } = b as { a: number; b: number };
        return data.slice(a, end).buffer;
    }),
});

describe('createBlobSource', () => {
    it('should report the blob size', () => {
        expect(createBlobSource(makeBlob().blob, makeReader()).size).toBe(256);
    });

    it('should read the requested range', () => {
        const { blob, slice } = makeBlob();
        const out = createBlobSource(blob, makeReader()).read(0, 4);

        expect(Array.from(out)).toEqual([0, 1, 2, 3]);
        expect(slice).toHaveBeenCalledWith(0, 4);
    });

    it('should clamp a read crossing the end', () => {
        const out = createBlobSource(makeBlob().blob, makeReader()).read(250, 100);

        expect(Array.from(out)).toEqual([250, 251, 252, 253, 254, 255]);
    });

    it.each([[256, 10], [300, 10]])('should return empty at offset %d', (offset, length) => {
        const { blob, slice } = makeBlob();
        const out = createBlobSource(blob, makeReader()).read(offset, length);

        expect(out.length).toBe(0);
        expect(slice).not.toHaveBeenCalled();
    });

    it('should clamp a negative offset to 0', () => {
        const out = createBlobSource(makeBlob().blob, makeReader()).read(-5, 3);

        expect(Array.from(out)).toEqual([0, 1, 2]);
    });

    it('should return empty for a negative or zero length', () => {
        const source = createBlobSource(makeBlob().blob, makeReader());

        expect(source.read(10, -3).length).toBe(0);
        expect(source.read(10, 0).length).toBe(0);
    });

    it('should propagate reader errors', () => {
        const reader = { readAsArrayBuffer: jest.fn(() => { throw new Error('boom'); }) };

        expect(() => createBlobSource(makeBlob().blob, reader).read(0, 4)).toThrow('boom');
    });

    it('should throw when no reader is given and FileReaderSync is missing', () => {
        const g = globalThis as { FileReaderSync?: unknown };
        const saved = g.FileReaderSync;
        delete g.FileReaderSync;
        try {
            expect(() => createBlobSource(makeBlob().blob))
                .toThrow('FileReaderSync is not available; E57 parsing must run in a dedicated worker');
        } finally {
            if (saved !== undefined) g.FileReaderSync = saved;
        }
    });

    it('should use the global FileReaderSync by default', () => {
        const g = globalThis as { FileReaderSync?: unknown };
        const saved = g.FileReaderSync;
        const created = jest.fn();
        g.FileReaderSync = class {
            constructor() { created(); }
            readAsArrayBuffer(b: unknown): ArrayBuffer {
                const { a, b: end } = b as { a: number; b: number };
                return data.slice(a, end).buffer;
            }
        };
        try {
            const source = createBlobSource(makeBlob().blob);

            expect(created).toHaveBeenCalledTimes(1);
            expect(Array.from(source.read(1, 2))).toEqual([1, 2]);
        } finally {
            if (saved === undefined) delete g.FileReaderSync; else g.FileReaderSync = saved;
        }
    });
});
