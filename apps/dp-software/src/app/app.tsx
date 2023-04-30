import {useCallback, useEffect, useState} from 'react';
import styled from 'styled-components';

import {PTSParser} from '@dp-software/point-cloud';

const StyledApp = styled.div`
    // Your style here
`;

export function App() {

    const [counter, setCounter] = useState(0);

    // this effect should indicate how thread is occupied while parsing
    useEffect(() => {
        const interval = setInterval(() => {
            setCounter(prevCounter => prevCounter + 1);
        }, 500);
        return () => clearInterval(interval);
    }, [setCounter]);

    const fileHandler = useCallback((e: any) => {
        const file = e.target.files[0] as File;

        const parser = new PTSParser(0.05);
        const now = performance.now();
        let points: [number, number, number][] = [];
        let colors: [number, number, number][] = [];
        parser.onNewPoints.subscribe(data => {
            points = points.concat(data.points);
            colors = colors.concat(data?.colors || [255, 255, 255]);
        });
        parser.onFinish.subscribe(() => {
            console.log(points, colors);
            console.log(`data are processed in ${(performance.now() - now) / 1000}`);
        });
        parser.parse(file);
    }, []);

    return (
        <StyledApp>
            {counter}
            <form>
                <input type="file" onChange={fileHandler}/>
            </form>
        </StyledApp>
    );
}

export default App;
