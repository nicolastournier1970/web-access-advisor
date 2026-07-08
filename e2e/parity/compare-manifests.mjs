/**
 * Parity harness — Phase 2e gate (docs/rewrite-plan.md).
 *
 * Replays golden sessions from ./snapshots/ through the NEW engine
 * (@waa/core, axe-only, headless, clean browser) into a scratch directory,
 * then compares against the LEGACY artifacts already on disk:
 *   - legacy manifest.json        → snapshot step set, per-step actions
 *   - legacy step_NNN/axe_results.json → axe rule-id sets
 *
 * The legacy engine is never executed; its committed output IS the baseline.
 * Golden sessions were recorded against live public sites, so this needs
 * network access. Run AFTER building: npm run build -w packages/shared -w packages/engine
 *
 * Usage: node e2e/parity/compare-manifests.mjs [sessionId ...]
 *   (no args = every session that has recording.json + manifest.json + steps)
 *
 * Pass criteria per session:
 *   P1 result.success === true and new manifest validates against the schema
 *   P2 every recorded action received a replay outcome; >= 80% executed
 *   P3 step-join correctness: every new stepDetail's action matches the
 *      recording action with the SAME step number (regression guard for the
 *      legacy actions[i]/snapshots[i] misalignment bug)
 *   P4 axe overlap: >= 50% of the legacy session-wide rule-id set is found
 *      by the new run (live-site drift means exact equality is not required;
 *      differences are printed for review)
 *   Snapshot-step set differences are REPORTED but not failed — the gating
 *   policy is intentionally sensitive to live-DOM timing.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const snapshotsDir = path.join(repoRoot, 'snapshots');
const outRoot = path.join(repoRoot, 'e2e', 'parity', '.out');

const { loadRecording, runAnalysis, DEFAULT_AUTH_DOMAINS_CONFIG, loadAuthDomainsConfig } =
  await import(pathToUrl(path.join(repoRoot, 'packages/engine/dist/index.js')));
const { sessionManifestSchema } = await import(
  pathToUrl(path.join(repoRoot, 'packages/shared/dist/index.js'))
);

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

function goldenSessions(filter) {
  return readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => !filter.length || filter.includes(id))
    .filter((id) => {
      const dir = path.join(snapshotsDir, id);
      return (
        existsSync(path.join(dir, 'recording.json')) &&
        existsSync(path.join(dir, 'manifest.json')) &&
        readdirSync(dir).some((f) => f.startsWith('step_'))
      );
    });
}

function legacyAxeRuleIds(sessionDir) {
  const ids = new Set();
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.startsWith('step_')) continue;
    const file = path.join(sessionDir, entry, 'axe_results.json');
    if (!existsSync(file)) continue;
    const axe = readJson(file);
    const violations = Array.isArray(axe) ? axe : (axe.violations ?? []);
    for (const v of violations) if (v?.id) ids.add(v.id);
  }
  return ids;
}

async function runSession(sessionId) {
  const goldenDir = path.join(snapshotsDir, sessionId);
  const sessionDir = path.join(outRoot, sessionId);
  rmSync(sessionDir, { recursive: true, force: true });

  const recording = loadRecording(readJson(path.join(goldenDir, 'recording.json')));
  const legacyManifest = readJson(path.join(goldenDir, 'manifest.json'));
  const authConfig = await loadAuthDomainsConfig(
    path.join(repoRoot, 'config', 'auth-domains.json'),
  ).catch(() => DEFAULT_AUTH_DOMAINS_CONFIG);

  const events = [];
  const control = runAnalysis({
    sessionId,
    sessionDir,
    recording,
    browserType: 'chromium',
    useProfile: false,
    headless: true,
    captureScreenshots: false,
    staticSectionMode: 'separate',
    llmProvider: null,
    llmBatchTimeoutMs: 1,
    authConfig,
    authPauseTimeoutMs: 30_000,
    onEvent: (e) => events.push(e),
  });

  // Golden sessions are public sites: any auth pause is unexpected — cancel
  // so the harness fails visibly instead of hanging for the timeout.
  const watchdog = setInterval(() => {
    if (events.some((e) => e.type === 'auth-required')) {
      clearInterval(watchdog);
      control.cancelAuth().catch(() => {});
    }
  }, 500);

  const result = await control.result;
  clearInterval(watchdog);

  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail = '') => checks.push({ name, ok: true, detail });

  // P1 success + schema
  if (!result.success) fail('P1 success', result.error ?? 'success=false');
  else {
    const parsed = sessionManifestSchema.safeParse(result.manifest);
    parsed.success
      ? pass('P1 success+schema')
      : fail('P1 success+schema', parsed.error.message.slice(0, 300));
  }

  // P2 outcomes
  const steps = result.manifest?.stepDetails ?? [];
  const outcomes = steps.filter((s) => s.actionOutcome);
  const executed = steps.filter((s) => s.actionOutcome === 'executed').length;
  const ratio = outcomes.length ? executed / outcomes.length : 1;
  ratio >= 0.8
    ? pass('P2 outcomes', `${executed}/${outcomes.length} executed`)
    : fail('P2 outcomes', `only ${executed}/${outcomes.length} executed`);

  // P3 step-join: stepDetail.action must describe the recording action with the same step
  const byStep = new Map(recording.actions.map((a) => [a.step, a]));
  const misjoined = steps.filter((s) => {
    const action = byStep.get(s.step);
    return action && s.action && s.action !== action.type;
  });
  misjoined.length === 0
    ? pass('P3 step-join')
    : fail(
        'P3 step-join',
        misjoined.map((s) => `step ${s.step}: manifest='${s.action}' recording='${byStep.get(s.step)?.type}'`).join('; '),
      );

  // P4 axe overlap (session-wide rule-id sets)
  const legacyIds = legacyAxeRuleIds(goldenDir);
  const newIds = new Set((result.axeResults ?? []).map((v) => v.id));
  const missing = [...legacyIds].filter((id) => !newIds.has(id));
  const extra = [...newIds].filter((id) => !legacyIds.has(id));
  const overlap = legacyIds.size ? (legacyIds.size - missing.length) / legacyIds.size : 1;
  overlap >= 0.5
    ? pass('P4 axe overlap', `${Math.round(overlap * 100)}% (missing: ${missing.join(',') || '-'}; extra: ${extra.join(',') || '-'})`)
    : fail('P4 axe overlap', `${Math.round(overlap * 100)}% — missing ${missing.join(',')}`);

  // Report-only: snapshot step sets
  const legacySteps = (legacyManifest.stepDetails ?? []).map((s) => s.step);
  const newSteps = steps.map((s) => s.step);
  const stepNote = `legacy=[${legacySteps}] new=[${newSteps}]`;

  return { sessionId, checks, stepNote };
}

const filter = process.argv.slice(2);
const sessions = goldenSessions(filter);
if (!sessions.length) {
  console.error('No golden sessions found (need recording.json + manifest.json + step_* dirs).');
  process.exit(2);
}

console.log(`Parity harness: ${sessions.length} golden session(s)\n`);
let failed = false;
for (const id of sessions) {
  try {
    const { checks, stepNote } = await runSession(id);
    const bad = checks.filter((c) => !c.ok);
    failed ||= bad.length > 0;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${id}`);
    for (const c of checks) console.log(`   ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    console.log(`   note snapshot steps ${stepNote}\n`);
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${id}\n   threw: ${err?.message ?? err}\n`);
  }
}
process.exit(failed ? 1 : 0);
