import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Collection, SmartField, SmartRule, SmartRules, Track } from './types';
import { IconButton } from './components';
import { evaluateSmart, FIELDS, filled, OPS, ruleCounts, SMART_PRESETS } from './smart';

const blank: SmartRules = { match: 'all', rules: [{ field: 'favorite', op: 'is', value: true }], sort: 'random', limit: 0 };
const defaultValue = (field: SmartField): SmartRule['value'] =>
  FIELDS[field].kind === 'bool' ? true : FIELDS[field].kind === 'text' ? '' : FIELDS[field].kind === 'date' ? 30 : 0;

/** Create or edit a smart playlist: rules, order, a limit, and a live song count. */
export default function SmartPlaylistEditor({
  existing,
  tracks,
  onSave,
}: {
  existing?: Collection;
  tracks: Track[];
  onSave: (c: Collection) => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [rules, setRules] = useState<SmartRules>(existing?.rules ?? blank);
  const [error, setError] = useState('');
  const count = useMemo(() => evaluateSmart(rules, tracks, Date.now()).length, [rules, tracks]);
  // How many songs each rule matches by itself, so a rule that keeps everything out shows.
  const counts = useMemo(() => ruleCounts(rules, tracks, Date.now()), [rules, tracks]);
  const setRule = (i: number, next: SmartRule) =>
    setRules({ ...rules, rules: rules.rules.map((r, n) => (n === i ? next : r)) });
  return (
    <div className="dialog-body smart-editor">
      {!existing && (
        <div className="smart-presets">
          <span>Start from</span>
          {SMART_PRESETS.map((p) => (
            <button
              key={p.name}
              className={name === p.name ? 'active' : ''}
              onClick={() => {
                setName(p.name);
                setRules(p.rules);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <label className="field">
        Name
        <input value={name} autoFocus={!existing} onChange={(e) => setName(e.target.value)} placeholder="Late-night lossless…" />
      </label>
      <div className="smart-match">
        Songs that match
        <select
          aria-label="Match"
          value={rules.match}
          onChange={(e) => setRules({ ...rules, match: e.target.value as SmartRules['match'] })}
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of these rules:
      </div>
      <div className="smart-rules">
        {rules.rules.map((rule, i) => {
          const kind = FIELDS[rule.field].kind;
          return (
            <div className="smart-rule" key={i}>
              <select
                aria-label={`Rule ${i + 1} field`}
                value={rule.field}
                onChange={(e) => {
                  const field = e.target.value as SmartField;
                  setRule(i, { field, op: OPS[FIELDS[field].kind][0].op, value: defaultValue(field) });
                }}
              >
                {Object.entries(FIELDS).map(([f, info]) => (
                  <option key={f} value={f}>
                    {info.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Rule ${i + 1} condition`}
                value={rule.op}
                onChange={(e) => setRule(i, { ...rule, op: e.target.value as SmartRule['op'] })}
              >
                {OPS[kind].map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              {kind !== 'bool' && (
                <input
                  aria-label={`Rule ${i + 1} value`}
                  type={kind === 'text' ? 'text' : 'number'}
                  value={String(rule.value)}
                  min={0}
                  onChange={(e) =>
                    setRule(i, {
                      ...rule,
                      value: kind === 'text' || e.target.value === '' ? e.target.value : Number(e.target.value),
                    })
                  }
                />
              )}
              {FIELDS[rule.field].unit && <span className="smart-unit">{FIELDS[rule.field].unit}</span>}
              <span className={'smart-count' + (filled(rule) && counts[i] === 0 ? ' none' : '')}
                title="Songs this rule matches by itself">
                {filled(rule) ? counts[i] : '–'}
              </span>
              <IconButton
                label={`Remove rule ${i + 1}`}
                disabled={rules.rules.length === 1}
                onClick={() => setRules({ ...rules, rules: rules.rules.filter((_, n) => n !== i) })}
              >
                <X size={15} />
              </IconButton>
            </div>
          );
        })}
        <button
          className="quiet"
          onClick={() => setRules({ ...rules, rules: [...rules.rules, { field: 'artist', op: 'contains', value: '' }] })}
        >
          <Plus size={15} /> Add a rule
        </button>
      </div>
      <div className="smart-match">
        Order by
        <select aria-label="Order" value={rules.sort} onChange={(e) => setRules({ ...rules, sort: e.target.value as SmartRules['sort'] })}>
          <option value="random">shuffle (changes daily)</option>
          <option value="plays">most played</option>
          <option value="recent">recently played</option>
          <option value="added">recently added</option>
          <option value="year">year</option>
          <option value="title">title</option>
        </select>
        and keep
        <select aria-label="Limit" value={rules.limit} onChange={(e) => setRules({ ...rules, limit: Number(e.target.value) })}>
          <option value={0}>every song</option>
          {[25, 50, 100, 250].map((n) => (
            <option key={n} value={n}>
              the first {n}
            </option>
          ))}
        </select>
      </div>
      <footer className="modal-footer">
        <span>
          {count} song{count === 1 ? '' : 's'} match right now. The list updates itself as your library and listening change.
        </span>
        <button
          className="primary"
          disabled={!name.trim()}
          onClick={async () => {
            try {
              await onSave({
                id: existing?.id ?? crypto.randomUUID(),
                name: name.trim(),
                kind: 'smart',
                rules,
                entries: [],
                created: existing?.created ?? Date.now(),
              });
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {existing ? 'Save smart playlist' : 'Create smart playlist'}
        </button>
      </footer>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
