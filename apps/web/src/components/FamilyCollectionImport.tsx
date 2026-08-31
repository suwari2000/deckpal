import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type FamilyCollectionImportPreview } from '../lib/api'

export function FamilyCollectionImport() {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<FamilyCollectionImportPreview | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [applied, setApplied] = useState<number | null>(null)
  const check = useMutation({
    mutationFn: () => api.previewFamilyCollectionImport(text),
    onSuccess: (result) => { setPreview(result); setAcknowledged(false); setApplied(null) },
  })
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const commit = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('Preview is required')
      const byVariant = new Map<number, { quantity: number; condition: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' }>()
      for (const item of preview.matched) {
        const condition = item.condition as 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'
        const current = byVariant.get(item.variantId)
        byVariant.set(item.variantId, { quantity: (current?.quantity ?? 0) + item.quantity, condition })
      }
      const rows = [...byVariant].map(([variantId, item]) => ({
        variantId,
        quantity: item.quantity,
        condition: item.condition,
      }))

      // The parser accepts 5,000 rows but `POST /collection/batch` refuses more
      // than 250 (BATCH_MAX_ITEMS, a ceiling on the API's own 30 s RLS hold), so
      // a real collection previewed clean and then failed on commit with
      // "items must be 250 or fewer". Send it in chunks instead of asking the
      // reader to split the file by hand.
      //
      // Sequential, not parallel: each batch recomputes set progress, and the
      // pool is small. `preview.matched` is ordered by cardId, so a chunk spans
      // only a few sets and stays clear of BATCH_MAX_SETS (40) as well.
      //
      // The idempotency key carries the chunk index. Without it every chunk
      // after the first would collide with the first one's key and be answered
      // from that batch's stored response — reporting success while writing
      // nothing (migration 036).
      const CHUNK = 200
      const chunks: typeof rows[] = []
      for (let index = 0; index < rows.length; index += CHUNK) chunks.push(rows.slice(index, index + CHUNK))

      setProgress({ done: 0, total: chunks.length })
      let applied = 0
      for (const [index, chunk] of chunks.entries()) {
        const result = await api.collectionBatch(chunk, {
          source: 'web',
          note: 'Import koleksi DeckPal ke akaun admin',
          idempotencyKey: `family-import:${preview.fingerprint}:${index}`,
        })
        applied += result.applied
        setProgress({ done: index + 1, total: chunks.length })
      }
      return { applied }
    },
    onSuccess: async (result) => {
      setApplied(result.applied)
      setProgress(null)
      await queryClient.invalidateQueries({ queryKey: ['family', 'members'] })
      await queryClient.invalidateQueries({ queryKey: ['family'] })
    },
    onError: () => setProgress(null),
  })
  const hasWarnings = !!preview && (preview.ambiguous.length > 0 || preview.unresolved.length > 0 || preview.errors.length > 0)

  return (
    <section className="rounded-[20px] border border-border-default bg-surface-raised p-[18px] shadow-sm lg:col-span-2">
      <h2 className="text-[20px] font-bold text-text-primary">Import koleksi asal ke akaun admin</h2>
      <p className="mt-[5px] text-[14px] text-text-secondary">Terima JSON atau CSV dengan lajur <span className="font-mono">cardId, finish, quantity, condition</span>. Akaun ahli keluarga lain kekal kosong.</p>
      <div className="mt-[14px] grid gap-[12px] lg:grid-cols-[1fr_220px]">
        <textarea value={text} onChange={(event) => { setText(event.target.value); setPreview(null); setApplied(null) }} rows={8} placeholder={'cardId,finish,quantity,condition\nsv3-125,normal,1,NM'} className="rounded-[12px] border border-border-default bg-surface-primary p-[11px] font-mono text-[12px] text-text-primary" />
        <div className="flex flex-col gap-[9px]">
          <label className="rounded-[12px] border border-dashed border-border-default p-[12px] text-center text-[12px] font-semibold text-text-secondary">
            Pilih fail JSON / CSV
            <input type="file" accept=".json,.csv,application/json,text/csv" className="hidden" onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void file.text().then((value) => { setText(value); setPreview(null); setApplied(null) })
              event.target.value = ''
            }} />
          </label>
          <button type="button" disabled={!text.trim() || check.isPending} onClick={() => check.mutate()} className={PRIMARY}>{check.isPending ? 'Memeriksa…' : 'Preview import'}</button>
          {preview && <button type="button" disabled={commit.isPending || preview.matched.length === 0 || (hasWarnings && !acknowledged)} onClick={() => commit.mutate()} className={PRIMARY}>{commit.isPending ? (progress && progress.total > 1 ? `Mengimport… ${progress.done}/${progress.total}` : 'Mengimport…') : `Import ${preview.matched.length} baris`}</button>}
        </div>
      </div>
      {preview && (
        <div className="mt-[14px] rounded-[14px] bg-surface-secondary p-[13px] text-[13px]">
          <p className="font-semibold text-text-primary">{preview.matched.length} sepadan · {preview.ambiguous.length} perlu semakan · {preview.unresolved.length} tidak dijumpai</p>
          {preview.errors.map((item) => <p key={`${item.row}:${item.message}`} className="mt-[4px] text-status-danger">Baris {item.row}: {item.message}</p>)}
          {preview.ambiguous.map((item) => <p key={`${item.cardId}:${item.finish}`} className="mt-[4px] text-status-warning">{item.cardId} ({item.finish}): lebih daripada satu printing sepadan.</p>)}
          {preview.unresolved.map((item) => <p key={`${item.cardId}:${item.finish}`} className="mt-[4px] text-status-danger">{item.cardId} ({item.finish}): tidak dijumpai.</p>)}
          {hasWarnings && <label className="mt-[9px] flex items-start gap-[8px] text-text-secondary"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-[2px]" />Saya faham baris yang tidak sepadan tidak akan diimport.</label>}
        </div>
      )}
      {applied !== null && <p className="mt-[12px] text-[13px] font-bold text-change-positive">Import selesai: {applied} kuantiti printing dikemas kini dalam akaun admin.</p>}
      {(check.error || commit.error) && <p className="mt-[10px] text-[13px] text-status-danger">{(check.error ?? commit.error) instanceof Error ? (check.error ?? commit.error as Error).message : 'Import tidak berjaya.'}</p>}
    </section>
  )
}

const PRIMARY = 'rounded-full bg-action-primary px-[15px] py-[9px] text-[12px] font-bold text-action-primary-text disabled:opacity-50'
