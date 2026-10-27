import { isOpenMessage, isWorkerMessage } from '../src/lib/protocol';

const cloud = {
    index: 0, name: null, guid: null, records: 1, translation: null, rotation: null,
    hasColor: false, hasIntensity: false, hasNormals: false,
};
const open = {
    type: 'open', jobId: 1, file: {}, format: 'e57', voxelSize: 1, acceptColorless: false,
    defaultColor: [1, 2, 3], intensities: false,
};

describe('protocol guards', () => {
    it('should accept a cloud worker message', () => {
        expect(isWorkerMessage({ type: 'cloud', jobId: 1, cloud })).toBe(true);
    });

    it('should accept a format worker message', () => {
        expect(isWorkerMessage({ type: 'format', jobId: 1, format: 'pts' })).toBe(true);
    });

    it.each([
        [{ type: 'open' }], [{ type: 'open', jobId: 1 }], [null], ['str'], [{ type: 'cloud' }],
        [{ type: 'scan', jobId: 1 }],
    ])(
        'should reject %p as a worker message', (value) => {
            expect(isWorkerMessage(value)).toBe(false);
        });

    it('should accept an open message', () => {
        expect(isOpenMessage(open)).toBe(true);
        expect(isOpenMessage({ ...open, format: 'auto' })).toBe(true);
    });

    it('should reject the removed start messages as open messages', () => {
        expect(isOpenMessage({ type: 'start', jobId: 1 })).toBe(false);
        expect(isOpenMessage({ type: 'start', jobId: 1, format: 'e57' })).toBe(false);
        expect(isOpenMessage(null)).toBe(false);
    });

    it('should reject an open message without a numeric jobId or a format', () => {
        expect(isOpenMessage({ ...open, jobId: '1' })).toBe(false);
        expect(isOpenMessage({ type: 'open', jobId: 1 })).toBe(false);
        expect(isOpenMessage({ ...open, format: 3 })).toBe(false);
    });
});
