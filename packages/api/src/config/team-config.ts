import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { CatBreed, CatCafeConfig, CatVariant, ReviewPolicy, RosterEntry } from '@cat-cafe/shared';
import { z } from 'zod';

export const DEFAULT_TEAM_ID = 'default';

const TEAM_ID_RE = /^[a-z][a-z0-9_-]*$/;

const clientIdSchema = z.enum(['anthropic', 'openai', 'google', 'kimi', 'dare', 'antigravity', 'opencode', 'a2a']);

const cliConfigSchema = z.object({
  command: z.string().min(1),
  outputFormat: z.string().min(1),
  defaultArgs: z.array(z.string()).optional(),
  effort: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).optional(),
});

const contextBudgetSchema = z.object({
  maxPromptTokens: z.number().positive().int(),
  maxContextTokens: z.number().positive().int(),
  maxMessages: z.number().positive().int(),
  maxContentLengthPerMsg: z.number().positive().int(),
});

const modelConfigSchema = z.object({
  clientId: clientIdSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  accountRef: z.string().min(1).nullable().optional(),
  mcpSupport: z.boolean().optional(),
  cli: cliConfigSchema.optional(),
  commandArgs: z.array(z.string().min(1)).optional(),
  cliConfigArgs: z.array(z.string().min(1)).optional(),
  contextBudget: contextBudgetSchema.optional(),
  provider: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.includes('/'), 'provider must be a bare provider id')
    .nullable()
    .optional(),
});

const rosterPatchSchema = z.object({
  family: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).optional(),
  lead: z.boolean().optional(),
  available: z.boolean().optional(),
  evaluation: z.string().min(1).optional(),
});

const rolePatchSchema = z
  .object({
    roleDescription: z.string().min(1).optional(),
    personality: z.string().min(1).optional(),
    teamStrengths: z.string().min(1).optional(),
    strengths: z.array(z.string().min(1)).optional(),
    caution: z.string().nullable().optional(),
    workflowPromptPath: z.string().min(1).optional(),
    governancePromptPath: z.string().min(1).optional(),
    collaborationGroup: z.string().min(1).optional(),
    modelConfig: modelConfigSchema.optional(),
    roster: rosterPatchSchema.optional(),
  })
  .merge(modelConfigSchema)
  .merge(rosterPatchSchema);

const teamProfileSchema = z.object({
  id: z.string().regex(TEAM_ID_RE).optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  members: z.array(z.string().min(1)).optional(),
  defaultCatId: z.string().min(1).optional(),
  roleDir: z.string().min(1).optional(),
  workflowDir: z.string().min(1).optional(),
  governancePromptPath: z.string().min(1).optional(),
  reviewPolicy: z
    .object({
      requireDifferentFamily: z.boolean().optional(),
      preferActiveInThread: z.boolean().optional(),
      preferLead: z.boolean().optional(),
      excludeUnavailable: z.boolean().optional(),
    })
    .optional(),
  roleDescriptions: z.record(z.string(), rolePatchSchema).optional(),
  roles: z.record(z.string(), rolePatchSchema).optional(),
  teamRoles: z.record(z.string(), rolePatchSchema).optional(),
  roster: z.record(z.string(), rosterPatchSchema).optional(),
});

export interface TeamProfileSummary {
  id: string;
  displayName: string;
  description?: string;
  memberCount?: number;
  path?: string;
  active: boolean;
}

type TeamProfile = z.infer<typeof teamProfileSchema>;
type RolePatch = z.infer<typeof rolePatchSchema>;
type RosterPatch = z.infer<typeof rosterPatchSchema>;
type ModelConfigPatch = z.infer<typeof modelConfigSchema>;
type MutableRecord = Record<string, any>;

interface LoadedTeamProfile {
  profile: TeamProfile;
  dir: string;
  teamId: string;
}

let activeTeamId = process.env.CAT_CAFE_TEAM_ID?.trim() || DEFAULT_TEAM_ID;
if (activeTeamId !== DEFAULT_TEAM_ID && !TEAM_ID_RE.test(activeTeamId)) {
  activeTeamId = DEFAULT_TEAM_ID;
}

function safeTeamDir(projectRoot: string, teamId: string): string {
  if (teamId === DEFAULT_TEAM_ID || !TEAM_ID_RE.test(teamId)) {
    throw new Error(`Invalid team id: ${teamId}`);
  }
  const root = resolve(projectRoot);
  const dir = resolve(root, 'config', teamId);
  const rel = relative(root, dir);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Team path escapes project root: ${dir}`);
  }
  return dir;
}

function parseTeamProfile(profilePath: string, teamId: string): LoadedTeamProfile {
  const parsed = teamProfileSchema.safeParse(JSON.parse(readFileSync(profilePath, 'utf-8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid team profile at ${profilePath}:\n${issues.join('\n')}`);
  }
  if (parsed.data.id && parsed.data.id !== teamId) {
    throw new Error(`Team profile id "${parsed.data.id}" does not match directory "${teamId}"`);
  }
  return { profile: parsed.data, dir: resolve(profilePath, '..'), teamId };
}

