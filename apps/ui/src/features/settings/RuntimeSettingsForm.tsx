import { useEffect, useState } from 'react';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { LanguageSwitch } from '../../shared/ui/LanguageSwitch';
import { PanelFeedback, PanelSection } from '../../shared/ui/PanelContent';
import type { RuntimeSettings } from '../status/system';
interface SettingsDraft {
  pollSeconds: string;
  retentionDays: string;
  minFreeGiB: string;
}
const GIB = 1024 ** 3;
const SETTINGS_MAX_FREE_BYTES = 2 ** 50;

function settingsToDraft(settings: RuntimeSettings): SettingsDraft {
  return {
    pollSeconds: String(settings.pollMs / 1000),
    retentionDays: String(settings.retentionDays),
    minFreeGiB: String(settings.minFreeBytes / GIB),
  };
}

export function RuntimeSettingsForm({
  settings,
  onSaved,
  recording,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings) => Promise<void>;
  recording: React.ReactNode;
}): JSX.Element {
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsToDraft(settings));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!dirty) setDraft(settingsToDraft(settings));
  }, [settings.pollMs, settings.retentionDays, settings.minFreeBytes, dirty]);

  function edit(field: keyof SettingsDraft, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setDirty(true);
    setError('');
    setMessage('');
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setMessage('');

    const pollSeconds = Number(draft.pollSeconds);
    const pollMsFloat = pollSeconds * 1000;
    const retentionDays = Number(draft.retentionDays);
    const minFreeGiB = Number(draft.minFreeGiB);
    const minFreeBytesFloat = minFreeGiB * GIB;
    const minFreeBytes = Math.round(minFreeBytesFloat);
    if (
      !Number.isFinite(pollSeconds) ||
      pollMsFloat < 1000 ||
      pollMsFloat > 300000 ||
      !Number.isInteger(pollMsFloat)
    ) {
      setError(tr('轮询间隔须为 1–300 秒，最多精确到毫秒（小数点后三位）。'));
      return;
    }
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      setError(tr('保留天数须为 0–3650 的整数；0 表示永久保留。'));
      return;
    }
    if (
      !Number.isFinite(minFreeGiB) ||
      minFreeGiB < 0 ||
      minFreeBytesFloat > SETTINGS_MAX_FREE_BYTES ||
      !Number.isSafeInteger(minFreeBytes)
    ) {
      setError(tr('最低剩余空间须为 0–1048576 GiB，并换算为整数 Byte。'));
      return;
    }
    const values: RuntimeSettings = {
      pollMs: pollMsFloat,
      retentionDays,
      minFreeBytes,
    };
    setSaving(true);
    try {
      const saved = await request<RuntimeSettings>('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      setDraft(settingsToDraft(saved));
      setDirty(false);
      setMessage(tr('设置已保存'));
      void onSaved(saved).catch((cause: unknown) => setError(messageFor(cause)));
    } catch (cause) {
      setError(tr('设置保存失败：{{v0}}', { v0: messageFor(cause) }));
    } finally {
      setSaving(false);
    }
  }

  function resetDraft(): void {
    setDraft(settingsToDraft(settings));
    setDirty(false);
    setError('');
    setMessage('');
  }

  return (
    <div className="runtime-settings">
      <PanelSection title={tr('即时生效')}>
        <LanguageSwitch />
        {recording}
      </PanelSection>
      <form onSubmit={(event) => void submit(event)}>
        <PanelSection title={tr('同步与存储')}>
          <label className="field">
            <span>{tr('统一同步间隔（秒）')}</span>
            <input
              type="number"
              min="1"
              max="300"
              step="0.001"
              value={draft.pollSeconds}
              disabled={saving}
              onChange={(event) => edit('pollSeconds', event.target.value)}
            />
            <small>{tr('清单、状态、图片和时间线共用此间隔。')}</small>
          </label>
          <label className="field">
            <span>{tr('录像保留天数')}</span>
            <input
              type="number"
              min="0"
              max="3650"
              step="1"
              value={draft.retentionDays}
              disabled={saving}
              onChange={(event) => edit('retentionDays', event.target.value)}
            />
            <small>{tr('0 为永久保留。')}</small>
          </label>
          <label className="field">
            <span>{tr('最低剩余空间（GiB）')}</span>
            <input
              type="number"
              min="0"
              max="1048576"
              step="0.001"
              value={draft.minFreeGiB}
              disabled={saving}
              onChange={(event) => edit('minFreeGiB', event.target.value)}
            />
            <small>{tr('低于阈值时暂停录制；0 关闭保护。')}</small>
          </label>
          {error && <PanelFeedback kind="error">{error}</PanelFeedback>}
        </PanelSection>
        {message && <PanelFeedback kind="success">{message}</PanelFeedback>}
        <div className="panel-actions">
          <button className="primary" disabled={saving || !dirty}>
            {saving ? tr('保存中…') : tr('保存运行设置')}
          </button>
          {dirty && (
            <button
              className="text-button"
              type="button"
              disabled={saving || !dirty}
              onClick={resetDraft}
            >
              {tr('撤销未保存修改')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
