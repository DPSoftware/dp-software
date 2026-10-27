import { Observable } from "../observable.js";

const decoder = new TextDecoder('utf-8');

export class Parser {

    private readonly file: Blob;
    public readonly onHeaderDataRead = new Observable<string[]>();
    public readonly onNextData = new Observable<string[]>();
    public readonly onFinish = new Observable<void>();
    public readonly onError = new Observable<string>();
    public readonly headerLength: number;
    private cancelled = false;
    private activeReader?: ReadableStreamDefaultReader<Uint8Array>;

    public constructor(file: Blob, headerLength=1) {
        this.file = file;
        this.headerLength = headerLength;
    }

    /** Stops scheduling chunks and releases the stream reader; `onFinish` does not fire. */
    public cancel(): void {
        this.cancelled = true;
        const reader = this.activeReader;
        this.activeReader = undefined;
        if (reader) {
            reader.cancel().catch(() => undefined);
        }
    }

    public parseFile(): void {
        const stream = this.file.stream()
        if (!stream.getReader) {
            throw new Error('Corrupted stream of Uint8Array');
        }

        const reader = getFileReader(this.file);
        this.activeReader = reader;

        let isFirst = true;
        let residual = '';
        let finished = false;

        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            this.onFinish.notify();
        };

        const chunkParser = async () => {
            try {
                const {done, value} = await reader.read();
                if (this.cancelled) {
                    return;
                }

                if (done) {
                    // A file without a trailing newline leaves its last line in the residual
                    if (residual !== '') {
                        this.onNextData.notify([residual]);
                    }
                    finish();
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

                if (this.cancelled) {
                    return;
                }
                window.requestAnimationFrame(chunkParser);
            } catch (e) {
                if (this.cancelled) {
                    return;
                }
                if (finished) {
                    throw e;
                }
                this.onError.notify(e instanceof Error ? e.message : String(e));
                finish();
            }
        };

        window.requestAnimationFrame(chunkParser);
    }

}

function getFileReader(file: Blob): ReadableStreamDefaultReader<Uint8Array> {
    const stream = file.stream() as unknown as ReadableStream<Uint8Array>;
    if (!stream.getReader) {
        throw new Error('Corrupted stream of Uint8Array');
    }
    return stream.getReader();
}