function readRolePatchFile(path: string): RolePatch {
  const parsed = rolePatchSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid team role file at ${path}:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

function readTeamProfile(projectRoot: string, teamId: string): LoadedTeamProfile | null {
  if (teamId === DEFAULT_TEAM_ID) return null;
  const dir = safeTeamDir(projectRoot, teamId);
  const profilePath = join(dir, 'team.json');
  if (!existsSync(profilePath)) return null;
  return parseTeamProfile(profilePath, teamId);
}

function readTeamProfilePath(projectRoot: string, profilePath: string): LoadedTeamProfile {
  const root = resolve(projectRoot);
  const resolvedPath = resolve(root, profilePath);
  const rel = relative(root, resolvedPath);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Team profile path escapes project root: ${profilePath}`);
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Team profile not found: ${profilePath}`);
  }
  return parseTeamProfile(resolvedPath, basename(resolve(resolvedPath, '..')));
}

function toProjectRelativePromptPath(projectRoot: string, teamDir: string, promptPath: string): string {
  const resolved = resolve(teamDir, promptPath);
  const relToTeam = relative(teamDir, resolved);
  if (relToTeam.startsWith(`..${sep}`) || relToTeam === '..') {
    throw new Error(`Team prompt path escapes team directory: ${promptPath}`);
  }
  return relative(projectRoot, resolved).split(sep).join('/');
}

function getVariantCatId(breed: CatBreed, variant: CatVariant): string {
  return variant.catId ?? (breed.catId as string);
}

function collectRolePatches(profile: TeamProfile): Record<string, RolePatch> {
  return {
    ...(profile.roleDescriptions ?? {}),
    ...(profile.roles ?? {}),
    ...(profile.teamRoles ?? {}),
  };
}

