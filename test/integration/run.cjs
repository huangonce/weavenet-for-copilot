const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.cjs');
  // An empty VSCODE_VERSION means "latest stable". CI sets the value explicitly
  // so the declared minimum host is exercised instead of only the newest one.
  const version = process.env.VSCODE_VERSION?.trim() || undefined;
  console.log(`Running the extension host smoke test against VS Code ${version ?? 'latest stable'}.`);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    version,
  });
}

main().catch((error) => {
  console.error('VS Code extension host smoke test failed.');
  console.error(error);
  process.exitCode = 1;
});
