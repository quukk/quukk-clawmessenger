export { PACKAGE_NAME, VERSION } from './version.js';
export {
  discoverLegacyConfigs,
  legacyConfigPaths,
  type LegacyConfigCandidate,
  type LegacyConfigDiscovery,
  type LegacyImportSettings,
} from './migration/discover.js';
export { importLegacyConfig, LegacyMigrationError } from './migration/import.js';
