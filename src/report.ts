// `ralph report`: files an issue about ralph in its own repo, with the user's `gh` auth. Shows the
// whole body first and sends nothing unless the user confirms.
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readRawConfig } from './config.ts';
import { isNotFound } from './fs.ts';
import { type Gh, GhError } from './github.ts';

export const REPORT_REPO = 'droruri/druri-ralph-loop';
const LABEL = 'from-cli';
const LOGS = '.ralph/logs';
const LOG_LINES = 100;
/** Keeps the body well under GitHub's 65536-character limit. */
const LOG_CHARS = 20_000;
// Same relative path from `src/` (tests) and `dist/` (the built package).
const PACKAGE_JSON = resolve(import.meta.dirname, '../package.json');

export interface ReportOptions {
  root: string;
  attachLog: boolean;
  gh: Gh;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
  /** Output of `claude --version`; tests pass a stub. */
  claudeVersion?: () => Promise<string>;
}

const REDACTED = '[redacted]';
const SECRET_KEY = /token|secret|passw|auth|credential|api[-_]?key|private/i;
const SECRET_VALUE =
  /(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|xox[abp]-)\S+|(?=[\w-]*\d)[\w-]{32,}/g;

/** Replaces token-looking substrings of `text`. */
export const redactText = (text: string) => text.replace(SECRET_VALUE, REDACTED);

/** A copy of `value` with `repo`, secret-named keys and token-looking strings redacted. */
export function redact(value: unknown, key = ''): unknown {
  if (key === 'repo' || SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

const Created = z.object({ html_url: z.string() });
const PackageJson = z.object({ version: z.string() });

/** True when the issue was created or the user declined; false when nothing could be sent. */
export async function report(options: ReportOptions): Promise<boolean> {
  const { gh, ask, log } = options;
  // Fail on missing auth before the user types anything.
  await authed(() => gh(['api', 'user']));

  const title = (await ask('Title: ')).trim();
  if (title === '') {
    log('A title is required; nothing sent.');
    return false;
  }
  const description = (await ask('Description: ')).trim();
  const body = await buildBody(description, options);

  log(body);
  const answer = await ask(`Create this issue in ${REPORT_REPO}? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    log('Nothing sent.');
    return true;
  }
  const stdout = await authed(() =>
    gh([
      'api',
      `repos/${REPORT_REPO}/issues`,
      '-f',
      `title=${title}`,
      '-f',
      `body=${body}`,
      '-f',
      `labels[]=${LABEL}`,
    ]),
  );
  const created = Created.safeParse(parseJson(stdout));
  log(created.success ? created.data.html_url : 'Issue created.');
  return true;
}

async function buildBody(description: string, options: ReportOptions): Promise<string> {
  const claude = await (options.claudeVersion ?? claudeVersion)();
  const sections = [
    description,
    '---',
    '### Environment',
    [
      `- ralph: ${await cliVersion()}`,
      `- OS: ${platform()} ${release()} ${arch()}`,
      `- Node: ${process.version}`,
      `- claude: ${claude}`,
    ].join('\n'),
    '### Config',
    await configText(options.root),
  ];
  if (options.attachLog) sections.push(await logSection(options.root));
  return sections.join('\n\n');
}

async function cliVersion(): Promise<string> {
  try {
    const parsed = PackageJson.safeParse(JSON.parse(await readFile(PACKAGE_JSON, 'utf8')));
    return parsed.success ? parsed.data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function claudeVersion(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('claude', ['--version']);
    return stdout.trim();
  } catch {
    return 'not found';
  }
}

async function configText(root: string): Promise<string> {
  try {
    const raw = await readRawConfig(root);
    return `\`\`\`json\n${JSON.stringify(redact(raw), null, 2)}\n\`\`\``;
  } catch (error) {
    return `(no readable .ralph/config.json: ${error instanceof Error ? error.message : String(error)})`;
  }
}

async function logSection(root: string): Promise<string> {
  const dir = join(root, LOGS);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return `(no log in ${LOGS})`;
    throw error;
  }
  const files = await Promise.all(
    names.map(async (name) => ({ name, info: await stat(join(dir, name)) })),
  );
  const newest = files
    .filter((file) => file.info.isFile())
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0];
  if (newest === undefined) return `(no log in ${LOGS})`;
  const text = await readFile(join(dir, newest.name), 'utf8');
  const tail = text.replace(/\n$/, '').split('\n').slice(-LOG_LINES).join('\n').slice(-LOG_CHARS);
  return `### Log (${newest.name}, last ${LOG_LINES} lines)\n\n\`\`\`text\n${redactText(tail)}\n\`\`\``;
}

/** Runs a `gh` call, turning an authentication failure into a hint to run `gh auth login`. */
async function authed(call: () => Promise<string>): Promise<string> {
  try {
    return await call();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/401|bad credentials|auth login|not logged in|authenticat/i.test(text)) {
      throw new GhError('gh is not authenticated; run `gh auth login` and try again', {
        cause: error,
      });
    }
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
