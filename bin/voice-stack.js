#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const apiRoot = path.resolve(__dirname, '..');
const deployRoot = path.resolve(apiRoot, '../livekit-deploy');
const runtimeRoot = path.join(apiRoot, '.runtime', 'voice-stack');
const apiPidPath = path.join(runtimeRoot, 'api.pid');
const apiLogPath = path.join(runtimeRoot, 'api.log');

const usage = `voice-stack

Usage:
  node ./bin/voice-stack.js start [api|deploy|all]
  node ./bin/voice-stack.js stop [api|deploy|all]
  node ./bin/voice-stack.js restart [api|deploy|all]
  node ./bin/voice-stack.js status
  node ./bin/voice-stack.js logs [api|deploy|all]

Shortcuts:
  npm run stack -- start
  npm run stack -- stop
  npm run stack -- restart
  npm run stack -- status
  npm run stack -- logs
`;

function ensureRuntimeRoot() {
  fs.mkdirSync(runtimeRoot, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(apiPidPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch (error) {
    return null;
  }
}

function writeApiPid(pid) {
  ensureRuntimeRoot();
  fs.writeFileSync(apiPidPath, `${pid}\n`);
}

function removeApiPid() {
  fs.rmSync(apiPidPath, { force: true });
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function getManagedApiPid() {
  const pid = readApiPid();
  if (!isProcessRunning(pid)) {
    removeApiPid();
    return null;
  }

  return pid;
}

function checkLocalPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const done = (isOpen) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(isOpen);
    };

    socket.setTimeout(750);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    cwd: options.cwd,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const message = options.capture
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : `${command} ${args.join(' ')} exited with status ${result.status}`;
    throw new Error(message || `${command} failed`);
  }

  return result.stdout ?? '';
}

function assertDeployRoot() {
  if (!fs.existsSync(path.join(deployRoot, 'docker-compose.yml'))) {
    throw new Error(`Expected docker-compose.yml at ${deployRoot}`);
  }
}

async function startApi() {
  ensureRuntimeRoot();

  const managedPid = getManagedApiPid();
  if (managedPid) {
    console.log(`API already running (pid ${managedPid})`);
    console.log(`Logs: ${apiLogPath}`);
    return;
  }

  if (!fs.existsSync(path.join(apiRoot, '.env'))) {
    throw new Error(`Missing ${path.join(apiRoot, '.env')}`);
  }

  if (await checkLocalPort(3000)) {
    throw new Error(
      'Port 3000 is already in use. Stop the existing API process first or use the existing process instead.',
    );
  }

  const logFd = fs.openSync(apiLogPath, 'a');
  const child = spawn(process.execPath, ['--env-file=.env', 'src/server.js'], {
    cwd: apiRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  fs.closeSync(logFd);
  child.unref();
  writeApiPid(child.pid);
  await sleep(900);

  const runningPid = getManagedApiPid();
  if (!runningPid) {
    const logTail = readLogTail(apiLogPath);
    throw new Error(`API failed to stay running.\n${logTail}`.trim());
  }

  console.log(`Started API server (pid ${runningPid})`);
  console.log(`Logs: ${apiLogPath}`);
}

async function stopApi() {
  const pid = getManagedApiPid();
  if (!pid) {
    if (await checkLocalPort(3000)) {
      console.log('API port 3000 is in use by an unmanaged process.');
    } else {
      console.log('API server is not running.');
    }
    return;
  }

  process.kill(pid, 'SIGTERM');

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    if (!isProcessRunning(pid)) {
      removeApiPid();
      console.log(`Stopped API server (pid ${pid})`);
      return;
    }
  }

  process.kill(pid, 'SIGKILL');
  await sleep(250);
  removeApiPid();
  console.log(`Force-stopped API server (pid ${pid})`);
}

function startDeploy() {
  assertDeployRoot();
  runOrThrow('docker', ['compose', 'up', '-d'], { cwd: deployRoot });
}

function stopDeploy() {
  assertDeployRoot();
  runOrThrow('docker', ['compose', 'stop'], { cwd: deployRoot });
}

function getDeployStatus() {
  assertDeployRoot();
  const raw = runOrThrow(
    'docker',
    ['compose', 'ps', '--services', '--status', 'running'],
    { cwd: deployRoot, capture: true },
  );

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readLogTail(filePath, lines = 20) {
  if (!fs.existsSync(filePath)) {
    return `No log file found at ${filePath}`;
  }

  const content = fs.readFileSync(filePath, 'utf8').trimEnd();
  if (!content) {
    return `Log file is empty: ${filePath}`;
  }

  return content.split('\n').slice(-lines).join('\n');
}

async function printStatus() {
  const apiPid = getManagedApiPid();
  console.log('API:');
  if (apiPid) {
    console.log(`  running (pid ${apiPid})`);
    console.log(`  logs: ${apiLogPath}`);
  } else if (await checkLocalPort(3000)) {
    console.log('  running on port 3000 (unmanaged by voice-stack)');
  } else {
    console.log('  stopped');
  }

  console.log('Deploy:');
  const runningServices = getDeployStatus();
  if (runningServices.length === 0) {
    console.log('  stopped');
  } else {
    console.log(`  running services: ${runningServices.join(', ')}`);
  }
}

function forwardStream(stream, prefix) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      process.stdout.write(`${prefix}${line}\n`);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      process.stdout.write(`${prefix}${buffer}\n`);
    }
  });
}

