import { PTSParser } from '../src/lib/parsers/pts';
import { JsPtsEngine } from '../src/lib/parsers/engines/js-engine';
import type { PtsEngine, PtsEngineSink } from '../src/lib/parsers/engines/types';

// Engines are replaced with stubs: the real JS engine needs Blob.stream and requestAnimationFrame.
describe('PTSParser engine selection', () => {
    let run: jest.Mock;
    let engine: PtsEngine;
    let file: Blob;

    const sinkOf = (call = 0) => run.mock.calls[call][2] as PtsEngineSink;

    beforeEach(() => {
        run = jest.fn();
        engine = { run };
        file = new Blob(['x']);
    });

    it('should run the injected engine with the resolved options and a sink', () => {
        const parser = new PTSParser(0.05, { acceptColorless: true, defaultColor: [1, 2, 3], engine });

        parser.parse(file);

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(
            file,
            { voxelSize: 0.05, acceptColorless: true, defaultColor: [1, 2, 3] },
            expect.any(Object),
        );
    });

    it('should default to the JS engine', () => {
        const parser = new PTSParser();

        expect((parser as unknown as { engine: unknown }).engine).toBeInstanceOf(JsPtsEngine);
    });

    describe('sink forwarding', () => {
        let parser: PTSParser;

        beforeEach(() => {
            parser = new PTSParser(0.05, { engine });
            parser.parse(file);
        });

        it('should forward header to onNumberOfPoints', () => {
            const listener = jest.fn();
            parser.onNumberOfPoints.subscribe(listener);

            sinkOf().header(5);

            expect(listener).toHaveBeenCalledWith(5);
        });

        it('should forward points to onNewPoints', () => {
            const listener = jest.fn();
            parser.onNewPoints.subscribe(listener);
            const data = { points: [[1, 2, 3]] as [number, number, number][], colors: [[4, 5, 6]] as [number, number, number][] };

            sinkOf().points(data);

            expect(listener).toHaveBeenCalledWith(data);
        });

        it('should forward progress to loadingStatus', () => {
            const listener = jest.fn();
            parser.loadingStatus.subscribe(listener);

            sinkOf().progress(0.3);

            expect(listener).toHaveBeenCalledWith(0.3);
        });

        it('should forward error to onParseError', () => {
            const listener = jest.fn();
            parser.onParseError.subscribe(listener);

            sinkOf().error('x');

            expect(listener).toHaveBeenCalledWith('x');
        });

        it('should forward finish to onFinish', () => {
            const listener = jest.fn();
            parser.onFinish.subscribe(listener);

            sinkOf().finish();

            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    describe('re-entrancy', () => {
        it('should ignore a second parse before finish', () => {
            const parser = new PTSParser(0.05, { engine });

            parser.parse(file);
            parser.parse(file);

            expect(run).toHaveBeenCalledTimes(1);
        });

        it('should allow a new parse after finish', () => {
            const parser = new PTSParser(0.05, { engine });

            parser.parse(file);
            sinkOf().finish();
            parser.parse(file);

            expect(run).toHaveBeenCalledTimes(2);
        });
    });

    describe('engine failures', () => {
        it('should report a throwing engine on onParseError and finish once', () => {
            const parser = new PTSParser(0.05, { engine });
            const errors = jest.fn();
            const finished = jest.fn();
            parser.onParseError.subscribe(errors);
            parser.onFinish.subscribe(finished);
            run.mockImplementation(() => { throw new Error('engine broke'); });

            parser.parse(file);

            expect(errors).toHaveBeenCalledWith('engine broke');
            expect(finished).toHaveBeenCalledTimes(1);
        });

        it('should allow a new parse after a throwing engine', () => {
            const parser = new PTSParser(0.05, { engine });
            run.mockImplementationOnce(() => { throw new Error('engine broke'); });

            parser.parse(file);
            parser.parse(file);

            expect(run).toHaveBeenCalledTimes(2);
        });

        it('should not finish twice when the engine finished before throwing', () => {
            const parser = new PTSParser(0.05, { engine });
            const finished = jest.fn();
            parser.onFinish.subscribe(finished);
            run.mockImplementation((_f, _o, sink: PtsEngineSink) => {
                sink.finish();
                throw new Error('late');
            });

            parser.parse(file);

            expect(finished).toHaveBeenCalledTimes(1);
        });

        it('should ignore a repeated sink finish', () => {
            const parser = new PTSParser(0.05, { engine });
            const finished = jest.fn();
            parser.onFinish.subscribe(finished);

            parser.parse(file);
            sinkOf().finish();
            sinkOf().finish();

            expect(finished).toHaveBeenCalledTimes(1);
        });
    });

    describe('loadingStatus', () => {
        it('should emit 0 when parse starts, before the engine runs', () => {
            const parser = new PTSParser(0.05, { engine });
            const events: string[] = [];
            parser.loadingStatus.subscribe((v) => events.push(`status:${v}`));
            run.mockImplementation(() => events.push('run'));

            parser.parse(file);

            expect(events).toEqual(['status:0', 'run']);
        });
    });
});
