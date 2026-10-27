import type { OpenMessage } from '../src/lib/protocol';

type Msg = {
    type: string;
    jobId?: number;
    total?: number | null;
    value?: number;
    message?: string;
    stage?: string;
    cloud?: unknown;
    format?: string;
    messages?: string[];
    dropped?: number;
    code?: string;
};

interface FakeBatch {
    takePositions: jest.Mock;
    takeColors: jest.Mock;
    takeIntensities: jest.Mock;
    takeErrors: jest.Mock;
    errorCount: number;
    records: number;
    recordsRead: number;
    cloud: number;
    keptPoints: number;
    free: jest.Mock;
    positions: Float64Array;
    colors: Uint8Array;
    intensities?: Float32Array;
}

const makeBatch = (
    opts: { points?: number; errors?: string[]; errorCount?: number; intensities?: boolean; cloud?: number; recordsRead?: number } = {},
): FakeBatch => {
    const n = opts.points ?? 0;
    const positions = new Float64Array(n * 3);
    const colors = new Uint8Array(n * 3);
    const intensities = opts.intensities ? new Float32Array(n) : undefined;
    const errors = opts.errors ?? [];
    return {
        takePositions: jest.fn(() => positions),
        takeColors: jest.fn(() => colors),
        takeIntensities: jest.fn(() => intensities),
        takeErrors: jest.fn(() => errors),
        errorCount: opts.errorCount ?? errors.length,
        records: n,
        recordsRead: opts.recordsRead ?? n,
        cloud: opts.cloud ?? 0,
        keptPoints: n,
        free: jest.fn(),
        positions,
        colors,
        intensities,
    };
};

// Shared with the (hoisted) jest.mock factory; the `mock` prefix is required by babel-plugin-jest-hoist.
const mockState = {
    init: jest.fn(),
    openStream: jest.fn(),
    openRandom: jest.fn(),
    detectFormat: jest.fn(),
    formatKind: jest.fn(),
};

jest.mock('../src/lib/wasm/point_cloud_wasm_core.js', () => ({
    __esModule: true,
    default: (...args: unknown[]) => mockState.init(...args),
    WasmReader: {
        openStream: (...args: unknown[]) => mockState.openStream(...args),
        openRandom: (...args: unknown[]) => mockState.openRandom(...args),
    },
    detectFormat: (...args: unknown[]) => mockState.detectFormat(...args),
    formatKind: (...args: unknown[]) => mockState.formatKind(...args),
    formats: () => ['pts', 'e57'],
}));

const KINDS: Record<string, string> = { pts: 'stream', e57: 'random', ply: 'stream' };

interface StreamScript {
    pushBatches?: FakeBatch[];
    finishBatch?: FakeBatch;
    total?: (pushes: number) => number | undefined;
    records?: (pushes: number) => number;
    pushError?: Error;
    complete?: (pushes: number) => boolean;
}

/** Installs a fake stream `WasmReader` returned by `WasmReader.openStream`. */
const installStreamReader = (script: StreamScript = {}) => {
    const state = { pushes: 0 };
    const queue = [...(script.pushBatches ?? [])];
    const finishBatch = script.finishBatch ?? makeBatch();
    const batches: FakeBatch[] = [...queue, finishBatch];
    const reader = {
        format: 'pts',
        kind: 'stream',
        push: jest.fn(() => {
            state.pushes++;
            if (script.pushError) {
                throw script.pushError;
            }
            const b = queue.shift() ?? makeBatch();
            if (!batches.includes(b)) {
                batches.push(b);
            }
            return b;
        }),
        finish: jest.fn(() => finishBatch),
        totalPoints: jest.fn(() => script.total?.(state.pushes)),
        recordsRead: jest.fn(() => script.records?.(state.pushes) ?? 0),
        bytesRead: jest.fn(() => 0),
        isComplete: jest.fn(() => script.complete?.(state.pushes) ?? false),
        keptPoints: jest.fn(() => 0),
        cloudCount: jest.fn(() => 0),
        free: jest.fn(),
    };
    mockState.openStream.mockImplementation(() => reader);
    return { reader, batches };
};

interface ScriptBatch {
    points: number;
    intensities?: boolean;
    errors?: string[];
    errorCount?: number;
}

interface ScriptCloud {
    records: number;
    name?: string;
    guid?: string;
    translation?: number[];
    rotation?: number[];
    hasColor?: boolean;
    hasIntensity?: boolean;
    hasNormals?: boolean;
    batches?: ScriptBatch[];
    throwMessage?: string;
    /** Own `code` property set on the thrown error. */
    throwCode?: string;
    /** When set together with `throwMessage`, `failed()` returns true after the throw. */
    failedAfter?: boolean;
}

interface Sink {
    onBatch(batch: FakeBatch): void;
}

