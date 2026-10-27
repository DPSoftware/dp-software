import type { PointCloudData, PtsEngine, PtsEngineSink, ResolvedPtsOptions } from '@dp-software/point-cloud';
import { isPointCloudParserSupported, PointCloudParser } from '../src/lib/point-cloud-parser';
import type { PointCloudParserOptions } from '../src/lib/point-cloud-parser';
import type { OpenMessage, SubCloudInfo } from '../src/lib/protocol';

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

    public failLoad(message: string): void {
        this.onerror?.({ message, preventDefault: this.preventDefault } as unknown as ErrorEvent);
    }

    public messageError(): void {
        this.onmessageerror?.({ data: null } as MessageEvent);
    }

    public get start(): OpenMessage {
        return this.postMessage.mock.calls[0][0] as OpenMessage;
    }

    public get jobId(): number {
        return this.start.jobId;
    }
}

const cloudInfo: SubCloudInfo = {
    index: 0, name: 'a', guid: 'g', records: 5, translation: [0, 0, 0], rotation: [1, 0, 0, 0],
    hasColor: true, hasIntensity: false, hasNormals: false,
};

describe('PointCloudParser', () => {
    let fake: FakeWorker;
    let file: Blob;
    let factory: jest.Mock;

    const setup = (options: PointCloudParserOptions = {}) => {
        const parser = new PointCloudParser({ voxelSize: 0.5, workerFactory: factory, ...options });
        const subs = {
            batch: jest.fn(), total: jest.fn(), status: jest.fn(),
            error: jest.fn(), coded: jest.fn(), finish: jest.fn(), cloud: jest.fn(), info: jest.fn(),
        };
        parser.onBatch.subscribe(subs.batch);
        parser.onNumberOfPoints.subscribe(subs.total);
        parser.loadingStatus.subscribe(subs.status);
        parser.onParseError.subscribe(subs.error);
        parser.onError.subscribe(subs.coded);
        parser.onFinish.subscribe(subs.finish);
        parser.onCloud.subscribe(subs.cloud);
        parser.onInfo.subscribe(subs.info);
        return { parser, subs };
    };

    const run = (options: PointCloudParserOptions = {}) => {
        const s = setup(options);
        s.parser.parse(file);
        return s;
    };

    beforeEach(() => {
        fake = new FakeWorker();
        file = new Blob(['x']);
        factory = jest.fn(() => fake as unknown as Worker);
    });

    it('should notify loadingStatus 0 on parse', () => {
        const { subs } = run();

        expect(subs.status).toHaveBeenCalledWith(0);
    });

    describe('open message', () => {
        it('should carry defaults with auto format and omit unset optional keys', () => {
            const parser = new PointCloudParser({ workerFactory: factory });
            parser.parse(file);

            expect(fake.start).toEqual({
                type: 'open',
                jobId: expect.any(Number),
                file,
                format: 'auto',
                voxelSize: 0.02,
                acceptColorless: false,
                defaultColor: [128, 128, 128],
                intensities: false,
            });
            expect('batchSize' in fake.start).toBe(false);
            expect('chunkSize' in fake.start).toBe(false);
            expect('wasmUrl' in fake.start).toBe(false);
        });

        it('should include configured options with wasmUrl as a string', () => {
            run({
                format: 'e57', defaultColor: [1, 2, 3], acceptColorless: true, intensities: true,
                batchSize: 10, chunkSize: 20, wasmUrl: new URL('https://x/y.wasm'),
            });

            expect(fake.start.format).toBe('e57');
            expect(fake.start.voxelSize).toBe(0.5);
            expect(fake.start.defaultColor).toEqual([1, 2, 3]);
            expect(fake.start.acceptColorless).toBe(true);
            expect(fake.start.intensities).toBe(true);
            expect(fake.start.batchSize).toBe(10);
            expect(fake.start.chunkSize).toBe(20);
            expect(fake.start.wasmUrl).toBe('https://x/y.wasm');
        });
    });

    describe('worker messages', () => {
        it('should forward the header total', () => {
            const { subs } = run();
            fake.emit({ type: 'header', jobId: fake.jobId, total: 30100 });

            expect(subs.total).toHaveBeenCalledWith(30100);
        });

        it('should report NaN for an unknown total', () => {
            const { subs } = run();
            fake.emit({ type: 'header', jobId: fake.jobId, total: null });

            expect(subs.total).toHaveBeenCalledWith(NaN);
            expect(subs.info).toHaveBeenCalledWith({ format: 'auto', totalPoints: null });
        });

        it('should emit onInfo once with the detected format and total', () => {
            const { subs } = run();
            fake.emit({ type: 'format', jobId: fake.jobId, format: 'e57' });
            expect(subs.info).not.toHaveBeenCalled();
            fake.emit({ type: 'header', jobId: fake.jobId, total: 10 });

            expect(subs.info).toHaveBeenCalledTimes(1);
            expect(subs.info).toHaveBeenCalledWith({ format: 'e57', totalPoints: 10 });
        });

        it('should emit onInfo with the requested format when there is no format message', () => {
            const { subs } = run({ format: 'pts' });
            fake.emit({ type: 'header', jobId: fake.jobId, total: 3 });

            expect(subs.info).toHaveBeenCalledWith({ format: 'pts', totalPoints: 3 });
        });

        it('should forward cloud info', () => {
            const { subs } = run();
            fake.emit({ type: 'cloud', jobId: fake.jobId, cloud: cloudInfo });

            expect(subs.cloud).toHaveBeenCalledWith(cloudInfo);
        });

        it('should pass the transferred arrays through with intensities and cloud', () => {
            const { subs } = run();
            const positions = new Float64Array([1, 2, 3, 4, 5, 6]);
            const colors = new Uint8Array([7, 8, 9, 10, 11, 12]);
            const intensities = new Float32Array([0.5, 1]);
            fake.emit({ type: 'points', jobId: fake.jobId, positions, colors, intensities, cloud: 1 });

            expect(subs.batch).toHaveBeenCalledTimes(1);
            const batch = subs.batch.mock.calls[0][0];
            expect(batch.positions).toBe(positions);
            expect(batch.colors).toBe(colors);
            expect(batch.intensities).toBe(intensities);
            expect(batch.cloud).toBe(1);
        });

        it('should omit intensities and use cloud 0 when the message has neither', () => {
            const { subs } = run();
            fake.emit({
                type: 'points', jobId: fake.jobId,
                positions: new Float64Array([1, 2, 3]), colors: new Uint8Array([4, 5, 6]),
            });

            const batch = subs.batch.mock.calls[0][0];
            expect('intensities' in batch).toBe(false);
            expect(batch.cloud).toBe(0);
        });

        it('should forward progress', () => {
            const { subs } = run();
            fake.emit({ type: 'progress', jobId: fake.jobId, value: 0.4 });

            expect(subs.status).toHaveBeenLastCalledWith(0.4);
        });

        it('should report record errors and the dropped count', () => {
            const { subs } = run();
            fake.emit({ type: 'error', jobId: fake.jobId, code: 'INVALID_ROW', messages: ['a', 'b'], dropped: 2 });

            expect(subs.error.mock.calls.map(c => c[0])).toEqual(['a', 'b', '2 more errors']);
        });

        it('should report only messages when nothing was dropped', () => {
            const { subs } = run();
            fake.emit({ type: 'error', jobId: fake.jobId, code: 'INVALID_ROW', messages: ['a', 'b'], dropped: 0 });

            expect(subs.error.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
        });

        it('should report coded errors with the dropped count only in errorCount', () => {
            const { subs } = run();
            fake.emit({ type: 'error', jobId: fake.jobId, code: 'INVALID_ROW', messages: ['a'], dropped: 2 });
            fake.emit({ type: 'finish', jobId: fake.jobId });

            expect(subs.coded.mock.calls.map(c => c[0])).toEqual([{ code: 'INVALID_ROW', message: 'a', fatal: false }]);
            expect(subs.error.mock.calls.map(c => c[0])).toEqual(['a', '2 more errors']);
            expect(subs.finish).toHaveBeenCalledWith({ status: 'OK', errorCount: 3 });
        });

        it('should report a CLOUD_ERROR as non-fatal with its cloud index and finish OK', () => {
            const { subs } = run();
            fake.emit({ type: 'error', jobId: fake.jobId, code: 'CLOUD_ERROR', messages: ['Scan 1: bad'], dropped: 0, cloud: 1 });
            fake.emit({ type: 'finish', jobId: fake.jobId });

            expect(subs.coded).toHaveBeenCalledWith({ code: 'CLOUD_ERROR', message: 'Scan 1: bad', fatal: false, cloud: 1 });
            expect(subs.finish).toHaveBeenCalledWith({ status: 'OK', errorCount: 1 });
        });

        it('should ignore messages with a stale jobId', () => {
            const { subs } = run();
            fake.emit({ type: 'header', jobId: fake.jobId + 1000, total: 5 });
            fake.emit({ type: 'finish', jobId: fake.jobId + 1000 });

            expect(subs.total).not.toHaveBeenCalled();
            expect(subs.finish).not.toHaveBeenCalled();
        });
    });

    describe('termination', () => {
        it('should finish once on finish and ignore later messages', () => {
            const { subs } = run();
            const id = fake.jobId;
            fake.onmessage?.({ data: { type: 'finish', jobId: id } } as MessageEvent);

            expect(subs.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
            expect(fake.onmessage).toBeNull();
        });

        it('should ignore messages after finish', () => {
            const { subs } = run();
            const handler = fake.onmessage as (e: MessageEvent) => void;
            const id = fake.jobId;
            handler({ data: { type: 'finish', jobId: id } } as MessageEvent);
            handler({ data: { type: 'header', jobId: id, total: 1 } } as MessageEvent);
            handler({ data: { type: 'finish', jobId: id } } as MessageEvent);

            expect(subs.total).not.toHaveBeenCalled();
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should report a fatal message then finish once', () => {
            const { subs } = run();
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'READ_ERROR', message: 'bad file' });

            expect(subs.error).toHaveBeenCalledWith('bad file');
            expect(subs.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should finish with the fatal code as status', () => {
            const { subs } = run();
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'NO_COLOR', message: 'Row has no color data: 1 2 3' });

            expect(subs.coded).toHaveBeenCalledWith({ code: 'NO_COLOR', message: 'Row has no color data: 1 2 3', fatal: true });
            expect(subs.finish).toHaveBeenCalledWith({ status: 'NO_COLOR', errorCount: 1 });
        });

        it('should finish with UNKNOWN_FORMAT when detection fails', () => {
            const { subs } = run();
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'UNKNOWN_FORMAT', message: 'Unknown point cloud format' });

            expect(subs.finish).toHaveBeenCalledWith({ status: 'UNKNOWN_FORMAT', errorCount: 1 });
        });

        it('should report a worker load failure and prevent default', () => {
            const { subs } = run();
            fake.failLoad('load failed');

            expect(subs.error).toHaveBeenCalledWith('load failed');
            expect(subs.coded).toHaveBeenCalledWith({ code: 'INIT_FAILED', message: 'load failed', fatal: true });
            expect(subs.finish).toHaveBeenCalledWith({ status: 'INIT_FAILED', errorCount: 1 });
            expect(fake.preventDefault).toHaveBeenCalled();
        });

        it('should report the default label for a worker load failure without a message', () => {
            const { subs } = run();
            fake.failLoad('');

            expect(subs.error).toHaveBeenCalledWith('Failed to load the point cloud worker');
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should report a message deserialization error and finish once', () => {
            const { subs } = run();
            fake.messageError();

            expect(subs.error).toHaveBeenCalledTimes(1);
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should finish with status CANCELLED and no error on cancel', () => {
            const { parser, subs } = run();
            parser.cancel();

            expect(subs.error).not.toHaveBeenCalled();
            expect(subs.coded).not.toHaveBeenCalled();
            expect(subs.finish).toHaveBeenCalledTimes(1);
            expect(subs.finish).toHaveBeenCalledWith({ status: 'CANCELLED', errorCount: 0 });
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });

        it('should do nothing on cancel when idle', () => {
            const { parser, subs } = setup();
            parser.cancel();

            expect(subs.finish).not.toHaveBeenCalled();
            expect(subs.error).not.toHaveBeenCalled();
        });
    });

    describe('lifecycle', () => {
        it('should ignore parse while running', () => {
            const { parser, subs } = run();
            const calls = subs.status.mock.calls.length;
            parser.parse(file);

            expect(factory).toHaveBeenCalledTimes(1);
            expect(subs.status.mock.calls.length).toBe(calls);
            expect(subs.error).not.toHaveBeenCalled();
            expect(subs.finish).not.toHaveBeenCalled();
        });

        it('should create a new worker when parsing again after finish', () => {
            const { parser, subs } = run();
            fake.emit({ type: 'finish', jobId: fake.jobId });
            const second = new FakeWorker();
            factory.mockReturnValueOnce(second);
            parser.parse(file);

            expect(factory).toHaveBeenCalledTimes(2);
            expect(second.postMessage).toHaveBeenCalledTimes(1);
            expect(second.jobId).not.toBe(fake.jobId);
            second.emit({ type: 'finish', jobId: second.jobId });
            expect(subs.finish).toHaveBeenCalledTimes(2);
        });

        it('should report an error and finish when the factory throws', () => {
            factory.mockImplementation(() => { throw new Error('no worker'); });
            const { subs } = run();

            expect(subs.error).toHaveBeenCalledWith('no worker');
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should report an error and finish when postMessage throws', () => {
            fake.postMessage.mockImplementation(() => { throw new Error('clone failed'); });
            const { subs } = run();

            expect(subs.error).toHaveBeenCalledWith('clone failed');
            expect(subs.finish).toHaveBeenCalledTimes(1);
            expect(fake.terminate).toHaveBeenCalledTimes(1);
        });
    });

    describe('pts fallback', () => {
        let fallback: { run: jest.Mock };

        beforeEach(() => {
            fallback = { run: jest.fn() };
        });

        const ptsFile = () => new File(['x'], 'cloud.PTS');

        it('should run the fallback on an init fatal for format pts and forward its sink calls', () => {
            const { subs } = run({ format: 'pts', ptsFallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(fake.terminate).toHaveBeenCalledTimes(1);
            expect(fallback.run).toHaveBeenCalledTimes(1);
            const [runFile, opts, sink] = fallback.run.mock.calls[0] as [Blob, ResolvedPtsOptions, PtsEngineSink];
            expect(runFile).toBe(file);
            expect(opts).toEqual({ voxelSize: 0.5, acceptColorless: false, defaultColor: [128, 128, 128] });
            expect(subs.error).not.toHaveBeenCalled();
            expect(subs.finish).not.toHaveBeenCalled();

            sink.header(2);
            sink.points({ points: [[1, 2, 3], [4, 5, 6]], colors: [[7, 8, 9], [10, 11, 12]] } as PointCloudData);
            sink.progress(0.5);
            sink.error('row', 'INVALID_ROW', false);
            sink.finish();
            sink.finish();

            expect(subs.info).toHaveBeenCalledWith({ format: 'pts', totalPoints: 2 });
            expect(subs.total).toHaveBeenCalledWith(2);
            const batch = subs.batch.mock.calls[0][0];
            expect(Array.from(batch.positions)).toEqual([1, 2, 3, 4, 5, 6]);
            expect(Array.from(batch.colors)).toEqual([7, 8, 9, 10, 11, 12]);
            expect(batch.cloud).toBe(0);
            expect(subs.status).toHaveBeenLastCalledWith(0.5);
            expect(subs.error).toHaveBeenCalledWith('row');
            expect(subs.coded).toHaveBeenCalledWith({ code: 'INVALID_ROW', message: 'row', fatal: false });
            expect(subs.finish).toHaveBeenCalledTimes(1);
            expect(subs.finish).toHaveBeenCalledWith({ status: 'OK', errorCount: 1 });
        });

        it('should forward fatal codes from the fallback sink into the finish status', () => {
            const { subs } = run({ format: 'pts', ptsFallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });
            const sink = fallback.run.mock.calls[0][2] as PtsEngineSink;
            sink.error('Row has no color data: 1 2 3', 'NO_COLOR', true);
            sink.finish();

            expect(subs.coded).toHaveBeenCalledWith({ code: 'NO_COLOR', message: 'Row has no color data: 1 2 3', fatal: true });
            expect(subs.finish).toHaveBeenCalledWith({ status: 'NO_COLOR', errorCount: 1 });
        });

        it('should report INIT_FAILED without a fallback for the same init fatal', () => {
            const { subs } = run({ format: 'pts' });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(subs.finish).toHaveBeenCalledWith({ status: 'INIT_FAILED', errorCount: 1 });
        });

        it('should run the fallback for auto format with a .pts file name, case-insensitive', () => {
            const s = setup({ ptsFallback: fallback as PtsEngine });
            const f = ptsFile();
            s.parser.parse(f);
            fake.failLoad('boom');

            expect(fallback.run).toHaveBeenCalledTimes(1);
            expect(fallback.run.mock.calls[0][0]).toBe(f);
        });

        it('should run the fallback when the environment is unsupported and no factory is given', () => {
            const g = globalThis as { Worker?: unknown };
            const saved = g.Worker;
            delete g.Worker;
            try {
                const parser = new PointCloudParser({ format: 'pts', ptsFallback: fallback as PtsEngine });
                parser.parse(file);

                expect(fallback.run).toHaveBeenCalledTimes(1);
            } finally {
                if (saved !== undefined) g.Worker = saved;
            }
        });

        it('should not run the fallback for auto format without a .pts name', () => {
            const { subs } = run({ ptsFallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(subs.error).toHaveBeenCalledWith('no wasm');
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should not run the fallback for e57', () => {
            const s = setup({ format: 'e57', ptsFallback: fallback as PtsEngine });
            s.parser.parse(ptsFile());
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(s.subs.error).toHaveBeenCalledWith('no wasm');
        });

        it('should not run the fallback after a batch was emitted', () => {
            const { subs } = run({ format: 'pts', ptsFallback: fallback as PtsEngine });
            fake.emit({
                type: 'points', jobId: fake.jobId,
                positions: new Float64Array([1, 2, 3]), colors: new Uint8Array([4, 5, 6]),
            });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'late init' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(subs.error).toHaveBeenCalledWith('late init');
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should not run the fallback for a run fatal', () => {
            const { subs } = run({ format: 'pts', ptsFallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'run', code: 'READ_ERROR', message: 'bad' });

            expect(fallback.run).not.toHaveBeenCalled();
            expect(subs.error).toHaveBeenCalledWith('bad');
        });

        it('should report and finish once when the fallback throws', () => {
            fallback.run.mockImplementation(() => { throw new Error('fallback broke'); });
            const { subs } = run({ format: 'pts', ptsFallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });

            expect(subs.error).toHaveBeenCalledWith('fallback broke');
            expect(subs.finish).toHaveBeenCalledTimes(1);
        });

        it('should finish on cancel during the fallback and ignore its later calls', () => {
            const { parser, subs } = run({ format: 'pts', ptsFallback: fallback as PtsEngine });
            fake.emit({ type: 'fatal', jobId: fake.jobId, stage: 'init', code: 'INIT_FAILED', message: 'no wasm' });
            const sink = fallback.run.mock.calls[0][2] as PtsEngineSink;
            parser.cancel();
            sink.points({ points: [[1, 2, 3]] });
            sink.error('late');
            sink.finish();

            expect(subs.finish).toHaveBeenCalledTimes(1);
            expect(subs.batch).not.toHaveBeenCalled();
            expect(subs.error).not.toHaveBeenCalled();
        });
    });

    describe('unsupported environment', () => {
        const g = globalThis as { Worker?: unknown };

        it('should report unsupported and finish once without a factory', () => {
            const saved = g.Worker;
            delete g.Worker;
            try {
                expect(isPointCloudParserSupported()).toBe(false);
                const parser = new PointCloudParser({ format: 'e57' });
                const error = jest.fn();
                const finish = jest.fn();
                parser.onParseError.subscribe(error);
                parser.onFinish.subscribe(finish);
                parser.parse(file);

                expect(error).toHaveBeenCalledTimes(1);
                expect(error).toHaveBeenCalledWith('Point cloud parsing requires WebAssembly and Web Workers');
                expect(finish).toHaveBeenCalledTimes(1);
                expect(finish).toHaveBeenCalledWith({ status: 'INIT_FAILED', errorCount: 1 });
            } finally {
                if (saved !== undefined) g.Worker = saved;
            }
        });

        it('should be supported when Worker and WebAssembly exist', () => {
            const saved = g.Worker;
            g.Worker = function () { /* stub */ };
            try {
                expect(isPointCloudParserSupported()).toBe(true);
            } finally {
                if (saved === undefined) delete g.Worker; else g.Worker = saved;
            }
        });

        it('should create the default worker from reader.worker.js as a module worker', () => {
            const saved = g.Worker;
            const ctor = jest.fn(function () { return new FakeWorker(); });
            g.Worker = ctor;
            try {
                new PointCloudParser().parse(file);

                expect(ctor).toHaveBeenCalledTimes(1);
                const [url, opts] = ctor.mock.calls[0] as unknown as [URL, WorkerOptions];
                expect(String(url)).toMatch(/\/reader\.worker\.js$/);
                expect(opts).toEqual({ type: 'module' });
            } finally {
                if (saved === undefined) delete g.Worker; else g.Worker = saved;
            }
        });
    });
});
