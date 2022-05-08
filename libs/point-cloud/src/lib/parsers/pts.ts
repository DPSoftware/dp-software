import { addValuesToBuffer, containsIndex, interpolateIndices } from '../utils';

export class PTSParser {
  private limitPoints?: number;

  public constructor(limitPoints?: number) {
    this.limitPoints = limitPoints;
  }

  public async parse(file: Blob) {
    const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
    if (!stream.getReader) {
      throw new Error('Corrupted stream of Uint8Array');
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');

    // reading first chunk separately as it contains the amount of points
    const { value: firstChunk } = await reader.read();

    const data = decoder.decode(firstChunk).split(/\r?\n/);

    const pointCloudLength = Number(data.shift());

    // last string might be incomplete in the given chunk
    let tail = data.pop();

    const buffersLength = Math.min(
      this.limitPoints ?? pointCloudLength,
      pointCloudLength
    );

    const indices = interpolateIndices(pointCloudLength, buffersLength);

    const points = new Float32Array(3 * buffersLength);
    const colors = new Uint8Array(3 * buffersLength);

    let index = 0;
    let pointer = 0;

    for (index; index < data.length; index++) {
      if (containsIndex(indices, index)) {
        const [p, c] = this.parseRow(data[index]);
        addValuesToBuffer(points, pointer * 3, p);
        addValuesToBuffer(colors, pointer * 3, c);
        pointer++;
      }
    }

    let running = true;
    while (running) {
      const { done, value } = await reader.read();
      running = !done;

      if (value !== undefined) {
        // concatenate the rest from the last iteration
        const chunkData = (tail + decoder.decode(value)).split(/\r?\n/);

        // last string might be incomplete in the given chunk
        tail = chunkData.pop();

        for (let i = 0; i < chunkData.length; i++) {
          if (containsIndex(indices, index)) {
            const [p, c] = this.parseRow(chunkData[i]);
            addValuesToBuffer(points, pointer * 3, p);
            addValuesToBuffer(colors, pointer * 3, c);
            pointer++;
          }

          index++;
        }
      }

      // parsing the last values
      if (value === undefined && tail !== undefined) {
        if (containsIndex(indices, index)) {
          const [p, c] = this.parseRow(tail);
          addValuesToBuffer(points, pointer * 3, p);
          addValuesToBuffer(colors, pointer * 3, c);
          pointer++;
        }

        index++;
      }
    }

    return {
      points: points,
      colors: colors,
    };
  }

  private parseRow(row: string) {
    const data = row.split(' ').map((v) => +v);

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
