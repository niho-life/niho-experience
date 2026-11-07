import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const source = readFileSync(new URL('../../../../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
const gates = [...source.matchAll(/# BOOKING_GATE_BEGIN[^\n]*\n([\s\S]*?)# BOOKING_GATE_END/g)];
it('both production jobs default closed and compare the revision against the current booking switch', () => {
  expect(gates).toHaveLength(2);
  expect(source.match(/BOOKINGS: \$\{\{ vars.PROD_BOOKINGS_ENABLED \|\| 'false' }}/g)).toHaveLength(2);
  expect(source.match(/select\(\.name == "BOOKINGS_ENABLED"\) \| \.value' <<< "\$revision_json"\)" = "\$BOOKINGS"/g)).toHaveLength(2);
});
for (const [index, gate] of gates.entries()) {
  it(`job ${index + 1} refuses a malformed switch and sales without guest booking or host console`, () => {
    const run = (bookings: string, guest: boolean, host: boolean) => spawnSync('bash', ['-eu', '-c', gate[1]], { env: { ...process.env, BOOKINGS: bookings, HOST_CALENDAR_ENABLED: String(host), DEPLOY_VARS: JSON.stringify({ PROD_GUEST_BOOKING_ENABLED: String(guest) }) }, encoding: 'utf8' }).status;
    expect(run('false', false, false)).toBe(0);
    expect(run('true', true, true)).toBe(0);
    expect(run('true', false, true)).not.toBe(0);
    expect(run('true', true, false)).not.toBe(0);
    for (const invalid of ['', 'TRUE', 'yes', 'true,false', '$(true)']) expect(run(invalid, true, true)).not.toBe(0);
  });
}
