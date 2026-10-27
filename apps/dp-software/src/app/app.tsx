import {useCallback, useEffect, useRef, useState} from 'react';
import styled from 'styled-components';

import {JsPtsEngine, PTSParser, PtsEngine} from '@dp-software/point-cloud';
import {createWasmEngine, isPointCloudParserSupported, isWasmEngineSupported, PointCloudParser} from '@dp-software/point-cloud-wasm';

import {PointCloudViewer, PointCloudViewerHandle} from './point-cloud-viewer';

const StyledApp = styled.div`
    font-family: sans-serif;
    padding: 12px;

    label {
        margin-right: 12px;
    }

    pre {
        background: #f3f3f3;
        padding: 8px;
    }
`;

type EngineName = 'js' | 'wasm' | 'unified';

const ENGINES: readonly EngineName[] = ['js', 'wasm', 'unified'];

interface ParseResult {
    label: string;
    /** `pts` for the js/wasm engines; the requested or detected format for the unified parser. */
    format: string;
    /** Number of `onCloud` notifications (unified parser, multi-cloud formats such as E57). */
    scans?: number;
    /** Unified parser with `?debug=1`: time spent in the harness's own `onBatch` handler (counting plus viewer append), not worker time. */
    handlerMs?: number;
    /** `OK`, `CANCELLED` or the code of the first fatal error. */
    status: string;
    engine: EngineName;
    engineRequested: EngineName;
    engineSupported: boolean;
    voxelSize: number;
    total: number;
    kept: number;
    errors: number;
    /** Includes worker start-up and wasm compile for the wasm engine: each run creates a fresh worker. */
    elapsedMs: number;
    /** True when the wasm engine handed the run over to its JS fallback. */
    fallback: boolean;
}

interface ParseOptions {
    engine: EngineName;
    voxelSize: number;
    acceptColorless: boolean;
    /** When set, parsed points are streamed into this viewer. */
    viewer?: PointCloudViewerHandle | null;
}

/** A JS engine that records whether it was used as a fallback. */
function trackedJsFallback(): { fallback: PtsEngine; js: JsPtsEngine; used: () => boolean } {
    let used = false;
    const js = new JsPtsEngine();
    const fallback: PtsEngine = {
        run: (f, o, s) => {
            used = true;
            js.run(f, o, s);
        },
    };
    return {fallback, js, used: () => used};
}

/** Builds the requested PTSParser engine; `usedFallback()` tells whether the wasm engine handed over to JS. */
function buildEngine(name: EngineName): { engine: PtsEngine; actual: EngineName; supported: boolean; usedFallback: () => boolean } {
    if (name === 'wasm') {
        const {fallback, js, used: fallbackUsed} = trackedJsFallback();
        const wasm = createWasmEngine({fallback});
        if (wasm) {
            return {engine: wasm, actual: 'wasm', supported: true, usedFallback: fallbackUsed};
        }
        console.warn('WebAssembly engine is not supported, falling back to the JS engine');
        return {engine: js, actual: 'js', supported: false, usedFallback: fallbackUsed};
    }
    return {engine: new JsPtsEngine(), actual: 'js', supported: true, usedFallback: () => false};
}

/** Parses the blob and resolves with the summary once the parser finishes. */
function parseBlob(file: Blob, label: string, options: ParseOptions): Promise<ParseResult> {
    return new Promise(resolve => {
        const {engine, actual, supported, usedFallback} = buildEngine(options.engine);
        const parser = new PTSParser(options.voxelSize, {acceptColorless: options.acceptColorless, engine});
        let kept = 0;
        const errorMessages: string[] = [];
        let errors = 0;
        let total = 0;

        const viewer = options.viewer;
        viewer?.reset();

        parser.onNumberOfPoints.subscribe(n => {
            total = n;
            viewer?.reset(n);
        });
        parser.onNewPoints.subscribe(data => {
            kept += data.points.length;
            viewer?.append(data.points, data.colors);
        });
        parser.onParseError.subscribe(message => {
            errors++;
            if (errorMessages.length < 5) {
                errorMessages.push(message);
            }
        });
        parser.onFinish.subscribe(({status}) => {
            viewer?.fit();
            const fallback = usedFallback();
            const result: ParseResult = {
                label,
                format: 'pts',
                status,
                engine: fallback ? 'js' : actual,
                engineRequested: options.engine,
                engineSupported: supported,
                voxelSize: options.voxelSize,
                total,
                kept,
                errors,
                elapsedMs: Math.round((performance.now() - start) * 100) / 100,
                fallback,
            };
            if (errorMessages.length) {
                console.warn('first errors', errorMessages);
            }
            const json = JSON.stringify(result);
            console.log('RESULT', json);
            document.title = 'RESULT ' + json;
            resolve(result);
        });

        const start = performance.now();
        parser.parse(file);
    });
}

