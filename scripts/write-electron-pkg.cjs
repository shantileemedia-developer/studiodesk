// Writes dist-electron/package.json so Node.js treats the compiled .js files
// as CommonJS. Without this, the root package.json's "type":"module" causes
// Electron to parse the CJS-compiled main process as ESM, crashing with
// "exports is not defined in ES module scope".
const fs = require('fs');
fs.writeFileSync('dist-electron/package.json', JSON.stringify({ type: 'commonjs' }));
console.log('✓ dist-electron/package.json written (type: commonjs)');
