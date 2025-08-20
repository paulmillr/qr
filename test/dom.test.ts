import { should } from '@paulmillr/jsbt/test.js';
import globalJsdom from 'global-jsdom';
import { deepStrictEqual } from 'node:assert';
import { getSize, svgToPng } from '../src/dom.ts';
import { encodeQR } from '../src/index.ts';

globalJsdom(undefined, { resources: 'usable' });

should('getSize', () => {
  const body = document.querySelector('body');
  const elm = document.createElement('html');
  elm.style.width = '100px';
  elm.style.height = '200px';
  body.appendChild(elm);

  deepStrictEqual(getSize(elm), { width: 100, height: 200 });

  elm.remove();
});

should('svgToPng', async () => {
  const svg = encodeQR('https://google.com/', 'svg');
  const size = 58; // Generated SVG viewport * 2
  const expected =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAYAAADhu0ooAAAABm' +
    'JLR0QA/wD/AP+gvaeTAAABiElEQVRoge2awRLCMAhEjeP//3I9ccHZ2QUSdQp7axtJmlcIwa' +
    'zruq5HAz1/PYBvaV70bnr5G2utlCHv6t6OPbf76PrUePoSNanB2M84I8Tsot9nx2MaoiY0Q9' +
    'EZVn3y1HiGaFVs5pFvn9IQzYqthyyaniI7RE3V6MiIRaNwdjxDNOsrbN1E16rdrNoQXbsrDG' +
    'jXsqt9Vm2Iwv1oNpdlz/21mimp6y0aRxui0Eej0RN2EIyW1UpDe6JyzSiaw2Z9jNlF47L26H' +
    'd9iZqqhNBMo35YO9Se3TcNUZNKUvUVlSwjFM2g2hD9WEejtZ5snTbarvq8DVEadVE0ZBlSNH' +
    'dV20VjhmmIIqkkoz6djc5qlB6iJjZT6v6SidlH/alfTBuix2pG2Uynul4itSG6/QwDqwFFSe' +
    'yqYfUlaqqeGYhmPrv/WfcaoqZTM62uz1H746OnDEe/hKyvqpnYEK1K3c9WT5ih/ryGqKmaCk' +
    'f3r/7+rnEN0VNnGFT7u6qLpjZEt+9H/1VtiM6L3k1vLwCAogw5DNQAAAAASUVORK5CYII=';

  deepStrictEqual(await svgToPng(svg, size, size), expected);
});

should.runWhen(import.meta.url);
