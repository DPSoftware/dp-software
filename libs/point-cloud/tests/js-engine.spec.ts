import { JsPtsEngine } from '../src/lib/parsers/engines/js-engine';
import type { PtsEngineSink, ResolvedPtsOptions } from '../src/lib/parsers/engines/types';

const opts: ResolvedPtsOptions = { voxelSize: 0.05, acceptColorless: false, defaultColor: [128, 128, 128] };

const makeSink = () => ({
    header: jest.fn(),
    points: jest.fn(),
    progress: jest.fn(),
    error: jest.fn(),
    finish: jest.fn(),
});

/** A Blob stand-in whose stream reader is `reader`. */
const blobWithReader = (reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> }) =>
    ({ stream: () => ({ getReader: () => reader }) } as unknown as Blob);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Parser needs Blob.stream and window.requestAnimationFrame; both are faked here.
describe('JsPtsEngine', () => {
    const g = globalThis as { window?: unknown };
    let sink: ReturnType<typeof makeSink>;
    let originalWindow: unknown;

    beforeEach(() => {
        sink = makeSink();
        originalWindow = g.window;
        g.window = {
            requestAnimationFrame: (cb: FrameRequestCallback) => {
                cb(0);
                return 0;
            },
        };
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            delete g.window;
        } else {
            g.window = originalWindow;
        }
    });

    it('should report a synchronous parseFile failure and finish once', () => {
        const file = { stream: () => ({}) } as unknown as Blob;

        new JsPtsEngine().run(file, opts, sink as PtsEngineSink);

        expect(sink.error).toHaveBeenCalledWith('Corrupted stream of Uint8Array', 'READ_ERROR', true);
        expect(sink.finish).toHaveBeenCalledTimes(1);
    });

    it('should report a rejected read and finish once', async () => {
        const read = jest.fn().mockRejectedValue(new Error('read failed'));

        new JsPtsEngine().run(blobWithReader({ read }), opts, sink as PtsEngineSink);
        await flush();

        expect(sink.error).toHaveBeenCalledWith('read failed', 'READ_ERROR', true);
        expect(sink.finish).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('should stop reading after a rejected read in a later chunk', async () => {
        const read = jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('1\n1 2 3 0 4 5 6\n') })
            .mockRejectedValueOnce(new Error('read failed'))
            .mockResolvedValue({ done: true });

        new JsPtsEngine().run(blobWithReader({ read }), opts, sink as PtsEngineSink);
        await flush();

        expect(sink.header).toHaveBeenCalledWith(1);
        expect(sink.points).toHaveBeenCalledWith({ points: [[1, 2, 3]], colors: [[4, 5, 6]] });
        expect(sink.error).toHaveBeenCalledWith('read failed', 'READ_ERROR', true);
        expect(sink.finish).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('should finish once at the end of a successful stream', async () => {
        const read = jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('1\n1 2 3 0 4 5 6') })
            .mockResolvedValue({ done: true });

        new JsPtsEngine().run(blobWithReader({ read }), opts, sink as PtsEngineSink);
        await flush();

        expect(sink.points).toHaveBeenCalledWith({ points: [[1, 2, 3]], colors: [[4, 5, 6]] });
        expect(sink.error).not.toHaveBeenCalled();
        expect(sink.finish).toHaveBeenCalledTimes(1);
    });
});
