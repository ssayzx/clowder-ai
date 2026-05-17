import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type {
  CatBreed,
  CatCafeConfig,
  CatColor,
  CatVariant,
  CliConfig,
  ClientId,
  ContextBudget,
  ReviewPolicy,
  RosterEntry,
} from '@cat-cafe/shared';
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

const acpConfigSchema = z.object({
  command: z.string().min(1),
  startupArgs: z.array(z.string().min(1)),
  mcpWhitelist: z.array(z.string().min(1)).optional(),
  supportsMultiplexing: z.boolean().optional(),
  pool: z
    .object({
      maxLiveProcesses: z.number().positive().int().optional(),
      idleTtlMs: z.number().positive().int().optional(),
    })
    .optional(),
});

const contextBudgetSchema = z.object({
  maxPromptTokens: z.number().positive().int(),
  maxContextTokens: z.number().positive().int(),
  maxMessages: z.number().positive().int(),
  maxContentLengthPerMsg: z.number().positive().int(),
});

const colorSchema = z.object({
  primary: z.string().min(1),
  secondary: z.string().min(1),
});

const modelConfigSchema = z.object({
  clientId: clientIdSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  accountRef: z.string().min(1).nullable().optional(),
  mcpSupport: z.boolean().optional(),
  cli: cliConfigSchema.optional(),
  acp: acpConfigSchema.optional(),
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
    name: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    nickname: z.string().min(1).optional(),
    avatar: z.string().min(1).optional(),
    color: colorSchema.optional(),
    mentionPatterns: z.array(z.string().min(2).regex(/^@/, 'mentionPattern must start with @')).optional(),
    defaultVariantId: z.string().min(1).optional(),
    roleDescription: z.string().min(1).optional(),
    personality: z.string().min(1).optional(),
    teamStrengths: z.string().min(1).optional(),
    strengths: z.array(z.string().min(1)).optional(),
    caution: z.string().nullable().optional(),
    sessionChain: z.boolean().optional(),
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
export type TeamAcpConfig = z.infer<typeof acpConfigSchema>;

export interface TeamCatInput {
  catId: string;
  name: string;
  displayName: string;
  nickname?: string;
  avatar: string;
  color: CatColor;
  mentionPatterns: string[];
  accountRef?: string;
  contextBudget?: ContextBudget;
  roleDescription: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string | null;
  strengths?: string[];
  sessionChain?: boolean;
  clientId: ClientId;
  defaultModel: string;
  mcpSupport: boolean;
  cli: CliConfig;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  provider?: string;
}

export interface TeamCatUpdate {
  name?: string;
  displayName?: string;
  nickname?: string;
  avatar?: string;
  color?: CatColor;
  mentionPatterns?: string[];
  accountRef?: string | null;
  contextBudget?: ContextBudget | null;
  roleDescription?: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string | null;
  strengths?: string[];
  sessionChain?: boolean;
  available?: boolean;
  clientId?: ClientId;
  defaultModel?: string;
  mcpSupport?: boolean;
  cli?: CliConfig;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  provider?: string | null;
}

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

function writeJsonAtomic(path: string, value: unknown): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, path);
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
  if (patch.name) target.name = patch.name;
  if (patch.displayName) target.displayName = patch.displayName;
  if (patch.nickname !== undefined) {
    if (patch.nickname.trim().length > 0) target.nickname = patch.nickname.trim();
    else delete target.nickname;
  }
  if (patch.avatar) target.avatar = patch.avatar;
  if (patch.color) target.color = patch.color;
  if (patch.mentionPatterns) target.mentionPatterns = patch.mentionPatterns;
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
  if (patch.sessionChain !== undefined) {
    if (Array.isArray((target as { variants?: unknown }).variants)) {
      target.features = { ...((target.features as Record<string, unknown> | undefined) ?? {}), sessionChain: patch.sessionChain };
    } else {
      target.sessionChain = patch.sessionChain;
    }
  }
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
  if (patch.acp) target.acp = patch.acp;
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

function getEffectiveModelConfig(patch: RolePatch): ModelConfigPatch {
  return {
    ...(patch.clientId ? { clientId: patch.clientId } : {}),
    ...(patch.defaultModel ? { defaultModel: patch.defaultModel } : {}),
    ...(patch.accountRef !== undefined ? { accountRef: patch.accountRef } : {}),
    ...(patch.mcpSupport !== undefined ? { mcpSupport: patch.mcpSupport } : {}),
    ...(patch.cli ? { cli: patch.cli } : {}),
    ...(patch.acp ? { acp: patch.acp } : {}),
    ...(patch.commandArgs ? { commandArgs: patch.commandArgs } : {}),
    ...(patch.cliConfigArgs ? { cliConfigArgs: patch.cliConfigArgs } : {}),
    ...(patch.contextBudget ? { contextBudget: patch.contextBudget } : {}),
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.modelConfig ?? {}),
  };
}

