// Which Claude Code agent types a project can use: built-ins, `.claude/agents/*.md` and the agents
// of enabled plugins (`plugin:agent`).
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const BUILT_IN = new Set([
  'general-purpose',
  'Explore',
  'Plan',
  'claude-code-guide',
  'statusline-setup',
]);

/** Agent names defined as `<dir>/.claude/agents/<name>.md`, sorted. */
export async function agentFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(dir, '.claude/agents'));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

const SettingsSchema = z.looseObject({
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
});

const InstalledPluginsSchema = z.looseObject({
  plugins: z.record(z.string(), z.array(z.looseObject({ installPath: z.string() }))),
});

/** Parsed JSON of a file, or undefined when it is missing, unreadable or does not match. */
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const result = schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Install paths of the plugins enabled in the user or project settings, keyed by plugin name. */
async function enabledPluginPaths(root: string, home: string): Promise<Map<string, string[]>> {
  const enabled = new Map<string, boolean>();
  for (const path of [join(home, '.claude/settings.json'), join(root, '.claude/settings.json')]) {
    const settings = await readJson(path, SettingsSchema);
    // Project settings come last, so they override the user's.
    for (const [id, on] of Object.entries(settings?.enabledPlugins ?? {})) enabled.set(id, on);
  }
  const installed = await readJson(
    join(home, '.claude/plugins/installed_plugins.json'),
    InstalledPluginsSchema,
  );
  const paths = new Map<string, string[]>();
  for (const [id, installs] of Object.entries(installed?.plugins ?? {})) {
    if (enabled.get(id) !== true) continue;
    // Plugin ids are `name@marketplace`; agent types use the name.
    const name = id.split('@')[0] ?? id;
    paths.set(name, [...(paths.get(name) ?? []), ...installs.map((i) => i.installPath)]);
  }
  return paths;
}

/** The given agent types that resolve to no built-in, agent file or enabled plugin agent. */
export async function missingAgentTypes(
  types: string[],
  root: string,
  home: string,
): Promise<string[]> {
  const local = new Set([...(await agentFiles(root)), ...(await agentFiles(home))]);
  const plugins = await enabledPluginPaths(root, home);
  const missing: string[] = [];
  for (const type of types) {
    if (BUILT_IN.has(type) || local.has(type)) continue;
    const [plugin, agent, ...rest] = type.split(':');
    if (plugin !== undefined && agent !== undefined && rest.length === 0) {
      const dirs = plugins.get(plugin) ?? [];
      const found = await Promise.all(
        dirs.map((dir) => exists(join(dir, 'agents', `${agent}.md`))),
      );
      if (found.includes(true)) continue;
    }
    missing.push(type);
  }
  return missing;
}
