import { useEffect, useState } from 'react';
import { api, type CustomCommandRecord, type Persona } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading } from '../components/ui.js';

/* ═══════════════════════════════════════════════════════════════════════
   BUILDER DI COMANDI E PERSONAS

   Una "persona" parla in chat con nome e immagine propri: tecnicamente è un
   webhook, l'unico modo che Discord offre per farlo. Un comando è una sequenza
   di passi — questa persona dice questo, pausa, quest'altra risponde, assegna
   un ruolo — utilizzabile solo da chi ha i ruoli indicati.
   ═══════════════════════════════════════════════════════════════════════ */

type Step = Record<string, unknown> & { kind: string; label?: string };

const STEP_TEMPLATES: { kind: string; label: string; make: () => Step }[] = [
  {
    kind: 'PERSONA_MESSAGE',
    label: 'Messaggio di una persona',
    make: () => ({
      kind: 'PERSONA_MESSAGE',
      personaId: '',
      content: 'Ciao {user}!',
      channelId: null,
      asEmbed: false,
      embedTitle: '',
      embedImageUrl: null,
      allowMentions: false,
      label: '',
    }),
  },
  { kind: 'WAIT', label: 'Pausa', make: () => ({ kind: 'WAIT', seconds: 3, label: '' }) },
  {
    kind: 'ADD_ROLE',
    label: 'Assegna ruolo',
    make: () => ({
      kind: 'ADD_ROLE',
      roleId: '',
      target: 'ARG_USER',
      argName: '',
      durationSec: 0,
      label: '',
    }),
  },
  {
    kind: 'REMOVE_ROLE',
    label: 'Rimuovi ruolo',
    make: () => ({ kind: 'REMOVE_ROLE', roleId: '', target: 'ARG_USER', argName: '', label: '' }),
  },
  {
    kind: 'DM_USER',
    label: 'Messaggio privato',
    make: () => ({ kind: 'DM_USER', target: 'ARG_USER', argName: '', content: '', label: '' }),
  },
  {
    kind: 'CONDITION',
    label: 'Condizione',
    make: () => ({
      kind: 'CONDITION',
      check: 'RANDOM_CHANCE',
      argName: '',
      value: '',
      roleId: null,
      chance: 50,
      skipSteps: 1,
      label: '',
    }),
  },
];