/**
 * Parses the blob with the unified `PointCloudParser` (format auto) and resolves with the summary once it finishes.
 * Typed batches go straight into the viewer without tuple conversion.
 */
function parseUnified(file: Blob, label: string, options: ParseOptions): Promise<ParseResult> {
    return new Promise(resolve => {
        const {fallback, used: usedFallback} = trackedJsFallback();
        const parser = new PointCloudParser({
            format: 'auto',
            voxelSize: options.voxelSize,
            acceptColorless: options.acceptColorless,
            intensities: false,
            ptsFallback: fallback,
        });
        // no capacity hint: totals of multi-cloud formats are pre-filter record counts and can be far larger than what is kept
        const viewer = options.viewer;
        viewer?.reset();
        const debug = new URLSearchParams(window.location.search).get('debug') === '1';
        let format = 'auto';
        let kept = 0;
        let total = 0;
        let scans = 0;
        let errors = 0;
        let handlerMs = 0;
        const errorMessages: string[] = [];

        parser.onInfo.subscribe(info => {
            format = info.format;
        });
        parser.onNumberOfPoints.subscribe(n => {
            total = n;
        });
        parser.onCloud.subscribe(cloud => {
            scans++;
            console.log('SCAN', JSON.stringify(cloud));
        });
        parser.onBatch.subscribe(batch => {
            const t0 = debug ? performance.now() : 0;
            kept += batch.positions.length / 3;
            viewer?.appendTyped(batch.positions, batch.colors);
            if (debug) {
                handlerMs += performance.now() - t0;
            }
        });
        parser.onParseError.subscribe(message => {
            errors++;
            if (errorMessages.length < 5) {
                errorMessages.push(message);
            }
        });
        parser.onFinish.subscribe(({status}) => {
            viewer?.fit();
            const fallbackUsed = usedFallback();
            const result: ParseResult = {
                label,
                format,
                status,
                engine: fallbackUsed ? 'js' : 'unified',
                engineRequested: options.engine,
                engineSupported: isPointCloudParserSupported(),
                voxelSize: options.voxelSize,
                total,
                kept,
                errors,
                scans,
                elapsedMs: Math.round((performance.now() - start) * 100) / 100,
                fallback: fallbackUsed,
            };
            if (debug) {
                result.handlerMs = Math.round(handlerMs * 100) / 100;
            }
            if (errorMessages.length) {
                console.warn('first errors', errorMessages);
            }
            const json = JSON.stringify(result);
            console.log('RESULT', json);
            document.title = 'RESULT ' + json;
            resolve(result);
        });

        const start = performance.now();
        parser.parse(file);
    });
}

/** `sphere.ply` when the URL has `?sample=ply`, else `sphere.pts`. */
function sampleName(): string {
    return new URLSearchParams(window.location.search).get('sample') === 'ply' ? 'sphere.ply' : 'sphere.pts';
}

async function fetchSample(name = sampleName()): Promise<File> {
    const response = await fetch(`assets/${name}`);
    return new File([await response.blob()], name);
}

