import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const root = new URL('../../../../', import.meta.url);
const { candidateEdgeUrl, EDGE } = await import(new URL('scripts/deploy/edge-route.mjs', root).href);

for (const target of ['stg', 'prod'] as const) {
  const edge = EDGE[target];
  const state = () => ({ metadata: { name: edge.service, labels: { app: 'niho-experience', env: edge.environment }, annotations: { 'run.googleapis.com/ingress': 'internal-and-cloud-load-balancing' } }, status: { traffic: [{ revisionName: 'accepted', tag: 'candidate' }, { revisionName: 'accepted', tag: 'cand-abc-123' }, { revisionName: 'previous', percent: 100 }] } });
  const input = () => ({ target, state: state(), revision: 'accepted', tag: 'cand-abc-123', siteUrl: edge.origin });
  describe(`${target} candidate edge`, () => {
    it('resolves the edge URL without moving stable traffic', () => {
      const value = input();
      expect(candidateEdgeUrl(value)).toBe(edge.candidate);
      expect(value.state.status.traffic.at(-1)?.revisionName).toBe('previous');
    });
    it('refuses a moved alias, missing immutable tag, or duplicate alias', () => {
      const moved = input(); moved.state.status.traffic[0].revisionName = 'another';
      expect(() => candidateEdgeUrl(moved)).toThrow(/alias/);
      expect(() => candidateEdgeUrl({ ...input(), tag: 'candidate-absent' })).toThrow(/alias/);
      const duplicate = input(); duplicate.state.status.traffic.push({ revisionName: 'accepted', tag: 'candidate' });
      expect(() => candidateEdgeUrl(duplicate)).toThrow(/alias/);
    });
    it('refuses public ingress, wrong service identity and arbitrary origins', () => {
      const publicOrigin = input(); publicOrigin.state.metadata.annotations['run.googleapis.com/ingress'] = 'all';
      expect(() => candidateEdgeUrl(publicOrigin)).toThrow(/direct public access/);
      const wrong = input(); wrong.state.metadata.name = 'other';
      expect(() => candidateEdgeUrl(wrong)).toThrow(/service/);
      expect(() => candidateEdgeUrl({ ...input(), siteUrl: 'https://attacker.example' })).toThrow(/origin/);
      expect(() => candidateEdgeUrl({ ...input(), tag: 'candidate' })).toThrow(/immutable/);
    });
  });
}

it('both official workflows deploy with restricted ingress and verify candidates through the edge', () => {
  for (const file of ['deploy-host-staging.yml', 'deploy-production.yml']) {
    const source = readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8');
    expect(source).toContain('--ingress internal-and-cloud-load-balancing');
    expect(source).toContain('--update-tags "candidate=$');
    expect(source).toContain('node scripts/deploy/edge-route.mjs');
  }
});
