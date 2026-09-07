/**
 * Deploy the collaboration stack to a container host.
 *
 * Committed rather than typed by hand each time, so a deployment is
 * reproducible and reviewable, and so the next person does not have to
 * reconstruct the sequence from a shell history nobody kept.
 *
 * WHAT IT WILL NOT DO, AND WHY EACH ONE IS DELIBERATE.
 *
 * It never writes a secret into this repository, into a command argument, into
 * a log line or into its own output. The session secret is generated ON THE
 * HOST, straight into a file only the deploying user can read. A secret in a
 * command argument is a secret in the process table; a secret in a committed
 * file is a secret in the history for ever, and history cannot be edited
 * without a force-push.
 *
 * It never prunes globally, never stops a container it did not start, and never
 * takes a port that is already published. The host carries unrelated workloads
 * that other people depend on, and a deployment that tidies up around itself is
 * a deployment that eventually takes one of them down.
 *
 * It re-checks the host live before doing anything. The recorded inventory is a
 * routing hint and not permission: `super` was the planned target for this
 * stack and was unreachable when this ran, which is exactly the case the check
 * exists for.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const target = process.argv[2] ?? '';
const port = process.argv[3] ?? '8477';
const remoteRoot = '~/material-workspace-collab';

const log = (message) => process.stdout.write('[deploy] ' + message + '\n');
const fail = (message) => {
  process.stderr.write('[deploy] FAILED: ' + message + '\n');
  process.exit(1);
};

if (target === '') {
  fail('usage: node server/deploy.mjs <user@host> [port]\n' +
    '       the host must already be in the private inventory, and reachable');
}

/**
 * Scoped trust on first use, and nothing weaker.
 *
 * A previously unseen key is enrolled; a key that DIFFERS from the recorded one
 * stops the deployment. Never StrictHostKeyChecking=no, never an empty
 * known_hosts, never a wildcard exception - those turn a private LAN into one
 * where anything answering on the address is trusted.
 */
const SSH_OPTIONS = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'UpdateHostKeys=no',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=12',
];

function ssh(script, { quiet = false } = {}) {
  const out = execFileSync('ssh', [...SSH_OPTIONS, target, 'bash -s'], {
    input: script,
    encoding: 'utf8',
    stdio: quiet ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'inherit'],
  });
  return out.trim();
}

// ------------------------------------------------------------- preflight --

log('checking ' + target + ' live, before anything is sent');

const facts = JSON.parse(
  ssh(
    'printf \'{"host":"%s","arch":"%s","free_mb":%s,"disk_avail":"%s","docker":"%s"}\' ' +
      '"$(hostname)" "$(uname -m)" "$(free -m | awk \'/^Mem:/{print $7}\')" ' +
      '"$(df -h / | tail -1 | awk \'{print $4}\')" "$(docker --version | head -1)"',
    { quiet: true },
  ),
);

log('  host      ' + facts.host + ' (' + facts.arch + ')');
log('  available ' + facts.free_mb + ' MB memory, ' + facts.disk_avail + ' disk');
log('  ' + facts.docker);

if (Number(facts.free_mb) < 512) {
  fail('only ' + facts.free_mb + ' MB available; this stack reserves 128 MB and is capped at 768');
}

// A port that is already published belongs to somebody else's workload - unless
// the thing publishing it is THIS stack, in which case this is a redeploy.
// Refusing outright would mean the guard blocks every second deployment, and
// the fix somebody reaches for then is to delete the guard.
const listening = ssh(
  'ss -ltn 2>/dev/null | grep -c ":' + port + ' " || true',
  { quiet: true },
);
const ours = ssh(
  'docker ps --format "{{.Names}} {{.Ports}}" | grep "^material-workspace-collab" | ' +
    'grep -c ":' + port + '->" || true',
  { quiet: true },
);

if (listening !== '0' && ours === '0') {
  fail(
    'port ' + port + ' is already listening on ' + facts.host +
      ' and it is not this stack. Pick another port rather than taking it.',
  );
}
log(
  listening === '0'
    ? '  port ' + port + ' is free'
    : '  port ' + port + ' belongs to this stack already, so this is a redeploy',
);

const existing = ssh(
  'docker ps -a --format "{{.Names}}" | grep -c "^material-workspace-collab" || true',
  { quiet: true },
);
log(
  existing === '0'
    ? '  no existing deployment of this stack'
    : '  ' + existing + ' container(s) from an earlier deployment of THIS stack will be replaced',
);

// ----------------------------------------------------------------- send --

log('packing the server');
// Only what the image needs. The rest of the repository has no business on a
// shared host.
const archive = path.join(ROOT, '.tmp', 'collab-server.tar.gz');
fs.mkdirSync(path.dirname(archive), { recursive: true });
execFileSync(
  'tar',
  // --force-local, because a Windows path begins `C:` and GNU tar reads that as
  // a remote host: without it the archive path is treated as `host:file` and it
  // fails trying to resolve a machine called C.
  ['--force-local', '-czf', archive, '-C', HERE, 'Dockerfile', 'compose.yaml', 'build.mjs', 'src'],
  { stdio: 'pipe' },
);
const size = fs.statSync(archive).size;
log('  ' + (size / 1024).toFixed(1) + ' KB');

