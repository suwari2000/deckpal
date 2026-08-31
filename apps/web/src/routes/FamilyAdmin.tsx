import { useEffect, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { canOpenFamilyAdmin } from './familyState'
import { FamilyCollectionImport } from '../components/FamilyCollectionImport'

export function FamilyAdmin() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const me = useQuery({ queryKey: ['family', 'me'], queryFn: ({ signal }) => api.familyMe(signal) })
  const allowed = canOpenFamilyAdmin(me.data?.family)
  const members = useQuery({ queryKey: ['family', 'members'], queryFn: ({ signal }) => api.familyMembers(signal), enabled: allowed })
  const invites = useQuery({ queryKey: ['family', 'invitations'], queryFn: ({ signal }) => api.familyInvitations(signal), enabled: allowed })
  const ai = useQuery({ queryKey: ['family', 'ai-usage'], queryFn: ({ signal }) => api.familyAiUsage(signal), enabled: allowed })
  const [aiEnabled, setAiEnabled] = useState(true)
  const [defaultLimit, setDefaultLimit] = useState(5)
  useEffect(() => {
    if (!ai.data) return
    setAiEnabled(ai.data.settings.enabled)
    setDefaultLimit(ai.data.settings.defaultDailyLimit)
  }, [ai.data])
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['family', 'members'] })
    await queryClient.invalidateQueries({ queryKey: ['family', 'invitations'] })
    await queryClient.invalidateQueries({ queryKey: ['family', 'ai-usage'] })
  }
  // The link is shown once, in the panel, for the admin to copy — DeckPal sends
  // no email and neither does Supabase, so this is the only place it appears.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const invite = useMutation({
    mutationFn: (address: string) => api.inviteFamilyMember(address),
    onSuccess: async (data) => { setEmail(''); setInviteUrl(data.inviteUrl); setCopied(false); await refresh() },
  })
  const relink = useMutation({
    mutationFn: (id: string) => api.regenerateFamilyInviteLink(id),
    onSuccess: (data) => { setInviteUrl(data.inviteUrl); setCopied(false) },
  })
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeFamilyInvitation(id), onSuccess: refresh })
  const status = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: 'active' | 'disabled' }) => api.setFamilyMemberStatus(userId, next),
    onSuccess: refresh,
  })
  const aiSettings = useMutation({
    mutationFn: () => api.updateFamilyAiSettings({ enabled: aiEnabled, defaultDailyLimit: defaultLimit }),
    onSuccess: refresh,
  })
  const aiMember = useMutation({
    mutationFn: ({ userId, dailyLimit, bonusRemaining }: { userId: string; dailyLimit: number | null; bonusRemaining: number }) =>
      api.updateFamilyMemberAiLimit(userId, { dailyLimit, bonusRemaining }),
    onSuccess: refresh,
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (email.trim()) invite.mutate(email.trim())
  }

  if (me.isLoading) return <Page><p className="text-text-muted">Memuatkan…</p></Page>
  if (!allowed) return <Page><p className="text-text-secondary">Halaman ini hanya untuk admin keluarga.</p></Page>

  return (
    <Page>
      <div className="mb-[22px] flex items-center justify-between gap-[12px]">
        <div><p className="text-[13px] font-bold uppercase tracking-[0.12em] text-text-muted">Admin</p><h1 className="text-[32px] font-extrabold text-text-primary">Urus keluarga</h1></div>
        <Link to="/family" className={SECONDARY}>Kembali ke koleksi</Link>
      </div>

      <div className="mb-[18px] flex justify-end">
        <Link to="/family/admin/prices" className={PRIMARY}>Semak cadangan harga</Link>
      </div>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <Panel>
          <h2 className="text-[20px] font-bold text-text-primary">Jemput ahli</h2>
          <p className="mt-[5px] text-[14px] text-text-secondary">Akaun hanya boleh dibuat melalui pautan jemputan admin. DeckPal tidak menghantar e-mel — salin pautan dan hantar sendiri (WhatsApp, Telegram, apa sahaja).</p>
          <form onSubmit={submit} className="mt-[16px] flex flex-col gap-[10px] sm:flex-row">
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="ahli@keluarga.com" className="min-w-0 flex-1 rounded-[12px] border border-border-default bg-surface-primary px-[13px] py-[10px] text-text-primary" />
            <button disabled={invite.isPending} className={PRIMARY}>{invite.isPending ? 'Menjana…' : 'Jana pautan'}</button>
          </form>
          {invite.error && <ErrorText error={invite.error} />}
          {relink.error && <ErrorText error={relink.error} />}
          {inviteUrl && <InviteLink url={inviteUrl} copied={copied} onCopied={setCopied} />}
          <div className="mt-[18px] space-y-[9px]">
            {invites.data?.invitations.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-[10px] rounded-[12px] border border-border-default p-[11px]">
                <div className="min-w-0"><p className="truncate font-semibold text-text-primary">{item.email}</p><p className="text-[12px] text-text-muted">{item.status}</p></div>
                {item.status === 'pending' && (
                  <div className="flex shrink-0 gap-[8px]">
                    <button className={SECONDARY} disabled={relink.isPending} onClick={() => relink.mutate(item.id)}>Pautan baharu</button>
                    <button className={DANGER} onClick={() => revoke.mutate(item.id)}>Batalkan</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="text-[20px] font-bold text-text-primary">Akaun ahli</h2>
          <div className="mt-[16px] space-y-[9px]">
            {members.data?.members.map((member) => (
              <div key={member.userId} className="flex items-center justify-between gap-[10px] rounded-[12px] border border-border-default p-[11px]">
                <div><p className="font-semibold text-text-primary">{member.displayName ?? member.username}</p><p className="text-[12px] text-text-muted">{member.role} · {member.status}</p></div>
                {member.role !== 'admin' && (
                  <button className={member.status === 'disabled' ? SECONDARY : DANGER} onClick={() => status.mutate({ userId: member.userId, next: member.status === 'disabled' ? 'active' : 'disabled' })}>
                    {member.status === 'disabled' ? 'Aktifkan' : 'Nyahaktif'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <h2 className="text-[20px] font-bold text-text-primary">Had imbasan AI</h2>
          <p className="mt-[5px] text-[14px] text-text-secondary">Imbasan percuma digunakan dahulu. Claude hanya digunakan selepas ahli memberi persetujuan.</p>
          <div className="mt-[16px] flex flex-wrap items-end gap-[12px]">
            <label className="flex items-center gap-[8px] text-[14px] font-semibold text-text-primary">
              <input type="checkbox" checked={aiEnabled} onChange={(event) => setAiEnabled(event.target.checked)} />
              Benarkan imbasan AI
            </label>
            <label className="text-[12px] font-semibold text-text-muted">
              Had lalai setiap ahli / hari
              <input
                type="number"
                min={0}
                max={100}
                value={defaultLimit}
                onChange={(event) => setDefaultLimit(Math.max(0, Math.min(100, Number(event.target.value))))}
                className="mt-[4px] block w-[110px] rounded-[10px] border border-border-default bg-surface-primary px-[10px] py-[8px] text-text-primary"
              />
            </label>
            <button type="button" disabled={aiSettings.isPending} onClick={() => aiSettings.mutate()} className={PRIMARY}>
              {aiSettings.isPending ? 'Menyimpan…' : 'Simpan had'}
            </button>
          </div>
          {aiSettings.error && <ErrorText error={aiSettings.error} />}

          <div className="mt-[18px] space-y-[10px]">
            {members.data?.members.filter((member) => member.status === 'active').map((member) => {
              const limit = ai.data?.memberLimits.find((item) => item.userId === member.userId)
              return (
                <AiMemberControl
                  key={`${member.userId}:${limit?.dailyLimit ?? 'default'}:${limit?.bonusRemaining ?? 0}`}
                  name={member.displayName ?? member.username}
                  userId={member.userId}
                  dailyLimit={limit?.dailyLimit ?? null}
                  bonusRemaining={limit?.bonusRemaining ?? 0}
                  defaultLimit={defaultLimit}
                  pending={aiMember.isPending}
                  onSave={(dailyLimit, bonusRemaining) => aiMember.mutate({ userId: member.userId, dailyLimit, bonusRemaining })}
                />
              )
            })}
          </div>
        </Panel>

        <Panel>
          <h2 className="text-[20px] font-bold text-text-primary">Penggunaan AI (31 hari)</h2>
          <div className="mt-[14px] max-h-[340px] overflow-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-text-muted"><tr><th className="pb-[8px]">Tarikh / ahli</th><th>Berjaya</th><th>Token</th><th>Anggaran</th></tr></thead>
              <tbody>
                {ai.data?.rows.map((row) => (
                  <tr key={`${row.user_id}:${row.usage_day}`} className="border-t border-border-default text-text-secondary">
                    <td className="py-[8px]"><span className="font-semibold text-text-primary">{row.username}</span><br />{row.usage_day}</td>
                    <td>{row.succeeded}</td>
                    <td>{row.input_tokens + row.output_tokens}</td>
                    <td>US${(Number(row.estimated_cost_microusd) / 1_000_000).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ai.data?.rows.length === 0 && <p className="py-[18px] text-center text-text-muted">Belum ada penggunaan AI.</p>}
          </div>
        </Panel>

        <FamilyCollectionImport />
      </div>
    </Page>
  )
}

function AiMemberControl(props: {
  name: string
  userId: string
  dailyLimit: number | null
  bonusRemaining: number
  defaultLimit: number
  pending: boolean
  onSave: (dailyLimit: number | null, bonusRemaining: number) => void
}) {
  const [custom, setCustom] = useState(props.dailyLimit !== null)
  const [limit, setLimit] = useState(props.dailyLimit ?? props.defaultLimit)
  const [bonus, setBonus] = useState(props.bonusRemaining)
  return (
    <div className="rounded-[12px] border border-border-default p-[11px]">
      <p className="font-semibold text-text-primary">{props.name}</p>
      <div className="mt-[8px] flex flex-wrap items-end gap-[8px]">
        <label className="text-[11px] text-text-muted">
          Had
          <select value={custom ? 'custom' : 'default'} onChange={(event) => setCustom(event.target.value === 'custom')} className="mt-[3px] block rounded-[8px] border border-border-default bg-surface-primary px-[8px] py-[6px] text-text-primary">
            <option value="default">Lalai ({props.defaultLimit})</option>
            <option value="custom">Khas</option>
          </select>
        </label>
        {custom && <input aria-label={`Had khas ${props.name}`} type="number" min={0} max={100} value={limit} onChange={(event) => setLimit(Number(event.target.value))} className="w-[72px] rounded-[8px] border border-border-default bg-surface-primary px-[8px] py-[6px] text-text-primary" />}
        <label className="text-[11px] text-text-muted">Bonus<input type="number" min={0} max={1000} value={bonus} onChange={(event) => setBonus(Number(event.target.value))} className="mt-[3px] block w-[72px] rounded-[8px] border border-border-default bg-surface-primary px-[8px] py-[6px] text-text-primary" /></label>
        <button type="button" disabled={props.pending} onClick={() => props.onSave(custom ? limit : null, bonus)} className={SECONDARY}>Simpan</button>
      </div>
    </div>
  )
}

/**
 * The invitation link, shown once. Whoever holds it becomes that account, so it
 * is never listed alongside the pending invitations — it appears here, gets
 * copied, and is gone on the next render of the page.
 *
 * The textarea is readOnly rather than disabled so the link stays selectable by
 * hand: `navigator.clipboard` needs a secure context and a permission that a
 * browser can refuse, and "the button did nothing" must not be a dead end.
 */
function InviteLink({ url, copied, onCopied }: { url: string; copied: boolean; onCopied: (value: boolean) => void }) {
  return (
    <div className="mt-[14px] rounded-[12px] border border-border-default bg-surface-primary p-[12px]">
      <p className="text-[13px] font-bold text-text-primary">Pautan jemputan — hantar kepada ahli</p>
      <p className="mt-[3px] text-[12px] text-text-muted">Sah selama 7 hari, sekali guna. Ia hanya dipaparkan sekarang; guna “Pautan baharu” jika hilang.</p>
      <textarea
        readOnly
        value={url}
        rows={3}
        aria-label="Pautan jemputan"
        onFocus={(event) => event.currentTarget.select()}
        className="mt-[9px] w-full resize-none break-all rounded-[8px] border border-border-default bg-surface-raised px-[9px] py-[7px] font-mono text-[12px] text-text-primary"
      />
      <button
        type="button"
        className={`${SECONDARY} mt-[9px]`}
        onClick={() => {
          navigator.clipboard?.writeText(url).then(() => onCopied(true), () => onCopied(false))
        }}
      >
        {copied ? 'Disalin ✓' : 'Salin pautan'}
      </button>
    </div>
  )
}

function Page({ children }: { children: React.ReactNode }) { return <div className="mx-auto max-w-[1100px] px-[16px] py-[28px] sm:px-[24px]">{children}</div> }
function Panel({ children }: { children: React.ReactNode }) { return <section className="rounded-[20px] border border-border-default bg-surface-raised p-[18px] shadow-sm">{children}</section> }
function ErrorText({ error }: { error: unknown }) { return <p className="mt-[10px] text-[14px] text-status-danger">{error instanceof Error ? error.message : 'Sesuatu tidak berjaya.'}</p> }
const PRIMARY = 'rounded-full bg-action-primary px-[16px] py-[10px] font-bold text-action-primary-text disabled:opacity-50'
const SECONDARY = 'rounded-full border border-border-default bg-surface-raised px-[14px] py-[8px] text-[13px] font-bold text-text-primary'
const DANGER = 'rounded-full border border-status-danger px-[12px] py-[7px] text-[12px] font-bold text-status-danger'
