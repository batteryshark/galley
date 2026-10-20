import { execFileSync } from 'node:child_process';

// Read-only Mac process metadata, not process attestation. Unknown is never gone.
export function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid PID');
  try {
    const text = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 500, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } }).trim();
    const birth = Date.parse(text);
    if (!Number.isFinite(birth)) throw new Error('Unknown process birth');
    return birth;
  } catch (e) {
    if (e.status === 1 && !String(e.stdout || '').trim()) return null;
    throw e;
  }
}
export function ownerGone(owner) {
  if (!Number.isSafeInteger(owner?.pid) || !Number.isFinite(owner?.birth)) throw new Error('Unknown old owner');
  const birth = processBirth(owner.pid);
  return birth === null || birth !== owner.birth;
}