log('sending');
execFileSync('scp', [...SSH_OPTIONS, archive, target + ':/tmp/collab-server.tar.gz'], {
  stdio: 'pipe',
});

// ------------------------------------------------------------- the secret --

// Generated on the host, straight into a file with no other reader, and never
// returned here. This process never learns it, so it cannot leak it.
log('ensuring a session secret exists on the host');
const secretState = ssh(
  [
    'set -e',
    'mkdir -p ' + remoteRoot,
    'chmod 700 ' + remoteRoot,
    'cd ' + remoteRoot,
    'if [ -s .env ]; then echo kept; else',
    '  umask 077',
    '  printf "SESSION_SECRET=%s\\n" "$(openssl rand -hex 32)" > .env',
    '  chmod 600 .env',
    '  echo created',
    'fi',
  ].join('\n'),
  { quiet: true },
);
log('  ' + (secretState === 'kept' ? 'an existing secret was kept' : 'a new secret was generated'));

// ------------------------------------------------------------------ build --

const version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const buildTime = new Date().toISOString();

log('building and starting on the host');
ssh(
  [
    'set -e',
    'cd ' + remoteRoot,
    'tar -xzf /tmp/collab-server.tar.gz',
    'rm -f /tmp/collab-server.tar.gz',
    'export COLLAB_PORT=' + port,
    'export BUILD_VERSION=' + version,
    'export BUILD_TIME=' + buildTime,
    // The env file carries the secret; --env-file keeps it out of the argument
    // list and out of the process table.
    'docker compose --env-file .env up -d --build',
  ].join('\n'),
);

// ------------------------------------------------------------- verifying --

log('waiting for the health check');
let healthy = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const state = ssh(
    'docker ps --filter "name=material-workspace-collab" --format "{{.Status}}" | head -1',
    { quiet: true },
  );
  if (state.includes('healthy')) {
    healthy = true;
    break;
  }
  if (state.includes('unhealthy') || state === '') {
    // Keep waiting: an unhealthy report during the start period is normal, and
    // an empty one means the container has not been listed yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
}
if (!healthy) {
  const logs = ssh(
    'docker logs --tail 40 $(docker ps -aq --filter "name=material-workspace-collab" | head -1) 2>&1 || true',
    { quiet: true },
  );
  fail('the container never reported healthy. Its last output:\n' + logs);
}

// Read from OUTSIDE the container, so the check proves the published port
// really serves rather than that the process is up.
const health = ssh(
  'curl -sS --max-time 8 http://127.0.0.1:' + port + '/health',
  { quiet: true },
);
log('  health:  ' + health);
if (JSON.parse(health).status !== 'ok') fail('the health route did not report ok');

// And the version, which is what proves the container is running the commit
// that was just sent rather than an image left over from an earlier one.
const reported = ssh(
  'curl -sS --max-time 8 http://127.0.0.1:' + port + '/version',
  { quiet: true },
);
log('  version: ' + reported);

const parsed = JSON.parse(reported);
if (parsed.version !== version) {
  fail('the running version is ' + parsed.version + ', expected ' + version);
}
if (typeof parsed.sessionSecret !== 'string' || parsed.sessionSecret.length === 0) {
  fail('the server reports no session secret, so it started without one');
}

// ------------------------------------------------ what actually applied --

// The compose file DECLARES bounds. Whether the host applies them is a
// different question, and the answer is silently no on a kernel with no memory
// cgroup controller. Reading the declaration and believing it is exactly the
// "the config said so" trap, so this reports what the container really got.
const inspect = (field) =>
  ssh(
    'docker inspect --format={{.HostConfig.' + field + '}} ' +
      '$(docker ps -q --filter "name=material-workspace-collab" | head -1)',
    { quiet: true },
  );

const applied = {
  memory: Number(inspect('Memory')),
  nanoCpus: Number(inspect('NanoCpus')),
  readOnly: inspect('ReadonlyRootfs') === 'true',
};

log('limits, as actually applied by the host:');
log('  cpu        ' + (applied.nanoCpus > 0 ? applied.nanoCpus / 1e9 + ' cores' : 'NOT ENFORCED'));
log(
  '  memory     ' +
    (applied.memory > 0
      ? (applied.memory / 1024 / 1024).toFixed(0) + ' MB'
      : 'NOT ENFORCED - this kernel has no memory cgroup controller'),
);
log('  read-only  ' + (applied.readOnly ? 'yes' : 'NOT ENFORCED'));

if (applied.memory === 0) {
  // A warning rather than a failure. The stack is still safe to run: it is
  // read-only, drops every capability, and cannot gain privileges. But a
  // compose file that claims a cap nobody applies is a claim, and a claim
  // nobody checks is how somebody later reasons from a bound that is not there.
  log('');
  log('  NOTE: the memory cap in compose.yaml is declared and NOT applied here.');
  log('  Do not reason from it on this host. It will apply on a kernel that has');
  log('  the memory controller; check this line rather than the file.');
}

log('');
log('deployed to ' + facts.host + ' on port ' + port + ', running ' + version);
log('reachable at ws://' + target.split('@')[1] + ':' + port);
