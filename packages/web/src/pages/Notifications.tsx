import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationSettings, NotificationStatus } from '@agent-canvas/shared';
import { api } from '../client';
import { createPoller } from '../diagnostics';
import { useMask } from '../MaskContext';
import {
  NOTIFICATION_KINDS, deliveryLines, lineInputText, mergeSettings, parseLineInput, parseNumberField,
  type NumberField,
} from '../notifications';
import { useNow } from '../useNow';

const REFRESH_MS = 5000;
/** The usage line's input (USAGE_LINE_HASH focuses it). */
const USAGE_LINE_INPUT_ID = 'notify-usage-line';
const SAVED_SHOWN_MS = 2500;

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; error: string };
export type TestState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'failed'; error: string };
/** The typed fields: the two number fields and today's usage line (typed in 万 token). */
export type Field = NumberField | 'usageLineTokens';
export type Drafts = Partial<Record<Field, string>>;
export type FieldErrors = Partial<Record<Field, string>>;

/** A field's text as stored: the line in 万 token (empty for no line), the others as they are. */
const fieldText = (field: Field, s: NotificationSettings): string =>
  field === 'usageLineTokens' ? lineInputText(s.usageLineTokens) : String(s[field]);

const parseField = (field: Field, raw: string): { ok: true; value: number } | { ok: false; error: string } =>
  field === 'usageLineTokens' ? parseLineInput(raw) : parseNumberField(field, raw);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Owns the 1-second tick for the relative times. */
function DeliveryStatus({ status: raw }: { status: NotificationStatus }) {
  const now = useNow(1000);
  // A delivery error can quote the notification (a session title): masked with the switch on.
  const { list: m } = useMask();
  const status = m.on
    ? { ...raw, lastError: raw.lastError === null ? null : m.text(raw.lastError), settingsError: raw.settingsError === null ? null : m.text(raw.settingsError) }
    : raw;
  const lines = deliveryLines(status, now);
  return (
    <section aria-labelledby="notify-status-h">
      <h2 id="notify-status-h">投递状态</h2>
      <p className={status.available ? undefined : 'notify-warn'}>能不能弹出：{lines.availability}</p>
      <p>最近一次发出：{lines.lastSent}</p>
      {lines.lastError !== null && <p className="error" style={{ padding: 0 }}>最近一次错误：{lines.lastError}</p>}
      {lines.settingsError !== null && <p className="notify-warn">保存的设置读不出来，暂时按默认（关闭）处理：{lines.settingsError}</p>}
    </section>
  );
}

