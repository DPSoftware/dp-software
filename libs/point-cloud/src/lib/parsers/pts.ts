
export class PTSParser {

    private limitPoints: number | null = null;

    public constructor(limitPoints: number | null = null) {
      this.limitPoints = limitPoints;
    }

    public async parse(file: Blob) {
        const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
        if (!stream.getReader) {
          throw new Error('Corrupted stream of Uint8Array');
        }
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');

        const { value: firstChunk } = await reader.read();

        const data = decoder.decode(firstChunk).split(/\r?\n/);

        const pointCloudLength = Number(data.shift());

        let tail = data.pop();
        let chankLength = data.length;

        console.log(pointCloudLength, tail, data);

        const buffersLength = Math.min(this.limitPoints ?? pointCloudLength,  pointCloudLength);

        const vertices = new Float32Array(3 * buffersLength);
        const colors = new Uint8Array(3 * buffersLength);

        let running = true;
        while (running) {
          const { done, value } = await reader.read();
          running = !done;

          if (value) {
            console.log(decoder.decode(value));
          }
        }

    }

    private parseRow(row: string) {
        const [x, y, z, _, r, g, b] = row.split(' ').map(v => +v);

        return [[x, y, z], [r, g, b]];
    }
}

// function readAsStream(file: Blob) {
//     const myStream = file.stream() as ReadableStream<Uint8Array>;
//     const reader = myStream.getReader();
//     (async () => {
//       const decoder = new TextDecoder('utf-8');

//       const { value: firstChunk } = await reader.read();
//       const list = decoder.decode(firstChunk).split(/\r?\n/);
//       const num = Number(list.shift());
//       // TODO swap list if initial PC smaller
//       const end_num = Math.min(1e+5, num);
//       const vertices = new Float32Array(3 * end_num)
//       const colors = new Int32Array(3 * end_num)
//       const step = num / end_num;
//       // let i = 0;

//       // for (i; i < list.length; i += 1) {
//       //   const j = Math.round(i * step);
//       //   const str = list[j].split(' ');
//       //   vertices[3 * i] = +str[0];
//       //   vertices[3 * i+1] = +str[1];
//       //   vertices[3 * i+2] = +str[2];
//       //   colors[3 * i] = +str[4];
//       //   colors[3 * i+1] = +str[5];
//       //   colors[3 * i+2] = +str[6];
//       // }

//       let running = true;
//       while (running) {
//         const { done, value } = await reader.read();
//         running = !done;
//         console.log(decoder.decode(value));
//       }
//     })()
//   }