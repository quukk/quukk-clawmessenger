import packageJson from '../package.json' with { type: 'json' };

export const PACKAGE_NAME = packageJson.name;
export const VERSION = packageJson.version;
export const RUNTIME_VERSION =
  packageJson.optionalDependencies['@quukk/clawmessenger-runtime-win32-x64'];

export type ReleaseChannel = 'beta' | 'stable';

const PRERELEASE_PATTERN = /^\d+\.\d+\.\d+-/;

export function channelForVersion(version: string): ReleaseChannel {
  return PRERELEASE_PATTERN.test(version) ? 'beta' : 'stable';
}

export const CHANNEL: ReleaseChannel = channelForVersion(VERSION);
