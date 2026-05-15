'use client';

import { useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

interface TeamProfile {
  id: string;
  displayName: string;
  description?: string;
  memberCount?: number;
  active: boolean;
}

interface TeamsResponse {
  activeTeamId?: string;
  teams?: TeamProfile[];
}

export function TeamSwitcher() {
  const { refresh } = useCatData();
  const [teams, setTeams] = useState<TeamProfile[]>([]);
  const [activeTeamId, setActiveTeamId] = useState('default');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/teams')
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as TeamsResponse;
      })
      .then((data) => {
        if (cancelled || !data) return;
        setTeams(data.teams ?? []);
        setActiveTeamId(data.activeTeamId ?? data.teams?.find((team) => team.active)?.id ?? 'default');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (teamId: string) => {
    if (teamId === activeTeamId || busy) return;
    const previous = activeTeamId;
    setActiveTeamId(teamId);
    setBusy(true);
    try {
      const res = await apiFetch('/api/teams/active', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId }),
      });
      if (!res.ok) throw new Error('team switch failed');
      const data = (await res.json().catch(() => ({}))) as TeamsResponse;
      setTeams(data.teams ?? teams);
      const nextTeamId = data.activeTeamId ?? teamId;
      setActiveTeamId(nextTeamId);
      const cats = await refresh();
      window.dispatchEvent(new CustomEvent('cat-team-changed', { detail: { teamId: nextTeamId, cats } }));
    } catch {
      setActiveTeamId(previous);
    } finally {
      setBusy(false);
    }
  };

  if (teams.length <= 1) return null;

  return (
    <label className="flex items-center gap-1 text-xs text-cafe-secondary">
      <span className="hidden xl:inline">团队</span>
      <select
        value={activeTeamId}
        disabled={busy}
        onChange={(event) => void handleChange(event.target.value)}
        className="h-8 max-w-[150px] rounded-md border border-cocreator-light bg-cocreator-bg px-2 text-xs text-cafe-black outline-none transition-colors hover:bg-cocreator-light disabled:opacity-60"
        aria-label="切换团队"
        title="切换团队"
      >
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
