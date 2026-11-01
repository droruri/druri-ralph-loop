// Scripted fake of the `gh` runner for tests: answers `gh api` calls from a route table and records
// every call. Never touches the network.
import type { Gh } from './github.ts';

export interface GhCall {
  method: string;
  path: string;
  /** `-f key=value` fields. */
  fields: Record<string, string[]>;
}

export interface FakeGh {
  gh: Gh;
  calls: GhCall[];
  /**
   * Sets the reply for `METHOD path` (a route without a query string matches any query): JSON data,
   * a raw string, an Error to fail like a non-zero `gh` exit, or a function of the call.
   */
  on: (route: string, reply: unknown) => void;
  /** Calls that are not GETs, as `METHOD path`. */
  writes: () => string[];
}

export function fakeGh(routes: Record<string, unknown> = {}): FakeGh {
  const table = new Map<string, unknown>(Object.entries(routes));
  const calls: GhCall[] = [];

  const gh: Gh = async (args) => {
    const call = parse(args);
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const bare = `${call.method} ${call.path.split('?')[0] ?? ''}`;
    const entry = table.has(key) ? table.get(key) : table.get(bare);
    if (entry === undefined && !table.has(key) && !table.has(bare)) {
      if (call.method !== 'GET') return '{}';
      throw new Error(`fake gh: no route for ${key}`);
    }
    const reply = typeof entry === 'function' ? entry(call) : entry;
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'string') return reply;
    const paginate = args.includes('--paginate');
    // `--paginate --slurp` wraps the pages in an array; the fake serves everything as one page.
    return JSON.stringify(paginate ? [reply] : reply);
  };

  return {
    gh,
    calls,
    on: (route, reply) => table.set(route, reply),
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
  };
}

function parse(args: string[]): GhCall {
  const call: GhCall = { method: 'GET', path: '', fields: {} };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-X') {
      call.method = args[++i] ?? '';
    } else if (arg === '-f' || arg === '-F') {
      const field = args[++i] ?? '';
      const eq = field.indexOf('=');
      const name = field.slice(0, eq);
      call.fields[name] = [...(call.fields[name] ?? []), field.slice(eq + 1)];
      if (call.method === 'GET') call.method = 'POST';
    } else if (!arg.startsWith('-')) {
      call.path = arg;
    }
  }
  return call;
}
