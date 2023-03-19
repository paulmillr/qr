import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'script.js',
  output: {
    file: 'compiled.js',
    format: 'cjs',
    preferConst: true,
  },

  plugins: [
    resolve({ browser: true }),
  ],
};
