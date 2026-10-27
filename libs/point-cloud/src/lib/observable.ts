
type Callback<T> = (data: T) => void;
export type Unsubscriber = () => void;

class Observer<T> {
    constructor(public cb: Callback<T>) {
    }
}

/** Minimal synchronous publish/subscribe primitive; `subscribe` returns an unsubscriber. */
export class Observable<T> {
    private observers: Observer<T>[] = [];

    public subscribe(cb: Callback<T>): Unsubscriber {
        const observer = new Observer(cb);
        this.observers.push(observer);

        return () => {
            const index = this.observers.indexOf(observer);

            if (index !== -1) {
                this.observers.splice(index, 1);
            }
        };
    }

    public notify(data: T) {
        for (const observer of this.observers) {
            observer.cb(data);
        }
    }

}