export function App() {

    const [counter, setCounter] = useState(0);
    const [engine, setEngine] = useState<EngineName>('js');
    const [voxelSize, setVoxelSize] = useState(() => {
        const voxel = new URLSearchParams(window.location.search).get('voxel');
        return voxel !== null && voxel !== '' && Number.isFinite(Number(voxel)) ? Number(voxel) : 0.05;
    });
    const [acceptColorless, setAcceptColorless] = useState(false);
    const [results, setResults] = useState<ParseResult[]>([]);
    const [busy, setBusy] = useState(false);
    const [render, setRender] = useState(true);
    const renderRef = useRef(true);
    const viewerRef = useRef<PointCloudViewerHandle>(null);
    const autoStarted = useRef(false);

    // this effect should indicate how thread is occupied while parsing
    useEffect(() => {
        const interval = setInterval(() => {
            setCounter(prevCounter => prevCounter + 1);
        }, 500);
        return () => clearInterval(interval);
    }, [setCounter]);

    const runParse = useCallback(async (file: Blob, label: string, override?: Partial<ParseOptions>) => {
        setBusy(true);
        const viewer = renderRef.current ? viewerRef.current : null;
        const options: ParseOptions = {engine, voxelSize, acceptColorless, viewer, ...override};
        // E57 and PLY have no PTSParser engine, so they always go through the unified parser
        const result = options.engine === 'unified' || /\.(e57|ply)$/i.test(label)
            ? await parseUnified(file, label, options)
            : await parseBlob(file, label, options);
        setResults(prev => [...prev, result]);
        setBusy(false);
        return result;
    }, [engine, voxelSize, acceptColorless]);

    const parseSample = useCallback(async () => {
        const name = sampleName();
        await runParse(await fetchSample(name), name);
    }, [runParse]);

    const benchBoth = useCallback(async () => {
        const sample = await fetchSample('sphere.pts');
        await runParse(sample, 'sphere.pts', {engine: 'js'});
        await runParse(sample, 'sphere.pts', {engine: 'wasm'});
    }, [runParse]);

    const fileHandler = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            void runParse(file, file.name);
        }
    }, [runParse]);

    // ?engine=wasm&auto=1 (or js / unified) starts the sample parse on mount (used for headless checks);
    // add &sample=ply (with engine=unified) to parse assets/sphere.ply instead of sphere.pts
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const requested = ENGINES.find(name => name === params.get('engine'));
        if (requested) {
            setEngine(requested);
        }
        const e57Url = params.get('e57');
        if (params.get('auto') === '1' && e57Url && !autoStarted.current) {
            // reads the Blob from memory rather than from disk, unlike the file input
            autoStarted.current = true;
            void (async () => {
                try {
                    const blob = await (await fetch(e57Url)).blob();
                    const result = await parseUnified(blob, e57Url, {
                        engine: 'unified',
                        voxelSize,
                        acceptColorless,
                        viewer: renderRef.current ? viewerRef.current : null,
                    });
                    setResults(prev => [...prev, result]);
                } catch (e) {
                    console.error('RESULT_FETCH_FAILED', String(e));
                }
            })();
        } else if (params.get('auto') === '1' && !autoStarted.current) {
            autoStarted.current = true;
            const name: EngineName = requested ?? 'js';
            const sample = sampleName();
            void fetchSample(sample).then(blob => runParse(blob, sample, {engine: name}));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <StyledApp>
            <div>ticks: {counter}</div>
            <div>wasm engine supported: {String(isWasmEngineSupported())}</div>
            <div>unified parser supported: {String(isPointCloudParserSupported())}</div>
            <div>
                <label>
                    engine{' '}
                    <select id="engine" value={engine} onChange={e => setEngine(e.target.value as EngineName)}>
                        <option value="js">js</option>
                        <option value="wasm">wasm</option>
                        <option value="unified">unified</option>
                    </select>
                </label>
                <label>
                    voxel size{' '}
                    <input
                        id="voxel-size"
                        type="number"
                        step="0.01"
                        value={voxelSize}
                        onChange={e => setVoxelSize(Number(e.target.value))}
                    />
                </label>
                <label>
                    <input
                        id="accept-colorless"
                        type="checkbox"
                        checked={acceptColorless}
                        onChange={e => setAcceptColorless(e.target.checked)}
                    />
                    accept colorless
                </label>
                <label>
                    <input
                        id="render"
                        type="checkbox"
                        checked={render}
                        onChange={e => {
                            renderRef.current = e.target.checked;
                            setRender(e.target.checked);
                        }}
                    />
                    render
                </label>
            </div>
            <div>
                <input type="file" id="file" accept=".pts,.e57" onChange={fileHandler}/>
                <button id="parse-sample" disabled={busy} onClick={parseSample}>parse sample</button>
                <button id="bench-both" disabled={busy} onClick={benchBoth}>bench js + wasm</button>
            </div>
            <PointCloudViewer ref={viewerRef}/>
            <pre id="results">{results.map(r => JSON.stringify(r)).join('\n')}</pre>
        </StyledApp>
    );
}

export default App;
