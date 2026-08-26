import { homedir } from 'node:os';
import { join } from 'node:path';

export type LocalPaths = {
  root: string;
  config: string;
  credentials: string;
  sessions: string;
  state: string;
  logsDir: string;
  bridgeLog: string;
  runDir: string;
  bridgePid: string;
  daemonPid: string;
  rongcloudDir: string;
};

export function localPaths(homeDirectory: string = homedir()): LocalPaths {
  const root = join(homeDirectory, '.quukk-clawmessenger');
  const logsDir = join(root, 'logs');
  const runDir = join(root, 'run');
  return {
    root,
    config: join(root, 'config.json'),
    credentials: join(root, 'credentials.json'),
    sessions: join(root, 'sessions.json'),
    state: join(root, 'state.json'),
    logsDir,
    bridgeLog: join(logsDir, 'bridge.log'),
    runDir,
    bridgePid: join(runDir, 'bridge.pid'),
    daemonPid: join(runDir, 'daemon.pid'),
    rongcloudDir: join(root, 'rongcloud'),
  };
}
