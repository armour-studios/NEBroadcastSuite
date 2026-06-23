'use strict';
/**
 * electron-builder custom sign hook — Microsoft Trusted Signing via Azure dlib.
 * Only runs when AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are set.
 * Falls back silently in dev so local builds still work unsigned.
 */
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function sign(config) {
  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    console.log('[sign] Azure credentials not set — skipping code signing.');
    return;
  }

  const signingDir  = path.join(__dirname, 'signing');
  const signtool    = path.join(signingDir, 'signtool.exe');
  const dlib        = path.join(signingDir, 'Azure.CodeSigning.Dlib.dll');
  const metadataFile = path.join(signingDir, 'metadata.json');

  const filePath = config.path;
  console.log('[sign] Signing:', filePath);

  execFileSync(signtool, [
    'sign',
    '/v',
    '/debug',
    '/fd', 'SHA256',
    '/tr', 'http://timestamp.acs.microsoft.com',
    '/td', 'SHA256',
    '/dlib', dlib,
    '/dmdf', metadataFile,
    filePath
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AZURE_TENANT_ID,
      AZURE_CLIENT_ID,
      AZURE_CLIENT_SECRET
    }
  });

  console.log('[sign] Signed successfully:', path.basename(filePath));
};