function requireStandaloneModelConfig(catId: string, patch: RolePatch): Required<Pick<ModelConfigPatch, 'clientId' | 'defaultModel' | 'cli'>> &
  ModelConfigPatch {
  const model = getEffectiveModelConfig(patch);
  if (!model.clientId || !model.defaultModel || !model.cli) {
    throw new Error(
      `Team member "${catId}" is not present in base catalog and must define modelConfig.clientId, modelConfig.defaultModel, and modelConfig.cli`,
    );
  }
  return model as Required<Pick<ModelConfigPatch, 'clientId' | 'defaultModel' | 'cli'>> & ModelConfigPatch;
}

function createStandaloneBreed(
  projectRoot: string,
  teamDir: string,
  teamId: string,
  catId: string,
  patch: RolePatch | undefined,
): MutableRecord & CatBreed {
  if (!patch) {
    throw new Error(`Team member "${catId}" is not present in base catalog and has no role config`);
  }
  const model = requireStandaloneModelConfig(catId, patch);
  const displayName = patch.displayName ?? patch.name ?? catId;
  const defaultVariantId = patch.defaultVariantId ?? `${catId}-default`;
  const breed = {
    id: patch.family ?? catId,
    catId: catId as CatBreed['catId'],
    name: patch.name ?? displayName,
    displayName,
    ...(patch.nickname ? { nickname: patch.nickname } : {}),
    avatar: patch.avatar ?? '/avatars/default-cat.png',
    color: patch.color ?? { primary: '#4A5568', secondary: '#E2E8F0' },
    mentionPatterns: patch.mentionPatterns ?? [`@${displayName}`, `@${catId}`],
    roleDescription: patch.roleDescription ?? 'Team member',
    defaultVariantId,
    variants: [
      {
        id: defaultVariantId,
        catId,
        clientId: model.clientId,
        defaultModel: model.defaultModel,
        mcpSupport: model.mcpSupport ?? true,
        cli: model.cli,
        ...(model.acp ? { acp: model.acp } : {}),
        ...(model.accountRef !== undefined && model.accountRef !== null ? { accountRef: model.accountRef } : {}),
        ...(model.commandArgs ? { commandArgs: model.commandArgs } : {}),
        ...(model.cliConfigArgs ? { cliConfigArgs: model.cliConfigArgs } : {}),
        ...(model.contextBudget ? { contextBudget: model.contextBudget } : {}),
        ...(model.provider ? { provider: model.provider } : {}),
        source: 'seed' as const,
      },
    ],
  } as MutableRecord & CatBreed;
  applyRolePatch(projectRoot, teamDir, teamId, breed, patch);
  const variant = (breed.variants[0] as MutableRecord & CatVariant) ?? null;
  if (variant) applyRolePatch(projectRoot, teamDir, teamId, variant, patch);
  return breed;
}

export function getActiveTeamId(): string {
  return activeTeamId;
}

