import type { PtsEngine, PtsEngineSink, ResolvedPtsOptions } from '@dp-software/point-cloud';
import { createWasmEngine, isWasmEngineSupported, WasmWorkerPtsEngine } from '../src/lib/wasm-engine';
import type { OpenMessage, WorkerMessage } from '../src/lib/protocol';

// A real Worker is not available in jsdom, so the engine is driven through a fake one.
class FakeWorker {
    public postMessage = jest.fn();
    public terminate = jest.fn();
    public onmessage: ((e: MessageEvent) => void) | null = null;
    public onerror: ((e: ErrorEvent) => void) | null = null;
    public onmessageerror: ((e: MessageEvent) => void) | null = null;
    public preventDefault = jest.fn();

    public emit(msg: unknown): void {
        this.onmessage?.({ data: msg } as MessageEvent);
    }

    public failDeserialize(): void {
        this.onmessageerror?.({ data: null } as MessageEvent);
    }

    public failLoad(message: string): void {
        this.onerror?.({ message, preventDefault: this.preventDefault } as unknown as ErrorEvent);
    }

    public get start(): OpenMessage {
        return this.postMessage.mock.calls[0][0] as OpenMessage;
    }

    public get jobId(): number {
        return this.start.jobId;
    }
}

const makeSink = () => ({
    header: jest.fn(),
    points: jest.fn(),
    progress: jest.fn(),
    error: jest.fn(),
    finish: jest.fn(),
});

const opts: ResolvedPtsOptions = { voxelSize: 0.05, acceptColorless: false, defaultColor: [128, 128, 128] };

