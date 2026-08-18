import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, CircleAlert, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { UploadQueue, UploadTask } from '@/lib/use-upload-queue'

const BYTES_PER_MB = 1024 * 1024

function megabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}

function TaskRow({ task }: { task: UploadTask }) {
  const percent = task.totalBytes === 0 ? 0 : Math.round((task.sentBytes / task.totalBytes) * 100)

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs" title={task.fileName}>
          {task.fileName}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {task.status === 'done' && <Check className="inline size-3" aria-label="完了" />}
          {task.status === 'queued' && '待機中'}
          {task.status === 'sending' && `${percent}%`}
          {task.status === 'failed' && (
            <span className="text-destructive">{task.errorMessage ?? '失敗'}</span>
          )}
        </span>
      </div>
      {task.status !== 'failed' && <Progress value={task.sentBytes} max={task.totalBytes || 1} />}
    </li>
  )
}

export function UploadTray({ queue }: { queue: UploadQueue }) {
  const [expanded, setExpanded] = useState(false)

  if (queue.tasks.length === 0) return null

  const { tasks, active, doneCount, failedCount, sentBytes, totalBytes } = queue
  const percent = totalBytes === 0 ? 0 : Math.round((sentBytes / totalBytes) * 100)

  return (
    // Fixed rather than inline so the progress stays visible while the member
    // scrolls the grid, and matched to the album column so it reads as part of
    // the same page.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 p-4">
      <div className="pointer-events-auto mx-auto flex max-w-2xl flex-col gap-2 rounded-xl bg-card p-3 shadow-lg ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-2">
          {/* "0件を追加しました" reads as a success when nothing got through,
              so a batch that ends with nothing added says so instead. */}
          <span className="text-sm font-medium">
            {active
              ? `追加中 ${doneCount}/${tasks.length}`
              : doneCount === 0
                ? '追加できませんでした'
                : `${doneCount}件を追加しました`}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={expanded ? 'ファイル一覧を隠す' : 'ファイル一覧を表示'}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? <ChevronDown /> : <ChevronUp />}
            </Button>
            {active ? (
              <Button variant="ghost" size="sm" onClick={queue.cancelAll}>
                中止
              </Button>
            ) : (
              <Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={queue.dismiss}>
                <X />
              </Button>
            )}
          </div>
        </div>

        <Progress value={sentBytes} max={totalBytes || 1} />

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {megabytes(sentBytes)} / {megabytes(totalBytes)}
            {active && ` · ${percent}%`}
          </span>
          {failedCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-destructive">
                <CircleAlert className="size-3" />
                {failedCount}件失敗
              </span>
              <Button variant="outline" size="xs" onClick={queue.retryFailed}>
                <RotateCw />
                再試行
              </Button>
            </span>
          )}
        </div>

        {expanded && (
          <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto border-t border-border pt-2">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
