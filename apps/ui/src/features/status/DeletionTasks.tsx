import type { MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { ProgressRing } from '../../shared/ui/ProgressRing';
import { OverflowText } from '../../shared/ui/OverflowText';
import { tr } from '../../shared/lib/i18n';
/** Temporary archive-service activity; completion removes the entire line. */
export function DeletionTasks({
  jobs,
  subjects,
  inline = false,
}: {
  jobs: MediaDeletionJob[];
  subjects: Subject[];
  inline?: boolean;
}): JSX.Element | null {
  const active = jobs.filter((job) => job.state !== 'completed');
  if (!active.length) return null;
  const text = active
    .map((job) => {
      const name =
        subjects.find((subject) => subject.id === job.subjectId)?.handle ?? job.subjectId;
      const progress = job.total ? Math.min(100, Math.floor((job.processed / job.total) * 100)) : 0;
      const stage =
        job.state === 'failed'
          ? '删除未完成'
          : job.error
            ? '等待恢复'
            : job.state === 'preparing'
              ? job.phase === 'plan'
                ? '正在整理分片'
                : '正在准备删除'
              : job.state === 'retry'
                ? '等待恢复'
                : job.state === 'queued' && !job.processed
                  ? '等待执行'
                  : '正在删除';
      const detail =
        job.state === 'failed'
          ? job.error && !/^[a-z_]+$/.test(job.error)
            ? job.error
            : tr('准备失败，原画面已保留。')
          : job.error
            ? tr('后台暂不可用，将自动继续。')
            : job.state === 'preparing'
              ? job.phase === 'plan'
                ? tr('已核对 {{v0}} 个分片', { v0: job.total.toLocaleString() })
                : tr('已检查 {{v0}} · 已选 {{v1}} 个单元', {
                    v0: (job.scannedUnits ?? 0).toLocaleString(),
                    v1: (job.selectedUnits ?? 0).toLocaleString(),
                  })
              : `${tr('已处理 {{v0}} / {{v1}} 个分片', { v0: job.processed.toLocaleString(), v1: job.total.toLocaleString() })} (${progress}%)`;
      return `${tr(stage)} · ${name} · ${detail}`;
    })
    .join('　／　');
  const Container = inline ? 'span' : 'div';
  return (
    <Container className="archive-activity" role="status" aria-live="polite">
      {active.some((job) => job.state !== 'failed') && <ProgressRing />}
      <OverflowText text={text} />
    </Container>
  );
}
