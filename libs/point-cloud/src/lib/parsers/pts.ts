import {Observable} from "../observable.js";
import {ErrorCode, ParseResult, PointCloudError, PointCloudParseError} from "../errors.js";
import {PointCloudData, PtsEngine, PtsEngineSink, ResolvedPtsOptions, RGB} from "./engines/types.js";
import {JsPtsEngine, parsePtsRow} from "./engines/js-engine.js";

export type {RGB, PointCloudData};

export interface PTSParserOptions {
    /**
     * Accept rows that carry no r g b values (`x y z` or `x y z intensity`).
     * Defaults to false: such rows are reported on `onError` (code `NO_COLOR`, fatal) and `onParseError`.
     */
    acceptColorless?: boolean;
    /**
     * Color assigned to colorless points when `acceptColorless` is true.
     * Defaults to grey.
     */
    defaultColor?: RGB;
    /**
     * Parsing engine. Defaults to the built-in JS streaming parser.
     * See @dp-software/point-cloud-wasm for a WebAssembly engine.
     */
    engine?: PtsEngine;
}

export const DEFAULT_COLOR: RGB = [128, 128, 128];

export class PTSParser {

    public readonly onNewPoints = new Observable<PointCloudData>();
    public readonly onParseError = new Observable<string>();
    public readonly onError = new Observable<PointCloudError>();
    public readonly onFinish = new Observable<ParseResult>();
    public readonly onNumberOfPoints: Observable<number> = new Observable<number>();
    public readonly loadingStatus: Observable<number> = new Observable<number>()
    private readonly options: ResolvedPtsOptions;
    private readonly engine: PtsEngine;
    private parsingInProgress = false;

    public constructor(voxelSize = 0.02, options: PTSParserOptions = {}) {
        this.options = {
            voxelSize,
            acceptColorless: options.acceptColorless ?? false,
            defaultColor: options.defaultColor ?? DEFAULT_COLOR,
        };
        this.engine = options.engine ?? new JsPtsEngine();
        this.loadingStatus.notify(0);
    }

    /**
     * @param file
     */
    public parse(file: Blob): void {
        // !!!you cannot parse multiple files simultaneously
        if (this.parsingInProgress) {
            return;
        }
        this.parsingInProgress = true;

        this.loadingStatus.notify(0);

        let finished = false;
        let errorCount = 0;
        let fatalCode: ErrorCode | undefined;
        const sink: PtsEngineSink = {
            header: (total) => this.onNumberOfPoints.notify(total),
            points: (data) => this.onNewPoints.notify(data),
            progress: (value) => this.loadingStatus.notify(value),
            error: (message, code = ErrorCode.UNKNOWN, fatal = false) => {
                errorCount++;
                if (fatal && fatalCode === undefined) {
                    fatalCode = code;
                }
                this.onError.notify({code, message, fatal});
                this.onParseError.notify(message);
            },
            finish: () => {
                if (finished) {
                    return;
                }
                finished = true;
                this.parsingInProgress = false;
                this.onFinish.notify({status: fatalCode ?? 'OK', errorCount});
            },
        };

        try {
            this.engine.run(file, this.options, sink);
        } catch (e) {
            const code = e instanceof PointCloudParseError ? e.code : ErrorCode.UNKNOWN;
            sink.error(e instanceof Error ? e.message : String(e), code, true);
            sink.finish();
        }
    }

    private parseRow(row: string): [[number, number, number], RGB] {
        return parsePtsRow(row, this.options);
    }
}
