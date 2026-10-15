/**
 * The dashboard's Distribution APIs (#1124, part of #1028): read the roles and
 * projects a workspace selects, preview what a new selection would deliver,
 * and save it. Every answer reuses the resolution `pull` uses (namespaces,
 * desired skills and rules) and every save goes through the same helper as
 * `roles set` and `projects set`. Nothing here runs pull, writes the team
 * repo, or returns a file body or an environment value.
 */
import { createHash } from 'node:crypto';
import { loadTeamConfig } from '../config.js';
import { loadRolesManifest, RolesManifestNotFoundError, type RolesManifest, type ResourceNamespaces } from '../roles.js';
import { loadProjectsManifest, type ProjectsManifest } from '../projects.js';
import { buildRolePullContext, describeDeliveryConflict, resolveDesiredRules, resolveDesiredSkills } from '../resources/desired.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { saveScopeSelection } from '../scope-selection.js';
import { log } from '../utils/logger.js';
import type { LocalConfig } from '../types.js';

/** A request the dashboard must answer with a client error, not a 500. */
export class DistributionRequestError extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
    this.name = 'DistributionRequestError';
  }
}

export interface DistributionSelection {
  primaryRole: string | null;
  additionalRoles: string[];
  projects: string[];
}

type ManifestRead<T> = { state: 'ok'; manifest: T } | { state: 'missing' } | { state: 'invalid'; error: string };

/**
 * What an API answer says about a manifest that cannot be read. The parser's
 * own message quotes the file around the error and may name absolute paths,
 * and the read routes answer any origin, so it goes to the debug log only.
 */
function invalidManifest(kind: 'roles' | 'projects', error: unknown): { state: 'invalid'; error: string } {
  log.debug(`dashboard: manifest/${kind}.yaml: ${(error as Error).message}`);
  return { state: 'invalid', error: `manifest/${kind}.yaml cannot be read or parsed. Run \`teamai ${kind} list\` for details.` };
}

/** The same for a resolution that fails (an invalid manifest, a namespace clash). */
const UNRESOLVED = 'Cannot resolve what pull delivers for this workspace. Run `teamai pull` for details.';

/** The namespace types the page shows: the four a role or project names a directory for. */
const NAMESPACE_TYPES = ['skills', 'knowledge', 'agents', 'learnings'] as const;
type NamespaceType = typeof NAMESPACE_TYPES[number];

function selectionOf(config: Pick<LocalConfig, 'primaryRole' | 'additionalRoles' | 'projects'>): DistributionSelection {
  return {
    primaryRole: config.primaryRole ?? null,
    additionalRoles: [...(config.additionalRoles ?? [])],
    projects: [...(config.projects ?? [])],
  };
}

/**
 * Names this workspace's config and its selection. A save must send back the
 * revision it previewed, so a page left open on one workspace, or one whose
 * selection changed since (another tab, `roles set`), cannot write a stale choice.
 */
function revisionOf(config: LocalConfig): string {
  const identity = { scope: config.scope, dataHome: config.dataHome ?? null, projectRoot: config.projectRoot ?? null };
  return createHash('sha256').update(JSON.stringify({ identity, selection: selectionOf(config) })).digest('hex').slice(0, 16);
}

async function readRoles(repoPath: string): Promise<ManifestRead<RolesManifest>> {
  try {
    return { state: 'ok', manifest: await loadRolesManifest(repoPath) };
  } catch (error) {
    if (error instanceof RolesManifestNotFoundError) return { state: 'missing' };
    return invalidManifest('roles', error);
  }
}

async function readProjects(repoPath: string): Promise<ManifestRead<ProjectsManifest>> {
  try {
    const manifest = await loadProjectsManifest(repoPath);
    return manifest ? { state: 'ok', manifest } : { state: 'missing' };
  } catch (error) {
    return invalidManifest('projects', error);
  }
}

function pickNamespaces(resources: Partial<Record<NamespaceType, string[]>>): Record<NamespaceType, string[]> {
  return Object.fromEntries(NAMESPACE_TYPES.map((type) => [type, [...(resources[type] ?? [])]])) as Record<NamespaceType, string[]>;
}

/** What `pull` would deliver to a config (with its children attached), by name. */
interface Effective {
  /** Null when no role or project filters the scope, so every namespace is delivered. */
  namespaces: Record<NamespaceType, string[]> | null;
  skills: string[];
  /** The namespaces the delivered skills sit in. */
  skillNamespaces: string[];
  rules: string[];
  /**
   * Skills a workspace holds back because two members deliver different copies
   * of one name (#913). Pull keeps whatever copy is installed: they neither
   * enter nor leave.
   */
  heldSkills: string[];
  /** Set when two skills of one name would be delivered: pull leaves skills as installed until it is fixed. */
  skillConflict?: string;
}

/**
 * Every namespace an unfiltered scope receives: each one a role or project
 * declares, and each one the delivered skills and rules sit in. Comparing a
 * filtered side against this, not against nothing, is what makes a switch
 * from unfiltered delivery show the namespaces that leave.
 */
