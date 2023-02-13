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

    public async parseFile() {
        const stream = this.file.stream()
        if (!stream.getReader) {
            throw new Error('Corrupted stream of Uint8Array');
        }

        const reader = getFileReader(this.file);

        let running = true;
        let isFirst = true;
        let residual = '';
        while (running) {
            const {done, value} = await reader.read();
            running = !done;

            if (done) {
                break;
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
        }

        if (residual !== '') {
            this.onNextData.notify([residual]);
        }

        this.onFinish.notify();
    }

}

function getFileReader(file: Blob): ReadableStreamDefaultReader<Uint8Array> {
    const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
    if (!stream.getReader) {
        throw new Error('Corrupted stream of Uint8Array');
    }
    return stream.getReader();
}
