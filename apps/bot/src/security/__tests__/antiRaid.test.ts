import { describe, expect, it } from 'vitest';
import { clusterMembers, type ClusterSettings, type JoinRecord } from '../antiRaid.js';

/* ═══════════════════════════════════════════════════════════════════════
   RILEVAMENTO DEI GRUPPI

   Questa logica decide se mettere in quarantena decine di persone in una
   volta. I casi qui sotto sono i due che contano davvero: il raid lento — che
   entra a pochi alla volta per stare sotto la soglia sui join — e la giornata
   di crescita normale, che non deve mai far scattare nulla.
   ═══════════════════════════════════════════════════════════════════════ */

const settings: ClusterSettings = {
  newAccountHours: 72,
  nameSimilarity: 0.85,
  minClusterSize: 5,
  windowSec: 300,
};

const NOW = 1_760_000_000_000;

function record(partial: Partial<JoinRecord> & { userId: string; username: string }): JoinRecord {
  return {
    accountAgeHours: 1000,
    hasAvatar: true,
    joinedAt: NOW - 10_000,
    ...partial,
  };
}

describe('clustering anti-raid', () => {
  it('riconosce nomi generati dallo stesso schema', () => {
    const candidate = record({ userId: '10', username: 'raider_07' });
    const recent = [
      record({ userId: '1', username: 'raider_01' }),
      record({ userId: '2', username: 'raider_02' }),
      record({ userId: '3', username: 'raider_03' }),
      record({ userId: '4', username: 'raider_04' }),
    ];

    const cluster = clusterMembers(recent, candidate, settings, NOW);
    expect(cluster).toHaveLength(4);
  });

  it('riconosce il gruppo anche con omoglifi nei nomi', () => {
    // "rаider" con la a cirillica: per un confronto ingenuo sarebbe un nome
    // completamente diverso.
    const candidate = record({ userId: '10', username: 'raider_09' });
    const recent = [record({ userId: '1', username: 'rаider_01' })];

    expect(clusterMembers(recent, candidate, settings, NOW)).toHaveLength(1);
  });

  it('raggruppa account nuovi e senza avatar anche con nomi diversi', () => {
    const candidate = record({ userId: '10', username: 'qualcosa' });
    const recent = [
      record({ userId: '1', username: 'mario', accountAgeHours: 2, hasAvatar: false }),
      record({ userId: '2', username: 'lucia', accountAgeHours: 5, hasAvatar: false }),
    ];

    expect(clusterMembers(recent, candidate, settings, NOW)).toHaveLength(2);
  });

  it('non raggruppa un account nuovo che ha però un avatar', () => {
    // Un solo segnale debole non basta: descrive anche un utente legittimo
    // appena iscritto a Discord.
    const candidate = record({ userId: '10', username: 'qualcosa' });
    const recent = [
      record({ userId: '1', username: 'mario', accountAgeHours: 2, hasAvatar: true }),
    ];

    expect(clusterMembers(recent, candidate, settings, NOW)).toHaveLength(0);
  });

  it('non scatta su una crescita normale', () => {
    const candidate = record({ userId: '10', username: 'giovanni_b' });
    const recent = [
      record({ userId: '1', username: 'mario_rossi' }),
      record({ userId: '2', username: 'lucia88' }),
      record({ userId: '3', username: 'TheGamer' }),
      record({ userId: '4', username: 'anna' }),
      record({ userId: '5', username: 'pietro_g' }),
    ];

    expect(clusterMembers(recent, candidate, settings, NOW)).toHaveLength(0);
  });

  it('ignora chi è entrato prima della finestra', () => {
    const candidate = record({ userId: '10', username: 'raider_07' });
    const recent = [
      record({ userId: '1', username: 'raider_01', joinedAt: NOW - 10_000 }),
      // Fuori finestra di 300s: appartiene a un'altra ondata, non a questa.
      record({ userId: '2', username: 'raider_02', joinedAt: NOW - 400_000 }),
    ];

    const cluster = clusterMembers(recent, candidate, settings, NOW);
    expect(cluster).toHaveLength(1);
    expect(cluster[0]?.userId).toBe('1');
  });

  it('rispetta una soglia di somiglianza più severa', () => {
    const candidate = record({ userId: '10', username: 'raider_07' });
    const recent = [record({ userId: '1', username: 'raider_01' })];

    // Con soglia 0.99 solo i nomi quasi identici finiscono nello stesso gruppo.
    expect(clusterMembers(recent, candidate, { ...settings, nameSimilarity: 0.99 }, NOW)).toHaveLength(0);
  });
});