/** Installs a fake random-access `WasmReader` that throws when called while `readCloud` is running. */
const installRandomReader = (clouds: ScriptCloud[], opts: { total?: number; sinkProbe?: (r: unknown) => void } = {}) => {
    const state = { inReadCloud: false, failed: false, recordsRead: 0 };
    const infos: { free: jest.Mock }[] = [];
    const summaries: { free: jest.Mock }[] = [];
    const batches: FakeBatch[] = [];
    const guard = <T extends unknown[], R>(fn: (...args: T) => R) =>
        jest.fn((...args: T): R => {
            if (state.inReadCloud) {
                throw new Error('re-entrant call into the reader');
            }
            return fn(...args);
        });
    const reader = {
        format: 'e57',
        kind: 'random',
        free: guard(() => undefined),
        failed: guard(() => state.failed),
        keptPoints: guard(() => 0),
        recordsRead: guard(() => state.recordsRead),
        cloudCount: guard(() => clouds.length),
        totalPoints: guard((): number | undefined => opts.total ?? clouds.reduce((s, x) => s + x.records, 0)),
        cloudInfo: guard((i: number) => {
            const s = clouds[i];
            const info = {
                index: i,
                name: s.name,
                guid: s.guid,
                records: s.records,
                hasCartesian: true,
                hasSpherical: false,
                hasColor: s.hasColor ?? false,
                hasIntensity: s.hasIntensity ?? false,
                hasNormals: s.hasNormals ?? false,
                translation: () => new Float64Array(s.translation ?? []),
                rotation: () => new Float64Array(s.rotation ?? []),
                free: jest.fn(),
            };
            infos.push(info);
            return info;
        }),
        readCloud: guard((i: number, sink: Sink) => {
            const s = clouds[i];
            state.inReadCloud = true;
            try {
                for (const b of s.batches ?? []) {
                    state.recordsRead += b.points;
                    const batch = makeBatch({ ...b, cloud: i, recordsRead: state.recordsRead });
                    batches.push(batch);
                    sink.onBatch(batch);
                }
                opts.sinkProbe?.(reader);
            } finally {
                state.inReadCloud = false;
            }
            if (s.throwMessage) {
                state.failed = !!s.failedAfter;
                throw Object.assign(new Error(s.throwMessage), s.throwCode ? { code: s.throwCode } : {});
            }
            const summary = { cloud: i, records: s.records, read: s.records, kept: 0, invalid: 0, free: jest.fn() };
            summaries.push(summary);
            return summary;
        }),
    };
    mockState.openRandom.mockImplementation(() => reader);
    return { reader, infos, summaries, batches, state };
};

interface FakeFile {
    size: number;
    name?: string;
    slice: jest.Mock;
}

const makeFile = (bytes: Uint8Array, delayMs = 0, name?: string): FakeFile => ({
    size: bytes.byteLength,
    name,
    slice: jest.fn((from: number, to: number) => {
        const part = bytes.slice(from, to);
        const buf = part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
        return {
            size: part.byteLength,
            arrayBuffer: () =>
                delayMs ? new Promise<ArrayBuffer>((r) => setTimeout(() => r(buf), delayMs)) : Promise.resolve(buf),
        };
    }),
});

const textFile = (text: string, delayMs = 0, name?: string) => makeFile(new TextEncoder().encode(text), delayMs, name);

const openMsg = (file: FakeFile, extra: Partial<OpenMessage> = {}): OpenMessage => ({
    type: 'open',
    jobId: 1,
    file: file as unknown as Blob,
    format: 'pts',
    voxelSize: 0.05,
    acceptColorless: false,
    defaultColor: [128, 128, 128],
    intensities: false,
    chunkSize: 1024,
    ...extra,
});

const e57Msg = (extra: Partial<OpenMessage> = {}): OpenMessage => ({
    type: 'open',
    jobId: 1,
    file: makeFile(new Uint8Array(1000)) as unknown as Blob,
    format: 'e57',
    voxelSize: 0.05,
    acceptColorless: false,
    defaultColor: [10, 20, 30],
    intensities: false,
    ...extra,
});

class FakeFileReaderSync {
    readAsArrayBuffer(blob: { size?: number }): ArrayBuffer {
        return new ArrayBuffer(blob.size ?? 0);
    }
}

