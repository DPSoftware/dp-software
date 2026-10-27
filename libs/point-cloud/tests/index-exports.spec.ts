import { Observable } from '../src/index';
import type { PointCloudData } from '../src/index';

describe('package index', () => {
    it('should export a working Observable', () => {
        const obs = new Observable<number>();
        const cb = jest.fn();
        const unsubscribe = obs.subscribe(cb);

        obs.notify(1);
        unsubscribe();
        obs.notify(2);

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith(1);
    });

    it('should allow PointCloudData with intensities and scanIndex', () => {
        const data: PointCloudData = {
            points: [[1, 2, 3]],
            colors: [[1, 2, 3]],
            intensities: [0.5],
            scanIndex: 2,
        };

        expect(data.scanIndex).toBe(2);
    });
});
