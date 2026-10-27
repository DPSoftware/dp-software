import { DEFAULT_COLOR, PTSParser, RGB } from '../src/lib/parsers/pts';

// parseRow is private and the streaming part of the parser needs Blob.stream and
// requestAnimationFrame, which jsdom does not provide, so the row parser is called directly.
type RowParser = { parseRow(row: string): [[number, number, number], RGB] };
const parseRow = (parser: PTSParser, row: string) => (parser as unknown as RowParser).parseRow(row);

describe('PTSParser.parseRow', () => {

    it('should parse a full row into a point and a color, skipping intensity', () => {
        const parser = new PTSParser();

        expect(parseRow(parser, '1 2 3 -500 10 20 30')).toEqual([[1, 2, 3], [10, 20, 30]]);
    });

    it('should reject colorless rows by default', () => {
        const parser = new PTSParser();

        expect(() => parseRow(parser, '1 2 3')).toThrow('Row has no color data: 1 2 3');
        expect(() => parseRow(parser, '1 2 3 -500')).toThrow('Row has no color data: 1 2 3 -500');
    });

    it('should use grey for colorless rows when they are accepted', () => {
        const parser = new PTSParser(0.02, { acceptColorless: true });

        expect(parseRow(parser, '1 2 3')).toEqual([[1, 2, 3], DEFAULT_COLOR]);
        expect(parseRow(parser, '1 2 3 -500')).toEqual([[1, 2, 3], DEFAULT_COLOR]);
        expect(DEFAULT_COLOR).toEqual([128, 128, 128]);
    });

    it('should use the configured default color for colorless rows', () => {
        const parser = new PTSParser(0.02, { acceptColorless: true, defaultColor: [255, 0, 0] });

        expect(parseRow(parser, '1 2 3')).toEqual([[1, 2, 3], [255, 0, 0]]);
    });

    it('should hand out a fresh color tuple per point so callers cannot mutate the default', () => {
        const parser = new PTSParser(0.02, { acceptColorless: true });

        const [, first] = parseRow(parser, '1 2 3');
        first[0] = 0;
        const [, second] = parseRow(parser, '4 5 6');

        expect(second).toEqual(DEFAULT_COLOR);
    });

    it('should reject rows with an unsupported number of fields', () => {
        const parser = new PTSParser(0.02, { acceptColorless: true });

        expect(() => parseRow(parser, '1 2')).toThrow('Invalid row: 1 2');
        expect(() => parseRow(parser, '1 2 3 4 5')).toThrow('Invalid row: 1 2 3 4 5');
        expect(() => parseRow(parser, '1 2 3 4 5 6 7 8')).toThrow('Invalid row: 1 2 3 4 5 6 7 8');
    });

});
