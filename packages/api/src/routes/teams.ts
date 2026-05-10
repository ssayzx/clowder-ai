import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_TEAM_ID,
  getActiveTeamId,
  getTeamConfigExample,
  listTeamProfiles,
  setActiveTeamId,
} from '../config/team-config.js';
import { _resetCachedConfig, loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const switchTeamSchema = z.object({
  teamId: z.string().min(1),
});

export interface TeamsRoutesOptions {
  onTeamChanged?: () => Promise<void> | void;
}

function resolveProjectRoot(): string {
  return resolveActiveProjectRoot();
}

function refreshCatRegistryForActiveTeam(): string[] {
  const configs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(configs)) {
    catRegistry.register(id, config);
  }
  return Object.keys(configs);
}

export const teamsRoutes: FastifyPluginAsync<TeamsRoutesOptions> = async (app, opts) => {
  app.get('/api/teams', async () => {
    const projectRoot = resolveProjectRoot();
    const activeTeamId = getActiveTeamId();
    return {
      activeTeamId,
      teams: listTeamProfiles(projectRoot),
      schema: {
        root: 'config/<team-id>/team.json',
        example: JSON.parse(getTeamConfigExample('code')),
      },
    };
  });

  app.patch('/api/teams/active', async (request, reply) => {
    const parsed = switchTeamSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const projectRoot = resolveProjectRoot();
    try {
      setActiveTeamId(projectRoot, parsed.data.teamId);
      _resetCachedConfig();
      const catIds = refreshCatRegistryForActiveTeam();
      await opts.onTeamChanged?.();
      await configEventBus.emitChangeAsync({
        source: 'cat-config',
        scope: 'domain',
        changedKeys: [`team:${getActiveTeamId()}`],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
      return {
        activeTeamId: getActiveTeamId(),
        teams: listTeamProfiles(projectRoot),
        catIds,
        updatedBy: operator,
      };
    } catch (err) {
      reply.status(400);
      return {
        error:
          parsed.data.teamId === DEFAULT_TEAM_ID
            ? err instanceof Error
              ? err.message
              : String(err)
            : `Cannot switch to team "${parsed.data.teamId}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
};
