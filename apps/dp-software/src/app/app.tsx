import {useCallback} from 'react';
import styled from 'styled-components';

import {PTSParser} from '@dp-software/point-cloud';

const StyledApp = styled.div`
    // Your style here
`;

export function App() {

    const fileHandler = useCallback((e: any) => {
        const file = e.target.files[0] as File;

        const parser = new PTSParser(0.05);
        const now = performance.now();
        let points: [number, number, number][] = [];
        let colors: [number, number, number][] = [];
        parser.onNewPoints.subscribe(data => {
            points = points.concat(data.points);
            colors = colors.concat(data?.colors || [0, 0, 0]);
        });
        parser.onFinish.subscribe(() => {
            console.log(points, colors);
            console.log(`data are processed in ${(performance.now() - now) / 1000}`);
        });
        parser.parse(file);
        // parser.parse(file).then(res => {
        //     console.log(res);
        //     console.log(`data are processed in ${(performance.now() - now) / 1000}`);
        // });
    }, []);

    return (
        <StyledApp>
            <form>
                <input type="file" onChange={fileHandler}/>
            </form>
        </StyledApp>
    );
}

export default App;
