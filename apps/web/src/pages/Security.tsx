import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RiskyUser, type SecurityInventory } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, formatDate } from '../components/ui.js';

interface ThreatSignature {
  id: string;
  kind: string;
  value: string;
  source: string;
  severity: number;
  campaign: string | null;
  hitCount: number;
  createdAt: string;
}

export function Security() {
  const guildId = useGuildId();
  const [inventory, setInventory] = useState<SecurityInventory | null>(null);
  const [risky, setRisky] = useState<RiskyUser[]>([]);
  const [threats, setThreats] = useState<{
    signatures: ThreatSignature[];
    globalCount: number;
    sources: { source: string; count: number }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newThreat, setNewThreat] = useState({ kind: 'DOMAIN', value: '', severity: 80 });

  const load = () => {
    Promise.all([
      api.get<SecurityInventory>(`/api/guilds/${guildId}/security/inventory`),
      api.get<RiskyUser[]>(`/api/guilds/${guildId}/users/risky`),
      api.get<{
        signatures: ThreatSignature[];
        globalCount: number;
        sources: { source: string; count: number }[];
      }>(`/api/guilds/${guildId}/threats`),
    ])
      .then(([inventoryResult, riskyResult, threatsResult]) => {
        setInventory(inventoryResult);
        setRisky(riskyResult);
        setThreats(threatsResult);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  const addThreat = async () => {
    if (!newThreat.value.trim()) return;
    try {
      await api.post(`/api/guilds/${guildId}/threats`, newThreat);
      setNewThreat({ ...newThreat, value: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (error) return <ErrorBox message={error} />;
  if (!inventory || !threats) return <Loading />;

  const unapprovedWebhooks = inventory.webhooks.filter((webhook) => !webhook.approved);
  const riskyBots = inventory.bots.filter((bot) => bot.riskScore >= 60);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Sicurezza</h1>

      {inventory.invitesAtRisk.length > 0 && (
        <Card title="🚨 Codici invito a rischio dirottamento">
          <p className="mb-3 text-sm text-neutral-300">
            Questi codici non appartengono più al server. Discord consente di rivendicare come
            vanity i codici scaduti o liberati: chi apre il vecchio link può finire su un server
            altrui. Sostituiscili ovunque siano stati pubblicati.
          </p>
          <ul className="space-y-1 font-mono text-sm">
            {inventory.invitesAtRisk.map((invite) => (
              <li key={invite.code} className="text-[var(--color-danger)]">
                discord.gg/{invite.code}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Webhook"
          subtitle="Un webhook permette di scrivere nel canale con nome e immagine arbitrari, senza essere membro del server."
        >
          {inventory.webhooks.length === 0 ? (
            <Empty>Nessun webhook presente.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {inventory.webhooks.map((webhook) => (
                <li key={webhook.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-neutral-200">{webhook.name}</div>
                    <div className="text-xs text-neutral-500">
                      canale {webhook.channelId} · dal {formatDate(webhook.firstSeenAt)}
                    </div>
                  </div>
                  <Badge tone={webhook.managed ? 'accent' : webhook.approved ? 'success' : 'danger'}>
                    {webhook.managed ? 'ANGEL' : webhook.approved ? 'approvato' : 'non approvato'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {unapprovedWebhooks.length > 0 && (
            <p className="mt-3 text-xs text-[var(--color-warning)]">
              {unapprovedWebhooks.length} webhook non approvati. Se il modulo di protezione è
              attivo vengono eliminati automaticamente alla creazione.
            </p>
          )}
        </Card>

        <Card
          title="Bot presenti"
          subtitle="Un bot con Administrator rende il server compromettibile attraverso la catena di fornitura del bot stesso."
        >
          {inventory.bots.length === 0 ? (
            <Empty>Nessun bot registrato.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {inventory.bots.map((bot) => (
                <li key={bot.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-neutral-200">{bot.name}</div>
                    <div className="text-xs text-neutral-500">
                      {bot.riskFlags.join(', ') || 'nessun permesso critico'}
                    </div>
                  </div>
                  <Badge
                    tone={bot.riskScore >= 80 ? 'danger' : bot.riskScore >= 60 ? 'warning' : 'neutral'}
                  >
                    {bot.riskScore}/100
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {riskyBots.length > 0 && (
            <p className="mt-3 text-xs text-[var(--color-warning)]">
              {riskyBots.length} bot con permessi molto ampi. Rivedi cosa serve davvero a ciascuno.
            </p>
          )}
        </Card>
      </div>

      <Card
        title="Account a rischio"
        subtitle="Punteggio calcolato all'ingresso e a ogni cambio di nome o avatar."
      >
        {risky.length === 0 ? (
          <Empty>Nessun account sopra la soglia di attenzione.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase text-neutral-500">
                  <th className="py-2 pr-3">Utente</th>
                  <th className="py-2 pr-3">Rischio</th>
                  <th className="py-2 pr-3">Segnali</th>
                  <th className="py-2 pr-3">Stato</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {risky.map((user) => (
                  <tr key={user.userId} className="border-b border-[var(--color-border)]/50">
                    <td className="py-2 pr-3">
                      <Link
                        to={`/g/${guildId}/utente/${user.userId}`}
                        className="text-neutral-200 hover:text-[var(--color-accent-soft)] hover:underline"
                      >
                        {user.displayName ?? user.username ?? '—'}
                      </Link>
                      <div className="font-mono text-xs text-neutral-600">{user.userId}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={user.riskScore >= 70 ? 'danger' : 'warning'}>
                        {user.riskScore}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs text-neutral-400">
                      {user.riskFlags.join(', ')}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {user.quarantinedAt ? (
                        <span className="text-[var(--color-danger)]">in quarantena</span>
                      ) : (
                        <span className="text-neutral-500">attivo</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {user.quarantinedAt && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void api
                              .post(`/api/guilds/${guildId}/users/${user.userId}/quarantine/lift`)
                              .then(load)
                          }
                        >
                          Libera
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Firme di minaccia"
        subtitle={`${threats.globalCount.toLocaleString('it-IT')} firme globali dalle blocklist pubbliche, più quelle di questo server.`}
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={newThreat.kind}
            onChange={(event) => setNewThreat({ ...newThreat, kind: event.target.value })}
          >
            <option value="DOMAIN">Dominio</option>
            <option value="URL">URL completo</option>
            <option value="KEYWORD">Parola chiave</option>
            <option value="REGEX">Espressione regolare</option>
            <option value="FILE_SHA256">Hash file (SHA-256)</option>
            <option value="IMAGE_PHASH">Hash percettivo immagine</option>
          </select>
          <input
            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            placeholder="Valore da bloccare"
            value={newThreat.value}
            onChange={(event) => setNewThreat({ ...newThreat, value: event.target.value })}
          />
          <Button variant="primary" onClick={() => void addThreat()}>
            Aggiungi
          </Button>
        </div>

        {threats.signatures.length === 0 ? (
          <Empty>Nessuna firma personalizzata per questo server.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {threats.signatures.map((signature) => (
              <li
                key={signature.id}
                className="flex items-center justify-between gap-3 border-b border-[var(--color-border)]/50 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-2 text-xs text-neutral-500">{signature.kind}</span>
                  <span className="font-mono text-neutral-300">
                    {signature.value.slice(0, 80)}
                  </span>
                </div>
                <span className="text-xs text-neutral-500">
                  {signature.source} · {signature.hitCount} blocchi
                </span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void api.delete(`/api/guilds/${guildId}/threats/${signature.id}`).then(load)
                  }
                >
                  Rimuovi
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
