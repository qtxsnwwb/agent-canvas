/**
 * The masking switch's state for the app's pages (spec 5): on / off (remembered in this browser, read synchronously at
 * start, so the first render already knows), the custom terms (the export settings on the server) and the maskers built
 * from them. Rendered by App.tsx only: the exported viewer has no provider (its data is masked already) and must not
 * load this module (it reaches the API client).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ExportSettingsResponse } from '@agent-canvas/shared';
import { api, failureOf } from './client';
import { settingsView, type SettingsView } from './export';
import { IDENTITY_MASKER, MASK_SWITCH_KEY, createPageMasker, parseMaskSwitch, serializeMaskSwitch, type PageMasker } from './masking';

/** How long pages wait for the custom terms (switch on) before rendering with the built-in rules. */
export const TERMS_WAIT_MS = 1_000;

/** The open session's learned-values state (POST …/mask/learned), shown next to the switch. */
export type SessionLearning = 'idle' | 'loading' | 'done' | 'partial';

export interface MaskState {
  on: boolean;
  setOn(on: boolean): void;
  /**
   * False while the switch is on and the custom terms are still loading, for at most TERMS_WAIT_MS: pages are not
   * rendered yet, so a custom term never flashes on screen unmasked. After that they render with the built-in rules
   * (the switch shows a note) and are masked again when the terms arrive.
   */
  ready: boolean;
  /** The cross-session lists' masker (unnumbered); the identity when off. */
  list: PageMasker;
  /** One session's masker (numbered, one per session id until the switch or the terms change); the identity when off. */
  forSession(sessionId: string): PageMasker;
  /** Forget a session's masker (and the values it learned) when its page closes. */
  dropSession(sessionId: string): void;
  /** The custom terms as loaded (also what the export dialog edits). */
  settings: SettingsView;
  /** After the export dialog saved the terms: use the answer (the maskers are rebuilt). */
  settingsSaved(r: ExportSettingsResponse): void;
  reloadSettings(): void;
  sessionLearning: SessionLearning;
  setSessionLearning(s: SessionLearning): void;
}

const OFF: MaskState = {
  on: false, setOn: () => {}, ready: true, list: IDENTITY_MASKER, forSession: () => IDENTITY_MASKER, dropSession: () => {},
  settings: { state: 'loading', terms: [], note: null }, settingsSaved: () => {}, reloadSettings: () => {},
  sessionLearning: 'idle', setSessionLearning: () => {},
};

const MaskContext = createContext<MaskState>(OFF);

export const useMask = (): MaskState => useContext(MaskContext);

/** Session maskers kept at once (the open session and the ones just left). */
const SESSION_MASKERS = 3;

function readSwitch(): boolean {
  try { return parseMaskSwitch(window.localStorage.getItem(MASK_SWITCH_KEY)); } catch { return false; }
}

export function MaskProvider({ children }: { children: ReactNode }) {
  const [on, setOnState] = useState(readSwitch);
  const setOn = useCallback((next: boolean) => {
    try { window.localStorage.setItem(MASK_SWITCH_KEY, serializeMaskSwitch(next)); } catch { /* not remembered */ }
    setOnState(next);
  }, []);
  const [loaded, setLoaded] = useState<{ r: ExportSettingsResponse | null; error: number | 'network' | null }>({ r: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api.exportSettings().then(
      (r) => { if (alive) setLoaded({ r, error: null }); },
      (e: unknown) => {
        if (!alive) return;
        const f = failureOf(e);
        setLoaded((prev) => ({ r: prev.r, error: f === 'abort' ? 'network' : f }));
      },
    );
    return () => { alive = false; };
  }, [attempt]);
  const settings = useMemo(() => settingsView(loaded.r, loaded.error), [loaded]);
  // The wait for the terms ends after TERMS_WAIT_MS at most.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (settings.state !== 'loading') return;
    const t = setTimeout(() => setWaited(true), TERMS_WAIT_MS);
    return () => clearTimeout(t);
  }, [settings.state]);
  const [sessionLearning, setSessionLearning] = useState<SessionLearning>('idle');
  // Only the terms that are in force: none while loading, after a failed load or with a damaged file.
  const terms = settings.state === 'ok' ? settings.terms : [];
  const termsKey = JSON.stringify(terms);
  const maskers = useMemo(() => {
    const customTerms = JSON.parse(termsKey) as string[];
    const list = on ? createPageMasker({ customTerms, numbered: false }) : IDENTITY_MASKER;
    const sessions = new Map<string, PageMasker>();
    const forSession = (sessionId: string): PageMasker => {
      if (!on) return IDENTITY_MASKER;
      let m = sessions.get(sessionId);
      if (m === undefined) {
        m = createPageMasker({ customTerms, numbered: true });
        sessions.set(sessionId, m);
        if (sessions.size > SESSION_MASKERS) sessions.delete(sessions.keys().next().value!);
      }
      return m;
    };
    return { list, forSession, dropSession: (id: string) => void sessions.delete(id) };
  }, [on, termsKey]);
  const value = useMemo<MaskState>(() => ({
    on, setOn, ready: !on || settings.state !== 'loading' || waited, ...maskers, settings,
    settingsSaved: (r) => setLoaded({ r, error: null }),
    reloadSettings: () => setAttempt((n) => n + 1),
    sessionLearning, setSessionLearning,
  }), [on, setOn, maskers, settings, waited, sessionLearning]);
  return <MaskContext.Provider value={value}>{children}</MaskContext.Provider>;
}

/**
 * The header's switch: a real toggle button (aria-pressed). While on, its label says so (遮蔽中, a different picture and
 * a filled style — not colour alone). Next to it: a note while the custom terms or the open session's learned values
 * are loading, a warning when the terms could not be loaded or the session's values were not all found.
 */
export function MaskSwitch() {
  const { on, setOn, settings, sessionLearning } = useMask();
  const termsMissing = on && (settings.state === 'error' || settings.state === 'damaged');
  return (
    <span className="mask-switch">
      <button type="button" className="mask-toggle" aria-pressed={on} onClick={() => setOn(!on)}
        title={on ? '正在遮蔽：页面上的密钥、密码和自定义词显示成占位符。点一下关闭' : '打开后，页面上的密钥、密码和自定义词显示成占位符（投屏、截图时用）'}>
        <span className="mask-icon" aria-hidden="true">{on ? '🙈' : '👁'}</span>
        <span className="mask-label">{on ? '遮蔽中' : '遮蔽'}</span>
      </button>
      {on && settings.state === 'loading' && <span className="mask-note" role="status">自定义词还没加载</span>}
      {termsMissing && (
        <span className="mask-warn" role="status" title={settings.note ?? ''}>⚠<span className="mask-warn-text"> 自定义词没有生效</span></span>
      )}
      {on && sessionLearning === 'loading' && <span className="mask-note" role="status">正在识别这个会话里的敏感值…</span>}
      {on && sessionLearning === 'partial' && (
        <span className="mask-warn" role="status" title="这个会话的敏感值没有识别全，个别地方可能没遮住">
          ⚠<span className="mask-warn-text"> 这个会话的敏感值没有识别全，个别地方可能没遮住</span>
        </span>
      )}
    </span>
  );
}
