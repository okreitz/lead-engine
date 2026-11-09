import { describe, expect, it } from 'vitest';
import { CommandArgumentError, runCommand } from '../src/commands.ts';

describe('command registry', () => {
  it('rejects names that are not registered', async () => {
    // @ts-expect-error: 'sh' is deliberately not a CommandName
    await expect(runCommand('sh', ['-c', 'echo hi'])).rejects.toBeInstanceOf(CommandArgumentError);
  });

  it('only runs claude in print mode', async () => {
    await expect(runCommand('claude', ['--help'])).rejects.toThrow(/print mode/);
  });

  it('rejects NUL bytes in arguments', async () => {
    await expect(runCommand('httpx', ['-u', 'a\0b'])).rejects.toBeInstanceOf(CommandArgumentError);
  });
});
