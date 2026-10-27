import { PTSParser } from '../src/lib/parsers/pts';
import type { ParseResult, PointCloudError } from '../src/index';

const blobOf = (chunks: string[], failAfter = false) => {
    const queue = chunks.map((c) => ({ done: false, value: new TextEncoder().encode(c) }));
    const cancel = jest.fn().mockResolvedValue(undefined);
    const read = jest.fn().mockImplementation(async () => {
        const next = queue.shift();
        if (next) {
            return next;
        }
        if (failAfter) {
            throw new Error('boom');
        }
        return { done: true };
    });
    const blob = { stream: () => ({ getReader: () => ({ read, cancel }) }) } as unknown as Blob;
    return { blob, read, cancel };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PTSParser error codes', () => {
    const g = globalThis as { window?: unknown };
    let originalWindow: unknown;

    beforeEach(() => {
        originalWindow = g.window;
        g.window = { requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0; } };
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            delete g.window;
        } else {
            g.window = originalWindow;
        }
    });

    const run = async (parser: PTSParser, blob: Blob) => {
        const errors: PointCloudError[] = [];
        const messages: string[] = [];
        const results: ParseResult[] = [];
        const points = jest.fn();
        parser.onError.subscribe((e) => errors.push(e));
        parser.onParseError.subscribe((m) => messages.push(m));
        parser.onFinish.subscribe((r) => results.push(r));
        parser.onNewPoints.subscribe(points);
        parser.parse(blob);
        await flush();
        return { errors, messages, results, points };
    };

    it('should fail fast with NO_COLOR on colorless rows', async () => {
        const { blob, cancel, read } = blobOf(['3\n1 2 3 0 1 2 3\n4 5 6\n', '7 8 9 0 1 2 3\n']);
        const { errors, messages, results, points } = await run(new PTSParser(), blob);

        expect(errors).toEqual([{ code: 'NO_COLOR', fatal: true, message: 'Row has no color data: 4 5 6' }]);
        expect(messages).toEqual(['Row has no color data: 4 5 6']);
        expect(points).not.toHaveBeenCalled();
        expect(results).toEqual([{ status: 'NO_COLOR', errorCount: 1 }]);
        expect(read).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalled();
    });

    it('should report OK with acceptColorless', async () => {
        const { blob } = blobOf(['2\n1 2 3\n4 5 6 0\n']);
        const { errors, results, points } = await run(new PTSParser(0.02, { acceptColorless: true }), blob);

        expect(errors).toEqual([]);
        expect(points).toHaveBeenCalledTimes(1);
        expect(results).toEqual([{ status: 'OK', errorCount: 0 }]);
    });

    it('should report INVALID_ROW as non-fatal', async () => {
        const { blob } = blobOf(['2\n1 2\n']);
        const { errors, results } = await run(new PTSParser(), blob);

        expect(errors).toEqual([{ code: 'INVALID_ROW', fatal: false, message: 'Invalid row: 1 2' }]);
        expect(results).toEqual([{ status: 'OK', errorCount: 1 }]);
    });

    it('should report READ_ERROR on stream failure', async () => {
        const { blob } = blobOf([], true);
        const { errors, results } = await run(new PTSParser(), blob);

        expect(errors).toEqual([{ code: 'READ_ERROR', fatal: true, message: 'boom' }]);
        expect(results).toEqual([{ status: 'READ_ERROR', errorCount: 1 }]);
    });

    it('should map an engine exception to fatal UNKNOWN', async () => {
        const engine = { run: () => { throw new Error('bad'); } };
        const { results, errors } = await run(new PTSParser(0.02, { engine }), {} as Blob);

        expect(errors).toEqual([{ code: 'UNKNOWN', fatal: true, message: 'bad' }]);
        expect(results).toEqual([{ status: 'UNKNOWN', errorCount: 1 }]);
    });
});
