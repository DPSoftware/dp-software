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
        // const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
        // if (!stream.getReader) {
        //     throw new Error('Corrupted stream of Uint8Array');
        // }
        // const reader = getFileReader(file);
        //
        // // reading first chunk separately as it contains the amount of points
        // const {value: firstChunk} = await reader.read();
        //
        // // const data = decoder.decode(firstChunk).split(/\r?\n/);
        // const { data, tail } = splitData(firstChunk as BufferSource);
        //
        // const pointCloudLength = Number(data.shift());
        //
        // // last string might be incomplete in the given chunk
        // // let tail = data.pop();
        //
        // const buffersLength = Math.min(
        //     this.limitPoints ?? pointCloudLength,
        //     pointCloudLength
        // );
        //
        // const voxelTable: Record<string, [number, number, number]> = {};
        //
        // const indices = interpolateIndices(pointCloudLength, buffersLength);
        //
        // const points = new Float32Array(3 * buffersLength);
        // const colors = new Uint8Array(3 * buffersLength);
        //
        // let index = 0;
        // let pointer = 0;
        //
        // for (index; index < data.length; index++) {
        //     const vertexData = this.parseRow(data[index]);
        //     const p = vertexData[0] as [number, number, number];
        //     const hash = hashPerVoxel(voxelSize, p);
        //
        //     if (!voxelTable[hash]) {
        //         voxelTable[hash] = p;
        //     }
        // }
        //
        // for (index; index < data.length; index++) {
        //     if (containsIndex(indices, index)) {
        //         const [p, c] = this.parseRow(data[index]);
        //         addValuesToBuffer(points, pointer * 3, p);
        //         addValuesToBuffer(colors, pointer * 3, c);
        //         this.onNewPoints.notify({
        //             points: points,
        //             colors: colors,
        //         });
        //         pointer++;
        //     }
        // }
        //
        // let running = true;
        // while (running) {
        //     const {done, value} = await reader.read();
        //     running = !done;
        //
        //     if (value !== undefined) {
        //         // concatenate the rest from the last iteration
        //         const chunkData = (tail + decoder.decode(value)).split(/\r?\n/);
        //
        //         // last string might be incomplete in the given chunk
        //         tail = chunkData.pop();
        //
        //         for (let i = 0; i < chunkData.length; i++) {
        //             const vertexData = this.parseRow(chunkData[i]);
        //             const p = vertexData[0] as [number, number, number];
        //             const hash = hashPerVoxel(voxelSize, p);
        //
        //             if (!voxelTable[hash]) {
        //                 voxelTable[hash] = p;
        //             }
        //         }
        //
        //         for (let i = 0; i < chunkData.length; i++) {
        //             if (containsIndex(indices, index)) {
        //                 const [p, c] = this.parseRow(chunkData[i]);
        //                 addValuesToBuffer(points, pointer * 3, p);
        //                 addValuesToBuffer(colors, pointer * 3, c);
        //                 this.onNewPoints.notify({
        //                     points: points,
        //                     colors: colors,
        //                 });
        //                 pointer++;
        //             }
        //
        //             index++;
        //         }
        //     }
        //
        //     // parsing the last values
        //     if (value === undefined && tail !== undefined) {
        //         if (containsIndex(indices, index)) {
        //             const [p, c] = this.parseRow(tail);
        //             addValuesToBuffer(points, pointer * 3, p);
        //             addValuesToBuffer(colors, pointer * 3, c);
        //             this.onNewPoints.notify({
        //                 points: points,
        //                 colors: colors,
        //             });
        //             pointer++;
        //         }
        //
        //         index++;
        //     }
        // }
        //
        // // console.log('length: ', Object.values(voxelTable).length);
        // // console.log('voxels: ', JSON.stringify(Object.values(voxelTable)));
        //
        // return {
        //     points: points,
        //     colors: colors,
        // };

        const parser = new Parser(file, 1);
        const voxelTable: Record<string, boolean> = {};

        parser.onHeaderDataRead.subscribe(data => {
            console.log(Number(data[0]));
        });
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

function getFileReader(file: Blob): ReadableStreamDefaultReader<Uint8Array> {
    const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
    if (!stream.getReader) {
        throw new Error('Corrupted stream of Uint8Array');
    }
    return stream.getReader();
}

function hashPerVoxel(voxelSize=0.5, coordinate: [number, number, number]): string {
    const [x, y, z] = coordinate;

    const vX = Math.floor(x / voxelSize);
    const vY = Math.floor(y / voxelSize);
    const vZ = Math.floor(z / voxelSize);

    return `${vX}${vY}${vZ}`;
}
