import { useCallback, useState } from 'react';
import styled from 'styled-components';

import { PTSParser } from '@dp-software/point-cloud';

const StyledApp = styled.div`
  // Your style here
`;

export function App() {

  const fileHandler = useCallback((e: any) => {
    const file = e.target.files[0] as File;
    console.log(file);

    const parser = new PTSParser(1000);
    parser.parse(file);
  }, []);

  return (
    <StyledApp>
      <form>
        <input type="file" onChange={fileHandler} />
      </form>
    </StyledApp>
  );
}

export default App;
