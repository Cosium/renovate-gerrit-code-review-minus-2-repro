import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Mode =
  | { readonly kind: 'released' }
  | { readonly kind: 'source'; readonly renovateClone: string };

interface Account {
  readonly username?: string;
}

interface Change {
  readonly _number: number;
  readonly subject: string;
  readonly status: string;
  readonly labels?: {
    readonly 'Code-Review'?: { readonly rejected?: Account };
  };
  readonly messages?: readonly {
    readonly author?: Account;
    readonly message: string;
  }[];
}

const reproDir = dirname(import.meta.dirname);
const admin = { username: 'admin', password: 'secret' };
const project = 'code-review-minus-2-demo';

const parseMode = (args: readonly string[]): Mode => {
  const [kind, renovateClone] = args;
  if (kind === 'released') {
    return { kind };
  }
  if (kind === 'source' && renovateClone) {
    return { kind, renovateClone: resolve(renovateClone) };
  }
  console.error('usage: node scripts/run.ts released | source <renovate-clone>');
  process.exit(2);
};

const log = (message: string): void => {
  console.log(`\n==> ${message}`);
};

// The caller's own RENOVATE_* variables would otherwise change the runs.
const buildEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('RENOVATE_'),
    ),
  ),
  ...overrides,
});

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string =>
  execFileSync(command, args, {
    cwd: options.cwd ?? reproDir,
    env: buildEnvironment(options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const callGerrit = async <T>(
  gerritUrl: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`${gerritUrl}/a/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  }
  // Gerrit prefixes JSON responses with )]}' to prevent XSSI.
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as T;
};

const computeLogPrefix = (mode: Mode): string => {
  if (mode.kind === 'released') {
    return 'released';
  }
  return `source-${run('git', ['rev-parse', '--short', 'HEAD'], { cwd: mode.renovateClone }).trim()}`;
};

const runRenovate = (
  gerritUrl: string,
  mode: Mode,
  logPrefix: string,
  renovateRunNumber: number,
  renovatePassword: string,
  workDirectory: string,
): void => {
  const name = `${logPrefix}-run${renovateRunNumber}`;
  log(`Renovate run ${renovateRunNumber} (${logPrefix}), log: logs/${name}.log`);
  rmSync(join(reproDir, 'logs', `${name}.log`), { force: true });
  if (mode.kind === 'released') {
    run(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '-e',
        `RENOVATE_GERRIT_PASSWORD=${renovatePassword}`,
        'renovate',
      ],
      { env: { LOG_NAME: name } },
    );
    return;
  }
  // Renovate lower-cases LOG_FILE, which breaks paths with capitals, so its
  // JSON output is written to the log instead.
  execFileSync('pnpm', ['--silent', 'start'], {
    cwd: mode.renovateClone,
    env: buildEnvironment({
      RENOVATE_CONFIG_FILE: join(reproDir, 'config.js'),
      RENOVATE_GERRIT_PASSWORD: renovatePassword,
      GERRIT_URL: `${gerritUrl}/`,
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json',
      RENOVATE_BASE_DIR: join(workDirectory, `renovate-run${renovateRunNumber}`),
    }),
    stdio: [
      'ignore',
      openSync(join(reproDir, 'logs', `${name}.log`), 'w'),
      'inherit',
    ],
  });
};

const findRenovateChange = async (gerritUrl: string): Promise<Change> => {
  const changes = await callGerrit<readonly Change[]>(
    gerritUrl,
    `changes/?q=owner:renovate+project:${project}&o=LABELS&o=DETAILED_ACCOUNTS&o=MESSAGES`,
  );
  const [change] = changes;
  if (changes.length !== 1 || !change) {
    throw new Error(`Expected one change of renovate, found ${changes.length}`);
  }
  return change;
};

const printChange = (change: Change): void => {
  console.log(`  change ${change._number}: ${change.subject}`);
  console.log(`  status: ${change.status}`);
  console.log(
    `  Code-Review rejected by: ${change.labels?.['Code-Review']?.rejected?.username ?? 'nobody'}`,
  );
  console.log('  messages:');
  // The first two lines carry the vote or action and the start of the text;
  // the rest is the long change description Renovate posts.
  for (const message of change.messages ?? []) {
    const [action, text] = message.message
      .split('\n')
      .filter((line) => line.trim() !== '');
    console.log(`    ${message.author?.username}: ${action}`);
    if (text) {
      console.log(`      ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`);
    }
  }
};

// Gerrit listens on a port Docker picks, so another service on 8080 is no obstacle.
const startCleanGerrit = (): string => {
  log('Starting a clean Gerrit');
  try {
    run('docker', ['compose', 'down', '-v', '--remove-orphans']);
  } catch (error) {
    console.trace('Stopping a previous Gerrit failed', error);
  }
  run('docker', ['compose', 'up', '-d', '--wait', 'gerrit']);
  const gerritUrl = `http://${run('docker', ['compose', 'port', 'gerrit', '8080']).trim()}`;
  console.log(`Gerrit is on ${gerritUrl}`);
  return gerritUrl;
};

const prepareLogDirectory = (): void => {
  const logs = join(reproDir, 'logs');
  mkdirSync(logs, { recursive: true });
  // The Renovate container writes its logs as another user.
  chmodSync(logs, 0o777);
};

const createAccount = async (
  gerritUrl: string,
  username: string,
): Promise<string> => {
  const password = randomBytes(18).toString('base64');
  await callGerrit(gerritUrl, `accounts/${username}`, {
    method: 'PUT',
    body: {
      name: username,
      email: `${username}@example.org`,
      http_password: password,
    },
  });
  return password;
};

const createProject = async (
  gerritUrl: string,
  workDirectory: string,
): Promise<void> => {
  log(`Creating project ${project}`);
  await callGerrit(gerritUrl, `projects/${project}`, {
    method: 'PUT',
    body: { branches: ['master'], create_empty_commit: true },
  });
  const administrators = await callGerrit<{ readonly id: string }>(
    gerritUrl,
    'groups/Administrators',
  );
  await callGerrit(gerritUrl, `projects/${project}/access`, {
    method: 'POST',
    body: {
      add: {
        'refs/heads/*': {
          permissions: {
            push: { rules: { [administrators.id]: { action: 'ALLOW' } } },
          },
        },
      },
    },
  });
  const seed = join(workDirectory, 'seed');
  run('git', [
    'clone',
    '--quiet',
    `${gerritUrl.replace('://', `://${admin.username}:${admin.password}@`)}/a/${project}`,
    seed,
  ]);
  cpSync(join(reproDir, 'project'), seed, { recursive: true });
  run('git', ['add', '-A'], { cwd: seed });
  run(
    'git',
    [
      '-c',
      'user.name=Administrator',
      '-c',
      'user.email=admin@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Add the demo project',
    ],
    { cwd: seed },
  );
  run('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], {
    cwd: seed,
  });
};

const mode = parseMode(process.argv.slice(2));
const logPrefix = computeLogPrefix(mode);
const gerritUrl = startCleanGerrit();
const workDirectory = mkdtempSync(join(tmpdir(), 'code-review-minus-2-'));
try {
  prepareLogDirectory();
  log('Creating user renovate');
  const renovatePassword = await createAccount(gerritUrl, 'renovate');
  await createProject(gerritUrl, workDirectory);

  runRenovate(gerritUrl, mode, logPrefix, 1, renovatePassword, workDirectory);
  const created = await findRenovateChange(gerritUrl);
  if (created.status !== 'NEW') {
    throw new Error(
      `Renovate run 1 left change ${created._number} ${created.status}, see logs/${logPrefix}-run1.log`,
    );
  }

  log('admin votes Code-Review -2 to hold the change back');
  await callGerrit(
    gerritUrl,
    `changes/${created._number}/revisions/current/review`,
    {
      method: 'POST',
      body: {
        labels: { 'Code-Review': -2 },
        message: 'Hold on until we know whether v7 drops a runtime we support.',
      },
    },
  );
  printChange(await findRenovateChange(gerritUrl));

  runRenovate(gerritUrl, mode, logPrefix, 2, renovatePassword, workDirectory);
  log('Change after run 2');
  const processedChange = await findRenovateChange(gerritUrl);
  printChange(processedChange);
  if (processedChange.status === 'ABANDONED') {
    log('Reproduced: Renovate abandoned the change voted Code-Review -2');
    process.exitCode = 1;
  } else if (processedChange.status === 'NEW') {
    log('Not reproduced: the change voted Code-Review -2 stays open');
  } else {
    throw new Error(`Unexpected status ${processedChange.status} of change ${processedChange._number}`);
  }
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
