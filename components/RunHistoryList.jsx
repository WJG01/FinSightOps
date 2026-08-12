import Link from "next/link";
import {
  MOCK_RUNS,
  getStageCompletion,
  formatTimestamp,
  totalRunDurationSeconds,
  formatDuration,
} from "@/lib/mockRuns";

const STATUS_BADGE = {
  running: "bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/25",
  completed: "bg-green-500/10 text-green-400 ring-1 ring-green-500/25",
  failed: "bg-red-500/10 text-red-400 ring-1 ring-red-500/25",
};

export default function RunHistoryList() {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-6 py-4 text-sm font-semibold text-white">
        Run History
      </div>

      <div className="divide-y divide-slate-800">
        {MOCK_RUNS.map((run) => {
          const { complete, total } = getStageCompletion(run);
          const durationSeconds = totalRunDurationSeconds(run);

          return (
            <div
              key={run.id}
              className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-slate-800/50"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-xs text-slate-400">{run.id}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-[0.68rem] font-mono font-medium capitalize ${STATUS_BADGE[run.status]}`}
                  >
                    {run.status}
                  </span>
                </div>
                {/* <div className="text-xs text-slate-500">
                  {formatTimestamp(run.startedAt)} · Triggered by {run.triggeredBy}
                </div> */}
              </div>

              <div className="flex items-center gap-6 text-xs text-slate-400">
                <div className="text-center">
                  <div className="font-mono text-sm text-slate-200">
                    {complete}/{total}
                  </div>
                  <div>Stages</div>
                </div>
                <div className="text-center">
                  <div className="font-mono text-sm text-slate-200">
                    {run.documentsProcessed}/{run.documentsTotal}
                  </div>
                  <div>Documents</div>
                </div>
                <div className="text-center">
                  <div className="font-mono text-sm text-slate-200">
                    {run.status === "running" ? "—" : formatDuration(durationSeconds)}
                  </div>
                  <div>Duration</div>
                </div>
              </div>

              <Link
                href={`/run/${run.id}`}
                className="shrink-0 rounded-md border border-slate-700 px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-amber-400 hover:text-amber-400"
              >
                Details
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
