// Small filesystem helpers shared by the commands.
import { access } from 'node:fs/promises';

/** True for the error Node raises when a file or command does not exist. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