/** `focus` `usage-line`: once the settings are shown, today's usage line is brought into view and focused. */
export function Notifications({ onEnabledChange, focus = null }: { onEnabledChange?: (enabled: boolean) => void; focus?: 'usage-line' | null }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // The latest settings the server confirmed; saves read it when they run, so they always build on the newest.
  const settingsRef = useRef<NotificationSettings | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(0);
  const onEnabled = useRef(onEnabledChange);
  onEnabled.current = onEnabledChange;

  const adopt = useCallback((s: NotificationSettings): void => {
    settingsRef.current = s;
    setSettings(s);
    onEnabled.current?.(s.enabled);
  }, []);

  useEffect(() => {
    alive.current = true;
    const poller = createPoller({
      load: api.notificationSettings,
      onResult: (r) => {
        if (!r.ok) { setLoadError(r.error); return; }
        setLoadError(null);
        setStatus(r.value.status);
        // Settings come from the first load only: later ones must not overwrite what the user is editing.
        if (settingsRef.current === null) adopt(r.value.settings);
      },
      intervalMs: REFRESH_MS,
    });
    poller.start();
    return () => {
      alive.current = false;
      poller.stop();
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    };
  }, [adopt]);

  /** Saves `patch` on top of the confirmed settings. Saves run one after another. Resolves to whether it was saved. */
  const commit = useCallback((patch: Partial<NotificationSettings>): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const base = settingsRef.current;
      if (base === null) return false;
      const merged = mergeSettings(base, patch);
      if (!merged.ok) {
        if (alive.current) setSave({ kind: 'failed', error: merged.error });
        return false;
      }
      try {
        const res = await api.saveNotificationSettings(merged.settings);
        if (!alive.current) return true;
        adopt(res.settings);
        setStatus(res.status);
        return true;
      } catch (e) {
        if (alive.current) setSave({ kind: 'failed', error: errorText(e) });
        return false;
      }
    };
    pending.current += 1;
    setSave({ kind: 'saving' });
    if (savedTimer.current !== null) { clearTimeout(savedTimer.current); savedTimer.current = null; }
    const result = chain.current.then(run);
    chain.current = result.then(() => undefined);
    return result.then((ok) => {
      pending.current -= 1;
      if (ok && alive.current && pending.current === 0) {
        setSave({ kind: 'saved' });
        savedTimer.current = setTimeout(() => setSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)), SAVED_SHOWN_MS);
      }
      return ok;
    });
  }, [adopt]);

  const commitField = (field: Field): void => {
    const draft = drafts[field];
    const current = settingsRef.current;
    if (draft === undefined || current === null) return;
    const parsed = parseField(field, draft);
    if (!parsed.ok) {
      setFieldErrors((e) => ({ ...e, [field]: parsed.error }));
      return;
    }
    setFieldErrors((e) => ({ ...e, [field]: undefined }));
    if (parsed.value === current[field]) {
      setDrafts((d) => ({ ...d, [field]: undefined }));
      return;
    }
    // The draft stays until the server accepted the value, so a failed save never loses what was typed.
    void commit({ [field]: parsed.value }).then((ok) => {
      if (ok && alive.current) setDrafts((d) => ({ ...d, [field]: undefined }));
    });
  };

  const sendTest = (): void => {
    setTest({ kind: 'sending' });
    api.testNotification().then(
      (r) => {
        if (!alive.current) return;
        setTest(r.ok ? { kind: 'sent' } : { kind: 'failed', error: r.error });
        api.notificationSettings().then((x) => { if (alive.current) setStatus(x.status); }, () => {});
      },
      (e: unknown) => { if (alive.current) setTest({ kind: 'failed', error: errorText(e) }); },
    );
  };

  const shown = settings !== null && status !== null;
  useEffect(() => {
    if (!shown || focus !== 'usage-line') return;
    const input = document.getElementById(USAGE_LINE_INPUT_ID);
    if (!(input instanceof HTMLInputElement)) return;
    input.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
  }, [shown, focus]);

  if (settings === null || status === null) {
    return (
      <div className="notify">
        {loadError !== null ? <p className="error">加载失败：{loadError}</p> : <p className="muted">加载中…</p>}
      </div>
    );
  }

  return (
    <NotificationsView
      settings={settings} status={status} loadError={loadError} drafts={drafts} fieldErrors={fieldErrors} save={save} test={test}
      onCommit={(patch) => void commit(patch)}
      onDraft={(field, value) => {
        setDrafts((d) => ({ ...d, [field]: value }));
        setFieldErrors((x) => ({ ...x, [field]: undefined }));
      }}
      onField={commitField}
      onTest={sendTest}
    />
  );
}

export interface NotificationsViewProps {
  settings: NotificationSettings;
  status: NotificationStatus;
  loadError: string | null;
  drafts: Drafts;
  fieldErrors: FieldErrors;
  save: SaveState;
  test: TestState;
  /** Save a change of the switches. */
  onCommit: (patch: Partial<NotificationSettings>) => void;
  /** A typed field's text changed. */
  onDraft: (field: Field, value: string) => void;
  /** A typed field is done (blur, Enter): check and save it. */
  onField: (field: Field) => void;
  onTest: () => void;
}