export function getTeamAcpConfig(projectRoot: string, teamId: string, catId: string): TeamAcpConfig | undefined {
  if (teamId === DEFAULT_TEAM_ID) return undefined;
  const loaded = readTeamProfile(projectRoot, teamId);
  if (!loaded) return undefined;
  const rolePatch = collectAllRolePatches(loaded.profile, loaded.dir)[catId];
  return rolePatch?.modelConfig?.acp ?? rolePatch?.acp;
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

function rolePathFor(profile: LoadedTeamProfile, catId: string): string {
  return join(resolveTeamLocalPath(profile.dir, profile.profile.roleDir ?? 'roles'), `${catId}.json`);
}

function teamProfilePathFor(profile: LoadedTeamProfile): string {
  return join(profile.dir, 'team.json');
}

function normalizeMentionPatterns(mentionPatterns: readonly string[]): string[] {
  return Array.from(
    new Set(
      mentionPatterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
        .map((pattern) => (pattern.startsWith('@') ? pattern : `@${pattern}`)),
    ),
  );
}

function normalizeRolePatchForWrite(catId: string, patch: RolePatch): RolePatch {
  return {
    ...patch,
    family: patch.family ?? catId,
    mentionPatterns: patch.mentionPatterns ? normalizeMentionPatterns(patch.mentionPatterns) : [`@${catId}`],
    defaultVariantId: patch.defaultVariantId ?? `${catId}-default`,
  };
}

function writeTeamProfileMembers(loaded: LoadedTeamProfile, members: readonly string[]): void {
  const profilePath = teamProfilePathFor(loaded);
  writeJsonAtomic(profilePath, {
    ...loaded.profile,
    members: Array.from(new Set(members)),
  });
}

function toWritableCliConfig(cli: CliConfig): z.infer<typeof cliConfigSchema> {
  return {
    command: cli.command,
    outputFormat: cli.outputFormat,
    ...(cli.defaultArgs ? { defaultArgs: [...cli.defaultArgs] } : {}),
    ...(cli.effort ? { effort: cli.effort } : {}),
  };
}

function toRolePatchFromInput(input: TeamCatInput): RolePatch {
  return normalizeRolePatchForWrite(input.catId, {
    family: input.catId,
    roles: ['assistant'],
    lead: false,
    name: input.name,
    displayName: input.displayName,
    ...(input.nickname ? { nickname: input.nickname } : {}),
    avatar: input.avatar,
    color: input.color,
    mentionPatterns: input.mentionPatterns,
    defaultVariantId: `${input.catId}-default`,
    roleDescription: input.roleDescription,
    ...(input.personality ? { personality: input.personality } : {}),
    ...(input.teamStrengths ? { teamStrengths: input.teamStrengths } : {}),
    ...(input.caution !== undefined ? { caution: input.caution } : {}),
    ...(input.strengths ? { strengths: input.strengths } : {}),
    ...(input.sessionChain !== undefined ? { sessionChain: input.sessionChain } : {}),
    modelConfig: {
      clientId: input.clientId,
      defaultModel: input.defaultModel,
      ...(input.accountRef ? { accountRef: input.accountRef } : {}),
      mcpSupport: input.mcpSupport,
      cli: toWritableCliConfig(input.cli),
      ...(input.commandArgs ? { commandArgs: input.commandArgs } : {}),
      ...(input.cliConfigArgs ? { cliConfigArgs: input.cliConfigArgs } : {}),
      ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    },
  });
}

function mergeRolePatchForUpdate(catId: string, existing: RolePatch, patch: TeamCatUpdate): RolePatch {
  const next: RolePatch = { ...existing };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.displayName !== undefined) next.displayName = patch.displayName;
  if (patch.nickname !== undefined) {
    if (patch.nickname.trim().length > 0) next.nickname = patch.nickname.trim();
    else delete next.nickname;
  }
  if (patch.avatar !== undefined) next.avatar = patch.avatar;
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.mentionPatterns !== undefined) next.mentionPatterns = normalizeMentionPatterns(patch.mentionPatterns);
  if (patch.roleDescription !== undefined) next.roleDescription = patch.roleDescription;
  if (patch.personality !== undefined) {
    if (patch.personality.trim().length > 0) next.personality = patch.personality;
    else delete next.personality;
  }
  if (patch.teamStrengths !== undefined) {
    if (patch.teamStrengths.trim().length > 0) next.teamStrengths = patch.teamStrengths.trim();
    else delete next.teamStrengths;
  }
  if (patch.caution !== undefined) next.caution = patch.caution && patch.caution.trim().length > 0 ? patch.caution.trim() : null;
  if (patch.strengths !== undefined) {
    if (patch.strengths.length > 0) next.strengths = patch.strengths;
    else delete next.strengths;
  }
  if (patch.sessionChain !== undefined) next.sessionChain = patch.sessionChain;
  if (patch.available !== undefined) next.available = patch.available;

  const modelConfig = { ...(next.modelConfig ?? {}) } as ModelConfigPatch;
  if (patch.clientId !== undefined) modelConfig.clientId = patch.clientId;
  if (patch.defaultModel !== undefined) modelConfig.defaultModel = patch.defaultModel;
  if (patch.accountRef !== undefined) {
    if (patch.accountRef && patch.accountRef.trim().length > 0) modelConfig.accountRef = patch.accountRef.trim();
    else delete modelConfig.accountRef;
  }
  if (patch.mcpSupport !== undefined) modelConfig.mcpSupport = patch.mcpSupport;
  if (patch.cli !== undefined) modelConfig.cli = toWritableCliConfig(patch.cli);
  if (patch.commandArgs !== undefined) {
    if (patch.commandArgs.length > 0) modelConfig.commandArgs = patch.commandArgs;
    else delete modelConfig.commandArgs;
  }
  if (patch.cliConfigArgs !== undefined) {
    if (patch.cliConfigArgs.length > 0) modelConfig.cliConfigArgs = patch.cliConfigArgs;
    else delete modelConfig.cliConfigArgs;
  }
  if (patch.contextBudget !== undefined) {
    if (patch.contextBudget) modelConfig.contextBudget = patch.contextBudget;
    else delete modelConfig.contextBudget;
  }
  if (patch.provider !== undefined) {
    if (patch.provider) modelConfig.provider = patch.provider;
    else delete modelConfig.provider;
  }
  next.modelConfig = modelConfig;
  return normalizeRolePatchForWrite(catId, next);
}

