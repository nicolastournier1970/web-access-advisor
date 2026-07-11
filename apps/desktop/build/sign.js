/**
 * Custom electron-builder Windows signing hook.
 *
 * CA/B-Forum rules (June 2023) forbid downloadable PFX keys for new public
 * OV/EV certificates, so production signing must shell out to a cloud-HSM /
 * Trusted-Signing tool rather than hand electron-builder a .pfx. This hook does
 * exactly that WHEN credentials are present, and no-ops otherwise — so Phases
 * 1–6 produce a runnable (unsigned) installer without any certificate.
 *
 * Phase 7 (needs a cert): set these in CI secrets, never commit them:
 *   WAA_SIGN_TOOL  — the signing executable, e.g. "AzureSignTool" or "signtool"
 *   WAA_SIGN_ARGS  — its arguments up to (but not including) the file path, e.g.
 *                    Azure Trusted Signing:
 *                      "sign -kvu <vault> -kvi <id> -kvs <secret> -kvc <cert> -tr http://timestamp.digicert.com -td sha256"
 *                    signtool with a KeyLocker/eSigner dlib:
 *                      "sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /dlib <dll> /kc <keyname>"
 * The file to sign is appended as the final argument.
 */
exports.default = async function sign(configuration) {
  const filePath = configuration.path;
  const tool = process.env.WAA_SIGN_TOOL;

  if (!tool) {
    // Unsigned build: emit a clear marker so it's obvious in logs why an
    // installer won't self-update / will trip SmartScreen.
    console.log(`[sign] WAA_SIGN_TOOL not set — leaving ${filePath} UNSIGNED (dev/internal build).`);
    return;
  }

  const { execFileSync } = require('node:child_process');
  const args = (process.env.WAA_SIGN_ARGS || '').split(' ').filter(Boolean);
  console.log(`[sign] signing ${filePath} with ${tool}…`);
  execFileSync(tool, [...args, filePath], { stdio: 'inherit' });
};
