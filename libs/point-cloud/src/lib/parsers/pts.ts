import {Observable} from "../observable";
import {Parser} from "./parser";

export interface PointCloudData {
    points: [number, number, number][];
    colors?: [number, number, number][];
    normals?: [number, number, number][];
}

export class PTSParser {

    public readonly onNewPoints = new Observable<PointCloudData>();
    public readonly onParseError = new Observable<string>();
    public readonly onFinish = new Observable<void>();
    public readonly onNumberOfPoints: Observable<number> = new Observable<number>();
    private readonly voxelSize: number;
    private parsingInProgress = false;

    public constructor(voxelSize = 0.02) {
        this.voxelSize = voxelSize;
    }

    /**
     * @param file
     * @param voxelSize
     */
    public parse(file: Blob): void {
        // !!!you cannot parse multiple files simultaneously
        if (this.parsingInProgress) {
            return;
        }
        this.parsingInProgress = true;

        const parser = new Parser(file, 1);
        const voxelTable: Record<string, boolean> = {};

        parser.onHeaderDataRead.subscribe((data) => {
            const numberOfPoints = Number(data[0]);
            this.onNumberOfPoints.notify(numberOfPoints);
        });

        parser.onNextData.subscribe((data) => {
            const points = [];
            const colors = [];

            for (const pointRaw of data) {
                try {
                    const point = this.parseRow(pointRaw);
                    const p = point[0] as [number, number, number];
                    const c = point[1] as [number, number, number];
                    const hash = hashPerVoxel(this.voxelSize, p);

                    if (!voxelTable[hash]) {
                        voxelTable[hash] = true;
                        points.push(p);
                        colors.push(c);
                    }
                } catch (e) {
                    this.onParseError.notify((e as Error).message);
                }
            }
            this.onNewPoints.notify({
                points: points,
                colors: colors,
            });
        });
        parser.onFinish.subscribe(() => {
            this.onFinish.notify();
            this.parsingInProgress = false;
        });

        try {
            parser.parseFile();
        } catch (e) {
            this.onParseError.notify((e as Error).message);
        }
    }

    private parseRow(row: string) {
        const data = row.split(' ');

        if (data.length < 3) {
            throw new Error(`Invalid row: ${row}`);
        }

        // use only position and default white color when no color is provided
        if (data.length < 7) {
            return [
                [+data[0], +data[1], +data[2]],
                [114, 114, 114],
            ];
        }

        return [
            [+data[0], +data[1], +data[2]],
            [+data[4], +data[5], +data[6]],
        ];
    }
}

function hashPerVoxel(voxelSize=0.5, coordinate: [number, number, number]): string {
    const [x, y, z] = coordinate;

    const vX = Math.floor(x / voxelSize);
    const vY = Math.floor(y / voxelSize);
    const vZ = Math.floor(z / voxelSize);

    return `${vX}${vY}${vZ}`;
}