export function createTeamCat(projectRoot: string, teamId: string, input: TeamCatInput): void {
  if (teamId === DEFAULT_TEAM_ID) throw new Error('default team writes must use runtime catalog');
  const loaded = readTeamProfile(projectRoot, teamId);
  if (!loaded) throw new Error(`Team "${teamId}" not found under config/${teamId}/team.json`);
  const members = loaded.profile.members ?? [];
  if (members.includes(input.catId) || existsSync(rolePathFor(loaded, input.catId))) {
    throw new Error(`Cat "${input.catId}" already exists in team "${teamId}"`);
  }
  writeJsonAtomic(rolePathFor(loaded, input.catId), toRolePatchFromInput(input));
  writeTeamProfileMembers(loaded, [...members, input.catId]);
}

export function updateTeamCat(projectRoot: string, teamId: string, catId: string, patch: TeamCatUpdate): void {
  if (teamId === DEFAULT_TEAM_ID) throw new Error('default team writes must use runtime catalog');
  const loaded = readTeamProfile(projectRoot, teamId);
  if (!loaded) throw new Error(`Team "${teamId}" not found under config/${teamId}/team.json`);
  const path = rolePathFor(loaded, catId);
  if (!existsSync(path)) {
    throw new Error(`Cat "${catId}" not found in team "${teamId}" role config`);
  }
  const existing = readRolePatchFile(path);
  writeJsonAtomic(path, mergeRolePatchForUpdate(catId, existing, patch));
}

export function deleteTeamCat(projectRoot: string, teamId: string, catId: string): void {
  if (teamId === DEFAULT_TEAM_ID) throw new Error('default team writes must use runtime catalog');
  const loaded = readTeamProfile(projectRoot, teamId);
  if (!loaded) throw new Error(`Team "${teamId}" not found under config/${teamId}/team.json`);
  const members = loaded.profile.members ?? [];
  writeTeamProfileMembers(
    loaded,
    members.filter((member) => member !== catId),
  );
  const path = rolePathFor(loaded, catId);
  if (existsSync(path)) unlinkSync(path);
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

  if (options.filterMembers && memberFilter) {
    const presentCatIds = new Set<string>();
    for (const breed of next.breeds) {
      for (const variant of breed.variants) {
        presentCatIds.add(getVariantCatId(breed, variant));
      }
    }
    for (const catId of memberFilter) {
      if (presentCatIds.has(catId)) continue;
      nextRecord.breeds.push(createStandaloneBreed(projectRoot, dir, teamId, catId, rolePatches[catId]));
    }
  }

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
