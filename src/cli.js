const fs = require('node:fs');
const path = require('node:path');
const { runWorkflow } = require('./workflow');
const { stableStringify } = require('./hash');

function main(argv = process.argv.slice(2)) {
  const [inputPath, outputPath] = argv;
  if (!inputPath) {
    console.error('Usage: node src/cli.js <synthetic-input.json> [output.json]');
    process.exitCode = 1;
    return;
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = runWorkflow(input);
  const serialized = `${stableStringify(result)}\n`;
  if (outputPath) {
    const destination = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
}

if (require.main === module) main();

module.exports = { main };