function everyNamespace(roles: RolesManifest | null, projects: ProjectsManifest | null, effective: Effective): Record<NamespaceType, string[]> {
  const declared = [...(roles?.roles ?? []).map((role) => role.resources), ...(projects?.projects ?? []).map((project) => project.resources)];
  const seen = (type: NamespaceType, extra: string[]) =>
    [...new Set([...declared.flatMap((resources) => (resources as Partial<Record<NamespaceType, string[]>>)[type] ?? []), ...extra])].sort();
  const prefixes = (names: string[]) => names.flatMap((name) => (name.includes('/') ? [name.split('/')[0]] : []));
  return {
    skills: seen('skills', effective.skillNamespaces),
    knowledge: seen('knowledge', prefixes(effective.rules)),
    agents: seen('agents', []),
    learnings: seen('learnings', []),
  };
}

async function effectiveOf(config: LocalConfig): Promise<Effective> {
  const teamConfig = await loadTeamConfig(config.repo.localPath);
  if (!teamConfig) return { namespaces: null, skills: [], skillNamespaces: [], rules: [], heldSkills: [] };
  const roleContext = await buildRolePullContext(config);
  const skills = await resolveDesiredSkills(teamConfig, config, roleContext);
  const rules = await resolveDesiredRules(teamConfig, config, roleContext);
  return {
    namespaces: roleContext ? pickNamespaces(roleContext.activeNamespaces as ResourceNamespaces) : null,
    skills: skills.kind === 'resolved' ? skills.items.map((item) => item.name).sort() : [],
    skillNamespaces: skills.kind === 'resolved' ? [...new Set(skills.items.flatMap((item) => (item.namespace ? [item.namespace] : [])))].sort() : [],
    rules: rules.items.map((item) => item.name).sort(),
    heldSkills: skills.kind === 'resolved' ? [...skills.held].sort() : [],
    ...(skills.kind === 'conflict' ? { skillConflict: describeDeliveryConflict(skills) } : {}),
  };
}

/** The resolution, or the safe message the API gives when it fails. */
async function tryEffective(config: LocalConfig): Promise<Effective | { error: string }> {
  try {
    return await effectiveOf(config);
  } catch (error) {
    log.debug(`dashboard: distribution resolution failed: ${(error as Error).message}`);
    return { error: UNRESOLVED };
  }
}

/** The read the Distribution page renders for one workspace. */
export async function readDistribution(ownConfig: LocalConfig) {
  const repoPath = ownConfig.repo.localPath;
  const [roles, projects] = await Promise.all([readRoles(repoPath), readProjects(repoPath)]);
  // What pull delivers to a workspace includes its children's selections (#913).
  const withChildren = await readWorkspaceChildren(ownConfig);
  // An invalid manifest fails pull too; say so instead of guessing what it delivers.
  const effective = await tryEffective(withChildren);
  return {
    configured: true as const,
    revision: revisionOf(ownConfig),
    selection: selectionOf(ownConfig),
    // A workspace saves only its own selection; its children's are shown, not edited.
    children: (withChildren.children?.children ?? []).map((child) => ({ path: child.path, ...selectionOf(child.selection) })),
    roles: roles.state === 'ok'
      ? { state: 'ok' as const, items: roles.manifest.roles.map((role) => ({ id: role.id, description: role.description, namespaces: pickNamespaces(role.resources) })) }
      : roles,
    projects: projects.state === 'ok'
      ? {
        state: 'ok' as const,
        items: projects.manifest.projects.map((project) => ({
          id: project.id, name: project.name, description: project.description, namespaces: pickNamespaces(project.resources),
        })),
      }
      : projects,
    effective,
  };
}