function resolveTeamLocalPath(teamDir: string, path: string): string {
  const resolved = resolve(teamDir, path);
  const rel = relative(teamDir, resolved);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Team local path escapes team directory: ${path}`);
  }
  return resolved;
}

function collectRolePatchesFromFiles(profile: TeamProfile, teamDir: string): Record<string, RolePatch> {
  const roleDir = resolveTeamLocalPath(teamDir, profile.roleDir ?? 'roles');
  if (!existsSync(roleDir)) return {};

  const rolePatches: Record<string, RolePatch> = {};
  const roleIds = new Set(profile.members ?? []);
  for (const entry of readdirSync(roleDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      roleIds.add(entry.name.slice(0, -'.json'.length));
    }
  }

  for (const catId of roleIds) {
    const rolePath = join(roleDir, `${catId}.json`);
    if (!existsSync(rolePath)) continue;
    rolePatches[catId] = readRolePatchFile(rolePath);
  }
  return rolePatches;
}

function applyTeamPromptDefaults(rolePatches: Record<string, RolePatch>, profile: TeamProfile, teamDir: string): void {
  for (const [catId, patch] of Object.entries(rolePatches)) {
    if (!patch.governancePromptPath && profile.governancePromptPath) {
      patch.governancePromptPath = profile.governancePromptPath;
    }
    if (!patch.workflowPromptPath && profile.workflowDir) {
      const workflowPath = `${profile.workflowDir.replace(/\/+$/, '')}/${catId}.md`;
      if (existsSync(resolveTeamLocalPath(teamDir, workflowPath))) {
        patch.workflowPromptPath = workflowPath;
      }
    }
  }
}

function collectAllRolePatches(profile: TeamProfile, teamDir: string): Record<string, RolePatch> {
  const rolePatches = {
    ...collectRolePatchesFromFiles(profile, teamDir),
    ...collectRolePatches(profile),
  };
  applyTeamPromptDefaults(rolePatches, profile, teamDir);
  return rolePatches;
}

function patchRosterEntry(
  base: RosterEntry | undefined,
  patch: (RosterPatch & { roleDescription?: string }) | undefined,
  fallbackFamily: string,
): RosterEntry {
  return {
    family: patch?.family ?? base?.family ?? fallbackFamily,
    roles: patch?.roles ?? base?.roles ?? ['assistant'],
    lead: patch?.lead ?? base?.lead ?? false,
    available: patch?.available ?? base?.available ?? true,
    evaluation: patch?.evaluation ?? patch?.roleDescription ?? base?.evaluation ?? 'Team member',
  };
}

function applyRolePatch(
  projectRoot: string,
  teamDir: string,
  teamId: string,
  target: Record<string, unknown>,
  patch: RolePatch | undefined,
): void {
  if (!patch) {
    target.collaborationGroup = teamId;
    return;
  }
  if (patch.roleDescription) target.roleDescription = patch.roleDescription;
  if (patch.personality) {
    target.personality = patch.personality;
  } else if (patch.roleDescription || patch.strengths) {
    delete target.personality;
  }
  if (patch.teamStrengths) target.teamStrengths = patch.teamStrengths;
  if (patch.strengths) {
    target.strengths = patch.strengths;
    if (!patch.teamStrengths) delete target.teamStrengths;
  }
  if (patch.caution !== undefined) target.caution = patch.caution;
  applyModelConfigPatch(target, patch);
  if (patch.modelConfig) applyModelConfigPatch(target, patch.modelConfig);
  if (patch.workflowPromptPath) {
    target.workflowPromptPath = toProjectRelativePromptPath(projectRoot, teamDir, patch.workflowPromptPath);
    delete target.workflowPrompt;
  }
  if (patch.governancePromptPath) {
    target.governancePromptPath = toProjectRelativePromptPath(projectRoot, teamDir, patch.governancePromptPath);
    delete target.governancePrompt;
  }
  target.collaborationGroup = patch.collaborationGroup ?? teamId;
}

function applyModelConfigPatch(target: Record<string, unknown>, patch: ModelConfigPatch): void {
  if (patch.clientId) target.clientId = patch.clientId;
  if (patch.defaultModel) target.defaultModel = patch.defaultModel;
  if (patch.accountRef !== undefined) {
    if (patch.accountRef === null) delete target.accountRef;
    else target.accountRef = patch.accountRef;
  }
  if (patch.mcpSupport !== undefined) target.mcpSupport = patch.mcpSupport;
  if (patch.cli) target.cli = patch.cli;
  if (patch.commandArgs) {
    if (patch.commandArgs.length > 0) target.commandArgs = patch.commandArgs;
    else delete target.commandArgs;
  }
  if (patch.cliConfigArgs) {
    if (patch.cliConfigArgs.length > 0) target.cliConfigArgs = patch.cliConfigArgs;
    else delete target.cliConfigArgs;
  }
  if (patch.contextBudget) target.contextBudget = patch.contextBudget;
  if (patch.provider !== undefined) {
    if (patch.provider === null) delete target.provider;
    else target.provider = patch.provider;
  }
}

export function getActiveTeamId(): string {
  return activeTeamId;
}

export function setActiveTeamId(projectRoot: string, teamId: string): void {
  if (teamId === DEFAULT_TEAM_ID) {
    activeTeamId = DEFAULT_TEAM_ID;
    return;
  }
  const profile = readTeamProfile(projectRoot, teamId);
  if (!profile) throw new Error(`Team "${teamId}" not found under config/${teamId}/team.json`);
  activeTeamId = teamId;
}

export function listTeamProfiles(projectRoot: string): TeamProfileSummary[] {
  const configDir = resolve(projectRoot, 'config');
  const profiles: TeamProfileSummary[] = [
    {
      id: DEFAULT_TEAM_ID,
      displayName: '通用团队',
      description: '使用 cat-template 和运行时 catalog 的完整成员配置',
      active: activeTeamId === DEFAULT_TEAM_ID,
    },
  ];
  if (!existsSync(configDir)) return profiles;

  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !TEAM_ID_RE.test(entry.name)) continue;
    const dir = join(configDir, entry.name);
    const profilePath = join(dir, 'team.json');
    if (!existsSync(profilePath)) continue;
    const parsed = teamProfileSchema.safeParse(JSON.parse(readFileSync(profilePath, 'utf-8')));
    if (!parsed.success) continue;
    profiles.push({
      id: entry.name,
      displayName: parsed.data.displayName ?? entry.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      memberCount: parsed.data.members?.length,
      path: `config/${entry.name}`,
      active: activeTeamId === entry.name,
    });
  }
  return profiles;
}

export function applyTeamProfile(config: CatCafeConfig, projectRoot: string, teamId = activeTeamId): CatCafeConfig {
  if (teamId === DEFAULT_TEAM_ID) return config;
  const loaded = readTeamProfile(projectRoot, teamId);
  if (!loaded) return config;

  return applyLoadedTeamProfile(config, projectRoot, loaded, { filterMembers: true, patchOnlyMembers: false });
}

function shouldPatchMember(catId: string, patchMembers: ReadonlySet<string> | null): boolean {
  return !patchMembers || patchMembers.has(catId);
}

function applyLoadedTeamProfile(
  config: CatCafeConfig,
  projectRoot: string,
  loaded: LoadedTeamProfile,
  options: { filterMembers: boolean; patchOnlyMembers: boolean },
): CatCafeConfig {
  const { profile, dir, teamId } = loaded;
  const memberFilter = profile.members ? new Set(profile.members) : null;
  const rolePatches = collectAllRolePatches(profile, dir);
  const patchMembers = options.patchOnlyMembers
    ? new Set([...(profile.members ?? []), ...Object.keys(rolePatches), ...Object.keys(profile.roster ?? {})])
    : null;
  const next = structuredClone(config) as MutableRecord & CatCafeConfig;
  const nextRecord = next as MutableRecord;

  nextRecord.breeds = [...next.breeds]
    .map((breed) => {
      const breedCatId = breed.catId as string;
      const breedPatch = shouldPatchMember(breedCatId, patchMembers) ? rolePatches[breedCatId] : undefined;
      const nextBreed = structuredClone(breed) as MutableRecord & CatBreed;
      const nextBreedRecord = nextBreed as MutableRecord;
      if (!options.patchOnlyMembers || breedPatch || shouldPatchMember(breedCatId, patchMembers)) {
        applyRolePatch(projectRoot, dir, teamId, nextBreed, breedPatch);
      }
      const variants = breed.variants
        .filter((variant) => !options.filterMembers || !memberFilter || memberFilter.has(getVariantCatId(breed, variant)))
        .map((variant) => {
          const catId = getVariantCatId(breed, variant);
          const nextVariant = structuredClone(variant) as MutableRecord & CatVariant;
          const variantPatch = shouldPatchMember(catId, patchMembers) ? rolePatches[catId] : undefined;
          if (!options.patchOnlyMembers || variantPatch || shouldPatchMember(catId, patchMembers)) {
            applyRolePatch(projectRoot, dir, teamId, nextVariant, variantPatch);
          }
          return nextVariant;
        });
      if (variants.length === 0) return null;
      nextBreedRecord.variants = variants;
      if (!variants.some((variant) => variant.id === nextBreed.defaultVariantId)) {
        nextBreedRecord.defaultVariantId = variants[0]!.id;
      }
      nextBreedRecord.catId = getVariantCatId(nextBreed, variants[0]!) as CatBreed['catId'];
      return nextBreed;
    })
    .filter((breed): breed is MutableRecord & CatBreed => breed !== null);

  if (next.version === 2) {
    const nextRoster: Record<string, RosterEntry> = options.filterMembers ? {} : { ...next.roster };
    for (const breed of next.breeds) {
      for (const variant of breed.variants) {
        const catId = getVariantCatId(breed, variant);
        if (options.patchOnlyMembers && !shouldPatchMember(catId, patchMembers)) continue;
        const patch = rolePatches[catId]?.roster ?? profile.roster?.[catId] ?? rolePatches[catId];
        if (!patch && options.patchOnlyMembers) continue;
        nextRoster[catId] = patchRosterEntry(next.roster[catId], patch, breed.id);
      }
    }
    nextRecord.roster = nextRoster;
    if (profile.reviewPolicy) {
      nextRecord.reviewPolicy = { ...next.reviewPolicy, ...profile.reviewPolicy } as ReviewPolicy;
    }
  }

  return next;
}

export function applyReferencedTeamProfiles(config: CatCafeConfig, projectRoot: string): CatCafeConfig {
  const profilePaths = new Set<string>();
  for (const breed of config.breeds) {
    const breedPath = (breed as CatBreed & { teamConfigPath?: string }).teamConfigPath;
    if (breedPath) profilePaths.add(breedPath);
    for (const variant of breed.variants) {
      const variantPath = (variant as CatVariant & { teamConfigPath?: string }).teamConfigPath;
      if (variantPath) profilePaths.add(variantPath);
    }
  }

  let next = config;
  for (const profilePath of profilePaths) {
    next = applyLoadedTeamProfile(next, projectRoot, readTeamProfilePath(projectRoot, profilePath), {
      filterMembers: false,
      patchOnlyMembers: true,
    });
  }
  return next;
}

export function getTeamConfigExample(teamId = 'code'): string {
  return JSON.stringify(
    {
      id: teamId,
      displayName: '写代码团队',
      description: '代码开发、审查和安全分析团队',
      members: ['opus', 'codex'],
      roleDir: 'roles',
      workflowDir: 'workflow',
      governancePromptPath: 'governance.md',
      reviewPolicy: {
        requireDifferentFamily: true,
        preferActiveInThread: true,
        preferLead: true,
        excludeUnavailable: true,
      },
    },
    null,
    2,
  );
}

export function isTeamConfigFileName(path: string): boolean {
  return basename(path) === 'team.json';
}
