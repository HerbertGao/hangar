import { spawnSync } from 'node:child_process';

const EXPECTED_VERSION = '1.6.0';
const command = 'openspec-cn';

const version = spawnSync(command, ['--version'], { encoding: 'utf8' });
if (version.error) {
  console.error(`${command} ${EXPECTED_VERSION} is required but was not found on PATH.`);
  process.exit(1);
}
if (version.status !== 0) {
  process.stderr.write(version.stderr);
  process.exit(version.status ?? 1);
}

const actualVersion = version.stdout.trim();
if (actualVersion !== EXPECTED_VERSION) {
  console.error(`Expected ${command} ${EXPECTED_VERSION}, found ${actualVersion || '<empty>'}.`);
  process.exit(1);
}

const result = spawnSync(command, ['validate', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) {
  console.error(`Failed to run ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
