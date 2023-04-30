import { Observable } from "../observable";

const decoder = new TextDecoder('utf-8');

export class Parser {

    private readonly file: Blob;
    public readonly onHeaderDataRead = new Observable<string[]>();
    public readonly onNextData = new Observable<string[]>();
    public readonly onFinish = new Observable<void>();
    public readonly headerLength: number;

    public constructor(file: Blob, headerLength=1) {
        this.file = file;
        this.headerLength = headerLength;
    }

    public parseFile(): void {
        const stream = this.file.stream()
        if (!stream.getReader) {
            throw new Error('Corrupted stream of Uint8Array');
        }

        const reader = getFileReader(this.file);

        let isFirst = true;
        let residual = '';

        const chunkParser = async () => {
            const {done, value} = await reader.read();

            if (done) {
                this.onFinish.notify();
                return;
            }

            const data = (residual + decoder.decode(value)).split('\n');
            residual = data.pop() || '';

            if (isFirst) {
                isFirst = false;
                const headerData = data.slice(0, this.headerLength);
                this.onHeaderDataRead.notify(headerData);
                this.onNextData.notify(data.slice(this.headerLength));
            } else {
                this.onNextData.notify(data);
            }

            window.requestAnimationFrame(chunkParser);
        };

        window.requestAnimationFrame(chunkParser);

        if (residual !== '') {
            this.onNextData.notify([residual]);
        }
    }

}

function getFileReader(file: Blob): ReadableStreamDefaultReader<Uint8Array> {
    const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
    if (!stream.getReader) {
        throw new Error('Corrupted stream of Uint8Array');
    }
    return stream.getReader();
}