export function Builder() {
  const guildId = useGuildId();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [commands, setCommands] = useState<CustomCommandRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomCommandRecord | null>(null);

  const load = () => {
    Promise.all([
      api.get<Persona[]>(`/api/guilds/${guildId}/personas`),
      api.get<CustomCommandRecord[]>(`/api/guilds/${guildId}/commands`),
    ])
      .then(([personaList, commandList]) => {
        setPersonas(personaList);
        setCommands(commandList);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  if (!personas || !commands) return error ? <ErrorBox message={error} /> : <Loading />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Comandi personalizzati e personas</h1>
      {error && <ErrorBox message={error} />}

      <PersonaSection
        guildId={guildId}
        personas={personas}
        onChange={load}
        onError={setError}
      />

      <Card
        title="Comandi"
        subtitle="Ogni comando è una sequenza di passi eseguita in ordine."
        action={
          <Button
            variant="primary"
            onClick={() =>
              setEditing({
                id: '',
                name: '',
                description: '',
                enabled: true,
                allowedRoleIds: [],
                deniedRoleIds: [],
                allowedChannelIds: [],
                args: [],
                steps: [],
                cooldownSec: 3,
                guildCooldownSec: 0,
                ephemeralAck: true,
                useCount: 0,
              })
            }
          >
            Nuovo comando
          </Button>
        }
      >
        {commands.length === 0 ? (
          <Empty>Nessun comando personalizzato. Creane uno per iniziare.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {commands.map((command) => (
              <li
                key={command.id}
                className="flex items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <code className="text-neutral-200">/{command.name}</code>
                    {!command.enabled && <Badge tone="neutral">disattivato</Badge>}
                    {command.allowedRoleIds.length > 0 && (
                      <Badge tone="accent">{command.allowedRoleIds.length} ruoli abilitati</Badge>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {command.description} · {(command.steps as unknown[]).length} passi ·{' '}
                    {command.useCount} usi
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setEditing(command)}>
                    Modifica
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .delete(`/api/guilds/${guildId}/commands/${command.id}`)
                        .then(load)
                        .catch((err: Error) => setError(err.message))
                    }
                  >
                    Elimina
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <CommandEditor
          guildId={guildId}
          personas={personas}
          command={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function PersonaSection({
  guildId,
  personas,
  onChange,
  onError,
}: {
  guildId: string;
  personas: Persona[];
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState({ name: '', avatarUrl: '', color: '#5865f2', description: '' });

  const create = async () => {
    if (!draft.name.trim()) return;
    try {
      await api.post(`/api/guilds/${guildId}/personas`, {
        name: draft.name,
        avatarUrl: draft.avatarUrl || null,
        color: draft.color,
        description: draft.description,
      });
      setDraft({ name: '', avatarUrl: '', color: '#5865f2', description: '' });
      onChange();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <Card
      title="Personas"
      subtitle="Identità con nome e immagine propri, realizzate tramite webhook. Ogni messaggio resta comunque attribuito, nel registro, a chi ha lanciato il comando."
    >
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
          placeholder="Nome (es. Giudice)"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <input
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
          placeholder="URL immagine del profilo"
          value={draft.avatarUrl}
          onChange={(event) => setDraft({ ...draft, avatarUrl: event.target.value })}
        />
        <input
          type="color"
          className="h-9 w-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]"
          value={draft.color}
          onChange={(event) => setDraft({ ...draft, color: event.target.value })}
        />
        <Button variant="primary" onClick={() => void create()}>
          Crea
        </Button>
      </div>

      <p className="mb-4 text-xs text-neutral-500">
        Nomi come "Discord", "Staff", "Supporto" o "Moderatore" vengono rifiutati, così come quelli
        troppo simili ai nickname reali dello staff: una persona indistinguibile dallo staff sarebbe
        uno strumento di truffa.
      </p>

      {personas.length === 0 ? (
        <Empty>Nessuna persona creata.</Empty>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {personas.map((persona) => (
            <li
              key={persona.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
            >
              {persona.avatarUrl ? (
                <img
                  src={persona.avatarUrl}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <div
                  className="h-9 w-9 rounded-full"
                  style={{ background: persona.color ?? '#5865f2' }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-200">{persona.name}</div>
                <div className="text-xs text-neutral-500">{persona.messageCount} messaggi</div>
              </div>
              <Button
                variant="ghost"
                onClick={() =>
                  void api
                    .delete(`/api/guilds/${guildId}/personas/${persona.id}`)
                    .then(onChange)
                    .catch((err: Error) => onError((err as Error).message))
                }
              >
                Elimina
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CommandEditor({
  guildId,
  personas,
  command,
  onClose,
  onSaved,
  onError,
}: {
  guildId: string;
  personas: Persona[];
  command: CustomCommandRecord;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState({
    ...command,
    steps: (command.steps as Step[]) ?? [],
    args: (command.args as Record<string, unknown>[]) ?? [],
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        enabled: draft.enabled,
        allowedRoleIds: draft.allowedRoleIds,
        deniedRoleIds: draft.deniedRoleIds,
        allowedChannelIds: draft.allowedChannelIds,
        args: draft.args,
        steps: draft.steps,
        cooldownSec: draft.cooldownSec,
        guildCooldownSec: draft.guildCooldownSec,
        ephemeralAck: draft.ephemeralAck,
      };
      if (command.id) {
        await api.put(`/api/guilds/${guildId}/commands/${command.id}`, body);
      } else {
        await api.post(`/api/guilds/${guildId}/commands`, body);
      }
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateStep = (index: number, patch: Partial<Step>) => {
    const steps = [...draft.steps];
    steps[index] = { ...steps[index]!, ...patch };
    setDraft({ ...draft, steps });
  };

  return (
    <Card
      title={command.id ? `Modifica /${command.name}` : 'Nuovo comando'}
      action={
        <div className="flex gap-2">
          <Button onClick={onClose}>Annulla</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            Salva
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Nome (senza barra)</span>
          <input
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Descrizione</span>
          <input
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">
            ID ruoli abilitati (separati da virgola, vuoto = tutti)
          </span>
          <input
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={draft.allowedRoleIds.join(',')}
            onChange={(event) =>
              setDraft({
                ...draft,
                allowedRoleIds: event.target.value.split(',').map((id) => id.trim()).filter(Boolean),
              })
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-500">Attesa fra due usi (secondi)</span>
          <input
            type="number"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={draft.cooldownSec}
            onChange={(event) => setDraft({ ...draft, cooldownSec: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-sm font-medium">Argomenti</h3>
        <div className="space-y-2">
          {draft.args.map((arg, index) => (
            <div key={index} className="flex gap-2">
              <input
                className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                placeholder="nome"
                value={String(arg.name ?? '')}
                onChange={(event) => {
                  const args = [...draft.args];
                  args[index] = { ...arg, name: event.target.value.toLowerCase() };
                  setDraft({ ...draft, args });
                }}
              />
              <select
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
                value={String(arg.type ?? 'STRING')}
                onChange={(event) => {
                  const args = [...draft.args];
                  args[index] = { ...arg, type: event.target.value };
                  setDraft({ ...draft, args });
                }}
              >
                <option value="STRING">testo</option>
                <option value="USER">utente</option>
                <option value="CHANNEL">canale</option>
                <option value="ROLE">ruolo</option>
                <option value="NUMBER">numero</option>
                <option value="BOOLEAN">sì/no</option>
              </select>
              <input
                className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                placeholder="descrizione"
                value={String(arg.description ?? '')}
                onChange={(event) => {
                  const args = [...draft.args];
                  args[index] = { ...arg, description: event.target.value };
                  setDraft({ ...draft, args });
                }}
              />
              <Button
                variant="ghost"
                onClick={() =>
                  setDraft({ ...draft, args: draft.args.filter((_, i) => i !== index) })
                }
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
        <Button
          onClick={() =>
            setDraft({
              ...draft,
              args: [
                ...draft.args,
                { name: 'utente', description: 'Destinatario', type: 'USER', required: true, choices: [] },
              ],
            })
          }
        >
          + Argomento
        </Button>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-medium">Sequenza</h3>
        <div className="space-y-3">
          {draft.steps.map((step, index) => (
            <div
              key={index}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <Badge tone="accent">
                  {index + 1}. {step.kind}
                </Badge>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (index === 0) return;
                      const steps = [...draft.steps];
                      [steps[index - 1], steps[index]] = [steps[index]!, steps[index - 1]!];
                      setDraft({ ...draft, steps });
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })
                    }
                  >
                    ✕
                  </Button>
                </div>
              </div>

              {step.kind === 'PERSONA_MESSAGE' && (
                <div className="space-y-2">
                  <select
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
                    value={String(step.personaId ?? '')}
                    onChange={(event) => updateStep(index, { personaId: event.target.value })}
                  >
                    <option value="">— scegli una persona —</option>
                    {personas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name}
                      </option>
                    ))}
                  </select>
                  <textarea
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                    rows={2}
                    value={String(step.content ?? '')}
                    onChange={(event) => updateStep(index, { content: event.target.value })}
                  />
                </div>
              )}

              {step.kind === 'WAIT' && (
                <input
                  type="number"
                  step="0.5"
                  className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
                  value={Number(step.seconds ?? 3)}
                  onChange={(event) => updateStep(index, { seconds: Number(event.target.value) })}
                />
              )}

              {(step.kind === 'ADD_ROLE' || step.kind === 'REMOVE_ROLE') && (
                <div className="flex gap-2">
                  <input
                    className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
                    placeholder="ID del ruolo"
                    value={String(step.roleId ?? '')}
                    onChange={(event) => updateStep(index, { roleId: event.target.value })}
                  />
                  <select
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                    value={String(step.target ?? 'ARG_USER')}
                    onChange={(event) => updateStep(index, { target: event.target.value })}
                  >
                    <option value="ARG_USER">destinatario dell'argomento</option>
                    <option value="INVOKER">chi lancia il comando</option>
                  </select>
                  <input
                    className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
                    placeholder="nome argomento"
                    value={String(step.argName ?? '')}
                    onChange={(event) => updateStep(index, { argName: event.target.value })}
                  />
                </div>
              )}

              {step.kind === 'DM_USER' && (
                <textarea
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                  rows={2}
                  value={String(step.content ?? '')}
                  onChange={(event) => updateStep(index, { content: event.target.value })}
                />
              )}

              {step.kind === 'CONDITION' && (
                <div className="flex flex-wrap gap-2">
                  <select
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                    value={String(step.check ?? 'RANDOM_CHANCE')}
                    onChange={(event) => updateStep(index, { check: event.target.value })}
                  >
                    <option value="RANDOM_CHANCE">probabilità</option>
                    <option value="ARG_EQUALS">argomento uguale a</option>
                    <option value="ARG_CONTAINS">argomento contiene</option>
                    <option value="INVOKER_HAS_ROLE">chi lancia ha il ruolo</option>
                    <option value="TARGET_HAS_ROLE">il destinatario ha il ruolo</option>
                  </select>
                  <input
                    className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                    placeholder="valore"
                    value={String(step.value ?? '')}
                    onChange={(event) => updateStep(index, { value: event.target.value })}
                  />
                  <label className="flex items-center gap-1 text-xs text-neutral-400">
                    salta
                    <input
                      type="number"
                      className="w-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                      value={Number(step.skipSteps ?? 1)}
                      onChange={(event) => updateStep(index, { skipSteps: Number(event.target.value) })}
                    />
                    passi se falsa
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {STEP_TEMPLATES.map((template) => (
            <Button
              key={template.kind}
              onClick={() => setDraft({ ...draft, steps: [...draft.steps, template.make()] })}
            >
              + {template.label}
            </Button>
          ))}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-neutral-500">
          Variabili utilizzabili nei testi: <code>{'{user}'}</code>, <code>{'{user.name}'}</code>,{' '}
          <code>{'{arg:nome}'}</code>, <code>{'{guild}'}</code>, <code>{'{channel}'}</code>,{' '}
          <code>{'{count}'}</code>, <code>{'{random:a|b|c}'}</code>.
          <br />I ruoli con permessi amministrativi non sono assegnabili da un comando
          personalizzato: sarebbe una scalata di privilegi a disposizione di chiunque possa lanciarlo.
        </p>
      </div>
    </Card>
  );
}
