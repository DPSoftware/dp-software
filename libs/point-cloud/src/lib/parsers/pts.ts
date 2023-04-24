import {Observable} from "../observable";
import {Parser} from "./parser";

export interface PointCloudData {
    points: [number, number, number][];
    colors?: [number, number, number][];
    normals?: [number, number, number][];
}

export class PTSParser {

    public readonly onNewPoints = new Observable<PointCloudData>()
    public readonly onFinish = new Observable<void>()
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

        parser.onNextData.subscribe((data) => {
            const points = [];
            const colors = [];

            for (const pointRaw of data) {
                const point = this.parseRow(pointRaw);
                const p = point[0] as [number, number, number];
                const c = point[1] as [number, number, number];
                const hash = hashPerVoxel(this.voxelSize, p);

                if (!voxelTable[hash]) {
                    voxelTable[hash] = true;
                    points.push(p);
                    colors.push(c);
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

        parser.parseFile();
    }

    private parseRow(row: string) {
        const data = row.split(' ').map(v => Number(v));

        // TODO make a better validator
        if (data.length !== 7) {
            throw new Error('invalid data row: ' + row);
        }

        const [x, y, z, _, r, g, b] = data;

        return [
            [x, y, z],
            [r, g, b],
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
