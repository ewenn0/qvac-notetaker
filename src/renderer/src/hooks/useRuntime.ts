import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { Device, RuntimeStats } from '@shared/types'

export interface UseRuntimeArgs {
  setError: Dispatch<SetStateAction<string | null>>
}

export interface UseRuntime {
  device: Device
  setDevice: (d: Device) => Promise<void>
  stats: RuntimeStats
}

/**
 * Owns the compute device toggle and the live runtime stats stream
 * (STT latency, LLM TTFT, tok/s, KV-cache tokens). Keeps the displayed
 * device in sync if the main process reports a different one.
 */
export function useRuntime({ setError }: UseRuntimeArgs): UseRuntime {
  const [device, setDeviceState] = useState<Device>('cpu')
  const [stats, setStats] = useState<RuntimeStats>({
    device: 'cpu',
    cacheTokens: 0,
    sttModelLoaded: false,
    llmModelLoaded: false
  })

  useEffect(() => {
    const api = window.notetakerAPI
    if (!api) return
    return api.onRuntimeStats(setStats)
  }, [])

  // Keep the panel-displayed device in sync if it was toggled elsewhere.
  useEffect(() => {
    setDeviceState(stats.device)
  }, [stats.device])

  const setDevice = useCallback(
    async (d: Device) => {
      setDeviceState(d)
      try {
        await window.notetakerAPI.setDevice(d)
      } catch (e) {
        setError(`Device switch failed: ${(e as Error).message}`)
      }
    },
    [setError]
  )

  return { device, setDevice, stats }
}
