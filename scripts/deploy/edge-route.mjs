#!/usr/bin/env node
// The candidate alias is served through the same authenticated Cloudflare/ALB edge as the stable site.
// A changing alias is safe only when both it and the immutable run tag identify the reviewed revision.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EDGE = Object.freeze({
  stg: { service: 'niho-experience-host-stg', origin: 'https://experience-stg.niho.life', candidate: 'https://experience-stg-candidate.niho.life', environment: 'host-staging' },
  prod: { service: 'niho-experience', origin: 'https://experience.niho.life', candidate: 'https://experience-candidate.niho.life', environment: 'production' },
});

export function candidateEdgeUrl({ target, state, revision, tag, siteUrl }) {
  const edge = EDGE[target];
  if (!edge || siteUrl !== edge.origin) throw new Error('Unexpected experience edge origin');
  if (state?.metadata?.name !== edge.service || state.metadata.labels?.app !== 'niho-experience' || state.metadata.labels?.env !== edge.environment) throw new Error('Unexpected experience service');
  if (state.metadata.annotations?.['run.googleapis.com/ingress'] !== 'internal-and-cloud-load-balancing') throw new Error('Cloud Run origin must reject direct public access');
  if (!revision || !/^(cand-|candidate-)[a-z0-9-]+$/.test(tag ?? '')) throw new Error('Expected immutable candidate tag');
  for (const name of [tag, 'candidate']) {
    const matches = (state.status?.traffic ?? []).filter((item) => item.tag === name);
    if (matches.length !== 1 || matches[0].revisionName !== revision) throw new Error('Edge candidate alias does not identify the reviewed revision');
  }
  return edge.candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(candidateEdgeUrl({ target: process.env.EDGE_TARGET, state: JSON.parse(readFileSync(0, 'utf8')), revision: process.env.EDGE_REVISION, tag: process.env.EDGE_TAG, siteUrl: process.env.SITE_URL }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
