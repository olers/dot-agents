import type { Peek, Plan, Resolutions, Result, State } from '../core/types.js'

declare global {
  interface Window {
    __AGENTS_TOKEN__?: string
  }
}

export interface StateBundle {
  repo: State
  global: State | null
  globalError: string | null
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-agents-token': window.__AGENTS_TOKEN__ ?? '',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export const getState = () => call<StateBundle>('/api/state')

export const getPlan = (resolutions: Resolutions) =>
  call<Plan>('/api/plan', { method: 'POST', body: JSON.stringify({ resolutions }) })

export const doApply = (resolutions: Resolutions, force: boolean) =>
  call<Result>('/api/apply', { method: 'POST', body: JSON.stringify({ resolutions, force }) })

export const getFile = (path: string) => call<Peek>(`/api/file?path=${encodeURIComponent(path)}`)
