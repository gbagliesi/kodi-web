// App version. BUILD is filled in by the GitHub Pages workflow (commit + date).
export const VERSION = '0.13.1';
export const BUILD = '__BUILD__';
export const versionLabel = () => 'v' + VERSION + (BUILD.startsWith('__') ? ' (sviluppo)' : ' · ' + BUILD);
