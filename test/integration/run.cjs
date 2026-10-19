const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.cjs');
  // An empty VSCODE_VERSION means "latest stable". CI sets the value explicitly
  // so the declared minimum host is exercised instead of only the newest one.
  const version = process.env.VSCODE_VERSION?.trim() || undefined;
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH?.trim()
    || await downloadAndUnzipVSCode({ version });
  const vsix = process.env.VSCODE_TEST_VSIX?.trim();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'weavenet-vscode-test-'));
  const userData = path.join(profile, 'user-data');
  const extensions = path.join(profile, 'extensions');
  fs.mkdirSync(userData);
  fs.mkdirSync(extensions);
  const isolated = [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`];
  const launchArgs = [...isolated, '--disable-gpu', '--disable-telemetry', '--password-store=basic', '--skip-welcome', '--skip-release-notes'];
  const fixture = path.join(__dirname, 'fixtures/provider-bridge');
  try {
    if (vsix) {
      const cli = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
      const args = [...isolated, '--no-sandbox', '--disable-gpu', '--disable-telemetry',
        '--password-store=basic', '--install-extension', path.resolve(vsix), '--force'];
      const shell = process.platform === 'win32';
      // Match test-electron's Windows shell quoting for executable/argument
      // paths containing spaces; POSIX uses exec-style argument passing.
      const installed = spawnSync(shell ? `"${cli}"` : cli, shell ? args.map(arg => `"${arg}"`) : args, {
        stdio: 'inherit', timeout: 60_000, shell,
      });
      if (installed.status !== 0) throw installed.error ?? new Error(`VSIX installation failed with exit code ${installed.status}.`);
    } else {
      launchArgs.push('--disable-extensions');
    }
    console.log(`Running ${vsix ? 'installed VSIX' : 'source'} regression against VS Code ${version ?? 'latest stable'}.`);
    await runTests({
      // In VSIX mode only the bridge is under development: loading the source
      // extension here would silently hide missing or stale packaged files.
      extensionDevelopmentPath: vsix ? fixture : [extensionDevelopmentPath, fixture],
      extensionTestsPath,
      launchArgs,
      version,
      vscodeExecutablePath,
    });
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.warn(`Could not remove isolated VS Code test profile ${profile}: ${error.message ?? error}`);
    }
  }
}

main().catch((error) => {
  console.error('VS Code extension host smoke test failed.');
  console.error(error);
  process.exitCode = 1;
});
