import { MoreVertical } from 'lucide-react'
import type { MouseEvent } from 'react'
import { Card } from '@/components/ui/card'
import { FileIcon } from '@/components/drive/FileIcon'
import type { FileItem } from '@/data/drive-data'

export function FileGrid({ files, selectedFileIds = new Set<string>(), onFileContextMenu, onToggleFile }: { files: FileItem[]; selectedFileIds?: Set<string>; onFileContextMenu?: (event: MouseEvent<HTMLElement>, file: FileItem) => void; onToggleFile?: (file: FileItem) => void }) {
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {files.map((file) => {
        const selected = selectedFileIds.has(file.id ?? '')
        return (
          <Card key={file.id ?? file.name} onClick={() => onToggleFile?.(file)} onContextMenu={(event) => onFileContextMenu?.(event, file)} className={selected ? 'relative cursor-pointer overflow-hidden border-blue-200 bg-blue-50 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md' : 'relative cursor-pointer overflow-hidden p-4 transition hover:-translate-y-0.5 hover:shadow-md'}>
            <div className="flex items-start justify-between gap-2">
              <input type="checkbox" className="h-5 w-5 shrink-0 accent-blue-600" checked={selected} onChange={() => onToggleFile?.(file)} onClick={(event) => event.stopPropagation()} />
              <button className="-mr-2 -mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-white/80" onClick={(event) => { event.stopPropagation(); onFileContextMenu?.(event, file) }} aria-label={`Open ${file.name} menu`}><MoreVertical className="h-5 w-5" /></button>
            </div>

            <div className="mt-5 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-700 sm:h-20 sm:w-20">
                <FileIcon kind={file.kind} className="h-9 w-9 rounded-xl p-2 sm:h-11 sm:w-11" />
              </div>
            </div>

            <div className="mt-5 min-w-0 text-center">
              <h3 className="line-clamp-2 min-h-10 text-sm font-extrabold text-slate-950" title={file.name}>{file.name}</h3>
              <p className="mt-2 truncate text-xs text-slate-500">{file.date}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs font-semibold text-slate-600">
                <span className="rounded-full bg-slate-100 px-2.5 py-1">{file.size}</span>
                <span className="max-w-full truncate rounded-full bg-slate-100 px-2.5 py-1">{file.access}</span>
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
