import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = new URL('../../../../', import.meta.url);

for (const [file, service, environment] of [['deploy-host-staging.yml', 'niho-experience-host-stg', 'host-staging'], ['deploy-production.yml', 'niho-experience', 'production']]) {
  const source = readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8');
  const blocks = [...source.matchAll(/# EDGE_CANDIDATE_READBACK_BEGIN\n([\s\S]*?)# EDGE_CANDIDATE_READBACK_END/g)];
  it(`${file} uses restricted ingress and the trusted edge for every candidate readback`, () => {
    expect(blocks.length).toBe(file.includes('production') ? 2 : 1);
    expect(source).toContain('--ingress internal-and-cloud-load-balancing');
    expect(source).toContain('--update-tags "candidate=$');
    expect(source).toContain(`url=https://experience-${file.includes('production') ? '' : 'stg-'}candidate.niho.life`);
    expect(source).not.toContain('node scripts/deploy/edge-route.mjs');
  });
  for (const [i, block] of blocks.entries()) {
    const query = block[1].match(/--arg tag "[^\n]+" '([\s\S]*?)' <<< "\$state"/)?.[1];
    const state = () => ({ metadata: { name: service, labels: { app: 'niho-experience', env: environment }, annotations: { 'run.googleapis.com/ingress': 'internal-and-cloud-load-balancing' } }, status: { traffic: [{ revisionName: 'accepted', tag: 'candidate' }, { revisionName: 'accepted', tag: 'cand-abc-123' }, { revisionName: 'previous', percent: 100 }] } });
    const accepts = (value: unknown, tag = 'cand-abc-123') => {
      expect(query).toBeTruthy();
      return spawnSync('jq', ['-e', '--arg', 'service', service, '--arg', 'environment', environment, '--arg', 'revision', 'accepted', '--arg', 'tag', tag, query!], { input: JSON.stringify(value), encoding: 'utf8' }).status === 0;
    };
    describe(`${file} candidate readback ${i + 1}`, () => {
      it('accepts the matching aliases without moving stable traffic', () => { expect(accepts(state())).toBe(true); });
      it('refuses a moved alias, missing immutable tag, or duplicate alias', () => {
        const moved = state(); moved.status.traffic[0].revisionName = 'another';
        expect(accepts(moved)).toBe(false);
        expect(accepts(state(), 'candidate-absent')).toBe(false);
        const duplicate = state(); duplicate.status.traffic.push({ revisionName: 'accepted', tag: 'candidate' });
        expect(accepts(duplicate)).toBe(false);
        expect(accepts(state(), 'candidate')).toBe(false);
      });
      it('refuses public ingress and the wrong service or environment', () => {
        const publicOrigin = state(); publicOrigin.metadata.annotations['run.googleapis.com/ingress'] = 'all';
        expect(accepts(publicOrigin)).toBe(false);
        const wrong = state(); wrong.metadata.name = 'other'; expect(accepts(wrong)).toBe(false);
        const wrongEnv = state(); wrongEnv.metadata.labels.env = 'other'; expect(accepts(wrongEnv)).toBe(false);
      });
    });
  }
}
