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
    public readonly loadingStatus: Observable<number> = new Observable<number>()
    private readonly voxelSize: number;
    private parsingInProgress = false;

    public constructor(voxelSize = 0.02) {
        this.voxelSize = voxelSize;
        this.loadingStatus.notify(0);
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

        this.loadingStatus.notify(0);

        const parser = new Parser(file, 1);
        const voxelTable: Record<string, boolean> = {};

        let totalNumberOfPoints = 0;
        let accumulatetNumberOfPoints = 0;

        parser.onHeaderDataRead.subscribe((data) => {
            totalNumberOfPoints = Number(data[0]);
            this.onNumberOfPoints.notify(totalNumberOfPoints);
        });

        parser.onNextData.subscribe((data) => {
            const points = [];
            const colors = [];

            accumulatetNumberOfPoints += data.length;

            this.loadingStatus.notify(accumulatetNumberOfPoints / totalNumberOfPoints);

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
                    break;
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

        if (data.length !== 7) {
            throw new Error(`Invalid row: ${row}`);
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
