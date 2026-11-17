// Jobs: named tasks of a project in config.json, started on demand or by their "every" schedule, not by a push.
const PARAM_LENGTH = 500;

export function requireJob(project, key) {
  const job = project.jobs?.[key];
  if (!job) {
    const known = Object.keys(project.jobs ?? {});
    throw Object.assign(new Error(`${project.name ?? project.id} has no job "${key}". Jobs: ${known.join(', ') || 'none'}.`), { status: 404 });
  }
  return job;
}

/** The params a start may give: only the ones the job declares, as plain one-line text. */
export function readParams(job, params = {}) {
  if (typeof params !== 'object' || Array.isArray(params) || params === null) throw badRequest('"params" is an object of texts, e.g. {"tests": "T-12,T-40"}.');
  const declared = job.params ?? [];
  const read = {};
  for (const [name, value] of Object.entries(params)) {
    if (!declared.includes(name)) throw badRequest(`The job takes no param "${name}". Params: ${declared.join(', ') || 'none'}.`);
    if (typeof value !== 'string' || value.length > PARAM_LENGTH || /[\n\r\0]/.test(value)) throw badRequest(`The param "${name}" is one line of text, at most ${PARAM_LENGTH} characters.`);
    if (value) read[name] = value;
  }
  return read;
}

/** tests -> CI_PARAM_TESTS: the step reads its params from the environment, never from its command line. */
export function toParamEnv(params = {}) {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [`CI_PARAM_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, value]));
}

export function listJobs(project) {
  return Object.entries(project.jobs ?? {}).map(([key, job]) => ({ key, name: job.name ?? key, params: job.params ?? [], every: job.every ?? null }));
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