function attachSignalCleanup(children) {
  const cleanup = () => {
    for (const child of children) {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

function streamLogs(target) {
  if (target === 'api') {
    if (!fs.existsSync(apiLogPath)) {
      throw new Error(`No API log file found at ${apiLogPath}`);
    }

    const child = spawn('tail', ['-n', '100', '-f', apiLogPath], { stdio: 'inherit' });
    attachSignalCleanup([child]);
    return;
  }

  if (target === 'deploy') {
    assertDeployRoot();
    const child = spawn('docker', ['compose', 'logs', '-f'], {
      cwd: deployRoot,
      stdio: 'inherit',
    });
    attachSignalCleanup([child]);
    return;
  }

  if (!fs.existsSync(apiLogPath)) {
    console.log(`No API log file found at ${apiLogPath}; streaming deploy logs only.`);
    streamLogs('deploy');
    return;
  }

  assertDeployRoot();
  const apiTail = spawn('tail', ['-n', '100', '-f', apiLogPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deployLogs = spawn('docker', ['compose', 'logs', '-f'], {
    cwd: deployRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  forwardStream(apiTail.stdout, '[api] ');
  forwardStream(apiTail.stderr, '[api] ');
  forwardStream(deployLogs.stdout, '[deploy] ');
  forwardStream(deployLogs.stderr, '[deploy] ');

  attachSignalCleanup([apiTail, deployLogs]);
}

async function main() {
  const command = process.argv[2] || 'status';
  const target = process.argv[3] || (command === 'logs' ? 'all' : 'all');

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }

  if (!['api', 'deploy', 'all'].includes(target)) {
    throw new Error(`Unknown target "${target}". Expected api, deploy, or all.`);
  }

  switch (command) {
    case 'start':
      if (target === 'api' || target === 'all') {
        if (target === 'all') {
          startDeploy();
        }
        await startApi();
        return;
      }

      startDeploy();
      return;

    case 'stop':
      if (target === 'api' || target === 'all') {
        await stopApi();
      }
      if (target === 'deploy' || target === 'all') {
        stopDeploy();
      }
      return;

    case 'restart':
      if (target === 'api' || target === 'all') {
        await stopApi();
      }
      if (target === 'deploy' || target === 'all') {
        stopDeploy();
      }
      if (target === 'deploy' || target === 'all') {
        startDeploy();
      }
      if (target === 'api' || target === 'all') {
        await startApi();
      }
      return;

    case 'status':
      await printStatus();
      return;

    case 'logs':
      streamLogs(target);
      return;

    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('\n' + usage);
  process.exit(1);
});
