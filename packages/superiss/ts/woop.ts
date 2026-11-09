import { fail, object, required, type Obj } from './util.ts';

export const WOOP_STAGES = ['implementation', 'delivery', 'outcome'] as const;
const topKeys = new Set(['id', 'name', 'owner', 'wish', 'outcome', 'obstacle', 'if', 'then', 'stages', 'actor', 'idem', 'run_id']);
function bounded(a: Obj, key: string, max = 400): string {
  const value = required(a, key);
  if ([...value].length > max) fail('bad_args', `${key} exceeds ${max} characters`);
  return value;
}
function exact(a: Obj, keys: Set<string>): void {
  for (const key of Object.keys(a)) if (!keys.has(key)) fail('bad_args', `unknown WOOP field: ${key}`);
}

/** Pure, bounded compilation into the existing atomic native plan operation. */
export function woopPlan(a: Obj): Obj {
  exact(a, topKeys);
  const id = bounded(a, 'id', 120), name = bounded(a, 'name'), owner = bounded(a, 'owner', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(id)) fail('bad_args', 'WOOP id must contain only ASCII letters, digits and hyphens');
  const intent = Object.fromEntries(['wish', 'outcome', 'obstacle', 'if', 'then'].map(key => [key, bounded(a, key)]));
  const supplied = object(a.stages);
  if (a.stages === null || typeof a.stages !== 'object' || Array.isArray(a.stages) ||
      Object.keys(supplied).length !== 3 || WOOP_STAGES.some(stage => !Object.hasOwn(supplied, stage))) {
    fail('bad_args', 'stages must contain exactly implementation, delivery and outcome');
  }
  const refs = Object.fromEntries(WOOP_STAGES.map((stage, i) => [stage, `${id}.${i + 1}`]));
  const customer = (stage: string): Obj => ({v: 1, source: 'sis_woop', desired_outcome: intent.outcome,
    bottleneck: intent.obstacle, woop: {v: 1, ...intent, goal_id: id, stage, stages: refs}});
  const subs = WOOP_STAGES.map((stage, i) => {
    const spec = object(supplied[stage]);
    exact(spec, new Set(['oracle_cmd', 'allowed_paths', 'acceptance']));
    const oracle = bounded(spec, 'oracle_cmd'), acceptance = bounded(spec, 'acceptance');
    if (!Array.isArray(spec.allowed_paths) || !spec.allowed_paths.length || spec.allowed_paths.length > 32 ||
        spec.allowed_paths.some(path => typeof path !== 'string' || !path.trim() || [...path].length > 400 || path.includes('\0'))) {
      fail('bad_args', `${stage}.allowed_paths requires 1..32 nonempty paths of at most 400 characters`);
    }
    return {title: `${stage}: ${name}`, owner, oracle_cmd: oracle, acceptance,
      allowed_paths: spec.allowed_paths, budget_eur: 0, deps: i ? [i - 1] : [],
      meta: {controller: owner, customer_outcome: customer(stage)}};
  });
  const final = subs[2];
  return {id, name, owner, oracle_cmd: final.oracle_cmd, allowed_paths: final.allowed_paths,
    acceptance: final.acceptance, budget_eur: 0,
    meta: {controller: owner, customer_outcome: customer('goal')}, subs};
}
