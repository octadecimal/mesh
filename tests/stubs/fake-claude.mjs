// tests/stubs/fake-claude.mjs
// Replays a recorded stream so the supervisor can be tested for free.
// FAKE_CLAUDE_FIXTURE: absolute path to an .ndjson recording.
// FAKE_CLAUDE_ARGS_OUT: optional path to write the received argv as JSON.
// FAKE_CLAUDE_EXIT_CODE: optional. When set, exit with this code before
// writing anything, so a test can simulate a child that fails fast.
import { readFileSync, writeFileSync } from 'node:fs';

const fixture = process.env.FAKE_CLAUDE_FIXTURE;
const argsOut = process.env.FAKE_CLAUDE_ARGS_OUT;
const exitCode = process.env.FAKE_CLAUDE_EXIT_CODE;

if (exitCode !== undefined) process.exit(Number(exitCode));

if (argsOut) writeFileSync(argsOut, JSON.stringify(process.argv.slice(2)), 'utf8');

for (const line of readFileSync(fixture, 'utf8').split('\n')) {
  if (line.trim().length > 0) process.stdout.write(`${line}\n`);
}

// Stay alive so the supervisor can write to stdin, and exit when it closes.
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (argsOut) writeFileSync(`${argsOut}.stdin`, chunk, { flag: 'a' });
});
process.stdin.on('end', () => process.exit(0));
