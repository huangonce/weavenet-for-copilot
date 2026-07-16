const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.cjs');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
}

main().catch((error) => {
  console.error('VS Code extension host smoke test failed.');
  console.error(error);
  process.exitCode = 1;
});
