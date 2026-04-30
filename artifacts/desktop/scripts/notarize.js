// Notarization script — called by electron-builder after code signing.
// Only runs when all required env vars are present (i.e., in CI with Apple certs).
// See: https://www.electron.build/configuration/mac#notarization
'use strict';

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId          = process.env.APPLE_ID;
  const appleIdPassword  = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const appleTeamId      = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !appleTeamId) {
    console.log('[notarize] Skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] Notarizing ${appName} (team ${appleTeamId})…`);
  await notarize({
    appBundleId: 'ai.noah.desktop',
    appPath,
    appleId,
    appleIdPassword,
    teamId: appleTeamId,
  });
  console.log('[notarize] Done.');
};