describe('WasmWorkerPtsEngine', () => {
    let fake: FakeWorker;
    let sink: ReturnType<typeof makeSink>;
    let file: Blob;

    const start = (options: ConstructorParameters<typeof WasmWorkerPtsEngine>[0] = {}) => {
        const engine = new WasmWorkerPtsEngine({ workerFactory: () => fake as unknown as Worker, ...options });
        engine.run(file, opts, sink as PtsEngineSink);
        return engine;
    };

    beforeEach(() => {
        fake = new FakeWorker();
        sink = makeSink();
        file = new Blob(['x']);
    });

    describe('open message', () => {
        it('should carry the file, the pts format and resolved options', () => {
            start();

            expect(fake.start).toEqual({
                type: 'open',
                jobId: expect.any(Number),
                file,
                format: 'pts',
                voxelSize: 0.05,
                acceptColorless: false,
                defaultColor: [128, 128, 128],
                intensities: false,
            });
            expect('wasmUrl' in fake.start).toBe(false);
            expect('chunkSize' in fake.start).toBe(false);
            expect('batchSize' in fake.start).toBe(false);
        });

        it('should include wasmUrl as a string and chunkSize when configured', () => {
            start({ wasmUrl: new URL('https://example.com/a.wasm'), chunkSize: 1024 });

            expect(fake.start.wasmUrl).toBe('https://example.com/a.wasm');
            expect(fake.start.chunkSize).toBe(1024);
        });
    });

    describe('message forwarding', () => {
        it('should convert points messages into PointCloudData', () => {
            start();
            fake.emit({
                type: 'points',
                jobId: fake.jobId,
                positions: new Float64Array([1, 2, 3, 4, 5, 6]),
                colors: new Uint8Array([7, 8, 9, 10, 11, 12]),
            });

            expect(sink.points).toHaveBeenCalledTimes(1);
            expect(sink.points).toHaveBeenCalledWith({
                points: [[1, 2, 3], [4, 5, 6]],
                colors: [[7, 8, 9], [10, 11, 12]],
            });
        });

        it('should forward the header total', () => {
            start();
            fake.emit({ type: 'header', jobId: fake.jobId, total: 10000 });

            expect(sink.header).toHaveBeenCalledWith(10000);
        });

        it('should report NaN when the header has no total', () => {
            start();
            fake.emit({ type: 'header', jobId: fake.jobId, total: null });

            expect(sink.header).toHaveBeenCalledTimes(1);
            expect(Number.isNaN(sink.header.mock.calls[0][0])).toBe(true);
        });

        it('should forward a header that arrives after points', () => {
            start();
            fake.emit({
                type: 'points',
                jobId: fake.jobId,
                positions: new Float64Array([1, 2, 3]),
                colors: new Uint8Array([4, 5, 6]),
            });
            fake.emit({ type: 'header', jobId: fake.jobId, total: 7 });

            expect(sink.points).toHaveBeenCalledTimes(1);
            expect(sink.header).toHaveBeenCalledWith(7);
        });

        it('should forward progress', () => {
            start();
            fake.emit({ type: 'progress', jobId: fake.jobId, value: 0.5 });

            expect(sink.progress).toHaveBeenCalledWith(0.5);
        });

        it('should report row errors followed by a dropped-count summary', () => {
            start();
            fake.emit({ type: 'error', jobId: fake.jobId, code: 'INVALID_ROW', messages: ['a', 'b'], dropped: 3 });

            expect(sink.error.mock.calls).toEqual([
                ['a', 'INVALID_ROW', false],
                ['b', 'INVALID_ROW', false],
                ['3 more row errors', 'INVALID_ROW', false],
            ]);
        });

        it('should report only the messages when nothing was dropped', () => {
            start();
            fake.emit({ type: 'error', jobId: fake.jobId, code: 'INVALID_ROW', messages: ['a', 'b'], dropped: 0 });

            expect(sink.error.mock.calls).toEqual([['a', 'INVALID_ROW', false], ['b', 'INVALID_ROW', false]]);
        });

        it('should ignore messages of another job', () => {
            start();
            const other = fake.jobId + 1000;
            fake.emit({ type: 'header', jobId: other, total: 1 });
            fake.emit({ type: 'progress', jobId: other, value: 1 });
            fake.emit({ type: 'finish', jobId: other });

            expect(sink.header).not.toHaveBeenCalled();
            expect(sink.progress).not.toHaveBeenCalled();
            expect(sink.finish).not.toHaveBeenCalled();
            expect(fake.terminate).not.toHaveBeenCalled();
        });

        it('should ignore format and cloud messages', () => {
            start();
            fake.emit({ type: 'format', jobId: fake.jobId, format: 'pts' });
            fake.emit({ type: 'cloud', jobId: fake.jobId, cloud: { index: 0 } });

            expect(sink.header).not.toHaveBeenCalled();
            expect(sink.points).not.toHaveBeenCalled();
            expect(sink.error).not.toHaveBeenCalled();
            expect(sink.finish).not.toHaveBeenCalled();
        });

        it('should ignore malformed messages', () => {
            start();
            fake.emit({ type: 'nonsense', jobId: fake.jobId });
            fake.emit(null);

            expect(sink.finish).not.toHaveBeenCalled();
            expect(sink.error).not.toHaveBeenCalled();
        });
    });

    describe('finish', () => {
        it('should finish the sink once and terminate the worker', () => {
            start();
            fake.emit({ type: 'finish', jobId: fake.jobId });

            expect(sink.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should ignore a second finish and any later message', () => {
            start();
            const jobId = fake.jobId;
            const onmessage = fake.onmessage as (e: MessageEvent) => void;
            const send = (msg: WorkerMessage) => onmessage({ data: msg } as MessageEvent);

            send({ type: 'finish', jobId });
            send({ type: 'finish', jobId });
            send({ type: 'progress', jobId, value: 1 });
            send({ type: 'fatal', jobId, stage: 'run', code: 'READ_ERROR', message: 'late' });

            expect(sink.finish).toHaveBeenCalledTimes(1);
            expect(sink.progress).not.toHaveBeenCalled();
            expect(sink.error).not.toHaveBeenCalled();
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });
    });

    describe('failures', () => {
        let fallback: { run: jest.Mock };

        beforeEach(() => {
            fallback = { run: jest.fn() };
        });

        it('should hand over to the fallback on an init fatal before any points', () => {
            start({ fallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(fallback.run).toHaveBeenCalledTimes(1);
            expect(fallback.run).toHaveBeenCalledWith(file, opts, sink);
            expect(sink.finish).not.toHaveBeenCalled();
            expect(sink.error).not.toHaveBeenCalled();
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should report the error and finish on an init fatal without a fallback', () => {
            start();
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(sink.error).toHaveBeenCalledTimes(1);
            expect(sink.error).toHaveBeenCalledWith('no wasm', 'INIT_FAILED', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should not use the fallback for a run fatal after points were emitted', () => {
            start({ fallback: fallback as PtsEngine });
            fake.emit({
                type: 'points',
                jobId: fake.jobId,
                positions: new Float64Array([1, 2, 3]),
                colors: new Uint8Array([4, 5, 6]),
            });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'READ_ERROR', message: 'bad stream' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(sink.error).toHaveBeenCalledTimes(1);
            expect(sink.error).toHaveBeenCalledWith('bad stream', 'READ_ERROR', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });

        it('should forward a NO_COLOR fatal with its code and finish once', () => {
            start({ fallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'NO_COLOR', message: 'Row has no color data: 1 2 3' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(sink.error).toHaveBeenCalledTimes(1);
            expect(sink.error).toHaveBeenCalledWith('Row has no color data: 1 2 3', 'NO_COLOR', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });

        it('should terminate the worker on a run fatal', () => {
            start({ fallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'READ_ERROR', message: 'bad stream' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(sink.error).toHaveBeenCalledWith('bad stream', 'READ_ERROR', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should treat a messageerror like a run fatal', () => {
            start({ fallback: fallback as PtsEngine });
            fake.failDeserialize();

            expect(fallback.run).not.toHaveBeenCalled();
            expect(sink.error).toHaveBeenCalledWith('Worker message could not be deserialized', 'READ_ERROR', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
            expect(fake.onmessageerror).toBeNull();
        });

        it('should report and finish when the fallback throws', () => {
            fallback.run.mockImplementation(() => { throw new Error('fallback broke'); });
            start({ fallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(fallback.run).toHaveBeenCalledTimes(1);
            expect(sink.error).toHaveBeenCalledWith('fallback broke', 'UNKNOWN', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });

        it('should treat a throwing postMessage as an init failure with a fallback', () => {
            fake.postMessage.mockImplementation(() => { throw new Error('cannot clone'); });
            start({ fallback: fallback as PtsEngine });

            expect(fallback.run).toHaveBeenCalledTimes(1);
            expect(fallback.run).toHaveBeenCalledWith(file, opts, sink);
            expect(sink.finish).not.toHaveBeenCalled();
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should report a throwing postMessage and finish without a fallback', () => {
            fake.postMessage.mockImplementation(() => { throw new Error('cannot clone'); });
            start();

            expect(sink.error).toHaveBeenCalledWith('cannot clone', 'INIT_FAILED', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should not use the fallback for an init fatal after points were emitted', () => {
            start({ fallback: fallback as PtsEngine });
            fake.emit({
                type: 'points',
                jobId: fake.jobId,
                positions: new Float64Array([1, 2, 3]),
                colors: new Uint8Array([4, 5, 6]),
            });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'late init' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(sink.error).toHaveBeenCalledWith('late init', 'INIT_FAILED', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });

        it('should treat a worker load error as an init failure and use the fallback', () => {
            start({ fallback: fallback as PtsEngine });
            fake.failLoad('boom');

            expect(fake.preventDefault).toHaveBeenCalled();
            expect(fallback.run).toHaveBeenCalledTimes(1);
            expect(fallback.run).toHaveBeenCalledWith(file, opts, sink);
            expect(sink.finish).not.toHaveBeenCalled();
        });

        it('should report a worker load error when there is no fallback', () => {
            start();
            fake.failLoad('boom');

            expect(sink.error).toHaveBeenCalledWith('boom', 'INIT_FAILED', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });

        it('should report the PTS worker label for a load error without a message', () => {
            start();
            fake.failLoad('');

            expect(sink.error).toHaveBeenCalledWith('Failed to load the PTS worker', 'INIT_FAILED', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });

        it('should treat a throwing workerFactory as an init failure with a fallback', () => {
            const engine = new WasmWorkerPtsEngine({
                workerFactory: () => { throw new Error('no worker'); },
                fallback: fallback as PtsEngine,
            });
            engine.run(file, opts, sink as PtsEngineSink);

            expect(fallback.run).toHaveBeenCalledTimes(1);
            expect(fallback.run).toHaveBeenCalledWith(file, opts, sink);
            expect(sink.finish).not.toHaveBeenCalled();
        });

        it('should report a throwing workerFactory and finish without a fallback', () => {
            const engine = new WasmWorkerPtsEngine({
                workerFactory: () => { throw new Error('no worker'); },
            });
            engine.run(file, opts, sink as PtsEngineSink);

            expect(sink.error).toHaveBeenCalledWith('no worker', 'INIT_FAILED', true);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });
    });

    describe('concurrent runs', () => {
        it('should reject a second run while the first is running and leave the first sink untouched', () => {
            const engine = start();
            const secondSink = makeSink();
            engine.run(file, opts, secondSink as PtsEngineSink);

            expect(secondSink.error).toHaveBeenCalledWith('WasmWorkerPtsEngine is already running', 'BUSY', true);
            expect(secondSink.finish).toHaveBeenCalledTimes(1);
            expect(sink.error).not.toHaveBeenCalled();
            expect(sink.finish).not.toHaveBeenCalled();
            expect(fake.terminate).not.toHaveBeenCalled();
        });

        it('should accept a new run after the first one finished', () => {
            const secondFake = new FakeWorker();
            const workers = [fake, secondFake];
            const engine = new WasmWorkerPtsEngine({ workerFactory: () => workers.shift() as unknown as Worker });
            engine.run(file, opts, sink as PtsEngineSink);
            fake.emit({ type: 'finish', jobId: fake.jobId });

            const secondSink = makeSink();
            engine.run(file, opts, secondSink as PtsEngineSink);

            expect(secondSink.error).not.toHaveBeenCalled();
            expect(secondFake.postMessage).toHaveBeenCalledTimes(1);

            secondFake.emit({ type: 'finish', jobId: secondFake.jobId });
            expect(secondSink.finish).toHaveBeenCalledTimes(1);
            expect(sink.finish).toHaveBeenCalledTimes(1);
        });
    });
});

describe('engine support detection', () => {
    it('should report no support in jsdom, which has no Worker', () => {
        expect(isWasmEngineSupported()).toBe(false);
    });

    it('should return null from createWasmEngine when unsupported', () => {
        expect(createWasmEngine()).toBeNull();
    });

    it('should create an engine when a workerFactory is given even if unsupported', () => {
        const engine = createWasmEngine({ workerFactory: () => new FakeWorker() as unknown as Worker });

        expect(engine).toBeInstanceOf(WasmWorkerPtsEngine);
    });

    it('should return null from createWasmEngine when WebAssembly is missing but Worker exists', () => {
        const g = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const originalWorker = g.Worker;
        const originalWasm = g.WebAssembly;
        g.Worker = function () { /* stub */ };
        delete g.WebAssembly;
        try {
            expect(isWasmEngineSupported()).toBe(false);
            expect(createWasmEngine()).toBeNull();
        } finally {
            g.WebAssembly = originalWasm;
            if (originalWorker === undefined) {
                delete g.Worker;
            } else {
                g.Worker = originalWorker;
            }
        }
    });

    it('should create the default worker from reader.worker.js as a module worker', () => {
        const g = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const original = g.Worker;
        const ctor = jest.fn(function () { return new FakeWorker(); });
        g.Worker = ctor;
        try {
            createWasmEngine()?.run(new Blob(['x']), opts, makeSink() as PtsEngineSink);

            expect(ctor).toHaveBeenCalledTimes(1);
            const [url, options] = ctor.mock.calls[0] as unknown as [URL, WorkerOptions];
            expect(String(url)).toMatch(/\/reader\.worker\.js$/);
            expect(options).toEqual({ type: 'module' });
        } finally {
            if (original === undefined) {
                delete g.Worker;
            } else {
                g.Worker = original;
            }
        }
    });

    it('should report support when Worker is defined', () => {
        const g = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const original = g.Worker;
        g.Worker = function () { /* stub */ };
        try {
            expect(isWasmEngineSupported()).toBe(true);
            expect(createWasmEngine()).toBeInstanceOf(WasmWorkerPtsEngine);
        } finally {
            if (original === undefined) {
                delete g.Worker;
            } else {
                g.Worker = original;
            }
        }
    });
});