// ─── Request validation ─────────────────────────────────

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** An id is one path segment: the manifest names a directory with it. */
function assertSafeId(kind: 'role' | 'project', id: string): void {
  if (id.trim() === '' || /[/\\]/.test(id) || id === '.' || id === '..') {
    throw new DistributionRequestError(400, `Invalid ${kind} id "${id}".`);
  }
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

interface RoleChange { primaryRole: string; additionalRoles: string[] }

function parseRoleChange(body: Record<string, unknown>): RoleChange {
  const { primaryRole, additionalRoles = [] } = body;
  if (typeof primaryRole !== 'string' || !isStringArray(additionalRoles)) {
    throw new DistributionRequestError(400, 'Expected { primaryRole: string, additionalRoles?: string[] }.');
  }
  for (const id of [primaryRole, ...additionalRoles]) assertSafeId('role', id);
  return { primaryRole, additionalRoles: dedupe(additionalRoles).filter((id) => id !== primaryRole) };
}

function parseProjectChange(body: Record<string, unknown>): string[] {
  const { projects } = body;
  if (!isStringArray(projects)) throw new DistributionRequestError(400, 'Expected { projects: string[] }.');
  for (const id of projects) assertSafeId('project', id);
  return dedupe(projects);
}

async function checkRoles(repoPath: string, change: RoleChange): Promise<RolesManifest> {
  const roles = await readRoles(repoPath);
  if (roles.state === 'missing') throw new DistributionRequestError(409, 'This team repo defines no roles (no manifest/roles.yaml).');
  if (roles.state === 'invalid') throw new DistributionRequestError(409, roles.error);
  const known = new Set(roles.manifest.roles.map((role) => role.id));
  for (const id of [change.primaryRole, ...change.additionalRoles]) {
    if (!known.has(id)) throw new DistributionRequestError(400, `Unknown role "${id}".`);
  }
  return roles.manifest;
}

async function checkProjects(repoPath: string, ids: string[]): Promise<void> {
  const projects = await readProjects(repoPath);
  if (projects.state === 'missing') throw new DistributionRequestError(409, 'This team repo defines no projects (no manifest/projects.yaml).');
  if (projects.state === 'invalid') throw new DistributionRequestError(409, projects.error);
  const known = new Set(projects.manifest.projects.map((project) => project.id));
  for (const id of ids) {
    if (!known.has(id)) throw new DistributionRequestError(400, `Unknown project "${id}".`);
  }
}

function assertRevision(ownConfig: LocalConfig, body: Record<string, unknown>): void {
  if (body.revision !== revisionOf(ownConfig)) {
    throw new DistributionRequestError(409, 'The selection changed since it was previewed. Reload and preview again.');
  }
}

// ─── Preview and save ───────────────────────────────────

function diff(before: readonly string[], after: readonly string[]) {
  return { entering: after.filter((item) => !before.includes(item)), leaving: before.filter((item) => !after.includes(item)) };
}

/**
 * What the next pull would add and remove if this workspace selected `body`
 * instead: `primaryRole`/`additionalRoles`, `projects`, or both. Writes nothing.
 */
export async function previewDistribution(ownConfig: LocalConfig, body: Record<string, unknown>) {
  const repoPath = ownConfig.repo.localPath;
  let candidate: LocalConfig = { ...ownConfig };
  if ('primaryRole' in body || 'additionalRoles' in body) {
    const change = parseRoleChange(body);
    await checkRoles(repoPath, change);
    candidate = { ...candidate, ...change };
  }
  if ('projects' in body) {
    const projects = parseProjectChange(body);
    await checkProjects(repoPath, projects);
    candidate = { ...candidate, projects };
  }
  const [before, after] = [await tryEffective(await readWorkspaceChildren(ownConfig)), await tryEffective(await readWorkspaceChildren(candidate))];
  if ('error' in before || 'error' in after) throw new DistributionRequestError(409, UNRESOLVED);
  const manifests = [await readRoles(repoPath), await readProjects(repoPath)] as const;
  const [roles, projects] = manifests.map((read) => (read.state === 'ok' ? read.manifest : null)) as [RolesManifest | null, ProjectsManifest | null];
  // An unfiltered side receives every namespace, not none.
  const namespacesOf = (side: Effective) => side.namespaces ?? everyNamespace(roles, projects, side);
  const [fromNs, toNs] = [namespacesOf(before), namespacesOf(after)];
  // A held skill keeps its installed copy, and a skill conflict leaves every
  // skill as installed: neither is a skill leaving.
  const skills = after.skillConflict
    ? { entering: [], leaving: [] }
    : (({ entering, leaving }) => ({ entering, leaving: leaving.filter((name) => !after.heldSkills.includes(name)) }))(diff(before.skills, after.skills));
  return {
    revision: revisionOf(ownConfig),
    selection: selectionOf(candidate),
    unfiltered: { before: before.namespaces === null, after: after.namespaces === null },
    namespaces: Object.fromEntries(NAMESPACE_TYPES.map((type) => [type, diff(fromNs[type], toNs[type])])),
    skills: { ...skills, held: after.heldSkills },
    rules: diff(before.rules, after.rules),
    ...(after.skillConflict ? { skillConflict: after.skillConflict } : {}),
  };
}

/** Save this workspace's roles, as `roles set` does. Takes effect on the next pull. */
export async function saveRoles(ownConfig: LocalConfig, body: Record<string, unknown>): Promise<void> {
  assertRevision(ownConfig, body);
  const change = parseRoleChange(body);
  const manifest = await checkRoles(ownConfig.repo.localPath, change);
  await saveScopeSelection(ownConfig, { ...ownConfig, ...change, resourceProfileVersion: manifest.version });
}

/** Save this workspace's active projects, as `projects set` does. An empty list is allowed. */
export async function saveProjects(ownConfig: LocalConfig, body: Record<string, unknown>): Promise<void> {
  assertRevision(ownConfig, body);
  const projects = parseProjectChange(body);
  await checkProjects(ownConfig.repo.localPath, projects);
  await saveScopeSelection(ownConfig, { ...ownConfig, projects });
}
