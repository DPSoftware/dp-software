import {Parser} from "../parser.js";
import {ErrorCode, PointCloudParseError} from "../../errors.js";
import {PtsEngine, PtsEngineSink, ResolvedPtsOptions, RGB} from "./types.js";

/** Built-in JS streaming PTS engine. */
export class JsPtsEngine implements PtsEngine {

    /** Streams `file` through `Parser`, voxel-downsamples and reports to `sink`. */
    public run(file: Blob, opts: ResolvedPtsOptions, sink: PtsEngineSink): void {
        const parser = new Parser(file, 1);
        const voxelTable: Record<string, boolean> = {};

        let totalNumberOfPoints = 0;
        let accumulatetNumberOfPoints = 0;

        let finished = false;
        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            sink.finish();
        };

        parser.onHeaderDataRead.subscribe((data) => {
            totalNumberOfPoints = Number(data[0]);
            sink.header(totalNumberOfPoints);
        });

        let aborted = false;

        parser.onNextData.subscribe((data) => {
            if (aborted) {
                return;
            }
            const points: [number, number, number][] = [];
            const colors: RGB[] = [];

            accumulatetNumberOfPoints += data.length;

            sink.progress(accumulatetNumberOfPoints / totalNumberOfPoints);

            for (const pointRaw of data) {
                try {
                    const [p, c] = parsePtsRow(pointRaw, opts);
                    const hash = hashPerVoxel(opts.voxelSize, p);

                    if (!voxelTable[hash]) {
                        voxelTable[hash] = true;
                        points.push(p);
                        colors.push(c);
                    }
                } catch (e) {
                    const code = e instanceof PointCloudParseError ? e.code : ErrorCode.UNKNOWN;
                    const fatal = code === ErrorCode.NO_COLOR;
                    sink.error((e as Error).message, code, fatal);
                    if (fatal) {
                        aborted = true;
                        parser.cancel();
                        finish();
                        return;
                    }
                    break;
                }
            }
            sink.points({
                points: points,
                colors: colors,
            });
        });
        parser.onError.subscribe((message) => sink.error(message, ErrorCode.READ_ERROR, true));
        parser.onFinish.subscribe(finish);

        try {
            parser.parseFile();
        } catch (e) {
            sink.error(e instanceof Error ? e.message : String(e), ErrorCode.READ_ERROR, true);
            finish();
        }
    }
}

/**
 * Supported rows:
 *   x y z intensity r g b   - full PTS row
 *   x y z intensity         - colorless, only with `acceptColorless`
 *   x y z                   - colorless, only with `acceptColorless`
 */
export function parsePtsRow(row: string, opts: ResolvedPtsOptions): [[number, number, number], RGB] {
    const data = row.split(' ');

    if (data.length === 7) {
        return [
            [+data[0], +data[1], +data[2]],
            [+data[4], +data[5], +data[6]],
        ];
    }

    if (data.length === 3 || data.length === 4) {
        if (!opts.acceptColorless) {
            throw new PointCloudParseError(ErrorCode.NO_COLOR, `Row has no color data: ${row}`);
        }
        const [r, g, b] = opts.defaultColor;
        return [
            [+data[0], +data[1], +data[2]],
            [r, g, b],
        ];
    }

    throw new PointCloudParseError(ErrorCode.INVALID_ROW, `Invalid row: ${row}`);
}

function hashPerVoxel(voxelSize=0.5, coordinate: [number, number, number]): string {
    const [x, y, z] = coordinate;

    const vX = Math.floor(x / voxelSize);
    const vY = Math.floor(y / voxelSize);
    const vZ = Math.floor(z / voxelSize);

    return `${vX}${vY}${vZ}`;
}
