import { errorMessage, startWorkerJob } from '../src/lib/worker-job';
import type { OpenMessage } from '../src/lib/protocol';

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
}

const openMsg = (jobId: number) => ({ type: 'open', jobId, format: 'pts' } as unknown as OpenMessage);

describe('startWorkerJob', () => {
    let fake: FakeWorker;
    let handlers: { message: jest.Mock; fail: jest.Mock };
    const labels = { loadError: 'Failed to load' };

    const start = (factory: () => Worker = () => fake as unknown as Worker) =>
        startWorkerJob(factory, openMsg, handlers, labels);

    beforeEach(() => {
        fake = new FakeWorker();
        handlers = { message: jest.fn(), fail: jest.fn() };
    });

    it('should post the start message built for its jobId and forward its messages', () => {
        const job = start();

        expect(fake.postMessage).toHaveBeenCalledWith(openMsg(job.jobId));
        fake.emit({ type: 'progress', jobId: job.jobId, value: 0.5 });
        expect(handlers.message).toHaveBeenCalledWith({ type: 'progress', jobId: job.jobId, value: 0.5 });
        expect(handlers.fail).not.toHaveBeenCalled();
    });

    it('should hand out increasing jobIds', () => {
        const a = start();
        const b = start(() => new FakeWorker() as unknown as Worker);

        expect(b.jobId).toBeGreaterThan(a.jobId);
    });

    it('should ignore messages of another job and non-protocol data', () => {
        const job = start();
        fake.emit({ type: 'finish', jobId: job.jobId + 1000 });
        fake.emit({ type: 'nonsense', jobId: job.jobId });
        fake.emit(null);

        expect(handlers.message).not.toHaveBeenCalled();
    });

    it('should report an init failure when the factory throws', () => {
        start(() => { throw new Error('no worker'); });

        expect(handlers.fail).toHaveBeenCalledWith('init', 'no worker', 'INIT_FAILED');
    });

    it('should report a worker load error with its message, prevent default and stop', () => {
        start();
        fake.failLoad('boom');

        expect(fake.preventDefault).toHaveBeenCalled();
        expect(handlers.fail).toHaveBeenCalledWith('init', 'boom', 'INIT_FAILED');
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(fake.onerror).toBeNull();
    });

    it('should report the label for a worker load error without a message', () => {
        start();
        fake.failLoad('');

        expect(handlers.fail).toHaveBeenCalledWith('init', 'Failed to load', 'INIT_FAILED');
    });

    it('should report a run failure on messageerror', () => {
        start();
        fake.onmessageerror?.({ data: null } as MessageEvent);

        expect(handlers.fail).toHaveBeenCalledWith('run', 'Worker message could not be deserialized', 'READ_ERROR');
        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(fake.onmessageerror).toBeNull();
    });

    it('should report an init failure and terminate when postMessage throws', () => {
        fake.postMessage.mockImplementation(() => { throw new Error('cannot clone'); });
        start();

        expect(handlers.fail).toHaveBeenCalledTimes(1);
        expect(handlers.fail).toHaveBeenCalledWith('init', 'cannot clone', 'INIT_FAILED');
        expect(fake.terminate).toHaveBeenCalledTimes(1);
    });

    it('should terminate once on stop and drop later messages and failures', () => {
        const job = start();
        const onmessage = fake.onmessage as (e: MessageEvent) => void;
        const onerror = fake.onerror as (e: ErrorEvent) => void;
        job.stop();
        job.stop();
        onmessage({ data: { type: 'finish', jobId: job.jobId } } as MessageEvent);
        onerror({ message: 'late', preventDefault: jest.fn() } as unknown as ErrorEvent);

        expect(fake.terminate).toHaveBeenCalledTimes(1);
        expect(fake.onmessage).toBeNull();
        expect(handlers.message).not.toHaveBeenCalled();
        expect(handlers.fail).not.toHaveBeenCalled();
    });
});

describe('errorMessage', () => {
    it('should use the message of an Error and stringify anything else', () => {
        expect(errorMessage(new Error('x'))).toBe('x');
        expect(errorMessage('y')).toBe('y');
        expect(errorMessage(3)).toBe('3');
    });
});