describe('reader.worker', () => {
    let post: jest.Mock;
    const g = globalThis as unknown as { self?: unknown; postMessage: unknown; FileReaderSync?: unknown };
    const savedFileReaderSync = g.FileReaderSync;

    const send = (data: unknown) => {
        (globalThis as unknown as { self: { onmessage: (e: MessageEvent) => void } }).self.onmessage({
            data,
        } as MessageEvent);
    };

    const messages = (): Msg[] => post.mock.calls.map((c) => c[0] as Msg);
    const types = () => messages().map((m) => m.type);

    const waitFor = async (pred: () => boolean) => {
        for (let i = 0; i < 100 && !pred(); i++) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(pred()).toBe(true);
    };
    const done = (jobId: number) => () =>
        messages().some((m) => m.jobId === jobId && (m.type === 'finish' || m.type === 'fatal'));
    // Lets pending microtasks of the worker settle, e.g. the busy flag release.
    const settle = () => new Promise((r) => setTimeout(r, 5));

    beforeEach(async () => {
        jest.resetModules();
        mockState.init.mockReset().mockResolvedValue(undefined);
        mockState.openStream.mockReset();
        mockState.openRandom.mockReset();
        mockState.detectFormat.mockReset();
        mockState.formatKind.mockReset().mockImplementation((f: string) => KINDS[f]);
        post = jest.fn();
        g.self = g.self ?? globalThis;
        g.postMessage = post;
        g.FileReaderSync = FakeFileReaderSync;
        await import('../src/lib/reader.worker');
    });

    afterEach(() => {
        g.FileReaderSync = savedFileReaderSync;
    });

    afterAll(() => {
        if (savedFileReaderSync === undefined) {
            delete g.FileReaderSync;
        }
    });

    describe('stream formats (pts)', () => {
        it('posts header, points, progress and finish in order for a single chunk', async () => {
            const points = makeBatch({ points: 2 });
            const { reader, batches } = installStreamReader({
                pushBatches: [points],
                total: (n) => (n >= 1 ? 2 : undefined),
            });

            send(openMsg(textFile('2\n1 2 3 0 1 2 3\n4 5 6 0 1 2 3\n')));
            await waitFor(done(1));

            expect(messages().map((m) => m.type)).toEqual(['header', 'points', 'progress', 'finish']);
            expect(messages()[0]).toMatchObject({ type: 'header', jobId: 1, total: 2 });
            expect(messages()[2]).toMatchObject({ type: 'progress', value: 1 });
            const pointsCall = post.mock.calls[1];
            expect(pointsCall[1]).toEqual([points.positions.buffer, points.colors.buffer]);
            expect(pointsCall[0]).toEqual({ type: 'points', jobId: 1, positions: points.positions, colors: points.colors });
            batches.forEach((b) => expect(b.free).toHaveBeenCalledTimes(1));
            expect(reader.free).toHaveBeenCalledTimes(1);
            expect(mockState.init).toHaveBeenCalledTimes(1);
            expect(mockState.init).toHaveBeenCalledWith();
            expect(mockState.openStream).toHaveBeenCalledWith('pts', {
                voxelSize: 0.05,
                acceptColorless: false,
                defaultColor: [128, 128, 128],
                intensities: false,
                batchPoints: 131072,
            });
            expect(mockState.openRandom).not.toHaveBeenCalled();
        });

        it('passes the wasm url to init as module_or_path', async () => {
            installStreamReader();
            send(openMsg(textFile('x'), { wasmUrl: 'https://x/y.wasm' }));
            await waitFor(done(1));

            expect(mockState.init).toHaveBeenCalledTimes(1);
            expect(mockState.init).toHaveBeenCalledWith({ module_or_path: 'https://x/y.wasm' });
        });

        it('posts the header once, before the first points, when it spans several chunks', async () => {
            const text = '10000\n1 2 3 0 1 2 3\n';
            const chunks = Math.ceil(text.length / 3);
            // Points only arrive once the header is known (push #4).
            const pushBatches = [makeBatch(), makeBatch(), makeBatch(), makeBatch({ points: 1 })];
            installStreamReader({
                pushBatches,
                total: (n) => (n >= 4 ? 10000 : undefined),
                records: () => 0,
            });

            send(openMsg(textFile(text), { chunkSize: 3 }));
            await waitFor(done(1));

            const headers = messages().filter((m) => m.type === 'header');
            expect(headers).toHaveLength(1);
            expect(headers[0].total).toBe(10000);
            expect(types().indexOf('header')).toBeLessThan(types().indexOf('points'));
            const progress = messages().filter((m) => m.type === 'progress');
            expect(progress).toHaveLength(chunks);
            expect(progress[progress.length - 1].value).toBe(1);
        });

        it('stops slicing and pushing once the reader is complete, then reports progress 1 and finishes', async () => {
            const { reader } = installStreamReader({
                pushBatches: [makeBatch({ points: 1 })],
                total: () => 1,
                complete: (n) => n >= 1,
            });

            send(openMsg(textFile('abcdefghi'), { chunkSize: 3 }));
            await waitFor(done(1));

            expect(reader.push).toHaveBeenCalledTimes(1);
            expect(reader.finish).toHaveBeenCalledTimes(1);
            const progress = messages().filter((m) => m.type === 'progress');
            expect(progress.map((m) => m.value)).toEqual([3 / 9, 1]);
            expect(types()).toEqual(['header', 'points', 'progress', 'progress', 'finish']);
            expect(reader.free).toHaveBeenCalledTimes(1);
        });

        it('posts progress 1 only once when the reader completes on the last chunk', async () => {
            installStreamReader({ pushBatches: [makeBatch()], complete: () => true });

            send(openMsg(textFile('abc'), { chunkSize: 3 }));
            await waitFor(done(1));

            const progress = messages().filter((m) => m.type === 'progress');
            expect(progress.map((m) => m.value)).toEqual([1]);
        });

        it('posts the header as soon as records were read, even without a declared total', async () => {
            installStreamReader({ pushBatches: [makeBatch({ points: 1 })], total: () => undefined, records: (n) => n });

            send(openMsg(textFile('1 2 3 0 1 2 3\n')));
            await waitFor(done(1));

            expect(types()).toEqual(['header', 'points', 'progress', 'finish']);
            expect(messages()[0].total).toBeNull();
        });

        it('posts a null-total header after the loop when the header was never parsed', async () => {
            installStreamReader({ total: () => undefined, records: () => 0 });

            send(openMsg(textFile('abcdef'), { chunkSize: 3 }));
            await waitFor(done(1));

            const headers = messages().filter((m) => m.type === 'header');
            expect(headers).toHaveLength(1);
            expect(headers[0].total).toBeNull();
            expect(types().indexOf('header')).toBeGreaterThan(types().lastIndexOf('progress'));
            expect(types().indexOf('header')).toBeLessThan(types().indexOf('finish'));
        });

        it('reports error messages together with the number of dropped errors', async () => {
            installStreamReader({ pushBatches: [makeBatch({ errors: ['a', 'b'], errorCount: 5 })] });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(messages().find((m) => m.type === 'error')).toEqual({
                type: 'error',
                jobId: 1,
                code: 'INVALID_ROW',
                messages: ['a', 'b'],
                dropped: 3,
            });
        });

        it('posts neither points nor error for an empty batch', async () => {
            installStreamReader({ pushBatches: [makeBatch()] });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(types()).not.toContain('points');
            expect(types()).not.toContain('error');
        });

        it('transfers intensities when a stream format provides them, without a cloud index', async () => {
            const withI = makeBatch({ points: 2, intensities: true });
            installStreamReader({ pushBatches: [withI] });

            send(openMsg(textFile('abc'), { intensities: true }));
            await waitFor(done(1));

            const pointsCall = post.mock.calls.find((c) => (c[0] as Msg).type === 'points');
            expect(pointsCall?.[1]).toEqual([withI.positions.buffer, withI.colors.buffer, withI.intensities?.buffer]);
            expect(pointsCall?.[0]).toMatchObject({ intensities: withI.intensities });
            expect(pointsCall?.[0]).not.toHaveProperty('cloud');
            expect(mockState.openStream.mock.calls[0][1]).toMatchObject({ intensities: true });
        });

        it('finishes an empty file with a null header and full progress', async () => {
            const { reader } = installStreamReader();

            send(openMsg(makeFile(new Uint8Array(0))));
            await waitFor(done(1));

            expect(messages()).toEqual([
                { type: 'header', jobId: 1, total: null },
                { type: 'progress', jobId: 1, value: 1 },
                { type: 'finish', jobId: 1 },
            ]);
            expect(reader.push).not.toHaveBeenCalled();
            expect(reader.free).toHaveBeenCalledTimes(1);
        });

        it('posts a single init fatal when init rejects and releases the worker', async () => {
            mockState.init.mockRejectedValueOnce(new Error('no wasm'));
            installStreamReader();

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(messages()).toEqual([{ type: 'fatal', jobId: 1, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' }]);
            expect(mockState.openStream).not.toHaveBeenCalled();

            await settle();
            send(openMsg(textFile('abc'), { jobId: 2 }));
            await waitFor(done(2));
            expect(messages().filter((m) => m.jobId === 2).map((m) => m.type)).toContain('finish');
        });

        it('posts a fatal NO_COLOR and no finish when push throws a coded error', async () => {
            const { reader } = installStreamReader({
                pushError: Object.assign(new Error('Row has no color data: 1 2 3'), { code: 'NO_COLOR' }),
            });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(messages()).toEqual([
                { type: 'fatal', jobId: 1, stage: 'run', code: 'NO_COLOR', message: 'Row has no color data: 1 2 3' },
            ]);
            expect(reader.free).toHaveBeenCalledTimes(1);
        });

        it('falls back to UNKNOWN for an unrecognised error code', async () => {
            installStreamReader({ pushError: Object.assign(new Error('x'), { code: 'WEIRD' }) });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(messages()[0]).toMatchObject({ type: 'fatal', code: 'UNKNOWN' });
        });

        it('posts a run fatal, frees the reader and releases the worker when push throws', async () => {
            const { reader } = installStreamReader({ pushError: new Error('boom') });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(messages()).toEqual([{ type: 'fatal', jobId: 1, stage: 'run', code: 'UNKNOWN', message: 'boom' }]);
            expect(reader.free).toHaveBeenCalledTimes(1);

            await settle();
            installStreamReader();
            send(openMsg(textFile('abc'), { jobId: 2 }));
            await waitFor(done(2));
            expect(messages().filter((m) => m.jobId === 2).map((m) => m.type)).toContain('finish');
        });

        it('posts a run fatal when openStream throws', async () => {
            mockState.openStream.mockImplementation(() => {
                throw new Error('Invalid ReadOptions.defaultColor');
            });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(messages()).toEqual([
                { type: 'fatal', jobId: 1, stage: 'run', code: 'UNKNOWN', message: 'Invalid ReadOptions.defaultColor' },
            ]);
        });

        it('rejects a second open with Worker busy while the first keeps running', async () => {
            installStreamReader();

            send(openMsg(textFile('abc', 30)));
            send(openMsg(textFile('abc'), { jobId: 2 }));

            expect(messages()).toEqual([{ type: 'fatal', jobId: 2, stage: 'run', code: 'BUSY', message: 'Worker busy' }]);

            await waitFor(done(1));
            expect(messages().filter((m) => m.jobId === 1).map((m) => m.type)).toContain('finish');
        });

        it('frees the batch and ends with a run fatal when takePositions throws', async () => {
            const bad = makeBatch({ points: 1 });
            bad.takePositions.mockImplementation(() => {
                throw new Error('detached');
            });
            const { reader } = installStreamReader({ pushBatches: [bad] });

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(bad.free).toHaveBeenCalledTimes(1);
            expect(messages()[messages().length - 1]).toMatchObject({ type: 'fatal', stage: 'run', message: 'detached' });
            expect(reader.free).toHaveBeenCalledTimes(1);
        });
    });

    describe('random-access formats (e57)', () => {
        it('posts header, clouds, points, progress and finish in order for two clouds', async () => {
            const { reader, batches } = installRandomReader([
                {
                    records: 4,
                    name: 'first',
                    guid: 'g-0',
                    translation: [1, 2, 3],
                    rotation: [1, 0, 0, 0],
                    hasColor: true,
                    hasIntensity: false,
                    batches: [{ points: 2 }],
                },
                { records: 6, hasIntensity: true, hasNormals: true, batches: [{ points: 3 }] },
            ]);

            send(e57Msg());
            await waitFor(done(1));

            expect(types()).toEqual(['header', 'cloud', 'cloud', 'points', 'progress', 'points', 'progress', 'progress', 'finish']);
            expect(messages()[0]).toEqual({ type: 'header', jobId: 1, total: 10 });
            expect(messages()[1]).toEqual({
                type: 'cloud',
                jobId: 1,
                cloud: {
                    index: 0,
                    name: 'first',
                    guid: 'g-0',
                    records: 4,
                    translation: [1, 2, 3],
                    rotation: [1, 0, 0, 0],
                    hasColor: true,
                    hasIntensity: false,
                    hasNormals: false,
                },
            });
            expect(messages()[2]).toEqual({
                type: 'cloud',
                jobId: 1,
                cloud: {
                    index: 1,
                    name: null,
                    guid: null,
                    records: 6,
                    translation: null,
                    rotation: null,
                    hasColor: false,
                    hasIntensity: true,
                    hasNormals: true,
                },
            });
            expect(messages()[3]).toEqual({
                type: 'points', jobId: 1, positions: batches[0].positions, colors: batches[0].colors, cloud: 0,
            });
            expect(messages()[5]).toMatchObject({ type: 'points', positions: batches[1].positions, cloud: 1 });
            expect(messages()[messages().length - 2]).toEqual({ type: 'progress', jobId: 1, value: 1 });
            expect(messages()[messages().length - 1]).toEqual({ type: 'finish', jobId: 1 });
            expect(mockState.init).toHaveBeenCalledTimes(1);
            expect(mockState.init).toHaveBeenCalledWith();
            expect(mockState.openRandom).toHaveBeenCalledWith('e57', expect.anything(), {
                voxelSize: 0.05,
                acceptColorless: false,
                defaultColor: [10, 20, 30],
                intensities: false,
                batchPoints: 131072,
            });
            expect(mockState.openStream).not.toHaveBeenCalled();
            expect(reader.readCloud).toHaveBeenCalledTimes(2);
        });

        it('passes the wasm url to init as module_or_path and forwards batchSize and intensities', async () => {
            installRandomReader([]);
            send(e57Msg({ wasmUrl: 'https://x/y.wasm', batchSize: 500, intensities: true }));
            await waitFor(done(1));

            expect(mockState.init).toHaveBeenCalledTimes(1);
            expect(mockState.init).toHaveBeenCalledWith({ module_or_path: 'https://x/y.wasm' });
            expect(mockState.openRandom).toHaveBeenCalledWith('e57', expect.anything(), {
                voxelSize: 0.05,
                acceptColorless: false,
                defaultColor: [10, 20, 30],
                intensities: true,
                batchPoints: 500,
            });
            expect(types()).toEqual(['header', 'progress', 'finish']);
        });

        it('builds a byte source over the file for the reader', async () => {
            installRandomReader([]);
            send(e57Msg());
            await waitFor(done(1));

            const source = mockState.openRandom.mock.calls[0][1] as { size: number; read(o: number, l: number): Uint8Array };
            expect(source.size).toBe(1000);
            expect(source.read(0, 10)).toBeInstanceOf(Uint8Array);
        });

        it('transfers 2 buffers without intensities, 3 with, and skips points for empty batches', async () => {
            const { batches } = installRandomReader([
                { records: 3, batches: [{ points: 1 }, { points: 0 }] },
                { records: 2, batches: [{ points: 2, intensities: true }] },
            ]);

            send(e57Msg({ intensities: true }));
            await waitFor(done(1));

            const [plain, , withI] = batches;
            const pointCalls = post.mock.calls.filter((c) => (c[0] as Msg).type === 'points');
            expect(pointCalls).toHaveLength(2);
            expect(pointCalls[0][1]).toEqual([plain.positions.buffer, plain.colors.buffer]);
            expect(pointCalls[0][0]).not.toHaveProperty('intensities');
            expect(pointCalls[0][0].cloud).toBe(0);
            expect(pointCalls[1][1]).toEqual([withI.positions.buffer, withI.colors.buffer, withI.intensities?.buffer]);
            expect(pointCalls[1][0]).toMatchObject({ intensities: withI.intensities, cloud: 1 });
            // header, cloud, cloud, points, progress, progress (empty batch), points, progress, progress, finish
            expect(types()).toEqual([
                'header', 'cloud', 'cloud', 'points', 'progress', 'progress', 'points', 'progress', 'progress', 'finish',
            ]);
        });

        it('reports progress as recordsRead / total, capped at 1', async () => {
            installRandomReader([{ records: 4, batches: [{ points: 1 }, { points: 2 }, { points: 3 }] }], { total: 4 });

            send(e57Msg());
            await waitFor(done(1));

            const progress = messages().filter((m) => m.type === 'progress').map((m) => m.value);
            expect(progress).toEqual([0.25, 0.75, 1, 1]);
        });

        it('reports progress 1 when the total is 0', async () => {
            installRandomReader([{ records: 0, batches: [{ points: 2 }] }], { total: 0 });

            send(e57Msg());
            await waitFor(done(1));

            expect(messages()[0]).toMatchObject({ type: 'header', total: 0 });
            const progress = messages().filter((m) => m.type === 'progress').map((m) => m.value);
            expect(progress).toEqual([1, 1]);
        });

        it('posts record errors of a batch with the dropped count, before its progress', async () => {
            installRandomReader([{ records: 2, batches: [{ points: 1, errors: ['bad'], errorCount: 3 }] }]);

            send(e57Msg());
            await waitFor(done(1));

            expect(types()).toEqual(['header', 'cloud', 'points', 'error', 'progress', 'progress', 'finish']);
            expect(messages()[3]).toEqual({ type: 'error', jobId: 1, code: 'INVALID_ROW', messages: ['bad'], dropped: 2 });
        });

        it('posts a per-cloud error and continues with the next cloud when the reader is not failed', async () => {
            const { reader } = installRandomReader([
                { records: 2, throwMessage: 'Scan 0: boom' },
                { records: 2, batches: [{ points: 2 }] },
            ]);

            send(e57Msg());
            await waitFor(done(1));

            const errors = messages().filter((m) => m.type === 'error');
            expect(errors).toEqual([{ type: 'error', jobId: 1, code: 'CLOUD_ERROR', messages: ['Scan 0: boom'], dropped: 0, cloud: 0 }]);
            expect(reader.readCloud).toHaveBeenCalledTimes(2);
            expect(types().indexOf('error')).toBeLessThan(types().indexOf('points'));
            expect(types()[types().length - 1]).toBe('finish');
            expect(types()).not.toContain('fatal');
            expect(reader.free).toHaveBeenCalledTimes(1);
        });

        it('uses the error code of a failed cloud when present', async () => {
            installRandomReader([{ records: 2, throwMessage: 'Scan 0: bad', throwCode: 'INVALID_HEADER' }]);

            send(e57Msg());
            await waitFor(done(1));

            expect(messages().find((m) => m.type === 'error')).toMatchObject({ code: 'INVALID_HEADER', cloud: 0 });
        });

        it('posts a run fatal, frees the reader and stops when the reader is failed', async () => {
            const { reader } = installRandomReader([
                { records: 2, throwMessage: 'Failed to read file: gone', failedAfter: true },
                { records: 2, batches: [{ points: 2 }] },
            ]);

            send(e57Msg());
            await waitFor(done(1));

            expect(messages()[messages().length - 1]).toEqual({
                type: 'fatal',
                jobId: 1,
                stage: 'run',
                code: 'UNKNOWN',
                message: 'Failed to read file: gone',
            });
            expect(types()).not.toContain('finish');
            expect(types()).not.toContain('error');
            expect(reader.readCloud).toHaveBeenCalledTimes(1);
            expect(reader.free).toHaveBeenCalledTimes(1);
        });

        it('posts a run fatal when openRandom throws', async () => {
            mockState.openRandom.mockImplementation(() => {
                throw new Error('E57 open failed: bad signature');
            });

            send(e57Msg());
            await waitFor(done(1));

            expect(messages()).toEqual([
                { type: 'fatal', jobId: 1, stage: 'run', code: 'UNKNOWN', message: 'E57 open failed: bad signature' },
            ]);
        });

        it('posts an init fatal without opening a reader when init rejects, then releases the worker', async () => {
            mockState.init.mockRejectedValueOnce(new Error('no wasm'));
            installRandomReader([]);

            send(e57Msg());
            await waitFor(done(1));

            expect(messages()).toEqual([{ type: 'fatal', jobId: 1, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' }]);
            expect(mockState.openRandom).not.toHaveBeenCalled();

            await settle();
            send(e57Msg({ jobId: 2 }));
            await waitFor(done(2));
            expect(messages().filter((m) => m.jobId === 2).map((m) => m.type)).toContain('finish');
        });

        it('frees the reader once and every cloud info, summary and batch on success', async () => {
            const { reader, infos, summaries, batches } = installRandomReader([
                { records: 1, batches: [{ points: 1 }] },
                { records: 1, batches: [{ points: 1 }] },
                { records: 1 },
            ]);

            send(e57Msg());
            await waitFor(done(1));

            expect(reader.free).toHaveBeenCalledTimes(1);
            expect(infos).toHaveLength(3);
            infos.forEach((i) => expect(i.free).toHaveBeenCalledTimes(1));
            expect(summaries).toHaveLength(3);
            summaries.forEach((s) => expect(s.free).toHaveBeenCalledTimes(1));
            expect(batches).toHaveLength(2);
            batches.forEach((b) => expect(b.free).toHaveBeenCalledTimes(1));
        });

        it('frees the reader and the cloud info when cloudInfo data is unusable', async () => {
            const { reader, infos } = installRandomReader([{ records: 1 }]);
            reader.cloudInfo.mockImplementationOnce(() => {
                const info = {
                    translation: () => {
                        throw new Error('detached');
                    },
                    rotation: () => new Float64Array(0),
                    free: jest.fn(),
                };
                infos.push(info);
                return info as never;
            });

            send(e57Msg());
            await waitFor(done(1));

            expect(messages()[messages().length - 1]).toMatchObject({ type: 'fatal', stage: 'run', message: 'detached' });
            expect(infos[0].free).toHaveBeenCalledTimes(1);
            expect(reader.free).toHaveBeenCalledTimes(1);
        });

        it('swallows an exception from reader.free', async () => {
            const { reader } = installRandomReader([]);
            reader.free.mockImplementation(() => {
                throw new Error('already freed');
            });

            send(e57Msg());
            await waitFor(done(1));
            await settle();

            expect(types()).toEqual(['header', 'progress', 'finish']);
        });

        it('rejects a second open with Worker busy while the first keeps running', async () => {
            mockState.init.mockImplementationOnce(() => new Promise((r) => setTimeout(r, 30)));
            installRandomReader([{ records: 1, batches: [{ points: 1 }] }]);

            send(e57Msg());
            send(e57Msg({ jobId: 2 }));

            expect(messages()).toEqual([{ type: 'fatal', jobId: 2, stage: 'run', code: 'BUSY', message: 'Worker busy' }]);

            await waitFor(done(1));
            expect(messages().filter((m) => m.jobId === 1).map((m) => m.type)).toContain('finish');
        });

        it('posts a run fatal when FileReaderSync is missing', async () => {
            delete g.FileReaderSync;
            installRandomReader([]);

            send(e57Msg());
            await waitFor(done(1));

            expect(messages()).toHaveLength(1);
            expect(messages()[0]).toMatchObject({ type: 'fatal', jobId: 1, stage: 'run' });
            expect(messages()[0].message).toContain('FileReaderSync is not available');
            expect(mockState.openRandom).not.toHaveBeenCalled();
        });

        it('fake reader detects re-entrant calls from inside readCloud', async () => {
            let probeError: unknown;
            installRandomReader([{ records: 1, batches: [{ points: 1 }] }], {
                sinkProbe: (r) => {
                    try {
                        (r as { recordsRead(): number }).recordsRead();
                    } catch (e) {
                        probeError = e;
                    }
                },
            });

            send(e57Msg());
            await waitFor(done(1));

            expect(probeError).toEqual(new Error('re-entrant call into the reader'));
            // The worker's own sink never re-enters the reader, so the run still finishes cleanly.
            expect(types()[types().length - 1]).toBe('finish');
        });
    });

    describe('format resolution and message filtering', () => {
        it('detects the format from a 64 KiB head and the file name, posting format before header', async () => {
            installStreamReader({ pushBatches: [makeBatch({ points: 1 })], total: () => 1 });
            mockState.detectFormat.mockReturnValue('pts');
            const file = textFile('1\n1 2 3 0 1 2 3\n', 0, 'cloud.pts');

            send(openMsg(file, { format: 'auto' }));
            await waitFor(done(1));

            expect(file.slice).toHaveBeenNthCalledWith(1, 0, 65536);
            expect(mockState.detectFormat).toHaveBeenCalledTimes(1);
            const [head, name] = mockState.detectFormat.mock.calls[0];
            expect(head).toBeInstanceOf(Uint8Array);
            expect(new TextDecoder().decode(head)).toBe('1\n1 2 3 0 1 2 3\n');
            expect(name).toBe('cloud.pts');
            expect(messages()[0]).toEqual({ type: 'format', jobId: 1, format: 'pts' });
            expect(types()).toEqual(['format', 'header', 'points', 'progress', 'finish']);
            expect(mockState.openStream).toHaveBeenCalledWith('pts', expect.anything());
        });

        it('opens a detected ply file as a stream format', async () => {
            installStreamReader({ pushBatches: [makeBatch({ points: 1 })], total: () => 1 });
            mockState.detectFormat.mockReturnValue('ply');

            send(openMsg(textFile('ply\nformat ascii 1.0\n', 0, 'mesh.ply'), { format: 'auto' }));
            await waitFor(done(1));

            expect(messages()[0]).toEqual({ type: 'format', jobId: 1, format: 'ply' });
            expect(types()).toEqual(['format', 'header', 'points', 'progress', 'finish']);
            expect(mockState.formatKind).toHaveBeenCalledWith('ply');
            expect(mockState.openStream).toHaveBeenCalledWith('ply', expect.anything());
            expect(mockState.openRandom).not.toHaveBeenCalled();
        });

        it('opens a detected random-access format with openRandom', async () => {
            installRandomReader([{ records: 1, batches: [{ points: 1 }] }]);
            mockState.detectFormat.mockReturnValue('e57');

            send(e57Msg({ format: 'auto' }));
            await waitFor(done(1));

            expect(types()).toEqual(['format', 'header', 'cloud', 'points', 'progress', 'progress', 'finish']);
            expect(messages()[0]).toEqual({ type: 'format', jobId: 1, format: 'e57' });
            expect(mockState.openRandom).toHaveBeenCalledWith('e57', expect.anything(), expect.anything());
            expect(mockState.openStream).not.toHaveBeenCalled();
        });

        it('posts a run fatal without opening a reader when the format cannot be detected', async () => {
            mockState.detectFormat.mockReturnValue(undefined);

            send(openMsg(textFile('garbage'), { format: 'auto' }));
            await waitFor(done(1));

            expect(messages()).toEqual([{ type: 'fatal', jobId: 1, stage: 'run', code: 'UNKNOWN_FORMAT', message: 'Unknown point cloud format' }]);
            expect(mockState.openStream).not.toHaveBeenCalled();
            expect(mockState.openRandom).not.toHaveBeenCalled();

            await settle();
            installStreamReader();
            send(openMsg(textFile('abc'), { jobId: 2 }));
            await waitFor(done(2));
            expect(messages().filter((m) => m.jobId === 2).map((m) => m.type)).toContain('finish');
        });

        it('posts a run fatal when a detected format is not compiled in', async () => {
            mockState.detectFormat.mockReturnValue('las');

            send(openMsg(textFile('LASF'), { format: 'auto' }));
            await waitFor(done(1));

            expect(messages()).toEqual([
                { type: 'format', jobId: 1, format: 'las' },
                { type: 'fatal', jobId: 1, stage: 'run', code: 'UNSUPPORTED_FORMAT', message: 'Format las is not supported by this build' },
            ]);
            expect(mockState.formatKind).toHaveBeenCalledWith('las');
            expect(mockState.openStream).not.toHaveBeenCalled();
            expect(mockState.openRandom).not.toHaveBeenCalled();
        });

        it('does not detect or post a format message for an explicit format', async () => {
            installStreamReader();

            send(openMsg(textFile('abc')));
            await waitFor(done(1));

            expect(mockState.detectFormat).not.toHaveBeenCalled();
            expect(types()).not.toContain('format');
        });

        it('ignores messages that are not open messages, including the removed start messages', async () => {
            send({ type: 'start', jobId: 1, file: makeFile(new Uint8Array(1)) });
            send({ type: 'start', jobId: 1, file: makeFile(new Uint8Array(1)), format: 'e57' });
            send({ type: 'open' });
            send({ type: 'open', jobId: 1 });
            send({ type: 'other', jobId: 1 });
            send(null);
            await settle();

            expect(post).not.toHaveBeenCalled();
            expect(mockState.init).not.toHaveBeenCalled();
        });
    });
});