/** The settings page once loaded: everything it shows comes in through the props. */
export function NotificationsView({
  settings, status, loadError, drafts, fieldErrors, save, test, onCommit, onDraft, onField, onTest,
}: NotificationsViewProps) {
  const { list: mask } = useMask();
  const off = !settings.enabled;
  // The usage line is never disabled: it colours the header and the stats block whatever the switches say.
  const numberField = (field: Field, label: string, unit: string, id: string, describedBy?: string) => {
    const err = fieldErrors[field];
    const described = [describedBy, err !== undefined ? `${id}-err` : undefined].filter((x) => x !== undefined).join(' ');
    return (
      <div className="notify-field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id} type="text" inputMode="numeric" autoComplete="off" disabled={off && field !== 'usageLineTokens'}
          value={drafts[field] ?? fieldText(field, settings)}
          aria-invalid={err !== undefined} aria-describedby={described === '' ? undefined : described}
          onChange={(e) => onDraft(field, e.target.value)}
          onBlur={() => onField(field)}
          onKeyDown={(e) => { if (e.key === 'Enter') onField(field); }}
        />
        <span className="muted">{unit}</span>
        {err !== undefined && <span id={`${id}-err`} className="notify-field-error">{err}</span>}
      </div>
    );
  };

  return (
    <div className="notify">
      <h1>通知</h1>
      <p className="muted">会话需要你的时候，在桌面上弹一条提醒。默认关着，打开后才会开始。</p>

      <p className={`notify-save${save.kind === 'saved' ? ' ok' : save.kind === 'failed' ? ' bad' : ''}`} role="status" aria-live="polite">
        {save.kind === 'saving' ? '保存中…' : save.kind === 'saved' ? '已保存' : save.kind === 'failed' ? `保存失败：${save.error}` : ''}
      </p>

      {loadError !== null && <p className="error" style={{ padding: 0 }}>刷新失败：{loadError}</p>}

      <section aria-labelledby="notify-main-h">
        <h2 id="notify-main-h">总开关</h2>
        <div className="notify-row">
          <input
            id="notify-enabled" className="notify-switch" type="checkbox" checked={settings.enabled}
            onChange={(e) => onCommit({ enabled: e.target.checked })}
          />
          <div className="notify-row-body">
            <label className="notify-row-title" htmlFor="notify-enabled">开启通知</label>
            <p className="muted">关着的时候下面的设置照样能改，只是不会弹出。</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="notify-kinds-h">
        <h2 id="notify-kinds-h">什么时候提醒</h2>
        {NOTIFICATION_KINDS.map((k) => (
          <div className="notify-row" key={k.key}>
            <input
              id={`notify-${k.key}`} className="notify-switch" type="checkbox" checked={settings[k.key]} disabled={off}
              aria-describedby={`notify-${k.key}-d notify-${k.key}-n`}
              onChange={(e) => onCommit({ [k.key]: e.target.checked })}
            />
            <div className="notify-row-body">
              <label className="notify-row-title" htmlFor={`notify-${k.key}`}>{k.label}</label>
              <p id={`notify-${k.key}-d`} className="muted">{k.hint}</p>
              <p id={`notify-${k.key}-n`} className="muted">各来源：{k.note}</p>
              {k.key === 'finished' && numberField('finishedMinSeconds', '最短时长（秒）', '填 0 表示每一轮都提醒', 'notify-min-seconds')}
              {k.key === 'stuck' && numberField('stuckMinutes', '卡住多久算卡住（分钟）', '最少 1 分钟', 'notify-stuck-minutes')}
              {k.key === 'usage' && (
                <>
                  {numberField('usageLineTokens', '提醒线（万 token）', '1 万 = 10,000；空着就是不设', USAGE_LINE_INPUT_ID, 'notify-usage-line-d')}
                  <p id="notify-usage-line-d" className="muted">
                    提醒线不受上面的开关管：设了线，顶栏的“今天”和统计页的“今天”区块到线就变色，不发通知也会变色。
                  </p>
                </>
              )}
            </div>
          </div>
        ))}
      </section>

      <section aria-labelledby="notify-test-h">
        <h2 id="notify-test-h">试一试</h2>
        <button type="button" className="notify-btn" disabled={test.kind === 'sending'} onClick={onTest}>
          {test.kind === 'sending' ? '发送中…' : '发一条测试通知'}
        </button>
        <p className={`notify-result${test.kind === 'sent' ? ' ok' : test.kind === 'failed' ? ' bad' : ''}`} role="status" aria-live="polite">
          {test.kind === 'sent' ? '已发送，看看屏幕右下角' : test.kind === 'failed' ? `没发出去：${mask.text(test.error)}` : ''}
        </p>
      </section>

      <DeliveryStatus status={status} />

      <p className="muted notify-privacy">通知只在这台电脑上弹出，不联网；内容只有项目名和会话标题，不含对话内容。</p>
    </div>
  );
}
